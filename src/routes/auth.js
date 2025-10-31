import express from 'express';
import db from '../db/index.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { sendOtpEmail } from '../utils/mailer.js';
import { mirrorUserToMongo, mongoUserExists, getMongoUser, mongoMobileTaken } from '../utils/mongo.js';

const router = express.Router();

function toUserDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    mobile: row.mobile,
    createdAt: row.created_at,
  };
}

function normalizeMobile(m) {
  if (!m) return null;
  const digits = String(m).replace(/\D/g, '');
  return digits || null;
}

router.post(
  '/login-password',
  body('email').isEmail(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email } = req.body;
    const normEmail = String(email).trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail);
    console.log('[auth][login-password] email=', normEmail, 'sqlite=', !!user);
    if (!user) return res.status(404).json({ error: 'Email not registered' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    
    // Store OTP in database
    db.prepare('INSERT OR REPLACE INTO otp_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)')
      .run(normEmail, code, 'login', expiresAt);

    // Send OTP via email
    const emailResult = await sendOtpEmail({ to: normEmail, code, purpose: 'login' });
    
    // In development or when email is not enabled, include the OTP in the response
    if (process.env.NODE_ENV !== 'production' || !emailResult.sent) {
      return res.json({ 
        pendingOtp: true, 
        expiresAt,
        debug: { 
          code,
          emailSent: emailResult.sent,
          reason: emailResult.reason 
        }
      });
    }
    
    return res.json({ pendingOtp: true, expiresAt });
  }
); // <-- make sure this closing parenthesis + semicolon exists

// Deprecated password login endpoint kept for compatibility; now returns 400
router.post('/login', (req, res) => {
  return res.status(400).json({ error: 'Password login disabled. Use OTP flow.' });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  return res.json({ user: toUserDTO(user) });
});

// --- OTP FLOW ---
function genOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Request OTP for login/signup
router.post(
  '/request-otp',
  [
    body('email').isEmail().normalizeEmail(),
    body('purpose').isIn(['login', 'signup', 'reset']).withMessage('Invalid purpose')
  ],
  // Debug middleware
  (req, res, next) => {
    console.log('Request received at /request-otp');
    console.log('Request body:', req.body);
    console.log('Request headers:', req.headers);
    next();
  },
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, purpose } = req.body;
      const normEmail = String(email).trim().toLowerCase();
      
      // For login purpose, check if user exists
      if (purpose === 'login') {
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
        const existsInMongo = await mongoUserExists(normEmail).catch(() => false);
        console.log('[auth][request-otp] purpose=login email=', normEmail, 'sqlite=', !!existing, 'mongo=', existsInMongo);
        if (!existing && !existsInMongo) {
          return res.status(404).json({ error: 'Email not registered. Please sign up first.' });
        }
      }
      
      // For signup, check if email is already registered
      if (purpose === 'signup') {
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
        if (existing) {
          return res.status(400).json({ error: 'Email already registered' });
        }
      }

      // Generate and save OTP
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry
      
      // Delete any existing OTPs for this email and purpose
      db.prepare('DELETE FROM otp_codes WHERE email = ? AND purpose = ?')
        .run(normEmail, purpose);
      
      // Insert new OTP
      db.prepare('INSERT INTO otp_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)')
        .run(normEmail, code, purpose, expiresAt.toISOString());

      // Log the OTP for development (remove in production)
      console.log(`OTP for ${normEmail} (${purpose}): ${code}`);
      
      // In production, you would send the OTP via email/SMS here
      // await sendOtpEmail({ to: normEmail, code, purpose });
      
      return res.json({
        success: true,
        message: 'OTP sent successfully',
        expiresAt: expiresAt.toISOString()
      });
      
    } catch (error) {
      console.error('Error in request-otp:', error);
      return res.status(500).json({ error: 'Failed to process OTP request' });
    }
  }
);

