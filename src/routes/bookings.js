import express from 'express';
import db from '../db/index.js';
import { body, validationResult } from 'express-validator';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureDir, saveDataUrl } from '../utils/files.js';
import fs from 'fs';
import { broadcast } from '../utils/events.js';
import { mirrorBookingToMongo, deleteBookingFromMongo, getMongoDb } from '../utils/mongo.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function toBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    carId: row.car_id,
    pickupDate: row.pickup_date,
    returnDate: row.return_date,
    pickupLocation: row.pickup_location,
    returnLocation: row.return_location,
    verification: row.verification_json ? JSON.parse(row.verification_json) : null,
    totalCost: row.total_cost,
    days: row.days,
    status: row.status,
    payment: row.payment_id
      ? { id: row.payment_id, method: row.payment_method, status: row.payment_status }
      : null,
    createdAt: row.created_at,
  };
}

function toBookingFull(row) {
  if (!row) return null;
  const base = toBooking(row);
  return {
    ...base,
    user: row.user_email
      ? {
          id: row.user_id,
          email: row.user_email,
          fullName: row.user_full_name,
          mobile: row.user_mobile,
        }
      : null,
    userEmail: row.user_email || null,
    userFullName: row.user_full_name || null,
    car: row.car_name
      ? {
          id: row.car_id,
          name: row.car_name,
          type: row.car_type,
          fuel: row.car_fuel,
          transmission: row.car_transmission,
          pricePerDay: row.car_price_per_day,
        }
      : null,
  };
}

// User: list own bookings
router.get('/me', requireAuth, async (req, res) => {
  const mdb = await getMongoDb();
  if (mdb) {
    const docs = await mdb
      .collection('bookings')
      .find({ userId: req.user.id })
      .sort({ sqliteId: -1 })
      .toArray();
    const list = docs.map((b) => ({
      id: b.sqliteId,
      userId: b.userId,
      carId: b.carId,
      pickupDate: b.pickupDate,
      returnDate: b.returnDate,
      pickupLocation: b.pickupLocation || null,
      returnLocation: b.returnLocation || null,
      verification: b.verification || null,
      totalCost: b.totalCost || null,
      days: b.days || null,
      status: b.status || 'confirmed',
      payment: b.payment || null,
      createdAt: b.createdAt || null,
    }));
    return res.json(list);
  }
  const rows = db
    .prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY id DESC')
    .all(req.user.id);
  return res.json(rows.map(toBooking));
});

// Host: list bookings for cars owned by the host
router.get('/host', requireAuth, async (req, res) => {
  const mdb = await getMongoDb();
  if (mdb) {
    const cars = await mdb.collection('cars').find({ hostId: req.user.id, $or: [ { deleted: { $exists: false } }, { deleted: false } ] }).project({ sqliteId: 1, name: 1, type: 1, fuel: 1, transmission: 1, pricePerDay: 1 }).toArray();
    const carIds = new Set(cars.map(c => c.sqliteId));
    if (carIds.size === 0) return res.json([]);
    const bookings = await mdb.collection('bookings').find({ carId: { $in: Array.from(carIds) } }).sort({ sqliteId: -1 }).toArray();
    const usersMap = new Map();
    const userIds = Array.from(new Set(bookings.map(b => b.userId)));
    if (userIds.length) {
      const users = await mdb.collection('users').find({ sqliteId: { $in: userIds } }).project({ sqliteId: 1, email: 1, fullName: 1, mobile: 1 }).toArray();
      users.forEach(u => usersMap.set(u.sqliteId, u));
    }
    const carsMap = new Map();
    cars.forEach(c => carsMap.set(c.sqliteId, c));
    const out = bookings.map(b => ({
      id: b.sqliteId,
      userId: b.userId,
      carId: b.carId,
      pickupDate: b.pickupDate,
      returnDate: b.returnDate,
      pickupLocation: b.pickupLocation || null,
      returnLocation: b.returnLocation || null,
      verification: b.verification || null,
      totalCost: b.totalCost || null,
      days: b.days || null,
      status: b.status || 'confirmed',
      payment: b.payment || null,
      createdAt: b.createdAt || null,
      user: usersMap.get(b.userId) ? { id: usersMap.get(b.userId).sqliteId, email: usersMap.get(b.userId).email, fullName: usersMap.get(b.userId).fullName || null, mobile: usersMap.get(b.userId).mobile || null } : null,
      userEmail: usersMap.get(b.userId)?.email || null,
      userFullName: usersMap.get(b.userId)?.fullName || null,
      car: carsMap.get(b.carId) ? { id: b.carId, name: carsMap.get(b.carId).name, type: carsMap.get(b.carId).type, fuel: carsMap.get(b.carId).fuel, transmission: carsMap.get(b.carId).transmission, pricePerDay: carsMap.get(b.carId).pricePerDay } : null,
    }));
    return res.json(out);
  }
  const rows = db.prepare(`
    SELECT b.*, 
           u.email AS user_email, u.full_name AS user_full_name, u.mobile AS user_mobile,
           c.name AS car_name, c.type AS car_type, c.fuel AS car_fuel, c.transmission AS car_transmission, c.price_per_day AS car_price_per_day
    FROM bookings b
    JOIN cars c ON c.id = b.car_id
    LEFT JOIN users u ON u.id = b.user_id
    WHERE c.host_id = ?
    ORDER BY b.id DESC
  `).all(req.user.id);
  return res.json(rows.map(toBookingFull));
});

