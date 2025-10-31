import db from '../db/index.js';

// Add role, is_active, deleted, and deleted_at columns to users table
const migrate = () => {
  try {
    // Start transaction
    db.exec('BEGIN TRANSACTION');

    // Add role column if it doesn't exist
    try {
      db.prepare('ALTER TABLE users ADD COLUMN role TEXT DEFAULT "user"').run();
      console.log('Added role column to users table');
    } catch (e) {
      if (!e.message.includes('duplicate column name')) {
        throw e;
      }
      console.log('role column already exists');
    }

    // Add is_active column if it doesn't exist
    try {
      db.prepare('ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1').run();
      console.log('Added is_active column to users table');
    } catch (e) {
      if (!e.message.includes('duplicate column name')) {
        throw e;
      }
      console.log('is_active column already exists');
    }

    // Add deleted column if it doesn't exist
    try {
      db.prepare('ALTER TABLE users ADD COLUMN deleted INTEGER DEFAULT 0').run();
      console.log('Added deleted column to users table');
    } catch (e) {
      if (!e.message.includes('duplicate column name')) {
        throw e;
      }
      console.log('deleted column already exists');
    }

    // Add deleted_at column if it doesn't exist
    try {
      db.prepare('ALTER TABLE users ADD COLUMN deleted_at TEXT').run();
      console.log('Added deleted_at column to users table');
    } catch (e) {
      if (!e.message.includes('duplicate column name')) {
        throw e;
      }
      console.log('deleted_at column already exists');
    }

    // Commit transaction
    db.exec('COMMIT');
    console.log('Migration completed successfully');
  } catch (error) {
    // Rollback on error
    db.exec('ROLLBACK');
    console.error('Migration failed:', error);
    process.exit(1);
  }
};

// Run migration
migrate();

// Close database connection
process.exit(0);
