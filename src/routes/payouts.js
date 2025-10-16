import express from 'express';
import db from '../db/index.js';
import { body, validationResult } from 'express-validator';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { broadcast } from '../utils/events.js';

const router = express.Router();

function toPayout(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    hostId: row.host_id,
    amount: row.amount,
    status: row.status,
    note: row.note || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at || null,
    host: row.host_email
      ? { id: row.host_id, email: row.host_email, fullName: row.host_full_name || null }
      : null,
  };
}

// Host: list own payout requests
router.get('/mine', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM payout_requests WHERE host_id = ? ORDER BY id DESC')
    .all(req.user.id);
  return res.json(rows.map(toPayout));
});

// Admin: list all payout requests
router.get('/', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT pr.*,
           b.user_id AS booking_user_id,
           b.car_id AS booking_car_id,
           c.host_id AS car_host_id,
           u.email AS host_email,
           u.full_name AS host_full_name
    FROM payout_requests pr
    LEFT JOIN bookings b ON b.id = pr.booking_id
    LEFT JOIN cars c ON c.id = b.car_id
    LEFT JOIN users u ON u.id = pr.host_id
    ORDER BY pr.id DESC
  `).all();
  return res.json(rows.map(toPayout));
});

// Host: create payout request for a booking they own
router.post(
  '/request',
  requireAuth,
  body('bookingId').isInt({ min: 1 }),
  body('amount').isInt({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { bookingId, amount, note } = req.body;

    const row = db.prepare(`
      SELECT b.*, c.host_id AS host_id
      FROM bookings b
      LEFT JOIN cars c ON c.id = b.car_id
      WHERE b.id = ?
    `).get(bookingId);
    if (!row) return res.status(404).json({ error: 'Booking not found' });
    if (Number(row.host_id) !== Number(req.user.id)) return res.status(403).json({ error: 'Not owner of this booking' });

    // Prevent duplicate pending requests for same booking
    const existing = db.prepare('SELECT id FROM payout_requests WHERE booking_id = ? AND status = ?').get(bookingId, 'pending');
    if (existing) return res.status(409).json({ error: 'Request already pending for this booking' });

    const info = db.prepare('INSERT INTO payout_requests (booking_id, host_id, amount, note) VALUES (?, ?, ?, ?)')
      .run(bookingId, req.user.id, amount, note || null);
    const pr = db.prepare('SELECT * FROM payout_requests WHERE id = ?').get(info.lastInsertRowid);

    broadcast('payout_request_created', toPayout(pr));
    return res.status(201).json(toPayout(pr));
  }
);

// Admin: approve payout request
router.post('/:id/approve', requireAdmin, (req, res) => {
  const pr = db.prepare('SELECT * FROM payout_requests WHERE id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  if (pr.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
  db.prepare("UPDATE payout_requests SET status='approved', approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(pr.id);
  const out = db.prepare('SELECT * FROM payout_requests WHERE id = ?').get(pr.id);
  broadcast('payout_request_updated', toPayout(out));
  return res.json(toPayout(out));
});

// Admin: reject payout request
router.post('/:id/reject', requireAdmin, (req, res) => {
  const pr = db.prepare('SELECT * FROM payout_requests WHERE id = ?').get(req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  if (pr.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
  db.prepare("UPDATE payout_requests SET status='rejected', updated_at = datetime('now') WHERE id = ?").run(pr.id);
  const out = db.prepare('SELECT * FROM payout_requests WHERE id = ?').get(pr.id);
  broadcast('payout_request_updated', toPayout(out));
  return res.json(toPayout(out));
});

export default router;