// Admin: list all
router.get('/', requireAdmin, async (req, res) => {
  const mdb = await getMongoDb();
  if (mdb) {
    const bookings = await mdb.collection('bookings').find({}).sort({ sqliteId: -1 }).toArray();
    const userIds = Array.from(new Set(bookings.map(b => b.userId)));
    const carIds = Array.from(new Set(bookings.map(b => b.carId)));
    const [users, cars] = await Promise.all([
      userIds.length ? mdb.collection('users').find({ sqliteId: { $in: userIds } }).project({ sqliteId: 1, email: 1, fullName: 1, mobile: 1 }).toArray() : Promise.resolve([]),
      carIds.length ? mdb.collection('cars').find({ sqliteId: { $in: carIds } }).project({ sqliteId: 1, name: 1, type: 1, fuel: 1, transmission: 1, pricePerDay: 1 }).toArray() : Promise.resolve([]),
    ]);
    const usersMap = new Map(users.map(u => [u.sqliteId, u]));
    const carsMap = new Map(cars.map(c => [c.sqliteId, c]));
    const out = bookings.map(b => ({
      ...{
        id: b.sqliteId,
        userId: b.userId,
        carId: b.carId,
        pickupDate: b.pickupDate,
        returnDate: b.returnDate,
        pickupLocation: b.pickupLocation || null,
        returnLocation: b.returnLocation || null,
        verification: b.verification || null,
        totalCost: b.totalCost || null,
        days: b.days || null,
        status: b.status || 'confirmed',
        payment: b.payment || null,
        createdAt: b.createdAt || null,
      },
      user: usersMap.get(b.userId) ? { id: usersMap.get(b.userId).sqliteId, email: usersMap.get(b.userId).email, fullName: usersMap.get(b.userId).fullName || null, mobile: usersMap.get(b.userId).mobile || null } : null,
      userEmail: usersMap.get(b.userId)?.email || null,
      userFullName: usersMap.get(b.userId)?.fullName || null,
      car: carsMap.get(b.carId) ? { id: b.carId, name: carsMap.get(b.carId).name, type: carsMap.get(b.carId).type, fuel: carsMap.get(b.carId).fuel, transmission: carsMap.get(b.carId).transmission, pricePerDay: carsMap.get(b.carId).pricePerDay } : null,
    }));
    return res.json(out);
  }
  const rows = db.prepare(`
    SELECT b.*, 
           u.email AS user_email, u.full_name AS user_full_name, u.mobile AS user_mobile,
           c.name AS car_name, c.type AS car_type, c.fuel AS car_fuel, c.transmission AS car_transmission, c.price_per_day AS car_price_per_day
    FROM bookings b
    LEFT JOIN users u ON u.id = b.user_id
    LEFT JOIN cars c ON c.id = b.car_id
    ORDER BY b.id DESC
  `).all();
  return res.json(rows.map(toBookingFull));
});

