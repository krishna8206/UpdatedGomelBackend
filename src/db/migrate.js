import db from './index.js';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

function run(sql) {
  db.exec(sql);
}

function up() {
  run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    full_name TEXT,
    mobile TEXT,
    password_hash TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Host payout requests for bookings
  CREATE TABLE IF NOT EXISTS payout_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    host_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    approved_at TEXT,
    FOREIGN KEY(booking_id) REFERENCES bookings(id),
    FOREIGN KEY(host_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT,
    fuel TEXT,
    transmission TEXT,
    price_per_day INTEGER NOT NULL,
    rating REAL DEFAULT 0,
    seats INTEGER,
    image TEXT,
    city TEXT,
    brand TEXT,
    description TEXT,
    available INTEGER DEFAULT 1,
    host_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    car_id INTEGER NOT NULL,
    pickup_date TEXT,
    return_date TEXT,
    pickup_location TEXT,
    return_location TEXT,
    verification_json TEXT,
    total_cost INTEGER,
    days INTEGER,
    status TEXT DEFAULT 'confirmed',
    payment_id TEXT,
    payment_method TEXT,
    payment_status TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(car_id) REFERENCES cars(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    message TEXT,
    status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    kind TEXT NOT NULL, -- idFront | idBack | license
    path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(booking_id) REFERENCES bookings(id)
  );
  
  -- Ensure only one account per mobile number (when provided)
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mobile_unique ON users(mobile) WHERE mobile IS NOT NULL;
  
  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    purpose TEXT CHECK(purpose IN ('login','signup')) NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    consumed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  `);

  // Normalize existing user mobile numbers to digits-only and resolve duplicates
  try {
    const rows = db.prepare("SELECT id, mobile FROM users WHERE mobile IS NOT NULL").all();
    const toNull = [];
    const toUpdate = [];
    const seen = new Map(); // normMobile -> id (keeper)
    for (const r of rows) {
      const norm = String(r.mobile).replace(/\D/g, '');
      if (!norm) {
        toNull.push(r.id);
        continue;
      }
      if (!seen.has(norm)) {
        seen.set(norm, r.id);
        if (norm !== r.mobile) toUpdate.push({ id: r.id, mobile: norm });
      } else {
        // duplicate mobile; null it on this record to enforce uniqueness
        toNull.push(r.id);
      }
    }
    if (toNull.length) {
      const nul = db.prepare('UPDATE users SET mobile = NULL WHERE id = ?');
      const tx1 = db.transaction((ids) => { ids.forEach((id) => nul.run(id)); });
      tx1(toNull);
      console.log(`Normalized mobiles: cleared duplicates on ${toNull.length} users`);
    }
    if (toUpdate.length) {
      const upd = db.prepare('UPDATE users SET mobile = ? WHERE id = ?');
      const tx2 = db.transaction((items) => { items.forEach((it) => upd.run(it.mobile, it.id)); });
      tx2(toUpdate);
      console.log(`Normalized mobiles: updated format on ${toUpdate.length} users`);
    }
  } catch (e) {
    console.warn('Mobile normalization step failed:', e?.message || e);
  }

  // Seed default admin if not exists
  const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get('admin@gomelcars.com');
  if (!existing) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run('admin@gomelcars.com', hash);
    console.log('Seeded default admin admin@gomelcars.com / admin123');
  }

  // Seed cars from frontend JSON if empty
  const carCount = db.prepare('SELECT COUNT(1) as c FROM cars').get().c;
  if (!carCount) {
    try {
      // Attempt to read cars.json from the repo frontend
      const candidatePaths = [
        path.resolve(process.cwd(), '../project/src/data/cars.json'),
        path.resolve(process.cwd(), '../../project/src/data/cars.json'),
      ];
      let carsJsonPath = null;
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) { carsJsonPath = p; break; }
      }
      if (carsJsonPath) {
        const raw = fs.readFileSync(carsJsonPath, 'utf-8');
        const cars = JSON.parse(raw);
        const insert = db.prepare(`INSERT INTO cars (name, type, fuel, transmission, price_per_day, rating, seats, image, city, brand, description, available)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const tx = db.transaction((rows) => {
          for (const c of rows) {
            insert.run(
              c.name,
              c.type || null,
              c.fuel || null,
              c.transmission || null,
              Number(c.pricePerDay) || 0,
              Number(c.rating) || 0,
              Number(c.seats) || null,
              c.image || null,
              c.city || null,
              c.brand || null,
              c.description || null,
              c.available ? 1 : 0
            );
          }
        });
        tx(cars);
        console.log(`Seeded ${cars.length} cars from cars.json`);
      } else {
        console.warn('cars.json not found for seeding; skipping car seed');
      }
    } catch (e) {
      console.warn('Failed to seed cars:', e.message);
    }
  }

  console.log('Migration complete');
}

up();

// Ensure 'deleted' column exists on cars for soft-delete semantics
try {
  const info = db.prepare("PRAGMA table_info(cars)").all();
  const hasDeleted = info.some((c) => String(c.name).toLowerCase() === 'deleted');
  if (!hasDeleted) {
    db.exec("ALTER TABLE cars ADD COLUMN deleted INTEGER DEFAULT 0");
    console.log("Added 'deleted' column to cars table");
  }
} catch (e) {
  console.warn('Could not add deleted column on cars:', e?.message || e);
}
