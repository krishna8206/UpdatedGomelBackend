import db from '../db/index.js';

// Add host_id column to cars table
const migrate = () => {
  try {
    // Start transaction
    db.exec('BEGIN TRANSACTION');

    // Add host_id column if it doesn't exist
    try {
      db.prepare('ALTER TABLE cars ADD COLUMN host_id INTEGER REFERENCES users(id)').run();
      console.log('Added host_id column to cars table');
    } catch (e) {
      if (!e.message.includes('duplicate column name')) {
        throw e;
      }
      console.log('host_id column already exists');
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
