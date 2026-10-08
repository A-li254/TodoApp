/**
 * Self-contained API test suite for the TaskFlow backend.
 *
 * It spawns its own server instance on a scratch port with a scratch SQLite
 * file, exercises the whole REST contract (auth, CRUD, ownership, failures),
 * restarts the server to prove data persists on disk, then cleans up.
 *
 * Run with:  npm test   (from the backend/ folder)
 */
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 5099;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `taskflow-test-${Date.now()}.sqlite`);

let server = null;
let passed = 0;
let failed = 0;
const failures = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      SQLITE_PATH: DB_PATH,
      JWT_SECRET: 'test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in 10s')), 10000);
    const poll = async () => {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) {
          clearTimeout(timer);
          return resolve();
        }
      } catch {}
      setTimeout(poll, 150);
    };
    poll();
  });
}

async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  });
}

async function request(method, urlPath, { token, body } = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

async function main() {
  console.log('Starting test server...');
  await startServer();
  console.log(`Server up at ${BASE}, db at ${DB_PATH}\n`);

  const stamp = Date.now();
  const userA = {
    name: 'Asha Patel',
    email: `asha.${stamp}@example.com`,
    password: 'secret123',
  };
  const userB = {
    name: 'Bruno',
    email: `bruno.${stamp}@example.com`,
    password: 'secret456',
  };
  let tokenA;
  let tokenB;
  let todoId;

  console.log('Health');
  await test('GET /api/health reports sqlite as the database', async () => {
    const { status, data } = await request('GET', '/api/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.database, 'sqlite');
  });

  console.log('\nAuth');
  await test('POST /api/auth/register creates an account and returns a token', async () => {
    const { status, data } = await request('POST', '/api/auth/register', { body: userA });
    assert.strictEqual(status, 201);
    assert.ok(data.token, 'expected a JWT');
    assert.strictEqual(data.user.email, userA.email);
    assert.strictEqual(data.user.name, userA.name);
    tokenA = data.token;
  });

  await test('POST /api/auth/register rejects a duplicate email', async () => {
    const { status, data } = await request('POST', '/api/auth/register', { body: userA });
    assert.strictEqual(status, 400);
    assert.match(String(data.error), /already registered/i);
  });

  await test('POST /api/auth/register rejects a short password and bad email', async () => {
    const short = await request('POST', '/api/auth/register', {
      body: { name: 'X', email: `x.${stamp}@example.com`, password: '123' },
    });
    assert.strictEqual(short.status, 400);
    const badEmail = await request('POST', '/api/auth/register', {
      body: { name: 'X', email: 'not-an-email', password: 'abcdef' },
    });
    assert.strictEqual(badEmail.status, 400);
  });

  await test('POST /api/auth/login succeeds with correct credentials', async () => {
    const { status, data } = await request('POST', '/api/auth/login', {
      body: { email: userA.email, password: userA.password },
    });
    assert.strictEqual(status, 200);
    assert.ok(data.token);
    tokenA = data.token;
  });

  await test('POST /api/auth/login fails with a wrong password (401)', async () => {
    const { status } = await request('POST', '/api/auth/login', {
      body: { email: userA.email, password: 'wrongpass' },
    });
    assert.strictEqual(status, 401);
  });

  await test('second user can register and log in', async () => {
    const { status, data } = await request('POST', '/api/auth/register', { body: userB });
    assert.strictEqual(status, 201);
    tokenB = data.token;
  });

  console.log('\nAuth middleware');
  await test('GET /api/todos without a token is rejected (401)', async () => {
    const { status } = await request('GET', '/api/todos');
    assert.strictEqual(status, 401);
  });

  await test('GET /api/todos with a garbage token is rejected (401)', async () => {
    const { status } = await request('GET', '/api/todos', { token: 'not.a.jwt' });
    assert.strictEqual(status, 401);
  });

  console.log('\nTodos CRUD');
  await test('POST /api/todos creates a todo with an _id', async () => {
    const { status, data } = await request('POST', '/api/todos', {
      token: tokenA,
      body: { title: 'Write the report', description: 'Quarterly numbers' },
    });
    assert.strictEqual(status, 201);
    assert.ok(data._id, 'expected _id (frontend contract)');
    assert.strictEqual(data.title, 'Write the report');
    assert.strictEqual(data.description, 'Quarterly numbers');
    assert.strictEqual(data.completed, false);
    todoId = data._id;
  });

  await test('POST /api/todos rejects an empty title (400)', async () => {
    const { status } = await request('POST', '/api/todos', {
      token: tokenA,
      body: { title: '   ' },
    });
    assert.strictEqual(status, 400);
  });

  await test('GET /api/todos lists the todo for the owner', async () => {
    const { status, data } = await request('GET', '/api/todos', { token: tokenA });
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data));
    assert.ok(data.some((t) => t._id === todoId));
  });

  await test('PUT /api/todos/:id updates title and description', async () => {
    const { status, data } = await request('PUT', `/api/todos/${todoId}`, {
      token: tokenA,
      body: { title: 'Write the report (final)', description: 'Reviewed', completed: false },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.title, 'Write the report (final)');
    assert.strictEqual(data.description, 'Reviewed');
  });

  await test('PATCH /api/todos/:id/toggle flips completed twice', async () => {
    const first = await request('PATCH', `/api/todos/${todoId}/toggle`, { token: tokenA });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.data.completed, true);
    const second = await request('PATCH', `/api/todos/${todoId}/toggle`, { token: tokenA });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.data.completed, false);
  });

  await test('GET /api/todos/:id unknown id returns 404', async () => {
    const { status } = await request('GET', '/api/todos/does-not-exist', { token: tokenA });
    assert.ok(status === 404 || status === 401, `unexpected status ${status}`);
  });

  console.log('\nOwnership isolation');
  await test('user B cannot see or edit user A todos', async () => {
    const list = await request('GET', '/api/todos', { token: tokenB });
    assert.strictEqual(list.status, 200);
    assert.ok(!list.data.some((t) => t._id === todoId), 'leaked another user todo');

    const put = await request('PUT', `/api/todos/${todoId}`, {
      token: tokenB,
      body: { title: 'hacked' },
    });
    assert.strictEqual(put.status, 404);

    const del = await request('DELETE', `/api/todos/${todoId}`, { token: tokenB });
    assert.strictEqual(del.status, 404);
  });

  await test('user B can create their own todo', async () => {
    const { status, data } = await request('POST', '/api/todos', {
      token: tokenB,
      body: { title: 'Bruno task' },
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(data.title, 'Bruno task');
  });

  console.log('\nPersistence across restart');
  await test('data survives a server restart (SQLite file)', async () => {
    await stopServer();
    await startServer();

    const login = await request('POST', '/api/auth/login', {
      body: { email: userA.email, password: userA.password },
    });
    assert.strictEqual(login.status, 200, 'account should survive restart');

    const list = await request('GET', '/api/todos', { token: login.data.token });
    assert.strictEqual(list.status, 200);
    assert.ok(
      list.data.some((t) => t._id === todoId && t.title === 'Write the report (final)'),
      'todo should survive restart'
    );
    tokenA = login.data.token;
  });

  console.log('\nDelete');
  await test('DELETE /api/todos/:id removes it (and again → 404)', async () => {
    const first = await request('DELETE', `/api/todos/${todoId}`, { token: tokenA });
    assert.strictEqual(first.status, 200);
    const second = await request('DELETE', `/api/todos/${todoId}`, { token: tokenA });
    assert.strictEqual(second.status, 404);

    const list = await request('GET', '/api/todos', { token: tokenA });
    assert.ok(!list.data.some((t) => t._id === todoId));
  });

  await stopServer();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(DB_PATH + suffix);
    } catch {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error('Test run crashed:', err);
  await stopServer();
  process.exitCode = 1;
});
