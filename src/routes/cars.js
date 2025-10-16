import express from 'express';
import db from '../db/index.js';
import { body, validationResult } from 'express-validator';
import { requireAdmin, requireAuth } from '../middleware/auth.js';

const router = express.Router();

function toCar(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    fuel: row.fuel,
    transmission: row.transmission,
    pricePerDay: row.price_per_day,
    rating: row.rating,
    seats: row.seats,
    image: row.image,
    city: row.city,
    brand: row.brand,
    description: row.description,
    available: !!row.available,
    hostId: row.host_id || null,
    createdAt: row.created_at,
  };
}

function toCarWithHost(row) {
  const base = toCar(row);
  return {
    ...base,
    host: row.host_email
      ? {
          id: row.host_id,
          email: row.host_email,
          fullName: row.host_full_name,
          mobile: row.host_mobile,
        }
      : null,
    hostEmail: row.host_email || null,
    hostFullName: row.host_full_name || null,
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM cars ORDER BY id DESC').all();
  return res.json(rows.map(toCar));
});

// Availability for a date range: returns [{ id, availableForRange }]
router.get('/availability', (req, res) => {
  const { pickup, return: ret, city } = req.query;
  if (!pickup || !ret) return res.status(400).json({ error: 'pickup and return are required' });

  // Evaluate overlap: booking overlaps if NOT (booking.end <= pickup OR booking.start >= return)
  const sql = `
    SELECT c.id,
      CASE
        WHEN c.available = 0 THEN 0
        WHEN EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.car_id = c.id
            AND (b.status IS NULL OR b.status <> 'cancelled')
            AND NOT (b.return_date <= ? OR b.pickup_date >= ?)
        ) THEN 0
        ELSE 1
      END AS available_for_range
    FROM cars c
    ${city ? 'WHERE c.city = ?' : ''}
  `;
  const rows = city
    ? db.prepare(sql).all(pickup, ret, city)
    : db.prepare(sql).all(pickup, ret);
  return res.json(rows.map(r => ({ id: r.id, availableForRange: !!r.available_for_range })));
});

// Admin: list cars with host details
router.get('/admin', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.email AS host_email, u.full_name AS host_full_name, u.mobile AS host_mobile
    FROM cars c
    LEFT JOIN users u ON u.id = c.host_id
    ORDER BY c.id DESC
  `).all();
  return res.json(rows.map(toCarWithHost));
});

// User: get own hosted cars
router.get('/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM cars WHERE host_id = ? ORDER BY id DESC').all(req.user.id);
  return res.json(rows.map(toCar));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  return res.json(toCar(row));
});

router.post(
  '/',
  requireAdmin,
  body('name').isString().notEmpty(),
  body('pricePerDay').isInt({ min: 0 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const {
      name,
      type,
      fuel,
      transmission,
      pricePerDay,
      rating = 0,
      seats = 5,
      image,
      city,
      brand,
      description,
      available = true,
      hostId = null,
    } = req.body;

    const stmt = db.prepare(`INSERT INTO cars (name, type, fuel, transmission, price_per_day, rating, seats, image, city, brand, description, available, host_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = stmt.run(
      name,
      type || null,
      fuel || null,
      transmission || null,
      pricePerDay,
      rating,
      seats,
      image || null,
      city || null,
      brand || null,
      description || null,
      available ? 1 : 0,
      hostId
    );
    const row = db.prepare('SELECT * FROM cars WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json(toCar(row));
  }
);

// User Host: create car owned by the authenticated user
router.post(
  '/host',
  requireAuth,
  body('name').isString().notEmpty(),
  body('pricePerDay').isInt({ min: 0 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const {
      name,
      type,
      fuel,
      transmission,
      pricePerDay,
      rating = 0,
      seats = 5,
      image,
      city,
      brand,
      description,
      available = true,
    } = req.body;

    const stmt = db.prepare(`INSERT INTO cars (name, type, fuel, transmission, price_per_day, rating, seats, image, city, brand, description, available, host_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = stmt.run(
      name,
      type || null,
      fuel || null,
      transmission || null,
      pricePerDay,
      rating,
      seats,
      image || null,
      city || null,
      brand || null,
      description || null,
      available ? 1 : 0,
      req.user.id
    );
    const row = db.prepare('SELECT * FROM cars WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json(toCar(row));
  }
);

router.put(
  '/:id',
  requireAdmin,
  body('pricePerDay').optional().isInt({ min: 0 }),
  async (req, res) => {
    const row = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const payload = req.body || {};
    const updated = {
      name: payload.name ?? row.name,
      type: payload.type ?? row.type,
      fuel: payload.fuel ?? row.fuel,
      transmission: payload.transmission ?? row.transmission,
      price_per_day: payload.pricePerDay ?? row.price_per_day,
      rating: payload.rating ?? row.rating,
      seats: payload.seats ?? row.seats,
      image: payload.image ?? row.image,
      city: payload.city ?? row.city,
      brand: payload.brand ?? row.brand,
      description: payload.description ?? row.description,
      available: typeof payload.available === 'boolean' ? (payload.available ? 1 : 0) : row.available,
      host_id: payload.hostId ?? row.host_id,
    };

    db.prepare(`UPDATE cars SET name=@name, type=@type, fuel=@fuel, transmission=@transmission, price_per_day=@price_per_day, rating=@rating, seats=@seats, image=@image, city=@city, brand=@brand, description=@description, available=@available, host_id=@host_id WHERE id=${row.id}`).run(updated);
    const out = db.prepare('SELECT * FROM cars WHERE id = ?').get(row.id);
    return res.json(toCar(out));
  }
);

// Delete car: allowed for admin or owning host
router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const isAdmin = req.user?.role === 'admin';
  const isOwner = row.host_id && Number(row.host_id) === Number(req.user.id);
  if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM cars WHERE id = ?').run(row.id);
  return res.json({ ok: true });
});

export default router;
