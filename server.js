require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ===== ADMIN AUTH =====
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const adminTokens = new Set();

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, error: 'Sai mat khau' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) adminTokens.delete(token);
  res.json({ success: true });
});

function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ success: false, error: 'Chua dang nhap' });
  }
  next();
}

app.use('/api/admin', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  requireAdmin(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

// ===== HELPERS =====
function vnToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function vnMonthRange() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    start: first.toLocaleDateString('en-CA'),
    end: last.toLocaleDateString('en-CA')
  };
}

// ===== DATABASE (PostgreSQL) =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    strava_username TEXT,
    pin TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )`);

  // Add pin column if missing
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin TEXT`);

  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    athlete_id TEXT UNIQUE,
    name TEXT,
    email TEXT,
    access_token TEXT,
    refresh_token TEXT,
    employee_id INTEGER
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS runs (
    id SERIAL PRIMARY KEY,
    athlete_id TEXT,
    name TEXT,
    distance REAL,
    date TEXT,
    proof TEXT
  )`);

  console.log('Database tables ready');
}

// ===== DASHBOARD API =====
app.get('/api/today', async (req, res) => {
  try {
    const today = vnToday();
    const { rows } = await pool.query(
      `SELECT e.name, COALESCE(SUM(r.distance), 0)::float as total
       FROM employees e
       LEFT JOIN users u ON u.employee_id = e.id
       LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id) AND r.date = $1
       GROUP BY e.id, e.name
       ORDER BY total DESC`, [today]
    );
    res.json(rows);
  } catch (err) { res.json([]); }
});

app.get('/api/month', async (req, res) => {
  try {
    const { start, end } = vnMonthRange();
    const { rows } = await pool.query(
      `SELECT e.name, COALESCE(SUM(r.distance), 0)::float as total
       FROM employees e
       LEFT JOIN users u ON u.employee_id = e.id
       LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id)
         AND r.date >= $1 AND r.date <= $2
       GROUP BY e.id, e.name
       ORDER BY total DESC`, [start, end]
    );
    res.json(rows);
  } catch (err) { res.json([]); }
});

app.get('/api/members', async (req, res) => {
  try {
    const today = vnToday();
    const { rows } = await pool.query(
      `SELECT e.id, e.name, COALESCE(SUM(r.distance), 0)::float as total,
         CASE WHEN u.id IS NOT NULL THEN 1 ELSE 0 END as strava_connected
       FROM employees e
       LEFT JOIN users u ON u.employee_id = e.id
       LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id) AND r.date = $1
       GROUP BY e.id, e.name, u.id
       ORDER BY total DESC`, [today]
    );
    res.json(rows);
  } catch (err) { res.json([]); }
});

// ===== ADMIN API =====
app.get('/api/admin/employees', async (req, res) => {
  try {
    const today = vnToday();
    const { rows } = await pool.query(
      `SELECT e.id, e.name, e.email, e.strava_username,
         CASE WHEN u.id IS NOT NULL THEN 1 ELSE 0 END as strava_connected,
         u.athlete_id as linked_athlete_id,
         COALESCE(r_today.today_km, 0)::float as today_km
       FROM employees e
       LEFT JOIN users u ON u.employee_id = e.id
       LEFT JOIN (
         SELECT athlete_id, SUM(distance) as today_km
         FROM runs WHERE date = $1
         GROUP BY athlete_id
       ) r_today ON u.athlete_id = r_today.athlete_id OR r_today.athlete_id = 'manual_' || e.id
       GROUP BY e.id, e.name, e.email, e.strava_username, u.id, u.athlete_id, r_today.today_km
       ORDER BY e.id`, [today]
    );
    res.json(rows);
  } catch (err) { res.json([]); }
});

app.post('/api/admin/employees', async (req, res) => {
  const { name, email, strava_username } = req.body;
  if (!name || !name.trim()) return res.json({ success: false, error: 'Thieu ten nhan vien' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO employees (name, email, strava_username) VALUES ($1, $2, $3) RETURNING id',
      [name.trim(), email || null, strava_username || null]
    );
    res.json({ success: true, id: rows[0].id });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.patch('/api/admin/employees/:id', async (req, res) => {
  const { name, email, strava_username } = req.body;
  try {
    const { rowCount } = await pool.query(
      'UPDATE employees SET name = $1, email = $2, strava_username = $3 WHERE id = $4',
      [name ? name.trim() : null, email ? email.trim() : null, strava_username ? strava_username.trim() : null, req.params.id]
    );
    if (rowCount === 0) return res.json({ success: false, error: 'Khong tim thay nhan vien' });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.delete('/api/admin/employees/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM employees WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// Admin: view runs detail with proof
app.get('/api/admin/runs', async (req, res) => {
  try {
    const date = req.query.date || vnToday();
    const { rows } = await pool.query(
      `SELECT r.id, r.athlete_id, r.name, r.distance::float, r.date, r.proof,
         e.id as employee_id, e.name as employee_name
       FROM runs r
       LEFT JOIN employees e ON r.athlete_id = 'manual_' || e.id
       WHERE r.date = $1
       ORDER BY r.id DESC`, [date]
    );
    res.json(rows);
  } catch (err) { res.json([]); }
});

// Admin: delete a run
app.delete('/api/admin/runs/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM runs WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// Admin: edit a run distance
app.patch('/api/admin/runs/:id', async (req, res) => {
  const { distance } = req.body;
  if (!distance || distance <= 0) return res.json({ success: false, error: 'KM khong hop le' });
  try {
    await pool.query('UPDATE runs SET distance = $1 WHERE id = $2', [distance, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.get('/api/admin/report', async (req, res) => {
  try {
    const { start, end } = vnMonthRange();
    const { rows } = await pool.query(
      `SELECT e.name,
         COALESCE(SUM(r.distance), 0)::float as total_km,
         COUNT(DISTINCT r.date)::int as run_days
       FROM employees e
       LEFT JOIN users u ON u.employee_id = e.id
       LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id)
         AND r.date >= $1 AND r.date <= $2
       GROUP BY e.id, e.name
       ORDER BY total_km DESC`, [start, end]
    );
    res.json(rows);
  } catch (err) { res.json([]); }
});

// Admin: reset PIN
app.patch('/api/admin/employees/:id/pin', async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4}$/.test(pin)) return res.json({ success: false, error: 'PIN phai la 4 chu so' });
  try {
    await pool.query('UPDATE employees SET pin = $1 WHERE id = $2', [pin, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.post('/api/admin/sync', async (req, res) => {
  try { await fetchAllUsers(); res.json({ success: true }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

// ===== EMPLOYEE SELF-REGISTER =====
app.post('/api/register', async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !name.trim()) return res.json({ success: false, error: 'Vui long nhap ten' });
  if (!pin || !/^\d{4}$/.test(pin)) return res.json({ success: false, error: 'PIN phai la 4 chu so' });
  const trimmed = name.trim();
  try {
    const { rows: existing } = await pool.query('SELECT id FROM employees WHERE LOWER(name) = LOWER($1)', [trimmed]);
    if (existing.length > 0) {
      return res.json({ success: true, id: existing[0].id, message: 'Ten da ton tai' });
    }
    const { rows } = await pool.query('INSERT INTO employees (name, pin) VALUES ($1, $2) RETURNING id', [trimmed, pin]);
    res.json({ success: true, id: rows[0].id });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ===== SET PIN (for existing employees without PIN) =====
app.post('/api/set-pin', async (req, res) => {
  const { employee_id, pin } = req.body;
  if (!employee_id) return res.json({ success: false, error: 'Thieu employee_id' });
  if (!pin || !/^\d{4}$/.test(pin)) return res.json({ success: false, error: 'PIN phai la 4 chu so' });
  try {
    const { rows } = await pool.query('SELECT id, pin FROM employees WHERE id = $1', [employee_id]);
    if (rows.length === 0) return res.json({ success: false, error: 'Khong tim thay nhan vien' });
    if (rows[0].pin) return res.json({ success: false, error: 'Ban da co PIN roi. Lien he admin neu quen.' });
    await pool.query('UPDATE employees SET pin = $1 WHERE id = $2', [pin, employee_id]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// ===== SUBMIT RUN (manual) =====
app.post('/api/submit-run', async (req, res) => {
  const { employee_id, distance, proof, pin } = req.body;
  if (!employee_id || !distance || distance <= 0) {
    return res.json({ success: false, error: 'Du lieu khong hop le' });
  }
  if (!pin) return res.json({ success: false, error: 'Vui long nhap ma PIN' });
  try {
    const { rows } = await pool.query('SELECT id, name, pin FROM employees WHERE id = $1', [employee_id]);
    if (rows.length === 0) return res.json({ success: false, error: 'Khong tim thay nhan vien' });
    const emp = rows[0];
    if (!emp.pin) return res.json({ success: false, error: 'NO_PIN', message: 'Ban chua co PIN. Vui long tao PIN truoc.' });
    if (emp.pin !== pin) return res.json({ success: false, error: 'Sai ma PIN' });
    const today = vnToday();
    await pool.query(
      'INSERT INTO runs (athlete_id, name, distance, date, proof) VALUES ($1, $2, $3, $4, $5)',
      ['manual_' + emp.id, emp.name, distance, today, proof || null]
    );
    res.json({ success: true });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.get('/api/my-runs/:empId', async (req, res) => {
  try {
    const today = vnToday();
    const { rows } = await pool.query(
      'SELECT distance, proof FROM runs WHERE athlete_id = $1 AND date = $2',
      ['manual_' + req.params.empId, today]
    );
    res.json(rows);
  } catch (err) { res.json([]); }
});

// ===== EMPLOYEE LIST (for connect/register page) =====
app.get('/api/employees-list', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.name,
         CASE WHEN u.id IS NOT NULL THEN 1 ELSE 0 END as strava_connected
       FROM employees e
       LEFT JOIN users u ON u.employee_id = e.id
       GROUP BY e.id, e.name, u.id
       ORDER BY e.name`
    );
    res.json(rows);
  } catch (err) { res.json([]); }
});

