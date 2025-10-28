// Optional MongoDB integration helpers
// This module safely no-ops if mongodb driver is not installed or MONGODB_URI is missing.

let _client = null;
let _db = null;
let _ready = false;
let _error = null;

async function ensureConnected() {
  if (_ready) return { ok: true, db: _db };
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    _error = 'MONGODB_URI not set';
    console.warn('[mongo] skipped: MONGODB_URI not set');
    return { ok: false, error: _error };
  }
  try {
    // Dynamic import so absence of dependency won't crash import time
    const { MongoClient } = await import('mongodb');
    _client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    await _client.connect();
    const dbName = process.env.MONGODB_DB;
    _db = dbName ? _client.db(dbName) : _client.db();
    _ready = true;
    console.log(`[mongo] connected: db="${_db.databaseName}"`);
    return { ok: true, db: _db };
  } catch (e) {
    _error = e?.message || 'mongo_connect_failed';
    console.warn('[mongo] connect failed:', _error);
    return { ok: false, error: _error };
  }
}

export async function getMongoDb() {
  const conn = await ensureConnected();
  return conn.ok ? _db : null;
}

export async function mongoMobileTaken(mobile, excludeEmail = null) {
  const conn = await ensureConnected();
  if (!conn.ok) return false;
  try {
    const users = _db.collection('users');
    const digits = String(mobile || '').replace(/\D/g, '');
    if (!digits) return false;
    const query = excludeEmail
      ? { mobile: digits, email: { $ne: String(excludeEmail).toLowerCase() } }
      : { mobile: digits };
    const doc = await users.findOne(query, { projection: { _id: 1 } });
    return !!doc;
  } catch (e) {
    console.warn('[mongo] mobile taken check failed:', e?.message || 'exists_failed');
    return false;
  }
}

export async function mongoUserExists(email) {
  const conn = await ensureConnected();
  if (!conn.ok) return false;
  try {
    const users = _db.collection('users');
    const doc = await users.findOne({ email: String(email).toLowerCase() }, { projection: { _id: 1 } });
    return !!doc;
  } catch (e) {
    console.warn('[mongo] exists check failed:', e?.message || 'exists_failed');
    return false;
  }
}

export async function getMongoUser(email) {
  const conn = await ensureConnected();
  if (!conn.ok) return null;
  try {
    const users = _db.collection('users');
    const doc = await users.findOne({ email: String(email).toLowerCase() });
    return doc || null;
  } catch (e) {
    console.warn('[mongo] get user failed:', e?.message || 'get_failed');
    return null;
  }
}

export async function mirrorUserToMongo(userRow) {
  // userRow fields: id, email, full_name, mobile, created_at, password_hash
  if (!userRow?.email) return { ok: false, skipped: true, reason: 'no_user' };
  const conn = await ensureConnected();
  if (!conn.ok) return { ok: false, skipped: true, reason: conn.error };
  try {
    const users = _db.collection('users');
    const email = String(userRow.email).toLowerCase();
    const createdAt = userRow.created_at || new Date().toISOString();

    // Determine if doc exists
    const existing = await users.findOne({ email });
    if (existing) {
      const set = {};
      if (typeof userRow.full_name !== 'undefined' && userRow.full_name !== null) {
        set.fullName = userRow.full_name;
      }
      if (typeof userRow.mobile !== 'undefined') {
        const norm = userRow.mobile ? String(userRow.mobile).replace(/\D/g, '') : null;
        set.mobile = norm || null;
      }
      if (Object.keys(set).length > 0) {
        await users.updateOne({ email }, { $set: set });
        console.log('[mongo] mirrored (update) user:', email, 'set:', JSON.stringify(set));
      } else {
        console.log('[mongo] mirror skipped (no changes):', email);
      }
    } else {
      const doc = {
        email,
        fullName: userRow.full_name || null,
        mobile: userRow.mobile ? String(userRow.mobile).replace(/\D/g, '') : null,
        createdAt,
        sqliteId: userRow.id,
      };
      await users.insertOne(doc);
      console.log('[mongo] mirrored (insert) user:', email);
    }
    return { ok: true };
  } catch (e) {
    console.warn('[mongo] mirror failed:', e?.message || 'mongo_write_failed');
    return { ok: false, error: e?.message || 'mongo_write_failed' };
  }
}