// Verify OTP
router.post(
  '/verify-otp',
  [
    body('email').isEmail().normalizeEmail(),
    body('code').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
    body('purpose').isIn(['login', 'signup', 'reset']).withMessage('Invalid purpose')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, purpose } = req.body;
    const normEmail = String(email).trim().toLowerCase();

    // For login purpose, allow if user exists in SQLite OR Mongo (mirror)
    if (purpose === 'login') {
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
      const existsInMongo = await mongoUserExists(normEmail).catch(()=>false);
      console.log('[auth][request-otp] purpose=login email=', normEmail, 'sqlite=', !!existing, 'mongo=', !!existsInMongo);
      if (!existing && !existsInMongo) return res.status(404).json({ error: 'Email not registered' });
    }
    // For signup purpose, block if email already registered
    if (purpose === 'signup') {
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
      if (existing) return res.status(409).json({ error: 'Email already registered' });
    }

    // If purpose is login, we can allow non-existing email too (we will create on verify)
    const code = genOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    // NOTE: otp_codes table CHECK may not include 'reset' in some environments.
    // To stay compatible, we store 'reset' as 'login'.
    const storedPurpose = (purpose === 'reset') ? 'login' : purpose;
    db.prepare('INSERT INTO otp_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)')
      .run(normEmail, code, storedPurpose, expiresAt);

    // In production, send via email/SMS. Do not include codes in API responses.
    // Try to send email if SENDGRID configured
    try { await sendOtpEmail({ to: normEmail, code, purpose }); } catch (e) {
      console.warn('[mailer] send failed:', e?.message || 'send_failed');
    }
    return res.json({ message: 'OTP sent successfully', expiresAt });
  }
);

router.post(
  '/verify-otp',
  body('email').isEmail(),
  body('code').isLength({ min: 4, max: 4 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, code, fullName, mobile } = req.body;
    const normEmail = String(email).trim().toLowerCase();
    const normMobile = normalizeMobile(mobile);
    const nowIso = new Date().toISOString();

    const row = db
      .prepare('SELECT * FROM otp_codes WHERE email = ? AND code = ? AND consumed = 0 ORDER BY id DESC')
      .get(normEmail, code);
    if (!row) return res.status(400).json({ error: 'Invalid OTP' });
    if (row.expires_at < nowIso) return res.status(400).json({ error: 'OTP expired' });
    if (row.attempts >= 5) return res.status(400).json({ error: 'Too many attempts' });

    // Mark consumed and increment attempts atomically
    db.prepare('UPDATE otp_codes SET consumed = 1, attempts = attempts + 1 WHERE id = ?').run(row.id);

    // Find or create user (create on signup-purpose OTPs; for login, also create if user exists only in Mongo)
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail);
    if (!user) {
      if (row.purpose === 'signup') {
        // Enforce mobile uniqueness when provided
        if (normMobile) {
          const mobileTakenSql = db.prepare('SELECT id FROM users WHERE mobile = ?').get(normMobile);
          const mobileTakenMongo = await mongoMobileTaken(normMobile);
          if (mobileTakenSql || mobileTakenMongo) return res.status(409).json({ error: 'Mobile number already registered' });
        }
        const info = db
          .prepare('INSERT INTO users (email, full_name, mobile, password_hash) VALUES (?, ?, ?, ?)')
          .run(normEmail, fullName || null, normMobile || null, null);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      } else {
        // Login OTP: if user exists only in Mongo Atlas, create a local SQLite record from Mongo profile
        const m = await getMongoUser(normEmail).catch(()=>null);
        if (m) {
          const info = db
            .prepare('INSERT INTO users (email, full_name, mobile, password_hash) VALUES (?, ?, ?, ?)')
            .run(normEmail, m.fullName || null, normalizeMobile(m.mobile) || null, null);
          user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
        } else {
          return res.status(404).json({ error: 'Email not registered' });
        }
      }
    } else {
      // If this OTP was a signup OTP but email already exists, block signup
      if (row.purpose === 'signup') {
        return res.status(409).json({ error: 'Email already registered' });
      }
      // Update profile fields if provided
      if (normMobile) {
        const mobileTaken = db.prepare('SELECT id FROM users WHERE mobile = ? AND id != ?').get(normMobile, user.id);
        const mobileTakenMongo = await mongoMobileTaken(normMobile, user.email);
        if (mobileTaken || mobileTakenMongo) return res.status(409).json({ error: 'Mobile number already registered' });
      }
      db.prepare('UPDATE users SET full_name = COALESCE(?, full_name), mobile = COALESCE(?, mobile) WHERE id = ?')
        .run(fullName || null, normMobile || null, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    // Mirror to Mongo and build DTO from Mongo if present
    try { await mirrorUserToMongo(user); } catch {}
    const m = await getMongoUser(user.email);
    const dto = m
      ? { id: user.id, email: m.email, fullName: m.fullName || null, mobile: m.mobile || null, createdAt: m.createdAt || user.created_at }
      : toUserDTO(user);
    const token = jwt.sign({ id: user.id, role: 'user' }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '7d' });
    return res.json({ user: dto, token });
  }
);

export default router;
