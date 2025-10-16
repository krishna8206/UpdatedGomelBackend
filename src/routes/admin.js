import express from 'express';
import db from '../db/index.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

router.post(
  '/login',
  body('email').isEmail(),
  body('password').isString(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    const normEmail = String(email).trim().toLowerCase();
    const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(normEmail);
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = bcrypt.compareSync(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: admin.id, role: 'admin' }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '7d' });
    return res.json({ token, admin: { id: admin.id, email: admin.email } });
  }
);

router.get('/me', requireAdmin, (req, res) => {
  const admin = db.prepare('SELECT id, email, created_at FROM admins WHERE id = ?').get(req.user.id);
  if (!admin) return res.status(404).json({ error: 'Not found' });
  return res.json({ admin });
});

export default router;
