require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const routes = require('./routes');

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('DATABASE_URL and a JWT_SECRET of at least 32 characters are required.');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false });
const app = express();
app.disable('x-powered-by');
// Enable only when the service is deployed behind a trusted reverse proxy (e.g. Render).
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet());
const allowedOrigins = (process.env.APP_ORIGIN || 'http://localhost:3000').split(',').map(v => v.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => {
  // Allow non-browser clients with no Origin header; browser origins must be explicitly listed.
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin is not allowed by CORS policy.'));
}, credentials: false }));
app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
// Apply a general API ceiling plus a stricter authentication ceiling. Tune after observing real traffic.
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
// Register health before the API router so the router's auth middleware cannot intercept it.
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'mp-pharmai-api' }); }
  catch { res.status(503).json({ ok: false }); }
});
app.use('/api', routes({ pool }));
const publicDir = require('path').join(__dirname, '..', 'public');
// Client-facing medicine search is the public homepage. Staff dashboard remains at /index.html.
app.get('/', (_req, res) => res.sendFile(require('path').join(publicDir, 'clients.html')));
app.use(express.static(publicDir));
app.use((err, _req, res, _next) => {
  console.error(err.message);
  if (err.code === '23505') return res.status(409).json({ error: 'A record with those unique details already exists.' });
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Unexpected server error.' });
});
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`MP PHARMAI API listening on port ${port}`));
