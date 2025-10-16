import express from 'express';
import db from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    mobile: row.mobile,
    createdAt: row.created_at,
  };
}

// List users with aggregates for admin
router.get('/', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT u.*, 
           COUNT(b.id) AS booking_count,
           COALESCE(SUM(b.total_cost), 0) AS total_spent
    FROM users u
    LEFT JOIN bookings b ON b.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id DESC
  `).all();

  return res.json(rows.map(r => ({
    ...toUser(r),
    bookingCount: Number(r.booking_count) || 0,
    totalSpent: Number(r.total_spent) || 0,
  })));
});

// Get single user with details and recent bookings/messages
router.get('/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const bookings = db.prepare(`
    SELECT * FROM bookings WHERE user_id = ? ORDER BY id DESC LIMIT 50
  `).all(user.id).map(b => ({
    id: b.id,
    carId: b.car_id,
    pickupDate: b.pickup_date,
    returnDate: b.return_date,
    pickupLocation: b.pickup_location,
    returnLocation: b.return_location,
    totalCost: b.total_cost,
    days: b.days,
    status: b.status,
    payment: b.payment_id ? { id: b.payment_id, method: b.payment_method, status: b.payment_status } : null,
    createdAt: b.created_at,
  }));

  const messages = db.prepare(`
    SELECT id, name, email, message, status, created_at FROM messages WHERE email = ? ORDER BY id DESC LIMIT 50
  `).all(user.email).map(m => ({
    id: m.id,
    name: m.name,
    email: m.email,
    message: m.message,
    status: m.status,
    createdAt: m.created_at,
  }));

  const totals = db.prepare(`
    SELECT COUNT(*) AS booking_count, COALESCE(SUM(total_cost), 0) AS total_spent FROM bookings WHERE user_id = ?
  `).get(user.id);

  return res.json({
    user: toUser(user),
    aggregates: {
      bookingCount: Number(totals.booking_count) || 0,
      totalSpent: Number(totals.total_spent) || 0,
      messageCount: messages.length,
    },
    bookings,
    messages,
  });
});

export default router;
