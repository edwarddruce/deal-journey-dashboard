import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dashboardRouter from './routes/dashboard';
import dealRouter from './routes/deal';
import reconciliationRouter from './routes/reconciliation';
import dealListRouter from './routes/dealList';
import aggregationsRouter from './routes/aggregations';
import { startLiveFeed, liveState } from './live';
import pool from './db';

const app = express();
const PORT = process.env.PORT ?? 3001;

// In production ALLOWED_ORIGIN is set to the Static Web App hostname.
// Locally it falls back to the Vite dev server.
const allowedOrigin = process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173';
app.use(cors({ origin: allowedOrigin, credentials: false }));
app.use(express.json());

app.use('/api/dashboard', dashboardRouter);
app.use('/api/deal', dealRouter);
app.use('/api/reconciliation', reconciliationRouter);
app.use('/api/deals/list', dealListRouter);
app.use('/api/aggregations', aggregationsRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Live feed control
app.get('/api/live', (_req, res) => res.json({ paused: liveState.paused }));
app.post('/api/live/pause',  (_req, res) => { liveState.paused = true;  res.json({ paused: true  }); });
app.post('/api/live/resume', (_req, res) => { liveState.paused = false; res.json({ paused: false }); });

// Serve React SPA in production (must be after all API routes)
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  // SPA fallback — all non-API routes return index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

app.listen(PORT, async () => {
  console.log(`Deal Journey API listening on http://localhost:${PORT}`);

  // Apply schema (idempotent — all statements use IF NOT EXISTS)
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    try {
      await pool.query(fs.readFileSync(schemaPath, 'utf-8'));
      console.log('[db] schema applied');
    } catch (err) {
      console.error('[db] schema migration failed:', err);
    }
  }

  startLiveFeed().catch((err) => console.error('[live] failed to start:', err));
});
