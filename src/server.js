import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import oidc from 'express-openid-connect';
import { auth as jwtAuth, requiredScopes } from 'express-oauth2-jwt-bearer';
import pool, { initDb } from './db.js';

const { auth: oidcAuth, requiresAuth } = oidc;

const port = process.env.PORT || 3000;
const baseURL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, '');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(import.meta.dirname, '..', 'views'));
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(
  oidcAuth({
    authRequired: false,
    auth0Logout: true,
    baseURL,
    clientID: process.env.AUTH0_CLIENT_ID,
    issuerBaseURL: process.env.AUTH0_ISSUER_URL,
    secret: process.env.SESSION_SECRET,
  })
);

const checkJwt = jwtAuth({
  audience: process.env.API_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_ISSUER_URL,
});

function toJson(row) {
  return {
    id: row.id,
    name: row.name,
    document: row.document,
    issuedAt: row.issued_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    status: row.status,
  };
}

app.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active FROM passes`
    );
    const loggedIn = req.oidc.isAuthenticated();
    let passes = [];
    if (loggedIn) {
      passes = (await pool.query('SELECT * FROM passes ORDER BY issued_at DESC')).rows.map(toJson);
    }
    res.render('index', { ...rows[0], loggedIn, user: req.oidc.user, passes });
  } catch (err) {
    next(err);
  }
});

app.get('/info/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM passes WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).render('info', { pass: null });
    res.render('info', { pass: toJson(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/passes/:id/cancel', requiresAuth(), async (req, res, next) => {
  try {
    await pool.query(`UPDATE passes SET status = 'CANCELLED' WHERE id = $1`, [req.params.id]);
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/passes/:id/delete', requiresAuth(), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM passes WHERE id = $1', [req.params.id]);
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

app.get('/passes/:id', checkJwt, requiredScopes('read:passes'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM passes WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Pass not found' });
    res.json(toJson(rows[0]));
  } catch (err) {
    next(err);
  }
});

app.post('/passes', checkJwt, requiredScopes('create:passes'), async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const document = typeof req.body?.document === 'string' ? req.body.document.trim() : '';
    if (!name || !document) {
      return res.status(400).json({ error: 'name and document are required' });
    }

    const id = randomUUID();
    await pool.query('INSERT INTO passes (id, name, document) VALUES ($1, $2, $3)', [id, name, document]);

    const png = await QRCode.toBuffer(`${baseURL}/info/${id}`);
    res.status(201).location(`${baseURL}/passes/${id}`).type('image/png').send(png);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

await initDb();
app.listen(port, () => console.log(`Listening on ${baseURL}`));
