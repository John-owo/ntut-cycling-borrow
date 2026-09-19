// Security regression tests: loopback server hardening, public bundle hygiene, i18n lookup safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

const publicDir = new URL('../public/', import.meta.url);
const raw = (port, { path = '/api/summary', method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, path, method, agent: false, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
    let data = ''; response.on('data', chunk => data += chunk); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: data && /json/.test(response.headers['content-type'] || '') ? JSON.parse(data) : data }));
  });
  request.on('error', reject); request.end(body ? JSON.stringify(body) : undefined);
});

test('Loopback server: Host allowlist blocks DNS rebinding, login has its own throttle, headers and session hygiene', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bike-security-')); let app;
  const start = async extra => { app = createApp({ dbPath: join(dir, 'db.sqlite'), ...extra }); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); return app.server.address().port; };
  try {
    let port = await start({ loginLimit: 3, origins: ['https://club.example'] });
    app.addAdmin('officer', 'test-password-123');
    // Default loopback hosts pass with or without a port; a foreign Host is refused even when the Origin matches it (rebinding).
    for (const host of [`127.0.0.1:${port}`, 'localhost', `localhost:${port}`, `[::1]:${port}`, 'club.example']) assert.equal((await raw(port, { headers: { Host: host } })).status, 200, host);
    for (const host of ['attacker.example', `attacker.example:${port}`, 'club.example.attacker.example']) assert.equal((await raw(port, { headers: { Host: host } })).status, 421, host);
    const missingHost = await new Promise((resolve, reject) => { const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /api/summary HTTP/1.1\r\nConnection: close\r\n\r\n')); let data = ''; const finish = () => { clearTimeout(timer); resolve(data); }; const timer = setTimeout(() => { socket.destroy(); finish(); }, 3000); socket.on('data', c => data += c); socket.on('end', finish); socket.on('close', finish); socket.on('error', reject); });
    assert.doesNotMatch(missingHost, /^HTTP\/1\.1 200 /); // Node rejects HTTP/1.1 without Host itself (requireHostHeader); otherwise the allowlist answers 421
    const rebinding = await raw(port, { headers: { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` } });
    assert.equal(rebinding.status, 421); assert.equal(rebinding.headers['access-control-allow-origin'], undefined);
    assert.equal((await raw(port, { headers: { Origin: 'https://club.example' } })).headers['access-control-allow-origin'], 'https://club.example');
    // Security headers are present on API and static responses alike.
    for (const path of ['/api/summary', '/', '/admin.js']) {
      const response = await raw(port, { path });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin'); assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
      assert.match(response.headers['permissions-policy'], /camera=\(\)/); assert.equal(response.headers['cache-control'], 'no-store');
      const csp = response.headers['content-security-policy'];
      assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /base-uri 'none'/); assert.match(csp, /require-trusted-types-for 'script'/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|connect-src[^;]* https:( |;)/);
    }
    // Login attempts are capped separately from the general API budget; the cap does not reveal whether the account exists.
    const login = body => raw(port, { path: '/api/admin/login', method: 'POST', body });
    for (let i = 0; i < 3; i++) { const attempt = await login({ username: i % 2 ? 'officer' : 'nobody', password: 'wrong-password-xx' }); assert.equal(attempt.status, 401); assert.equal(attempt.body.error, '帳號或密碼不正確'); }
    const blocked = await login({ username: 'officer', password: 'test-password-123' });
    assert.equal(blocked.status, 429); assert.match(blocked.headers['retry-after'], /^\d+$/); assert.ok(Number(blocked.headers['retry-after']) <= 60);
    assert.equal((await raw(port)).status, 200); // other endpoints keep working
    // Sessions never appear in URLs or logs; expired sessions are purged on the next login.
    await app.close(); port = await start();
    const session = (await login({ username: 'officer', password: 'test-password-123' })).body; assert.match(session.token, /^[a-f0-9]{64}$/);
    app.db.prepare("INSERT INTO sessions VALUES('stale-hash','officer',?)").run(Date.now() - 1000);
    assert.equal((await raw(port, { path: '/api/admin/records', headers: { Authorization: 'Bearer stale-hash' } })).status, 401);
    await login({ username: 'officer', password: 'test-password-123' });
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sessions WHERE tokenHash='stale-hash'").get().n, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 2);
    assert.equal((await raw(port, { path: '/api/admin/records?token=' + session.token })).status, 401); // query string is never an auth channel
    assert.equal((await raw(port, { path: '/api/admin/records', headers: { Authorization: `Bearer ${session.token}` } })).status, 200);
    const admin = (path, body) => raw(port, { path, method: 'POST', body, headers: { Authorization: `Bearer ${session.token}` } });
    // Contact link: HTTPS only and never with embedded credentials.
    assert.equal((await admin('/api/admin/settings', { total: 3, contactUrl: 'https://officer:secret@example.org/' })).status, 400);
    assert.equal((await admin('/api/admin/settings', { total: 3, contactUrl: 'https://example.org/contact' })).status, 200);
    // Multibyte JSON split across TCP chunks must be decoded intact, not as replacement characters.
    const name = '吳測試'.repeat(8); const payload = Buffer.from(JSON.stringify({ studentId: 'utf8-1', name, contactType: 'line', contact: 'test-only', token: 'c'.repeat(64) }));
    const cut = payload.indexOf(Buffer.from('吳')) + 1;
    const split = await new Promise((resolve, reject) => { const request = http.request({ host: '127.0.0.1', port, path: '/api/register', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json' } }, response => { let data = ''; response.on('data', c => data += c); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) })); }); request.on('error', reject); request.write(payload.subarray(0, cut)); setTimeout(() => request.end(payload.subarray(cut)), 30); });
    assert.equal(split.status, 200); assert.equal(split.body.record.name, name);
    // Static allowlist: traversal-shaped paths and unknown files are 404, never read from disk.
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/server/app.mjs', '/data/bikes.sqlite', '/.git/config']) assert.equal((await raw(port, { path })).status, 404, path);
  } finally { await app?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Public bundle contains no secret credentials and keeps the CSP without inline execution', () => {
  const files = readdirSync(publicDir).filter(f => /\.(js|html|css)$/.test(f));
  assert.ok(files.length >= 8);
  for (const file of files) {
    const source = readFileSync(new URL(file, publicDir), 'utf8');
    assert.doesNotMatch(source, /sb_secret_/, file);
    assert.doesNotMatch(source, /service_role["']?\s*[:=]/, file);
    for (const jwt of source.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || []) {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')); assert.notEqual(payload.role, 'service_role', file);
    }
    assert.doesNotMatch(source, /-----BEGIN [A-Z ]*PRIVATE KEY/, file);
    if (file.endsWith('.js')) { assert.doesNotMatch(source, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, file); }
    if (file.endsWith('.html')) {
      const csp = source.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]; assert.ok(csp, `${file} must declare a CSP`);
      assert.match(csp, /script-src 'self'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /base-uri 'none'/); assert.match(csp, /require-trusted-types-for 'script'/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
      assert.doesNotMatch(source, /<script(?![^>]*\bsrc=)[^>]*>[^<]/, `${file} must not use inline scripts`);
      assert.doesNotMatch(source, /\son[a-z]+="/i, `${file} must not use inline event handlers`);
      for (const anchor of source.match(/<a [^>]*target="_blank"[^>]*>/g) || []) assert.match(anchor, /rel="[^"]*noopener/, anchor);
    }
  }
  const config = readFileSync(new URL('config.js', publicDir), 'utf8');
  assert.match(config, /mode: "local"/); assert.match(config, /supabaseKey: ""/);
  // Officer desk refuses to run framed (Pages cannot send frame-ancestors) and signs out idle sessions.
  const admin = readFileSync(new URL('admin.js', publicDir), 'utf8');
  assert.match(admin, /window\.self!==window\.top/); assert.match(admin, /idleLimit=30\*60\*1000/);
});

test('Deploy workflow tests pull requests but only publishes from pushes to main with least privilege', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/);
  assert.match(workflow, /if: \$\{\{ github\.event_name != 'pull_request' && vars\.SUPABASE_URL/);
  assert.match(workflow, /^permissions:\n\s+contents: read/m);
  assert.match(workflow, /npm audit --audit-level=high/);
  for (const use of workflow.match(/uses: [^\n]+/g)) assert.match(use, /@[0-9a-f]{40}( #|$)/, use); // every action pinned to a commit SHA
});

test('i18n translate never resolves prototype properties for member-supplied text', async t => {
  const previous = Object.fromEntries(['localStorage', 'MutationObserver'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.localStorage = { getItem: key => key === 'bike-language' ? 'en' : null, setItem() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.after(() => { for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } });
  const { translate } = await import('../public/i18n.js');
  assert.equal(translate('北科大自由車社'), 'NTUT Cycling Club');
  for (const text of ['constructor', '__proto__', 'toString', 'hasOwnProperty', ' valueOf ']) assert.equal(translate(text), text);
  assert.equal(translate('車號／備註：constructor'), 'Bike / notes: constructor');
});
