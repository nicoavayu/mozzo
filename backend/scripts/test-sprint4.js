const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozzo-sprint4-test-'));
const dbPath = path.join(tempDir, 'database.sqlite');
const port = 3311;
const baseUrl = `http://127.0.0.1:${port}`;
const adminPassword = 'admin123';
const adminSecret = 'sprint4-test-secret';

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

    const fallback = await requestJson(`${baseUrl}/api/venue-settings`);
    assert.equal(fallback.response.status, 200);
    assert.deepEqual(
      {
        restaurant_name: fallback.body.restaurant_name,
        restaurant_subtitle: fallback.body.restaurant_subtitle,
        contact_label: fallback.body.contact_label,
        contact_url: fallback.body.contact_url,
        review_url: fallback.body.review_url,
        feedback_url: fallback.body.feedback_url
      },
      {
        restaurant_name: 'Mozzo',
        restaurant_subtitle: '',
        contact_label: '',
        contact_url: '',
        review_url: '',
        feedback_url: ''
      }
    );
    const adminToken = await loginAdmin();

    const missingName = await requestJson(`${baseUrl}/api/admin/venue-settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        restaurant_name: '',
        restaurant_subtitle: '',
        contact_label: '',
        contact_url: '',
        review_url: '',
        feedback_url: ''
      })
    });
    assert.equal(missingName.response.status, 400);
    assert.ok(missingName.body.fields.restaurant_name);

    const invalidUrl = await requestJson(`${baseUrl}/api/admin/venue-settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        restaurant_name: 'Mozzo Test',
        restaurant_subtitle: '',
        contact_label: '',
        contact_url: '',
        review_url: 'http://',
        feedback_url: ''
      })
    });
    assert.equal(invalidUrl.response.status, 400);
    assert.ok(invalidUrl.body.fields.review_url);

    const incompleteContact = await requestJson(`${baseUrl}/api/admin/venue-settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        restaurant_name: 'Mozzo Test',
        restaurant_subtitle: '',
        contact_label: 'WhatsApp',
        contact_url: '',
        review_url: '',
        feedback_url: ''
      })
    });
    assert.equal(incompleteContact.response.status, 400);
    assert.ok(incompleteContact.body.fields.contact);

    const validSave = await requestJson(`${baseUrl}/api/admin/venue-settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        restaurant_name: 'Mozzo Belgrano',
        restaurant_subtitle: 'Pizzas y tapas',
        contact_label: 'WhatsApp',
        contact_url: 'https://wa.me/5491100000001',
        review_url: 'https://example.com/review',
        feedback_url: 'https://example.com/feedback'
      })
    });
    assert.equal(validSave.response.status, 200);
    assert.equal(validSave.body.restaurant_name, 'Mozzo Belgrano');
    assert.equal(validSave.body.review_url, 'https://example.com/review');

    const flexibleSave = await requestJson(`${baseUrl}/api/admin/venue-settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        restaurant_name: 'Mozzo Núñez',
        restaurant_subtitle: '',
        contact_label: 'Web',
        contact_url: 'arma2.com.ar',
        review_url: 'google.com/maps',
        feedback_url: ''
      })
    });
    assert.equal(flexibleSave.response.status, 200);
    assert.equal(flexibleSave.body.contact_url, 'https://arma2.com.ar');
    assert.equal(flexibleSave.body.review_url, 'https://google.com/maps');

    const persisted = await requestJson(`${baseUrl}/api/venue-settings`);
    assert.equal(persisted.response.status, 200);
    assert.equal(persisted.body.restaurant_name, 'Mozzo Núñez');
    assert.equal(persisted.body.contact_label, 'Web');
    assert.ok(persisted.body.updated_at);

    console.log('Sprint 4 backend tests passed');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
