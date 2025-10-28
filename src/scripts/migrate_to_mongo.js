import 'dotenv/config';
import db from '../db/index.js';
import { getMongoDb, mirrorUserToMongo, mirrorCarToMongo, mirrorBookingToMongo } from '../utils/mongo.js';

async function main() {
  const mdb = await getMongoDb();
  if (!mdb) {
    console.error('[migrate] MongoDB not configured. Set MONGODB_URI and retry.');
    process.exit(1);
  }

  // Ensure indexes for upserts by sqliteId
  await Promise.all([
    mdb.collection('users').createIndex({ email: 1 }, { unique: true }),
    mdb.collection('cars').createIndex({ sqliteId: 1 }, { unique: true }),
    mdb.collection('bookings').createIndex({ sqliteId: 1 }, { unique: true })
  ]).catch(() => {});

  // Migrate users
  const users = db.prepare('SELECT * FROM users').all();
  let usersOk = 0;
  for (const u of users) {
    try { const r = await mirrorUserToMongo(u); if (r?.ok) usersOk++; } catch {}
  }
  console.log(`[migrate] users migrated: ${usersOk}/${users.length}`);

  // Migrate cars
  const cars = db.prepare('SELECT * FROM cars').all();
  let carsOk = 0;
  for (const c of cars) {
    try { const r = await mirrorCarToMongo(c); if (r?.ok) carsOk++; } catch {}
  }
  console.log(`[migrate] cars migrated: ${carsOk}/${cars.length}`);

  // Migrate bookings
  const bookings = db.prepare('SELECT * FROM bookings').all();
  let bookingsOk = 0;
  for (const b of bookings) {
    try { const r = await mirrorBookingToMongo(b); if (r?.ok) bookingsOk++; } catch {}
  }
  console.log(`[migrate] bookings migrated: ${bookingsOk}/${bookings.length}`);

  console.log('[migrate] done');
  process.exit(0);
}

main().catch((e) => { console.error('[migrate] failed', e?.message || e); process.exit(1); });