// --- Cars & Bookings mirroring ---
export async function mirrorCarToMongo(carRow) {
  const db = await getMongoDb();
  if (!db || !carRow?.id) return { ok: false, skipped: true };
  try {
    const cars = db.collection('cars');
    const doc = {
      sqliteId: Number(carRow.id),
      name: carRow.name,
      type: carRow.type || null,
      fuel: carRow.fuel || null,
      transmission: carRow.transmission || null,
      pricePerDay: Number(carRow.price_per_day ?? carRow.pricePerDay ?? 0),
      rating: Number(carRow.rating ?? 0),
      seats: carRow.seats != null ? Number(carRow.seats) : null,
      image: carRow.image || null,
      city: carRow.city || null,
      brand: carRow.brand || null,
      description: carRow.description || null,
      available: !!(carRow.available ?? (carRow.available === 1)),
      hostId: carRow.host_id ?? carRow.hostId ?? null,
      deleted: !!(carRow.deleted ?? 0),
      createdAt: carRow.created_at || null,
      updatedAt: new Date().toISOString(),
    };
    await cars.updateOne({ sqliteId: doc.sqliteId }, { $set: doc }, { upsert: true });
    return { ok: true };
  } catch (e) {
    console.warn('[mongo] mirror car failed:', e?.message || e);
    return { ok: false, error: e?.message || 'mongo_write_failed' };
  }
}

export async function deleteCarFromMongo(sqliteId) {
  const db = await getMongoDb();
  if (!db) return { ok: false, skipped: true };
  try {
    await db.collection('cars').deleteOne({ sqliteId: Number(sqliteId) });
    return { ok: true };
  } catch (e) {
    console.warn('[mongo] delete car failed:', e?.message || e);
    return { ok: false };
  }
}

export async function mirrorBookingToMongo(bookingRow) {
  const db = await getMongoDb();
  if (!db || !bookingRow?.id) return { ok: false, skipped: true };
  try {
    const bookings = db.collection('bookings');
    const doc = {
      sqliteId: Number(bookingRow.id),
      userId: Number(bookingRow.user_id ?? bookingRow.userId),
      carId: Number(bookingRow.car_id ?? bookingRow.carId),
      pickupDate: bookingRow.pickup_date ?? bookingRow.pickupDate ?? null,
      returnDate: bookingRow.return_date ?? bookingRow.returnDate ?? null,
      pickupLocation: bookingRow.pickup_location ?? bookingRow.pickupLocation ?? null,
      returnLocation: bookingRow.return_location ?? bookingRow.returnLocation ?? null,
      verification: bookingRow.verification_json ? JSON.parse(bookingRow.verification_json) : (bookingRow.verification ?? null),
      totalCost: bookingRow.total_cost != null ? Number(bookingRow.total_cost) : (bookingRow.totalCost != null ? Number(bookingRow.totalCost) : null),
      days: bookingRow.days != null ? Number(bookingRow.days) : null,
      status: bookingRow.status || 'confirmed',
      payment: (bookingRow.payment_id || bookingRow.payment_method || bookingRow.payment_status)
        ? { id: bookingRow.payment_id || null, method: bookingRow.payment_method || null, status: bookingRow.payment_status || null }
        : (bookingRow.payment || null),
      createdAt: bookingRow.created_at || null,
      updatedAt: new Date().toISOString(),
    };
    await bookings.updateOne({ sqliteId: doc.sqliteId }, { $set: doc }, { upsert: true });
    return { ok: true };
  } catch (e) {
    console.warn('[mongo] mirror booking failed:', e?.message || e);
    return { ok: false };
  }
}

export async function deleteBookingFromMongo(sqliteId) {
  const db = await getMongoDb();
  if (!db) return { ok: false, skipped: true };
  try {
    await db.collection('bookings').deleteOne({ sqliteId: Number(sqliteId) });
    await db.collection('attachments').deleteMany({ bookingSqliteId: Number(sqliteId) });
    return { ok: true };
  } catch (e) {
    console.warn('[mongo] delete booking failed:', e?.message || e);
    return { ok: false };
  }
}
