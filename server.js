require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Storage: SQLite file (no MongoDB, no external database service needed)
// ---------------------------------------------------------------------------
const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'data.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
`);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET not set in .env — using an insecure dev fallback.');
}

const rowToUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
});

const rowToTodo = (row) => ({
  _id: row.id,
  userId: row.user_id,
  title: row.title,
  description: row.description || '',
  completed: !!row.completed,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
const auth = (req, res, next) => {
  try {
    const header = req.header('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Please authenticate.' });
  }
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', database: 'sqlite', file: path.basename(DB_PATH) });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const id = crypto.randomUUID();
    const hashedPassword = await bcrypt.hash(String(password), 10);
    db.prepare('INSERT INTO users (id, name, email, password) VALUES (?, ?, ?, ?)').run(
      id,
      String(name).trim(),
      normalizedEmail,
      hashedPassword
    );

    const token = jwt.sign({ id }, JWT_SECRET);
    res.status(201).json({ user: { id, name: String(name).trim(), email: normalizedEmail }, token });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
    if (!user || !(await bcrypt.compare(String(password), user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET);
    res.json({ user: rowToUser(user), token });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/todos', auth, (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM todos WHERE user_id = ? ORDER BY datetime(created_at) DESC, id')
      .all(req.user.id);
    res.json(rows.map(rowToTodo));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/todos', auth, (req, res) => {
  try {
    const { title, description, completed } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });

    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO todos (id, user_id, title, description, completed) VALUES (?, ?, ?, ?, ?)'
    ).run(
      id,
      req.user.id,
      String(title).trim(),
      description ? String(description) : '',
      completed ? 1 : 0
    );

    const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id);
    res.status(201).json(rowToTodo(row));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/todos/:id', auth, (req, res) => {
  try {
    const existing = db
      .prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Todo not found' });

    const { title, description, completed } = req.body || {};
    const nextTitle = title === undefined ? existing.title : String(title).trim();
    if (!nextTitle) return res.status(400).json({ error: 'Title is required' });

    db.prepare(
      `UPDATE todos SET title = ?, description = ?, completed = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
    ).run(
      nextTitle,
      description === undefined ? existing.description : String(description),
      completed === undefined ? existing.completed : completed ? 1 : 0,
      req.params.id,
      req.user.id
    );

    const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id);
    res.json(rowToTodo(row));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/todos/:id/toggle', auth, (req, res) => {
  try {
    const existing = db
      .prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Todo not found' });

    db.prepare(
      `UPDATE todos SET completed = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
    ).run(existing.completed ? 0 : 1, req.params.id, req.user.id);

    const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id);
    res.json(rowToTodo(row));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/todos/:id', auth, (req, res) => {
  try {
    const result = db
      .prepare('DELETE FROM todos WHERE id = ? AND user_id = ?')
      .run(req.params.id, req.user.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Todo not found' });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------------------------------------------------------------------------
// Static web build (Expo export) + SPA fallback
// ---------------------------------------------------------------------------
const webBuildPath = path.join(__dirname, '..', 'mobile', 'dist');
if (fs.existsSync(webBuildPath)) {
  app.use(express.static(webBuildPath));
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    res.sendFile(path.join(webBuildPath, 'index.html'), (err) => err && next());
  });
} else {
  console.warn(`Web build not found at ${webBuildPath}. Run: npm --prefix ../mobile run build:web`);
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