// ===== STRAVA AUTH =====
app.get('/auth/login', (req, res) => {
  const employeeId = req.query.employee_id || '';
  const state = employeeId ? encodeURIComponent(employeeId) : '';
  const redirectUri = encodeURIComponent(process.env.STRAVA_REDIRECT_URI);
  const url = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&approval_prompt=auto&scope=activity:read_all&state=${state}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  const employeeId = req.query.state ? decodeURIComponent(req.query.state) : null;

  try {
    const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });

    const { access_token, refresh_token, athlete } = tokenRes.data;
    const stravaName = athlete.username || `${athlete.firstname || ''} ${athlete.lastname || ''}`.trim();
    const athleteId = String(athlete.id);

    const { rows: existing } = await pool.query('SELECT id FROM users WHERE athlete_id = $1', [athleteId]);
    if (existing.length > 0) {
      await pool.query(
        'UPDATE users SET name = $1, access_token = $2, refresh_token = $3, employee_id = COALESCE($4, employee_id) WHERE athlete_id = $5',
        [stravaName, access_token, refresh_token, employeeId, athleteId]
      );
    } else {
      await pool.query(
        'INSERT INTO users (athlete_id, name, access_token, refresh_token, employee_id) VALUES ($1, $2, $3, $4, $5)',
        [athleteId, stravaName, access_token, refresh_token, employeeId]
      );
    }

    if (employeeId) {
      await pool.query('UPDATE employees SET strava_username = $1 WHERE id = $2', [stravaName, employeeId]);
    }

    let empName = null;
    if (employeeId) {
      const { rows } = await pool.query('SELECT name FROM employees WHERE id = $1', [employeeId]);
      if (rows.length > 0) empName = rows[0].name;
    }

    const esc = s => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
      <style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
      .card{background:#1e293b;border-radius:16px;padding:32px;max-width:400px;text-align:center;}
      .icon{font-size:48px;margin-bottom:16px;}h2{color:#4ade80;margin-bottom:12px;}
      p{color:#94a3b8;margin:8px 0;font-size:14px;}strong{color:#e2e8f0;}
      a{display:inline-block;margin-top:16px;padding:12px 24px;background:#38bdf8;color:#0f172a;text-decoration:none;border-radius:10px;font-weight:600;}</style></head>
      <body><div class="card">
      <div class="icon">&#9989;</div>
      <h2>Ket noi thanh cong!</h2>
      ${empName ? `<p>Nhan vien: <strong>${esc(empName)}</strong></p>` : ''}
      <p>Strava: <strong>${esc(stravaName)}</strong></p>
      <p>Du lieu chay cua ban se duoc tu dong dong bo.</p>
      <a href="/">Ve trang chu</a>
      </div></body></html>`);
  } catch (err) {
    console.error(err.message);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
      <style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
      .card{background:#1e293b;border-radius:16px;padding:32px;max-width:400px;text-align:center;}
      .icon{font-size:48px;margin-bottom:16px;}h2{color:#f87171;margin-bottom:12px;}
      p{color:#94a3b8;font-size:14px;}a{color:#38bdf8;}</style></head>
      <body><div class="card"><div class="icon">&#10060;</div><h2>Loi ket noi Strava</h2><p>Vui long thu lai.</p>
      <a href="/connect.html">Quay lai</a></div></body></html>`);
  }
});

// ===== TOKEN REFRESH =====
async function refreshAccessToken(user) {
  try {
    const r = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.refresh_token,
    });
    const { access_token, refresh_token } = r.data;
    await pool.query('UPDATE users SET access_token = $1, refresh_token = $2 WHERE id = $3',
      [access_token, refresh_token, user.id]);
    return access_token;
  } catch (err) {
    console.error('Refresh token failed for', user.name);
    return null;
  }
}

