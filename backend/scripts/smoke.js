const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint4-smoke-'));
const dbPath = path.join(tempDir, 'database.sqlite');
const port = 3310;
const baseUrl = `http://127.0.0.1:${port}`;
const adminPassword = 'admin123';
const adminSecret = 'sprint4-smoke-secret';

function waitForServer(childProcess) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout esperando backend.'));
    }, 15000);

    childProcess.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes(`Server running on port ${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    childProcess.stderr.on('data', (chunk) => {
      process.stderr.write(chunk.toString());
    });

    childProcess.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Backend terminó antes de tiempo con código ${code}.`));
    });
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch (_error) {
    body = text;
  }

  return { response, body };
}

async function loginAdmin() {
  const login = await requestJson(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword })
  });

  assert.equal(login.response.status, 200);
  assert.ok(login.body.token);
  return login.body.token;
}

async function main() {
  const server = spawn('node', ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      ADMIN_PASSWORD: adminPassword,
      ADMIN_TOKEN_SECRET: adminSecret
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(server);

    const initial = await requestJson(`${baseUrl}/api/venue-settings`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.restaurant_name, 'Mozzo');
    const adminToken = await loginAdmin();

    const payload = {
      restaurant_name: 'Mozzo Palermo',
      restaurant_subtitle: 'Cocina y barra',
      contact_label: 'WhatsApp',
      contact_url: 'https://wa.me/5491100000000',
      review_url: 'https://example.com/reviews',
      feedback_url: 'https://example.com/feedback'
    };

    const saved = await requestJson(`${baseUrl}/api/admin/venue-settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify(payload)
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.restaurant_name, payload.restaurant_name);

    const fetched = await requestJson(`${baseUrl}/api/venue-settings`);
    assert.equal(fetched.response.status, 200);
    assert.equal(fetched.body.restaurant_subtitle, payload.restaurant_subtitle);
    assert.equal(fetched.body.contact_url, payload.contact_url);

    const menu = await requestJson(`${baseUrl}/api/menu`);
    assert.equal(menu.response.status, 200);
    assert.ok(Array.isArray(menu.body));

    console.log('Smoke check passed');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
