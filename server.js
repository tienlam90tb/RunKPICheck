require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');

const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

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

// Protect all admin API routes (except login/logout)
app.use('/api/admin', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  requireAdmin(req, res, next);
});

// Serve static files
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

// ===== DATABASE =====
const db = new Database('./data.db');
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id TEXT,
  name TEXT,
  distance REAL,
  date TEXT,
  proof TEXT
)`);

db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id TEXT UNIQUE,
  name TEXT,
  email TEXT,
  access_token TEXT,
  refresh_token TEXT,
  employee_id INTEGER
)`);

// Add columns if missing
try { db.exec('ALTER TABLE runs ADD COLUMN proof TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN employee_id INTEGER'); } catch (e) {}

db.exec(`CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  strava_username TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// ===== DASHBOARD API =====
app.get('/api/today', (req, res) => {
  const today = vnToday();
  const rows = db.prepare(
    `SELECT e.name, COALESCE(SUM(r.distance), 0) as total
     FROM employees e
     LEFT JOIN users u ON u.employee_id = e.id
     LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id) AND r.date = ?
     GROUP BY e.id
     ORDER BY total DESC`
  ).all(today);
  res.json(rows);
});

app.get('/api/month', (req, res) => {
  const { start, end } = vnMonthRange();
  const rows = db.prepare(
    `SELECT e.name, COALESCE(SUM(r.distance), 0) as total
     FROM employees e
     LEFT JOIN users u ON u.employee_id = e.id
     LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id)
       AND r.date >= ? AND r.date <= ?
     GROUP BY e.id
     ORDER BY total DESC`
  ).all(start, end);
  res.json(rows);
});

app.get('/api/members', (req, res) => {
  const today = vnToday();
  const rows = db.prepare(
    `SELECT e.id, e.name, COALESCE(SUM(r.distance), 0) as total,
       CASE WHEN u.id IS NOT NULL THEN 1 ELSE 0 END as strava_connected
     FROM employees e
     LEFT JOIN users u ON u.employee_id = e.id
     LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id) AND r.date = ?
     GROUP BY e.id
     ORDER BY total DESC`
  ).all(today);
  res.json(rows);
});

// ===== ADMIN API =====
app.get('/api/admin/employees', (req, res) => {
  const today = vnToday();
  const rows = db.prepare(
    `SELECT e.id, e.name, e.email, e.strava_username,
       CASE WHEN u.id IS NOT NULL THEN 1 ELSE 0 END as strava_connected,
       u.athlete_id as linked_athlete_id,
       COALESCE(r_today.today_km, 0) as today_km
     FROM employees e
     LEFT JOIN users u ON u.employee_id = e.id
     LEFT JOIN (
       SELECT athlete_id, SUM(distance) as today_km
       FROM runs WHERE date = ?
       GROUP BY athlete_id
     ) r_today ON u.athlete_id = r_today.athlete_id OR r_today.athlete_id = 'manual_' || e.id
     GROUP BY e.id
     ORDER BY e.id`
  ).all(today);
  res.json(rows);
});

app.post('/api/admin/employees', (req, res) => {
  const { name, email, strava_username } = req.body;
  if (!name || !name.trim()) return res.json({ success: false, error: 'Thieu ten nhan vien' });

  try {
    const result = db.prepare(
      `INSERT INTO employees (name, email, strava_username) VALUES (?, ?, ?)`
    ).run(name.trim(), email || null, strava_username || null);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.patch('/api/admin/employees/:id', (req, res) => {
  const { name, email, strava_username } = req.body;
  try {
    const result = db.prepare(
      `UPDATE employees SET name = ?, email = ?, strava_username = ? WHERE id = ?`
    ).run(
      name ? name.trim() : null,
      email ? email.trim() : null,
      strava_username ? strava_username.trim() : null,
      req.params.id
    );
    if (result.changes === 0) return res.json({ success: false, error: 'Khong tim thay nhan vien' });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/employees/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM employees WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/admin/report', (req, res) => {
  const { start, end } = vnMonthRange();
  const rows = db.prepare(
    `SELECT e.name,
       COALESCE(SUM(r.distance), 0) as total_km,
       COUNT(DISTINCT r.date) as run_days
     FROM employees e
     LEFT JOIN users u ON u.employee_id = e.id
     LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id)
       AND r.date >= ? AND r.date <= ?
     GROUP BY e.id
     ORDER BY total_km DESC`
  ).all(start, end);
  res.json(rows);
});

app.post('/api/admin/sync', async (req, res) => {
  try {
    await fetchAllUsers();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===== EMPLOYEE SELF-REGISTER =====
app.post('/api/register', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.json({ success: false, error: 'Vui long nhap ten' });

  const trimmed = name.trim();
  // Check if name already exists
  const existing = db.prepare('SELECT id FROM employees WHERE LOWER(name) = LOWER(?)').get(trimmed);
  if (existing) {
    return res.json({ success: true, id: existing.id, message: 'Ten da ton tai' });
  }

  try {
    const result = db.prepare('INSERT INTO employees (name) VALUES (?)').run(trimmed);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===== SUBMIT RUN (manual) =====
app.post('/api/submit-run', (req, res) => {
  const { employee_id, distance, proof } = req.body;
  if (!employee_id || !distance || distance <= 0) {
    return res.json({ success: false, error: 'Du lieu khong hop le' });
  }

  const emp = db.prepare('SELECT id, name FROM employees WHERE id = ?').get(employee_id);
  if (!emp) return res.json({ success: false, error: 'Khong tim thay nhan vien' });

  const today = vnToday();
  db.prepare('INSERT INTO runs (athlete_id, name, distance, date, proof) VALUES (?, ?, ?, ?, ?)')
    .run('manual_' + emp.id, emp.name, distance, today, proof || null);

  res.json({ success: true });
});

app.get('/api/my-runs/:empId', (req, res) => {
  const today = vnToday();
  const rows = db.prepare(
    'SELECT distance, proof FROM runs WHERE athlete_id = ? AND date = ?'
  ).all('manual_' + req.params.empId, today);
  res.json(rows);
});

// ===== EMPLOYEE LIST (for connect page) =====
app.get('/api/employees-list', (req, res) => {
  const rows = db.prepare(
    `SELECT e.id, e.name,
       CASE WHEN u.id IS NOT NULL THEN 1 ELSE 0 END as strava_connected
     FROM employees e
     LEFT JOIN users u ON u.employee_id = e.id
     GROUP BY e.id
     ORDER BY e.name`
  ).all();
  res.json(rows);
});

// ===== STRAVA AUTH =====
app.get('/auth/login', (req, res) => {
  const employeeId = req.query.employee_id || '';
  const state = employeeId ? encodeURIComponent(employeeId) : '';
  const url = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${process.env.STRAVA_REDIRECT_URI}&approval_prompt=auto&scope=activity:read_all&state=${state}`;
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

    // Upsert user record
    const existing = db.prepare('SELECT id FROM users WHERE athlete_id = ?').get(athleteId);
    if (existing) {
      db.prepare('UPDATE users SET name = ?, access_token = ?, refresh_token = ?, employee_id = COALESCE(?, employee_id) WHERE athlete_id = ?')
        .run(stravaName, access_token, refresh_token, employeeId, athleteId);
    } else {
      db.prepare('INSERT INTO users (athlete_id, name, access_token, refresh_token, employee_id) VALUES (?, ?, ?, ?, ?)')
        .run(athleteId, stravaName, access_token, refresh_token, employeeId);
    }

    // Update employee strava_username
    if (employeeId) {
      db.prepare('UPDATE employees SET strava_username = ? WHERE id = ?')
        .run(stravaName, employeeId);
    }

    const empName = employeeId
      ? (db.prepare('SELECT name FROM employees WHERE id = ?').get(employeeId) || {}).name
      : null;

    const safeEmpName = empName ? empName.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])) : null;
    const safeStravaName = stravaName.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
      <style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
      .card{background:#1e293b;border-radius:16px;padding:32px;max-width:400px;text-align:center;}
      .icon{font-size:48px;margin-bottom:16px;}h2{color:#4ade80;margin-bottom:12px;}
      p{color:#94a3b8;margin:8px 0;font-size:14px;}strong{color:#e2e8f0;}
      a{display:inline-block;margin-top:16px;padding:12px 24px;background:#38bdf8;color:#0f172a;text-decoration:none;border-radius:10px;font-weight:600;}</style></head>
      <body><div class="card">
      <div class="icon">&#9989;</div>
      <h2>Ket noi thanh cong!</h2>
      ${safeEmpName ? `<p>Nhan vien: <strong>${safeEmpName}</strong></p>` : ''}
      <p>Strava: <strong>${safeStravaName}</strong></p>
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
    const res = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.refresh_token,
    });

    const { access_token, refresh_token } = res.data;
    db.prepare('UPDATE users SET access_token = ?, refresh_token = ? WHERE id = ?')
      .run(access_token, refresh_token, user.id);

    return access_token;
  } catch (err) {
    console.error('Refresh token failed for', user.name);
    return null;
  }
}

// ===== FETCH ALL USERS DATA =====
async function fetchAllUsers() {
  const users = db.prepare('SELECT * FROM users WHERE access_token IS NOT NULL').all();
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

      const checkStmt = db.prepare('SELECT id FROM runs WHERE athlete_id = ? AND date = ? AND ABS(distance - ?) < 0.01');
      const insertStmt = db.prepare('INSERT INTO runs (athlete_id, name, distance, date) VALUES (?, ?, ?, ?)');

      for (const run of runs) {
        const km = run.distance / 1000;
        const runDate = new Date(run.start_date).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

        const existing = checkStmt.get(user.athlete_id, runDate, km);
        if (!existing) {
          insertStmt.run(user.athlete_id, user.name, km, runDate);
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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
