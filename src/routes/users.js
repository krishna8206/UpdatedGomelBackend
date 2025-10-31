import express from 'express';
import db from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { getMongoDb } from '../utils/mongo.js';

const router = express.Router();

function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    mobile: row.mobile,
    role: row.role || 'user',
    isActive: row.is_active !== 0,
    createdAt: row.created_at,
  };
}

// List users with aggregates for admin
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { role } = req.query;
    let query = `
      SELECT u.*, 
             COUNT(b.id) AS booking_count,
             COALESCE(SUM(b.total_cost), 0) AS total_spent
      FROM users u
      LEFT JOIN bookings b ON b.user_id = u.id
    `;
    
    if (role) {
      query += ` WHERE u.role = ?`;
    }
    
    query += ` GROUP BY u.id ORDER BY u.id DESC`;
    
    const rows = role 
      ? db.prepare(query).all(role)
      : db.prepare(query).all();

    // For MongoDB integration
    const mdb = await getMongoDb();
    if (mdb) {
      const hosts = await mdb.collection('users').find({
        role: role || { $exists: true },
        $or: [
          { deleted: { $exists: false } },
          { deleted: false }
        ]
      }).toArray();
      
      // Merge SQLite and MongoDB results
      const combined = [...rows];
      for (const host of hosts) {
        if (!rows.some(r => r.email === host.email)) {
          combined.push({
            id: host.sqliteId || `mongo_${host._id}`,
            email: host.email,
            full_name: host.fullName,
            mobile: host.mobile,
            role: host.role,
            is_active: host.isActive !== false ? 1 : 0,
            created_at: host.createdAt,
            booking_count: 0,
            total_spent: 0
          });
        }
      }
      
      return res.json(combined.map(r => ({
        ...toUser(r),
        bookingCount: Number(r.booking_count) || 0,
        totalSpent: Number(r.total_spent) || 0,
      })));
    }

    return res.json(rows.map(r => ({
      ...toUser(r),
      bookingCount: Number(r.booking_count) || 0,
      totalSpent: Number(r.total_spent) || 0,
    })));
  } catch (error) {
    console.error('Error fetching users:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create a new user (admin only)
router.post(
  '/',
  requireAdmin,
  [
    body('email').isEmail().normalizeEmail(),
    body('fullName').trim().notEmpty(),
    body('mobile').optional().trim(),
    body('password').isLength({ min: 6 }),
    body('role').optional().isIn(['user', 'host', 'admin']),
    body('isActive').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, fullName, mobile, password, role = 'user', isActive = true } = req.body;
      
      // Check if user already exists
      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existingUser) {
        return res.status(400).json({ error: 'User with this email already exists' });
      }

      // Hash password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      // Insert into SQLite
      const result = db.prepare(`
        INSERT INTO users (email, full_name, mobile, password_hash, role, is_active)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(email, fullName, mobile, hashedPassword, role, isActive ? 1 : 0);

      const newUser = {
        id: result.lastInsertRowid,
        email,
        fullName,
        mobile,
        role,
        isActive,
        createdAt: new Date().toISOString()
      };

      // Sync to MongoDB if available
      const mdb = await getMongoDb();
      if (mdb) {
        await mdb.collection('users').insertOne({
          sqliteId: result.lastInsertRowid,
          email,
          fullName,
          mobile,
          role,
          isActive,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }

      return res.status(201).json({ user: newUser });
    } catch (error) {
      console.error('Error creating user:', error);
      return res.status(500).json({ error: 'Failed to create user' });
    }
  }
);

// Get single user with details and recent bookings/messages
router.get('/:id', requireAdmin, async (req, res) => {
  try {
    let user;
    
    // Check if it's a MongoDB ID
    if (req.params.id.startsWith('mongo_')) {
      const mdb = await getMongoDb();
      if (mdb) {
        const mongoId = req.params.id.replace('mongo_', '');
        user = await mdb.collection('users').findOne({ _id: mongoId });
        if (user) {
          user.id = `mongo_${user._id}`;
          user.full_name = user.fullName;
          user.is_active = user.isActive !== false ? 1 : 0;
          user.created_at = user.createdAt;
        }
      }
    } else {
      // Regular SQLite ID
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    }
    
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get bookings (only for SQLite users)
    const bookings = user.id.startsWith('mongo_') ? [] : db.prepare(`
      SELECT * FROM bookings WHERE user_id = ? ORDER BY id DESC LIMIT 50
    `).all(req.params.id).map(b => ({
      id: b.id,
      carId: b.car_id,
      pickupDate: b.pickup_date,
      returnDate: b.return_date,
      pickupLocation: b.pickup_location,
      returnLocation: b.return_location,
      totalCost: b.total_cost,
      days: b.days,
      status: b.status,
      payment: b.payment_id ? { 
        id: b.payment_id, 
        method: b.payment_method, 
        status: b.payment_status 
      } : null,
      createdAt: b.created_at,
    }));

    // Get messages
    const messages = db.prepare(`
      SELECT id, name, email, message, status, created_at 
      FROM messages 
      WHERE email = ? 
      ORDER BY id DESC 
      LIMIT 50
    `).all(user.email).map(m => ({
      id: m.id,
      name: m.name,
      email: m.email,
      message: m.message,
      status: m.status,
      createdAt: m.created_at,
    }));

    // Get totals (only for SQLite users)
    const totals = user.id.startsWith('mongo_') 
      ? { booking_count: 0, total_spent: 0 }
      : db.prepare(`
          SELECT COUNT(*) AS booking_count, COALESCE(SUM(total_cost), 0) AS total_spent 
          FROM bookings 
          WHERE user_id = ?
        `).get(req.params.id);

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
  } catch (error) {
    console.error('Error fetching user:', error);
    return res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// Update a user
router.put(
  '/:id',
  requireAdmin,
  [
    body('email').optional().isEmail().normalizeEmail(),
    body('fullName').optional().trim().notEmpty(),
    body('mobile').optional().trim(),
    body('role').optional().isIn(['user', 'host', 'admin']),
    body('isActive').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { id } = req.params;
      const { email, fullName, mobile, role, isActive } = req.body;
      
      // Check if user exists
      let user;
      if (id.startsWith('mongo_')) {
        const mdb = await getMongoDb();
        if (mdb) {
          const mongoId = id.replace('mongo_', '');
          user = await mdb.collection('users').findOne({ _id: mongoId });
          if (!user) {
            return res.status(404).json({ error: 'User not found' });
          }
        }
      } else {
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      }
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Update in SQLite
      if (!id.startsWith('mongo_')) {
        const updates = [];
        const params = [];
        
        if (email !== undefined) {
          // Check if email is already taken
          const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, id);
          if (existing) {
            return res.status(400).json({ error: 'Email already in use' });
          }
          updates.push('email = ?');
          params.push(email);
        }
        
        if (fullName !== undefined) {
          updates.push('full_name = ?');
          params.push(fullName);
        }
        
        if (mobile !== undefined) {
          updates.push('mobile = ?');
          params.push(mobile);
        }
        
        if (role !== undefined) {
          updates.push('role = ?');
          params.push(role);
        }
        
        if (isActive !== undefined) {
          updates.push('is_active = ?');
          params.push(isActive ? 1 : 0);
        }
        
        if (updates.length > 0) {
          const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
          db.prepare(query).run(...params, id);
        }
        
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      }

      // Update in MongoDB if available
      const mdb = await getMongoDb();
      if (mdb) {
        const updateData = {};
        
        if (email !== undefined) updateData.email = email;
        if (fullName !== undefined) updateData.fullName = fullName;
        if (mobile !== undefined) updateData.mobile = mobile;
        if (role !== undefined) updateData.role = role;
        if (isActive !== undefined) updateData.isActive = isActive;
        
        updateData.updatedAt = new Date().toISOString();
        
        if (id.startsWith('mongo_')) {
          const mongoId = id.replace('mongo_', '');
          await mdb.collection('users').updateOne(
            { _id: mongoId },
            { $set: updateData }
          );
          user = await mdb.collection('users').findOne({ _id: mongoId });
          user.id = `mongo_${user._id}`;
        } else if (user) {
          await mdb.collection('users').updateOne(
            { sqliteId: user.id },
            { $set: updateData },
            { upsert: true }
          );
        }
      }

      return res.json({ user: toUser(user) });
    } catch (error) {
      console.error('Error updating user:', error);
      return res.status(500).json({ error: 'Failed to update user' });
    }
  }
);

// Delete a user
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user exists
    let user;
    if (id.startsWith('mongo_')) {
      const mdb = await getMongoDb();
      if (mdb) {
        const mongoId = id.replace('mongo_', '');
        user = await mdb.collection('users').findOne({ _id: mongoId });
        if (user) {
          // Soft delete in MongoDB
          await mdb.collection('users').updateOne(
            { _id: mongoId },
            { $set: { 
              deleted: true,
              deletedAt: new Date().toISOString() 
            }}
          );
        }
      }
    } else {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (user) {
        // Soft delete in SQLite
        db.prepare('UPDATE users SET deleted = 1, deleted_at = ? WHERE id = ?')
          .run(new Date().toISOString(), id);
      }
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting user:', error);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

export default router;
