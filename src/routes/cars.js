import express from 'express';
import db from '../db/index.js';
import { body, validationResult } from 'express-validator';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureDir, saveDataUrl } from '../utils/files.js';
import { mirrorCarToMongo, getMongoDb } from '../utils/mongo.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function normalizeImage(req, car) {
  if (!car || !car.image) return car;
  const img = String(car.image);
  if (/^https?:\/\//i.test(img)) return car;
  const rel = img.replace(/^\/?/, '');
  const base = `${req.protocol}://${req.get('host')}`;
  return { ...car, image: `${base}/${rel}` };
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

router.get('/', async (req, res) => {
  const mdb = await getMongoDb();
  if (mdb) {
    const docs = await mdb
      .collection('cars')
      .find({ $or: [ { deleted: { $exists: false } }, { deleted: false } ] })
      .sort({ sqliteId: -1 })
      .toArray();
    const list = docs.map((d) => ({
      id: d.sqliteId,
      name: d.name,
      type: d.type,
      fuel: d.fuel,
      transmission: d.transmission,
      pricePerDay: d.pricePerDay,
      rating: d.rating,
      seats: d.seats,
      image: d.image,
      city: d.city,
      brand: d.brand,
      description: d.description,
      available: !!d.available,
      hostId: d.hostId || null,
      createdAt: d.createdAt || null,
    })).map(c => normalizeImage(req, c));
    return res.json(list);
  }
  const rows = db.prepare('SELECT * FROM cars WHERE (deleted IS NULL OR deleted = 0) ORDER BY id DESC').all();
  const list = rows.map(toCar).map(c => normalizeImage(req, c));
  return res.json(list);
});

// Availability for a date range: returns [{ id, availableForRange }]
router.get('/availability', async (req, res) => {
  const { pickup, return: ret, city } = req.query;
  if (!pickup || !ret) return res.status(400).json({ error: 'pickup and return are required' });

  const mdb = await getMongoDb();
  if (mdb) {
    const carFilter = { $or: [ { deleted: { $exists: false } }, { deleted: false } ] };
    if (city) carFilter.city = city;
    const cars = await mdb.collection('cars').find(carFilter).project({ sqliteId: 1, available: 1 }).toArray();
    const results = [];
    for (const c of cars) {
      let available = !!c.available;
      if (available) {
        const conflict = await mdb.collection('bookings').findOne({
          carId: c.sqliteId,
          $or: [ { status: { $exists: false } }, { status: { $ne: 'cancelled' } } ],
          $nor: [ { returnDate: { $lte: pickup } }, { pickupDate: { $gte: ret } } ]
        });
        if (conflict) available = false;
      }
      results.push({ id: c.sqliteId, availableForRange: available });
    }
    return res.json(results);
  }

  // SQLite fallback
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
    WHERE (c.deleted IS NULL OR c.deleted = 0)
    ${city ? ' AND c.city = ?' : ''}
  `;
  const rows = city
    ? db.prepare(sql).all(pickup, ret, city)
    : db.prepare(sql).all(pickup, ret);
  return res.json(rows.map(r => ({ id: r.id, availableForRange: !!r.available_for_range })));
});

// Admin: list cars with host details
router.get('/admin', requireAdmin, async (req, res) => {
  const mdb = await getMongoDb();
  if (mdb) {
    const cars = await mdb
      .collection('cars')
      .find({ $or: [ { deleted: { $exists: false } }, { deleted: false } ] })
      .sort({ sqliteId: -1 })
      .toArray();
    const list = [];
    for (const c of cars) {
      let host = null;
      if (c.hostId) host = await mdb.collection('users').findOne({ sqliteId: c.hostId }, { projection: { email: 1, fullName: 1, mobile: 1, sqliteId: 1 } });
      list.push(normalizeImage(req, {
        id: c.sqliteId,
        name: c.name,
        type: c.type,
        fuel: c.fuel,
        transmission: c.transmission,
        pricePerDay: c.pricePerDay,
        rating: c.rating,
        seats: c.seats,
        image: c.image,
        city: c.city,
        brand: c.brand,
        description: c.description,
        available: !!c.available,
        hostId: c.hostId || null,
        createdAt: c.createdAt || null,
        host: host ? { id: host.sqliteId, email: host.email, fullName: host.fullName || null, mobile: host.mobile || null } : null,
        hostEmail: host?.email || null,
        hostFullName: host?.fullName || null,
      }));
    }
    return res.json(list);
  }
  const rows = db.prepare(`
    SELECT c.*, u.email AS host_email, u.full_name AS host_full_name, u.mobile AS host_mobile
    FROM cars c
    LEFT JOIN users u ON u.id = c.host_id
    WHERE (c.deleted IS NULL OR c.deleted = 0)
    ORDER BY c.id DESC
  `).all();
  const list = rows.map(toCarWithHost).map(c => normalizeImage(req, c));
  return res.json(list);
});

// User: get own hosted cars
router.get('/mine', requireAuth, async (req, res) => {
  const mdb = await getMongoDb();
  if (mdb) {
    const docs = await mdb
      .collection('cars')
      .find({ hostId: req.user.id, $or: [ { deleted: { $exists: false } }, { deleted: false } ] })
      .sort({ sqliteId: -1 })
      .toArray();
    const list = docs.map((d) => ({
      id: d.sqliteId,
      name: d.name,
      type: d.type,
      fuel: d.fuel,
      transmission: d.transmission,
      pricePerDay: d.pricePerDay,
      rating: d.rating,
      seats: d.seats,
      image: d.image,
      city: d.city,
      brand: d.brand,
      description: d.description,
      available: !!d.available,
      hostId: d.hostId || null,
      createdAt: d.createdAt || null,
    })).map(c => normalizeImage(req, c));
    return res.json(list);
  }
  const rows = db.prepare('SELECT * FROM cars WHERE (deleted IS NULL OR deleted = 0) AND host_id = ? ORDER BY id DESC').all(req.user.id);
  const list = rows.map(toCar).map(c => normalizeImage(req, c));
  return res.json(list);
});

router.get('/:id', async (req, res) => {
  const mdb = await getMongoDb();
  if (mdb) {
    const d = await mdb.collection('cars').findOne({ sqliteId: Number(req.params.id), $or: [ { deleted: { $exists: false } }, { deleted: false } ] });
    if (!d) return res.status(404).json({ error: 'Not found' });
    const car = normalizeImage(req, {
      id: d.sqliteId,
      name: d.name,
      type: d.type,
      fuel: d.fuel,
      transmission: d.transmission,
      pricePerDay: d.pricePerDay,
      rating: d.rating,
      seats: d.seats,
      image: d.image,
      city: d.city,
      brand: d.brand,
      description: d.description,
      available: !!d.available,
      hostId: d.hostId || null,
      createdAt: d.createdAt || null,
    });
    return res.json(car);
  }
  const row = db.prepare('SELECT * FROM cars WHERE (deleted IS NULL OR deleted = 0) AND id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  return res.json(normalizeImage(req, toCar(row)));
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
      imageData,
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
    let row = db.prepare('SELECT * FROM cars WHERE id = ?').get(info.lastInsertRowid);
    try { await mirrorCarToMongo(row); } catch {}

    // If imageData provided, save to uploads and update image path
    if (imageData && typeof imageData === 'string' && imageData.startsWith('data:')) {
      try {
        const carsDir = path.join(__dirname, '../../uploads/cars');
        ensureDir(carsDir);
        const targetPath = path.join(carsDir, `${row.id}.png`);
        const saved = saveDataUrl(imageData, targetPath);
        if (saved) {
          const rel = path
            .relative(path.join(__dirname, '../../'), saved)
            .replace(/\\/g, '/');
          db.prepare('UPDATE cars SET image = ? WHERE id = ?').run(rel, row.id);
          row = db.prepare('SELECT * FROM cars WHERE id = ?').get(row.id);
          try { await mirrorCarToMongo(row); } catch {}
        }
      } catch (_) {}
    }

    try { await mirrorCarToMongo(row); } catch {}
    return res.status(201).json(normalizeImage(req, toCar(row)));
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
      imageData,
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
    let row = db.prepare('SELECT * FROM cars WHERE id = ?').get(info.lastInsertRowid);

    // Save uploaded image if provided as data URL
    if (imageData && typeof imageData === 'string' && imageData.startsWith('data:')) {
      try {
        const carsDir = path.join(__dirname, '../../uploads/cars');
        ensureDir(carsDir);
        const targetPath = path.join(carsDir, `${row.id}.png`);
        const saved = saveDataUrl(imageData, targetPath);
        if (saved) {
          const rel = path
            .relative(path.join(__dirname, '../../'), saved)
            .replace(/\\/g, '/');
          db.prepare('UPDATE cars SET image = ? WHERE id = ?').run(rel, row.id);
          row = db.prepare('SELECT * FROM cars WHERE id = ?').get(row.id);
        }
      } catch (_) {}
    }

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
    try { await mirrorCarToMongo(out); } catch {}
    return res.json(normalizeImage(req, toCar(out)));
  }
);

// Delete car: allowed for admin or owning host
router.delete('/:id', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const isAdmin = req.user?.role === 'admin';
  const isOwner = row.host_id && Number(row.host_id) === Number(req.user.id);
  if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('UPDATE cars SET deleted = 1 WHERE id = ?').run(row.id);
  try { await mirrorCarToMongo({ ...row, deleted: 1 }); } catch {}
  return res.json({ ok: true, softDeleted: true });
});

export default router;
