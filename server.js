require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  refresh_token TEXT
)`);

// Add proof column if missing
try { db.exec('ALTER TABLE runs ADD COLUMN proof TEXT'); } catch (e) {}

db.exec(`CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  strava_username TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// ===== DASHBOARD API =====
app.get('/api/today', (req, res) => {
  const today = new Date().toDateString();
  const rows = db.prepare(
    `SELECT e.name, COALESCE(SUM(r.distance), 0) as total
     FROM employees e
     LEFT JOIN users u ON u.athlete_id = e.strava_username OR LOWER(u.name) = LOWER(e.strava_username)
     LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id) AND r.date = ?
     GROUP BY e.id
     ORDER BY total DESC`
  ).all(today);
  res.json(rows);
});

app.get('/api/month', (req, res) => {
  const rows = db.prepare(
    `SELECT e.name, COALESCE(SUM(r.distance), 0) as total
     FROM employees e
     LEFT JOIN users u ON u.athlete_id = e.strava_username OR LOWER(u.name) = LOWER(e.strava_username)
     LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id)
     GROUP BY e.id
     ORDER BY total DESC`
  ).all();
  res.json(rows);
});

app.get('/api/members', (req, res) => {
  const today = new Date().toDateString();
  const rows = db.prepare(
    `SELECT e.name, COALESCE(SUM(r.distance), 0) as total
     FROM employees e
     LEFT JOIN users u ON u.athlete_id = e.strava_username OR LOWER(u.name) = LOWER(e.strava_username)
     LEFT JOIN runs r ON (r.athlete_id = u.athlete_id OR r.athlete_id = 'manual_' || e.id) AND r.date = ?
     GROUP BY e.id
     ORDER BY total DESC`
  ).all(today);
  res.json(rows);
});

// ===== ADMIN API =====
app.get('/api/admin/employees', (req, res) => {
  const today = new Date().toDateString();
  const rows = db.prepare(
    `SELECT e.id, e.name, e.email, e.strava_username,
       CASE WHEN u.id IS NOT NULL THEN 1 ELSE 0 END as strava_connected,
       COALESCE(r_today.today_km, 0) as today_km
     FROM employees e
     LEFT JOIN users u ON
       u.athlete_id = e.strava_username
       OR LOWER(u.name) = LOWER(e.strava_username)
     LEFT JOIN (
       SELECT athlete_id, SUM(distance) as today_km
       FROM runs WHERE date = ?
       GROUP BY athlete_id
     ) r_today ON u.athlete_id = r_today.athlete_id
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
  const rows = db.prepare(
    `SELECT e.name,
       COALESCE(SUM(r.distance), 0) as total_km,
       COUNT(DISTINCT r.date) as run_days
     FROM employees e
     LEFT JOIN users u ON
       u.athlete_id = e.strava_username
       OR LOWER(u.name) = LOWER(e.strava_username)
     LEFT JOIN runs r ON r.athlete_id = u.athlete_id
     GROUP BY e.id
     ORDER BY total_km DESC`
  ).all();
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

// ===== SUBMIT RUN (manual) =====
app.post('/api/submit-run', (req, res) => {
  const { employee_id, distance, proof } = req.body;
  if (!employee_id || !distance || distance <= 0) {
    return res.json({ success: false, error: 'Du lieu khong hop le' });
  }

  const emp = db.prepare('SELECT id, name FROM employees WHERE id = ?').get(employee_id);
  if (!emp) return res.json({ success: false, error: 'Khong tim thay nhan vien' });

  const today = new Date().toDateString();
  db.prepare('INSERT INTO runs (athlete_id, name, distance, date, proof) VALUES (?, ?, ?, ?, ?)')
    .run('manual_' + emp.id, emp.name, distance, today, proof || null);

  res.json({ success: true });
});

app.get('/api/my-runs/:empId', (req, res) => {
  const today = new Date().toDateString();
  const rows = db.prepare(
    'SELECT distance, proof FROM runs WHERE athlete_id = ? AND date = ?'
  ).all('manual_' + req.params.empId, today);
  res.json(rows);
});

// ===== STRAVA AUTH =====
app.get('/auth/login', (req, res) => {
  const url = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${process.env.STRAVA_REDIRECT_URI}&approval_prompt=auto&scope=activity:read_all`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
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

    const existing = db.prepare('SELECT id FROM users WHERE athlete_id = ?').get(athleteId);
    if (existing) {
      db.prepare('UPDATE users SET name = ?, access_token = ?, refresh_token = ? WHERE athlete_id = ?')
        .run(stravaName, access_token, refresh_token, athleteId);
    } else {
      db.prepare('INSERT INTO users (athlete_id, name, access_token, refresh_token) VALUES (?, ?, ?, ?)')
        .run(athleteId, stravaName, access_token, refresh_token);
    }

    res.send(`<h2>Ket noi thanh cong!</h2><p>Athlete ID: <strong>${athlete.id}</strong></p><p>Username: <strong>${stravaName}</strong></p><p>Hay gui Athlete ID hoac username nay cho admin de lien ket voi tai khoan nhan vien.</p><p>Ban co the dong tab nay.</p>`);
  } catch (err) {
    console.error(err.message);
    res.send('<h2>Loi ket noi Strava</h2><p>Vui long thu lai.</p>');
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
  const users = db.prepare('SELECT * FROM users').all();
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
        const runDate = new Date(run.start_date).toDateString();

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