// Admin: get one
router.get('/:id', requireAdmin, async (req, res) => {
  const mdb = await getMongoDb();
  const id = Number(req.params.id);
  if (mdb) {
    const b = await mdb.collection('bookings').findOne({ sqliteId: id });
    if (!b) return res.status(404).json({ error: 'Not found' });
    const [u, c] = await Promise.all([
      mdb.collection('users').findOne({ sqliteId: b.userId }, { projection: { sqliteId: 1, email: 1, fullName: 1, mobile: 1 } }),
      mdb.collection('cars').findOne({ sqliteId: b.carId }, { projection: { sqliteId: 1, name: 1, type: 1, fuel: 1, transmission: 1, pricePerDay: 1 } }),
    ]);
    const out = {
      id: b.sqliteId,
      userId: b.userId,
      carId: b.carId,
      pickupDate: b.pickupDate,
      returnDate: b.returnDate,
      pickupLocation: b.pickupLocation || null,
      returnLocation: b.returnLocation || null,
      verification: b.verification || null,
      totalCost: b.totalCost || null,
      days: b.days || null,
      status: b.status || 'confirmed',
      payment: b.payment || null,
      createdAt: b.createdAt || null,
      user: u ? { id: u.sqliteId, email: u.email, fullName: u.fullName || null, mobile: u.mobile || null } : null,
      userEmail: u?.email || null,
      userFullName: u?.fullName || null,
      car: c ? { id: c.sqliteId, name: c.name, type: c.type, fuel: c.fuel, transmission: c.transmission, pricePerDay: c.pricePerDay } : null,
    };
    return res.json(out);
  }
  const row = db.prepare(`
    SELECT b.*, 
           u.email AS user_email, u.full_name AS user_full_name, u.mobile AS user_mobile,
           c.name AS car_name, c.type AS car_type, c.fuel AS car_fuel, c.transmission AS car_transmission, c.price_per_day AS car_price_per_day
    FROM bookings b
    LEFT JOIN users u ON u.id = b.user_id
    LEFT JOIN cars c ON c.id = b.car_id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  return res.json(toBookingFull(row));
});

// Create booking after payment success
router.post(
  '/',
  requireAuth,
  body('carId').isInt({ min: 1 }),
  body('pickupDate').isString(),
  body('returnDate').isString(),
  body('totalCost').isInt({ min: 0 }),
  body('days').isInt({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      carId,
      pickupDate,
      returnDate,
      pickupLocation,
      returnLocation,
      verification = null,
      totalCost,
      days,
      payment = null,
    } = req.body;

    // Ensure car exists and is available
    const carRow = db.prepare('SELECT id, available FROM cars WHERE id = ?').get(carId);
    if (!carRow) return res.status(400).json({ error: 'Invalid car' });
    if (!carRow.available) return res.status(400).json({ error: 'Car is not available for booking' });

    // Save booking
    const info = db
      .prepare(
        `INSERT INTO bookings (user_id, car_id, pickup_date, return_date, pickup_location, return_location, verification_json, total_cost, days, status, payment_id, payment_method, payment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.user.id,
        carId,
        pickupDate,
        returnDate,
        pickupLocation || null,
        returnLocation || null,
        verification ? JSON.stringify(verification) : null,
        totalCost,
        days,
        'confirmed',
        payment?.id || null,
        payment?.method || null,
        payment?.status || null
      );

    const bookingId = info.lastInsertRowid;

    // Persist attachments if provided as data URLs in verification.attachmentsData
    const attachmentsData = verification?.attachmentsData || {};
    const kinds = ['idFront', 'idBack', 'license'];
    const baseDir = path.join(__dirname, '../../uploads/bookings', String(bookingId));
    ensureDir(baseDir);

    kinds.forEach((k) => {
      if (attachmentsData[k]) {
        const targetPath = path.join(baseDir, `${k}.png`);
        const saved = saveDataUrl(attachmentsData[k], targetPath);
        if (saved) {
          db.prepare('INSERT INTO attachments (booking_id, kind, path) VALUES (?, ?, ?)').run(
            bookingId,
            k,
            path.relative(path.join(__dirname, '../../'), saved).replace(/\\/g, '/')
          );
        }
      }
    });

    const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    try { await mirrorBookingToMongo(row); } catch {}
    const out = toBooking(row);
    // Notify subscribers (admin/hosts) about new booking
    broadcast('booking_created', out);
    return res.status(201).json(out);
  }
);

// Admin: delete booking
router.delete('/:id', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Do DB deletion in a transaction
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM attachments WHERE booking_id = ?').run(id);
    db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
  });
  tx(row.id);
  try { await deleteBookingFromMongo(row.id); } catch {}

  // Best-effort: remove uploaded files directory
  try {
    const baseDir = path.join(__dirname, '../../uploads/bookings', String(row.id));
    fs.rmSync(baseDir, { recursive: true, force: true });
  } catch (_) {
    // ignore fs cleanup errors
  }
  return res.json({ ok: true });
});

export default router;
