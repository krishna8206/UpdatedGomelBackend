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
  try {
    const mdb = await getMongoDb();
    
    // Try MongoDB first if available
    if (mdb) {
      try {
        const docs = await mdb.collection('cars')
          .aggregate([
            {
              $match: {
                $or: [
                  { deleted: { $exists: false } },
                  { deleted: false }
                ]
              }
            },
            {
              $lookup: {
                from: 'users',
                localField: 'hostId',
                foreignField: 'sqliteId',
                as: 'host'
              }
            },
            { $unwind: { path: '$host', preserveNullAndEmptyArrays: true } },
            { $sort: { _id: -1 } }
          ])
          .toArray();

        console.log(`Found ${docs.length} cars in MongoDB`);
        
        const list = docs.map(d => ({
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
          host: d.host && d.host.length > 0 ? {
            id: d.host[0]?.sqliteId || d.hostId,
            name: d.host[0]?.fullName || '',
            email: d.host[0]?.email || '',
            mobile: d.host[0]?.mobile || ''
          } : null,
          createdAt: d.createdAt || null,
        }));
        
        console.log('Returning cars from MongoDB');
        return res.json(list.map(c => normalizeImage(req, c)));
        
      } catch (mongoError) {
        console.error('Error fetching from MongoDB, falling back to SQLite:', mongoError);
        // Fall through to SQLite
      }
    }
    
    // Fallback to SQLite if MongoDB is not available or fails
    console.log('Falling back to SQLite...');
    const rows = db.prepare(`
      SELECT c.*, u.email AS host_email, u.full_name AS host_name, u.mobile AS host_mobile
      FROM cars c
      LEFT JOIN users u ON u.id = c.host_id
      WHERE (c.deleted IS NULL OR c.deleted = 0)
      ORDER BY c.id DESC
    `).all();
    
    console.log(`Found ${rows.length} cars in SQLite`);
    
    const list = rows.map(row => {
      const car = toCar(row);
      if (row.host_email) {
        car.host = {
          id: row.host_id,
          name: row.host_name,
          email: row.host_email,
          mobile: row.host_mobile
        };
      }
      return car;
    });
    
    console.log('Returning cars from SQLite');
    return res.json(list.map(c => normalizeImage(req, c)));
    
  } catch (error) {
    console.error('Error in / endpoint:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch cars',
      message: error.message 
    });
  }
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
  try {
    const mdb = await getMongoDb();
    if (mdb) {
      const cars = await mdb.collection('cars')
        .find({})
        .sort({ _id: -1 })
        .toArray();
      return res.json(cars.map(c => normalizeImage(req, c)));
    }
    // Fallback to SQLite
    const rows = db.prepare(`
      SELECT c.*, u.email AS host_email, u.full_name AS host_name, u.mobile AS host_mobile
      FROM cars c
      LEFT JOIN users u ON u.id = c.host_id
      WHERE c.deleted = 0 OR c.deleted IS NULL
      ORDER BY c.id DESC
    `).all();
    return res.json(rows.map(r => normalizeImage(req, toCarWithHost(r))));
  } catch (error) {
    console.error('Error in /admin endpoint:', error);
    return res.status(500).json({ error: 'Failed to fetch admin car list' });
  }
});