// ===== FETCH ALL USERS DATA =====
async function fetchAllUsers() {
  const { rows: users } = await pool.query('SELECT * FROM users WHERE access_token IS NOT NULL');
  if (!users.length) return;

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  for (const user of users) {
    try {
      let token = user.access_token;
      let apiRes;
      try {
        apiRes = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (apiErr) {
        token = await refreshAccessToken(user);
        if (!token) continue;
        apiRes = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
          headers: { Authorization: `Bearer ${token}` },
        });
      }

      const runs = apiRes.data.filter((a) => {
        if (a.type !== 'Run') return false;
        const d = new Date(a.start_date);
        return d >= sevenDaysAgo && d <= now;
      });

      for (const run of runs) {
        const km = run.distance / 1000;
        const runDate = new Date(run.start_date).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

        const { rows: existing } = await pool.query(
          'SELECT id FROM runs WHERE athlete_id = $1 AND date = $2 AND ABS(distance - $3) < 0.01',
          [user.athlete_id, runDate, km]
        );
        if (existing.length === 0) {
          await pool.query(
            'INSERT INTO runs (athlete_id, name, distance, date) VALUES ($1, $2, $3, $4)',
            [user.athlete_id, user.name, km, runDate]
          );
        }
      }
      console.log(`Synced ${runs.length} runs for ${user.name}`);
    } catch (userErr) {
      console.error('Error syncing user:', user.name, userErr.message);
    }
  }
}

// ===== CRON JOB - 20:00 moi ngay =====
cron.schedule('0 20 * * *', () => {
  console.log('Running daily sync...');
  fetchAllUsers();
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init database:', err.message);
  process.exit(1);
});
