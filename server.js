// =========================
// RUNNING KPI SYSTEM (FULL PROJECT)
// Tech: Node.js + Express + SQLite + Strava API
// =========================

// ===== 1. INSTALL =====
// npm init -y
// npm install express axios sqlite3 dotenv cors node-cron

// ===== 2. FILE: .env =====
// STRAVA_TOKEN=your_access_token_here

// ===== 3. FILE: server.js =====

require('dotenv').config();
console.log("CLIENT ID:", process.env.STRAVA_CLIENT_ID);
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const cors = require('cors');

const path = require('path');

const app = express();
app.use(cors());
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
    athlete_id TEXT,
    name TEXT,
    email TEXT,
    access_token TEXT,
    refresh_token TEXT
  )`);

  // In case existing DB before add athlete_id or email fields
  db.run(`ALTER TABLE runs ADD COLUMN athlete_id TEXT`, (err) => {
    // ignore if already exists
  });
  db.run(`ALTER TABLE users ADD COLUMN email TEXT`, (err) => {
    // ignore if already exists
  });
});

// ===== GET STRAVA DATA =====
async function fetchStrava() {
  try {
    const res = await axios.get(
      'https://www.strava.com/api/v3/athlete/activities',
      {
        headers: {
          Authorization: `Bearer ${process.env.STRAVA_TOKEN}`,
        },
      }
    );

    const today = new Date().toDateString();

    const runs = res.data.filter(
      (a) =>
        a.type === 'Run' &&
        new Date(a.start_date).toDateString() === today
    );

    runs.forEach((run) => {
      const km = run.distance / 1000;
      const athleteId = run.athlete && run.athlete.id ? run.athlete.id : null;

      db.run(
        `INSERT INTO runs (athlete_id, name, distance, date) VALUES (?, ?, ?, ?)`,
        [athleteId, run.name, km, today]
      );
    });

    console.log('Data synced');
  } catch (err) {
    console.error(err.message);
  }
}

// ===== CRON JOB (8PM DAILY) =====
cron.schedule('0 20 * * *', () => {
  console.log('Running daily sync...');
  fetchStrava();
});

// ===== API =====
app.get('/api/today', (req, res) => {
  const today = new Date().toDateString();

  db.all(
    `SELECT name, SUM(distance) as total FROM runs WHERE date = ? GROUP BY name`,
    [today],
    (err, rows) => {
      res.json(rows);
    }
  );
});

app.get('/api/month', (req, res) => {
  db.all(
    `SELECT name, SUM(distance) as total FROM runs GROUP BY name`,
    (err, rows) => {
      res.json(rows);
    }
  );
});

app.get('/api/members', (req, res) => {
  const today = new Date().toDateString();
  db.all(
    `SELECT u.name, COALESCE(SUM(r.distance), 0) as total
     FROM users u
     LEFT JOIN runs r ON u.name = r.name AND r.date = ?
     GROUP BY u.name
     ORDER BY total DESC`,
    [today],
    (err, rows) => {
      res.json(rows || []);
    }
  );
});

// ===== ADMIN API =====
app.use(express.json());

// Add employee table
db.run(`CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  strava_username TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// Add column if missing for older DB versions
db.run(`ALTER TABLE employees ADD COLUMN strava_username TEXT`, (err) => {
  // ignore error if column exists already
});

// Get all employees with today's KM and strava status
app.get('/api/admin/employees', (req, res) => {
  const today = new Date().toDateString();
  db.all(
    `SELECT e.id, e.name, e.email, e.strava_username,
       CASE WHEN u.id IS NOT NULL THEN 1 ELSE 0 END as strava_connected,
       COALESCE(r.today_km, 0) as today_km
     FROM employees e
     LEFT JOIN users u ON
       LOWER(e.strava_username) = LOWER(u.name)
       OR LOWER(e.email) = LOWER(u.email)
       OR LOWER(e.name) = LOWER(u.name)
     LEFT JOIN (
       SELECT athlete_id, SUM(distance) as today_km FROM runs WHERE date = ? GROUP BY athlete_id
     ) r ON u.athlete_id = r.athlete_id
     ORDER BY e.id`,
    [today],
    (err, rows) => {
      res.json(rows || []);
    }
  );
});