// Get cars for the logged-in user
router.get('/mine', requireAuth, async (req, res) => {
  try {
    console.log('Fetching cars for user:', req.user.id);
    const mdb = await getMongoDb();
    
    if (mdb) {
      console.log('Using MongoDB to fetch cars');
      try {
        // First try to get from MongoDB with host info
        const docs = await mdb
          .collection('cars')
          .aggregate([
            { 
              $match: { 
                hostId: req.user.id,
                $or: [
                  { deleted: { $exists: false } },
                  { deleted: false }
                ]
              }
            },
            {
              $lookup: {
                from: 'users',
                localField: 'hostId',
                foreignField: 'sqliteId',
                as: 'host'
              }
            },
            { $unwind: { path: '$host', preserveNullAndEmptyArrays: true } },
            { $sort: { _id: -1 } }
          ])
          .toArray();

        console.log(`Found ${docs.length} cars in MongoDB for user ${req.user.id}`);
        
        const list = docs.map(d => ({
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
        }));
        
        return res.json(list.map(c => normalizeImage(req, c)));
        
      } catch (mongoError) {
        console.error('Error fetching from MongoDB, falling back to SQLite:', mongoError);
        // Fall through to SQLite
      }
    }
    
    // Fallback to SQLite if MongoDB is not available or fails
    console.log('Falling back to SQLite for user cars...');
    const rows = db.prepare(`
      SELECT c.*, u.email AS host_email, u.full_name AS host_name, u.mobile AS host_mobile
      FROM cars c
      LEFT JOIN users u ON u.id = c.host_id
      WHERE (c.deleted IS NULL OR c.deleted = 0) AND c.host_id = ?
      ORDER BY c.id DESC
    `).all(req.user.id);
    
    console.log(`Found ${rows.length} cars in SQLite for user ${req.user.id}`);
    
    const list = rows.map(row => {
      const car = toCar(row);
      if (row.host_email) {
        car.host = {
          id: row.host_id,
          name: row.host_name,
          email: row.host_email,
          mobile: row.host_mobile
        };
      }
      return car;
    });
    
    return res.json(list.map(c => normalizeImage(req, c)));
    
  } catch (error) {
    console.error('Error in /mine endpoint:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch your cars',
      message: error.message 
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const mdb = await getMongoDb();
    
    // Try MongoDB first if available
    if (mdb) {
      try {
        // Get car with host information using aggregation
        const result = await mdb.collection('cars').aggregate([
          {
            $match: { 
              sqliteId: Number(req.params.id),
              $or: [ 
                { deleted: { $exists: false } }, 
                { deleted: false } 
              ] 
            }
          },
          {
            $lookup: {
              from: 'users',
              localField: 'hostId',
              foreignField: 'sqliteId',
              as: 'host'
            }
          },
          { $unwind: { path: '$host', preserveNullAndEmptyArrays: true } }
        ]).toArray();
        
        if (result.length > 0) {
          const d = result[0];
          const car = {
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
            host: d.host ? {
              id: d.host.sqliteId,
              name: d.host.fullName,
              email: d.host.email,
              mobile: d.host.mobile
            } : null,
            createdAt: d.createdAt || null,
          };
          
          return res.json(normalizeImage(req, car));
        }
        // If no result in MongoDB, fall through to SQLite
      } catch (mongoError) {
        console.error('Error fetching from MongoDB, falling back to SQLite:', mongoError);
        // Fall through to SQLite
      }
    }
    
    // Fallback to SQLite if MongoDB is not available or fails
    const query = `
      SELECT c.*, u.email as host_email, u.full_name as host_name, u.mobile as host_mobile
      FROM cars c
      LEFT JOIN users u ON c.host_id = u.id
      WHERE (c.deleted IS NULL OR c.deleted = 0) 
      AND c.id = ?
    `;
    
    const row = db.prepare(query).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Car not found' });
    
    const car = toCar(row);
    if (row.host_email) {
      car.host = {
        id: row.host_id,
        name: row.host_name,
        email: row.host_email,
        mobile: row.host_mobile
      };
    }
    
    return res.json(normalizeImage(req, car));
    
  } catch (error) {
    console.error('Error in /:id endpoint:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch car details',
      message: error.message 
    });
  }
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
  [
    body('name').isString().notEmpty().withMessage('Car name is required'),
    body('pricePerDay').isInt({ min: 0 }).withMessage('Price per day must be a positive number'),
    body('type').optional().isString(),
    body('fuel').optional().isString(),
    body('transmission').optional().isString(),
    body('seats').optional().isInt({ min: 1 }).withMessage('Seats must be at least 1'),
    body('city').optional().isString(),
    body('brand').optional().isString(),
    body('description').optional().isString(),
  ],
  // Add MongoDB connection check middleware
  async (req, res, next) => {
    if (process.env.MONGODB_URI) {
      const mdb = await getMongoDb();
      if (!mdb) {
        console.warn('MongoDB connection not available, falling back to SQLite only');
      }
    }
    next();
  },
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

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

    try {
      const now = new Date().toISOString();
      
      // Start a database transaction to ensure data consistency
      await db.exec('BEGIN TRANSACTION');
      
      try {
        // Insert into SQLite
        const stmt = db.prepare(
          `INSERT INTO cars (
            name, type, fuel, transmission, price_per_day, 
            rating, seats, image, city, brand, 
            description, available, host_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        
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
          req.user.id,
          now
        );

        const carId = info.lastInsertRowid;
        
        // Handle image upload if provided
        let imagePath = image || null;
        if (imageData && typeof imageData === 'string' && imageData.startsWith('data:')) {
          try {
            const carsDir = path.join(__dirname, '../../uploads/cars');
            ensureDir(carsDir);
            const targetPath = path.join(carsDir, `${carId}.png`);
            const saved = saveDataUrl(imageData, targetPath);
            if (saved) {
              const rel = path
                .relative(path.join(__dirname, '../../'), saved)
                .replace(/\\/g, '/');
              db.prepare('UPDATE cars SET image = ? WHERE id = ?').run(rel, carId);
              imagePath = rel;
            }
          } catch (error) {
            console.error('Error saving car image:', error);
            // Continue without image if there's an error
          }
        }

        // Get the complete car data
        const row = db.prepare('SELECT * FROM cars WHERE id = ?').get(carId);
        
        // Mirror to MongoDB if available
        console.log('MongoDB URI:', process.env.MONGODB_URI ? 'Set' : 'Not set');
        if (process.env.MONGODB_URI) {
          try {
            console.log('Attempting to get MongoDB connection...');
            const mdb = await getMongoDb();
            console.log('MongoDB connection result:', mdb ? 'Success' : 'Failed');
            
            if (mdb) {
              const carDoc = {
                sqliteId: carId,
                name: name || null,
                type: type || null,
                fuel: fuel || null,
                transmission: transmission || null,
                pricePerDay: Number(pricePerDay) || 0,
                rating: Number(rating) || 0,
                seats: Number(seats) || 4,
                image: imagePath || null,
                city: city || null,
                brand: brand || null,
                description: description || null,
                available: Boolean(available),
                hostId: req.user.id,
                createdAt: new Date(now),
                updatedAt: new Date(),
                deleted: false
              };
              
              console.log('Saving car to MongoDB:', {
                collection: 'cars',
                document: carDoc
              });
              
              const result = await mdb.collection('cars').insertOne(carDoc);
              console.log('Car saved to MongoDB:', { 
                insertedId: result.insertedId,
                carId,
                name,
                hostId: req.user.id,
                collection: 'cars',
                database: mdb.databaseName
              });
              
              // Verify the document was saved
              const savedDoc = await mdb.collection('cars').findOne({ _id: result.insertedId });
              console.log('Verification - Found document in MongoDB:', savedDoc ? 'Yes' : 'No');
              
            } else {
              console.warn('MongoDB connection not available during car creation');
              console.warn('Check if MongoDB is running and MONGODB_URI is correctly set in .env');
            }
          } catch (mongoError) {
            console.error('Error saving car to MongoDB:', {
              error: mongoError.message,
              stack: mongoError.stack,
              carId,
              name,
              hostId: req.user.id
            });
            // Don't fail the request if MongoDB save fails
          }
        } else {
          console.warn('MONGODB_URI not set, skipping MongoDB save');
        }

        // Commit the transaction
        await db.exec('COMMIT');
        
        // Return the created car
        const car = toCar(row);
        return res.status(201).json(normalizeImage(req, car));
        
      } catch (error) {
        // Rollback the transaction on error
        await db.exec('ROLLBACK');
        throw error;
      }
      
    } catch (error) {
      console.error('Error creating car listing:', error);
      return res.status(500).json({ 
        error: 'Failed to create car listing',
        message: error.message 
      });
    }
  }
);

router.put(
  '/:id',
  requireAuth, // Changed from requireAdmin to requireAuth since hosts should be able to update their own cars
  [
    body('name').optional().isString().notEmpty(),
    body('pricePerDay').optional().isInt({ min: 0 }),
    body('type').optional().isString(),
    body('fuel').optional().isString(),
    body('transmission').optional().isString(),
    body('seats').optional().isInt({ min: 1 }),
    body('city').optional().isString(),
    body('brand').optional().isString(),
    body('description').optional().isString(),
    body('available').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const carId = req.params.id;
    const row = db.prepare('SELECT * FROM cars WHERE id = ?').get(carId);
    if (!row) return res.status(404).json({ error: 'Car not found' });
    
    // Check if the user is the owner of the car or an admin
    if (row.host_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to update this car' });
    }

    const payload = req.body || {};
    const now = new Date().toISOString();
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
      available: payload.available !== undefined ? (payload.available ? 1 : 0) : row.available,
      updated_at: now,
    };

    try {
      // Update SQLite
      const stmt = db.prepare(
        'UPDATE cars SET name = ?, type = ?, fuel = ?, transmission = ?, price_per_day = ?, rating = ?, seats = ?, image = ?, city = ?, brand = ?, description = ?, available = ?, updated_at = ? WHERE id = ?'
      );
      stmt.run(
        updated.name,
        updated.type,
        updated.fuel,
        updated.transmission,
        updated.price_per_day,
        updated.rating,
        updated.seats,
        updated.image,
        updated.city,
        updated.brand,
        updated.description,
        updated.available,
        updated.updated_at,
        carId
      );

      // Get the updated row
      const updatedRow = db.prepare('SELECT * FROM cars WHERE id = ?').get(carId);

      // Update MongoDB if available
      if (process.env.MONGODB_URI) {
        try {
          const mdb = await getMongoDb();
          if (mdb) {
            const updateDoc = {
              $set: {
                name: updated.name,
                type: updated.type,
                fuel: updated.fuel,
                transmission: updated.transmission,
                pricePerDay: updated.price_per_day,
                rating: updated.rating,
                seats: updated.seats,
                image: updated.image,
                city: updated.city,
                brand: updated.brand,
                description: updated.description,
                available: updated.available === 1,
                updatedAt: new Date(now)
              }
            };
            
            await mdb.collection('cars').updateOne(
              { sqliteId: parseInt(carId) },
              updateDoc
            );
          }
        } catch (mongoError) {
          console.error('Error updating car in MongoDB:', mongoError);
          // Don't fail the request if MongoDB update fails
        }
      }

      return res.json(normalizeImage(req, toCar(updatedRow)));
      
    } catch (error) {
      console.error('Error updating car:', error);
      return res.status(500).json({ error: 'Failed to update car' });
    }
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
  try { 
    await mirrorCarToMongo({ ...row, deleted: 1 }); 
  } catch (error) {
    console.error('Error deleting car:', error);
    return res.status(500).json({ 
      error: 'Failed to delete car',
      message: error.message 
    });
  }
  return res.json({ ok: true, softDeleted: true });
});

export default router;
