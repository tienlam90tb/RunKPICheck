require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== DATABASE =====
const db = new sqlite3.Database('./data.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    athlete_id TEXT,
    name TEXT,
    distance REAL,
    date TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    athlete_id TEXT UNIQUE,
    name TEXT,
    email TEXT,
    access_token TEXT,
    refresh_token TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    strava_username TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
});

// ===== DASHBOARD API =====
app.get('/api/today', (req, res) => {
  const today = new Date().toDateString();
  db.all(
    `SELECT e.name, COALESCE(SUM(r.distance), 0) as total
     FROM employees e
     LEFT JOIN users u ON u.athlete_id = e.strava_username OR LOWER(u.name) = LOWER(e.strava_username)
     LEFT JOIN runs r ON r.athlete_id = u.athlete_id AND r.date = ?
     GROUP BY e.id
     ORDER BY total DESC`,
    [today],
    (err, rows) => {
      res.json(rows || []);
    }
  );
});

app.get('/api/month', (req, res) => {
  db.all(
    `SELECT e.name, COALESCE(SUM(r.distance), 0) as total
     FROM employees e
     LEFT JOIN users u ON u.athlete_id = e.strava_username OR LOWER(u.name) = LOWER(e.strava_username)
     LEFT JOIN runs r ON r.athlete_id = u.athlete_id
     GROUP BY e.id
     ORDER BY total DESC`,
    (err, rows) => {
      res.json(rows || []);
    }
  );
});

app.get('/api/members', (req, res) => {
  const today = new Date().toDateString();
  db.all(
    `SELECT e.name, COALESCE(SUM(r.distance), 0) as total
     FROM employees e
     LEFT JOIN users u ON u.athlete_id = e.strava_username OR LOWER(u.name) = LOWER(e.strava_username)
     LEFT JOIN runs r ON r.athlete_id = u.athlete_id AND r.date = ?
     GROUP BY e.id
     ORDER BY total DESC`,
    [today],
    (err, rows) => {
      res.json(rows || []);
    }
  );
});

// ===== ADMIN API =====

// Lay danh sach nhan vien + trang thai Strava + KM hom nay
app.get('/api/admin/employees', (req, res) => {
  const today = new Date().toDateString();
  db.all(
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
     ORDER BY e.id`,
    [today],
    (err, rows) => {
      res.json(rows || []);
    }
  );
});

// Them nhan vien
app.post('/api/admin/employees', (req, res) => {
  const { name, email, strava_username } = req.body;
  if (!name || !name.trim()) return res.json({ success: false, error: 'Thieu ten nhan vien' });

  db.run(
    `INSERT INTO employees (name, email, strava_username) VALUES (?, ?, ?)`,
    [name.trim(), email || null, strava_username || null],
    function (err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// Cap nhat nhan vien
app.patch('/api/admin/employees/:id', (req, res) => {
  const { name, email, strava_username } = req.body;
  db.run(
    `UPDATE employees SET name = ?, email = ?, strava_username = ? WHERE id = ?`,
    [
      name ? name.trim() : null,
      email ? email.trim() : null,
      strava_username ? strava_username.trim() : null,
      req.params.id
    ],
    function (err) {
      if (err) return res.json({ success: false, error: err.message });
      if (this.changes === 0) return res.json({ success: false, error: 'Khong tim thay nhan vien' });
      res.json({ success: true });
    }
  );
});

// Xoa nhan vien
app.delete('/api/admin/employees/:id', (req, res) => {
  db.run(`DELETE FROM employees WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// Bao cao thang
app.get('/api/admin/report', (req, res) => {
  db.all(
    `SELECT e.name,
       COALESCE(SUM(r.distance), 0) as total_km,
       COUNT(DISTINCT r.date) as run_days
     FROM employees e
     LEFT JOIN users u ON
       u.athlete_id = e.strava_username
       OR LOWER(u.name) = LOWER(e.strava_username)
     LEFT JOIN runs r ON r.athlete_id = u.athlete_id
     GROUP BY e.id
     ORDER BY total_km DESC`,
    (err, rows) => {
      res.json(rows || []);
    }
  );
});

// Dong bo thu cong
app.post('/api/admin/sync', async (req, res) => {
  try {
    await fetchAllUsers();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
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

    // Upsert user
    db.get('SELECT id FROM users WHERE athlete_id = ?', [String(athlete.id)], (err, row) => {
      if (row) {
        db.run(
          `UPDATE users SET name = ?, access_token = ?, refresh_token = ? WHERE athlete_id = ?`,
          [stravaName, access_token, refresh_token, String(athlete.id)]
        );
      } else {
        db.run(
          `INSERT INTO users (athlete_id, name, access_token, refresh_token) VALUES (?, ?, ?, ?)`,
          [String(athlete.id), stravaName, access_token, refresh_token]
        );
      }
      res.send(`<h2>Ket noi thanh cong!</h2><p>Athlete ID: <strong>${athlete.id}</strong></p><p>Username: <strong>${stravaName}</strong></p><p>Hay gui Athlete ID hoac username nay cho admin de lien ket voi tai khoan nhan vien.</p><p>Ban co the dong tab nay.</p>`);
    });
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

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users SET access_token = ?, refresh_token = ? WHERE id = ?`,
        [access_token, refresh_token, user.id],
        (err) => (err ? reject(err) : resolve())
      );
    });

    return access_token;
  } catch (err) {
    console.error('Refresh token failed for', user.name);
    return null;
  }
}

// ===== FETCH ALL USERS DATA =====
async function fetchAllUsers() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM users', async (err, users) => {
      if (err) return reject(err);
      if (!users || users.length === 0) return resolve();

      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      for (const user of users) {
        try {
          let token = user.access_token;
          let res;

          try {
            res = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch (apiErr) {
            token = await refreshAccessToken(user);
            if (!token) continue;
            res = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
              headers: { Authorization: `Bearer ${token}` },
            });
          }

          const runs = res.data.filter((a) => {
            if (a.type !== 'Run') return false;
            const d = new Date(a.start_date);
            return d >= sevenDaysAgo && d <= now;
          });

          for (const run of runs) {
            const km = run.distance / 1000;
            const runDate = new Date(run.start_date).toDateString();

            // Tranh trung lap: kiem tra truoc khi insert
            await new Promise((res2, rej2) => {
              db.get(
                `SELECT id FROM runs WHERE athlete_id = ? AND date = ? AND ABS(distance - ?) < 0.01`,
                [user.athlete_id, runDate, km],
                (err2, existing) => {
                  if (err2) return rej2(err2);
                  if (!existing) {
                    db.run(
                      `INSERT INTO runs (athlete_id, name, distance, date) VALUES (?, ?, ?, ?)`,
                      [user.athlete_id, user.name, km, runDate]
                    );
                  }
                  res2();
                }
              );
            });
          }

          console.log(`Synced ${runs.length} runs for ${user.name}`);
        } catch (userErr) {
          console.error('Error syncing user:', user.name, userErr.message);
        }
      }
      resolve();
    });
  });
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
