import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import './db/migrate.js';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import carsRoutes from './routes/cars.js';
import bookingsRoutes from './routes/bookings.js';
import messagesRoutes from './routes/messages.js';
import usersRoutes from './routes/users.js';
import payoutsRoutes from './routes/payouts.js';
import { sseHandler } from './utils/events.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(helmet());
app.use(cors({ origin: '*', credentials: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Static uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/cars', carsRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/payouts', payoutsRoutes);

// Real-time events (SSE)
app.get('/api/events', sseHandler);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Debug 404 handler
app.use('/api/*', (req, res, next) => {
  console.log('404 - Route not found:', req.originalUrl);
  console.log('Method:', req.method);
  console.log('Headers:', req.headers);
  res.status(404).json({ error: 'Route not found', path: req.originalUrl });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Gomel Cars backend running on http://localhost:${PORT}`);
});