// Add employee
app.post('/api/admin/employees', (req, res) => {
  const { name, email, strava_username } = req.body;
  if (!name) return res.json({ success: false, error: 'Thieu ten nhan vien' });

  db.run(
    `INSERT INTO employees (name, email, strava_username) VALUES (?, ?, ?)`,
    [name, email || null, strava_username || null],
    function (err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// Delete employee
app.delete('/api/admin/employees/:id', (req, res) => {
  db.run(`DELETE FROM employees WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// Update employee (name/email/strava_username)
app.patch('/api/admin/employees/:id', (req, res) => {
  const { name, email, strava_username } = req.body;
  const fields = [];
  const values = [];
  if (name) { fields.push('name = ?'); values.push(name); }
  if (email) { fields.push('email = ?'); values.push(email); }
  if (strava_username) { fields.push('strava_username = ?'); values.push(strava_username); }
  if (!fields.length) return res.json({ success: false, error: 'No fields to update' });
  values.push(req.params.id);

  db.run(
    `UPDATE employees SET ${fields.join(', ')} WHERE id = ?`,
    values,
    function (err) {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true });
    }
  );
});

// Monthly report
app.get('/api/admin/report', (req, res) => {
  db.all(
    `SELECT e.name,
       COALESCE(SUM(r.distance), 0) as total_km,
       COUNT(DISTINCT r.date) as run_days
     FROM employees e
     LEFT JOIN users u ON
       LOWER(e.strava_username) = LOWER(u.name)
       OR LOWER(e.email) = LOWER(u.email)
       OR LOWER(e.name) = LOWER(u.name)
     LEFT JOIN runs r ON r.athlete_id = u.athlete_id
     GROUP BY e.name
     ORDER BY total_km DESC`,
    (err, rows) => {
      res.json(rows || []);
    }
  );
});

// Manual sync trigger
app.post('/api/admin/sync', async (req, res) => {
  try {
    await fetchAllUsers();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));

// ===== 4. DASHBOARD (Modern UI - index.html) =====

/*
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Running KPI Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Inter', sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      margin: 0;
      padding: 20px;
    }

    h1 {
      text-align: center;
      margin-bottom: 20px;
    }

    .container {
      max-width: 1000px;
      margin: auto;
    }

    .card {
      background: #1e293b;
      padding: 20px;
      border-radius: 16px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.3);
      margin-bottom: 20px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th, td {
      padding: 12px;
      text-align: left;
    }

    th {
      background: #334155;
    }

    tr:nth-child(even) {
      background: #1e293b;
    }

    .badge {
      padding: 5px 10px;
      border-radius: 10px;
      font-size: 12px;
    }

    .ok { background: #16a34a; }
    .fail { background: #dc2626; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🏃 Running KPI Dashboard</h1>

    <div class="card">
      <h2>Today Status</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>KM</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="table"></tbody>
      </table>
    </div>

    <div class="card">
      <h2>Leaderboard</h2>
      <canvas id="chart"></canvas>
    </div>
  </div>

  <script>
    async function loadData() {
      const res = await fetch('http://localhost:3000/api/today');
      const data = await res.json();

      const table = document.getElementById('table');
      const names = [];
      const kms = [];

      data.sort((a, b) => b.total - a.total);

      data.forEach((item) => {
        const status = item.total >= 5 ?
          '<span class="badge ok">✔ đạt</span>' :
          '<span class="badge fail">✘ chưa đạt</span>';

        const row = `<tr>
          <td>${item.name}</td>
          <td>${item.total.toFixed(2)}</td>
          <td>${status}</td>
        </tr>`;

        table.innerHTML += row;
        names.push(item.name);
        kms.push(item.total);
      });

      new Chart(document.getElementById('chart'), {
        type: 'bar',
        data: {
          labels: names,
          datasets: [{ label: 'KM', data: kms }]
        },
        options: {
          plugins: {
            legend: { display: false }
          }
        }
      });
    }

    loadData();
  </script>
</body>
</html>
*/

// ===== 5. STRAVA OAUTH (MULTI-USER) =====

// Add these env vars:
// STRAVA_CLIENT_ID=your_client_id
// STRAVA_CLIENT_SECRET=your_client_secret
// STRAVA_REDIRECT_URI=http://localhost:3000/auth/callback

// ===== UPDATE DB (store users & tokens) =====
// Run once to add table
// CREATE TABLE users (
//   id INTEGER PRIMARY KEY AUTOINCREMENT,
//   athlete_id TEXT,
//   name TEXT,
//   access_token TEXT,
//   refresh_token TEXT
// );

// ===== AUTH ROUTES =====
app.get('/auth/login', (req, res) => {
  const url = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${process.env.STRAVA_REDIRECT_URI}&approval_prompt=auto&scope=read_all`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;

  try {
    const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
    });

    const { access_token, refresh_token, athlete } = tokenRes.data;
    const stravaName = athlete.username || `${athlete.firstname || ''} ${athlete.lastname || ''}`.trim();
    const stravaEmail = athlete.email || null;

    // Check if user already exists by athlete_id
    db.get('SELECT id FROM users WHERE athlete_id = ?', [athlete.id], (err, row) => {
      if (row) {
        // Update existing user
        db.run(
          `UPDATE users SET name = ?, email = ?, access_token = ?, refresh_token = ? WHERE athlete_id = ?`,
          [stravaName, stravaEmail, access_token, refresh_token, athlete.id]
        );
        res.send('✅ Updated connection successfully! You can close this tab.');
      } else {
        // Insert new user
        db.run(
          `INSERT INTO users (athlete_id, name, email, access_token, refresh_token) VALUES (?, ?, ?, ?, ?)`,
          [athlete.id, stravaName, stravaEmail, access_token, refresh_token]
        );
        res.send('✅ Connected successfully! You can close this tab.');
      }
    });
  } catch (err) {
    res.send('❌ Error connecting Strava');
  }
});

// ===== TOKEN REFRESH HELPER =====
async function refreshAccessToken(user) {
  try {
    const res = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.refresh_token,
    });

    const { access_token, refresh_token } = res.data;

    // update DB
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

// ===== FETCH ALL USERS DATA (LAST 7 DAYS) =====
async function fetchAllUsers() {
  db.all('SELECT * FROM users', async (err, users) => {
    // Calculate date range: last 7 days
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    for (const user of users) {
      try {
        let token = user.access_token;

        // try call API
        let res;
        try {
          res = await axios.get(
            'https://www.strava.com/api/v3/athlete/activities',
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
        } catch (err) {
          // token expired → refresh
          token = await refreshAccessToken(user);
          if (!token) continue;

          res = await axios.get(
            'https://www.strava.com/api/v3/athlete/activities',
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
        }

        // Filter runs from last 7 days
        const runs = res.data.filter((a) => {
          if (a.type !== 'Run') return false;
          const activityDate = new Date(a.start_date);
          return activityDate >= sevenDaysAgo && activityDate <= now;
        });

        runs.forEach((run) => {
          const km = run.distance / 1000;
          const runDate = new Date(run.start_date).toDateString();

          db.run(
            `INSERT INTO runs (athlete_id, name, distance, date) VALUES (?, ?, ?, ?)`,
            [user.athlete_id, user.name, km, runDate]
          );
        });

        console.log(`Synced ${runs.length} runs for ${user.name}`);
      } catch (err) {
        console.error('Error user:', user.name);
      }
    }
  });
}

// Replace cron job (Friday 3PM only):
cron.schedule('0 15 * * 5', () => {
  console.log('Running weekly sync (all users, last 7 days)...');
  fetchAllUsers();
});

// ===== HOW TO USE =====
// 1. Run server
// 2. Each employee opens:
//    http://localhost:3000/auth/login
// 3. Login Strava + Allow
// 4. System saves their token
// 5. Done → fully automatic

// ===== DONE =====
// Run server: node server.js
// Open index.html to view dashboard

// ===== NEXT UPGRADE =====
// - Add user mapping (real employee names)
// - Add anti-cheat (pace filter)
// - Add Telegram bot
// - Deploy to VPS (Railway / Render)
