import express from 'express';
import db from '../db/index.js';
import { body, validationResult } from 'express-validator';
import { requireAdmin } from '../middleware/auth.js';
import sgMail from '@sendgrid/mail';

const router = express.Router();

// Configure SendGrid if available
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

router.post(
  '/',
  body('name').isString().notEmpty(),
  body('email').isEmail(),
  body('message').isString().isLength({ min: 3 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { name, email, message } = req.body;
    const info = db.prepare('INSERT INTO messages (name, email, message) VALUES (?, ?, ?)').run(name, email, message);
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json({
      id: row.id,
      name: row.name,
      email: row.email,
      message: row.message,
      status: row.status,
      createdAt: row.created_at,
    });
  }
);

router.get('/', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM messages ORDER BY id DESC').all();
  return res.json(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      message: row.message,
      status: row.status,
      createdAt: row.created_at,
    }))
  );
});

// Get single message (admin)
router.get('/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  return res.json({
    id: row.id,
    name: row.name,
    email: row.email,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
  });
});

// Reply to a message (admin) -> send email to user and mark as replied
router.post(
  '/:id/reply',
  requireAdmin,
  body('reply').isString().isLength({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const fromEmail = process.env.SUPPORT_EMAIL || process.env.SENDGRID_FROM || '';
    const subject = `Re: Your message to Gomel Cars`;
    const replyText = String(req.body.reply);

    // If SendGrid not configured, return a 503 indicating email not set up
    if (!process.env.SENDGRID_API_KEY) {
      return res.status(503).json({ error: 'Email service not configured (missing SENDGRID_API_KEY)' });
    }

    // Validate sender email presence
    if (!fromEmail) {
      return res.status(503).json({ error: 'Email sender not configured (set SUPPORT_EMAIL or SENDGRID_FROM)' });
    }

    try {
      const msg = {
        to: row.email,
        from: fromEmail,
        subject,
        text: replyText,
        // html: can be added if needed
      };
      // Optional sandbox mode to avoid accidental sends during dev
      if (String(process.env.SENDGRID_SANDBOX).toLowerCase() === 'true') {
        msg.mailSettings = { sandboxMode: { enable: true } };
      }
      await sgMail.send(msg);

      // Mark message as replied
      db.prepare("UPDATE messages SET status = 'replied' WHERE id = ?").run(row.id);

      return res.json({ ok: true });
    } catch (e) {
      // Extract friendly error from SendGrid response when available
      const sgErrors = e?.response?.body?.errors;
      const detail = Array.isArray(sgErrors) && sgErrors.length ? sgErrors.map(x => x.message).join('; ') : null;
      return res.status(500).json({ error: detail || e?.message || 'Failed to send email' });
    }
  }
);

router.delete('/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
  return res.json({ ok: true });
});

export default router;
