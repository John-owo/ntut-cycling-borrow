import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { createApp } from '../server/app.mjs';

function drawnPng(width=120,height=40,noisy=false) {
  const pixels = noisy?randomBytes(height * (1 + width * 4)):Buffer.alloc(height * (1 + width * 4), 255);
  for (let y = 0; y < height; y++) pixels[y * (1 + width * 4)] = 0;
  for (let x = 10; x < 110; x++) for (let dy = 0; dy < 2; dy++) {
    const y = 10 + Math.floor((x - 10) / 5) + dy;
    if (y < height) pixels.fill(0, y * (1 + width * 4) + 1 + x * 4, y * (1 + width * 4) + 1 + x * 4 + 3);
  }
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const kind = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([kind, data]))); return Buffer.concat([length, kind, data, checksum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

function cleanupTestDir(dir, prefix) {
  assert.equal(resolve(dirname(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith(prefix));
  rmSync(dir, { recursive: true, force: true });
}

test('SQLite HTTP lifecycle persists gated reservation, immutable photos, abnormal review and retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bike-lifecycle-'));
  const dbPath = join(dir, 'db.sqlite');
  let app, base, bearer;
  const start = async () => { app = createApp({ dbPath, rateLimit: 1000 }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; };
  const call = async (path, body, admin = false) => { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, ...await response.json() }; };
  const staff = (action, payload = {}) => call('/api/admin/lifecycle', { action, payload }, true);
  const member = (action, token, payload = {}) => call('/api/lifecycle', { action, token, payload });
  const uid = () => randomUUID();
  const png = drawnPng();
  const all = { frame: true, tires: true, brakes: true, gears: true, accessories: true };
  try {
    await start(); app.addAdmin('officer', 'test-password-123');
    bearer = (await call('/api/admin/login', { username: 'officer', password: 'test-password-123' })).token;
    assert.equal((await call('/api/admin/lifecycle', { action: 'list', payload: {} })).status, 401);
    // The legacy total is closed and never set here: numbered bikes become available without it.
    assert.equal((await call('/api/admin/settings', { total: 2, contactUrl: '' }, true)).status, 410);
    const asset = (await staff('asset', { code: 'B-01', name: '測試車', kind: 'bike', state: 'available', reason: '盤點' })).asset;
    const accessory = (await staff('asset', { code: 'H-01', name: '安全帽', kind: 'accessory', state: 'available', reason: '盤點' })).asset;
    const t1 = randomBytes(32).toString('hex'), t2 = randomBytes(32).toString('hex');
    const until = new Date(Date.now() + 7 * 86400000).toISOString();
    const member1 = (await staff('member', { studentId: 'S001', name: '測試社員一', contact: 'test', validUntil: until, active: true, token: t1, reason: '測試核對' })).member;
    await staff('member', { studentId: 'S002', name: '測試社員二', contact: 'test', validUntil: until, active: true, token: t2, reason: '測試核對' });
    assert.equal((await member('reserve', t1, { requestId: uid(), assetIds: [asset.id], start: new Date(Date.now() + 500).toISOString(), end: new Date(Date.now() + 3600000).toISOString() })).status, 409);
    const settings = (await staff('settings', { location: '測試社辦', terms: '測試借車規範' })).settings;
    assert.deepEqual(Object.keys(settings).sort(), ['location', 'terms', 'termsVersion']);
    assert.equal((await staff('settings', { location: '測試社辦', terms: '測試借車規範', extra: 'x' })).status, 400);
    assert.equal((await staff('settings', { location: '測試社辦' })).status, 400);
    const startAt = new Date(Date.now() + 700).toISOString(), endAt = new Date(Date.now() + 3600000).toISOString();
    const reserve = { requestId: uid(), assetIds: [asset.id, accessory.id], start: startAt, end: endAt };
    const first = await member('reserve', t1, reserve);
    assert.equal(first.status, 200); assert.equal(first.reservation.status, 'reserved');
    assert.deepEqual(first.reservation.borrower, { studentId: 'S001', name: '測試社員一', contact: 'test' });
    assert.equal((await call('/api/register', { studentId: 'S001', name: '測試社員一', contactType: 'line', contact: 'test', purpose: 'group_ride', token: randomBytes(32).toString('hex') })).status, 410);
    assert.equal((await call('/api/me', { token: randomBytes(32).toString('hex') })).status, 410);
    for (const [path, body] of [['/api/admin/action', { id: 1, action: 'lend' }], ['/api/admin/confirm-schedule', { id: 1 }], ['/api/admin/borrowed', { borrowed: 1, expectedBorrowed: 0, expectedOpening: 0, requestId: uid(), reason: 'x' }]]) assert.equal((await call(path, body, true)).status, 410, path);
    assert.equal((await call('/api/admin/action', { id: 1, action: 'lend' })).status, 401, 'closed officer routes still require login');
    assert.equal((await member('reserve', t1, reserve)).reservation.id, first.reservation.id);
    assert.equal((await member('reserve', t1, { ...reserve, end: new Date(Date.now() + 7200000).toISOString() })).status, 409);
    assert.equal((await member('reserve', t2, { requestId: uid(), assetIds: [asset.id], start: startAt, end: endAt })).status, 409);
    assert.equal((await member('reserve', t2, { requestId: uid(), assetIds: [accessory.id], start: startAt, end: endAt })).status, 409);
    const calendar = await member('calendar', undefined, { start: new Date(Date.now() - 1000).toISOString(), end: endAt });
    assert.equal(calendar.bookings[0].status, 'reserved'); assert.equal(JSON.stringify(calendar).includes(member1.studentId), false);
    assert.equal((await member('pickup', t1, { requestId: uid(), reservationId: first.reservation.id, checks: all, notes: '', signature: { name: member1.name, accepted: true, termsVersion: settings.termsVersion, image: `data:image/png;base64,${png}` } })).status, 409);
    await delay(Math.max(0, Date.parse(startAt) - Date.now() + 30));
    // A genuine 4.8 MB camera-sized PNG exercises JSON limits and base64 parsing.
    const cameraPng=drawnPng(1200,1000,true);assert.ok(Buffer.from(cameraPng,'base64').length>3*1024*1024);
    const upload = slot => ({ requestId: uid(), reservationId: first.reservation.id, assetId: asset.id, phase: 'pickup', slot, mime: 'image/png', data: slot==='left'?cameraPng:png });
    const photo = await member('photo', t1, upload('left'));
    assert.equal(photo.status, 200); assert.equal((await member('photo_read', t2, { id: photo.photo.id })).status, 404);
    assert.throws(() => app.db.prepare('UPDATE lifecycle_photos SET data=? WHERE id=?').run(Buffer.from('replacement'), photo.photo.id), /immutable evidence/);
    assert.equal(app.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal((await member('photo', t1, { ...upload('right'), mime: 'image/jpeg' })).status, 400);
    assert.equal((await member('pickup', t1, { requestId: uid(), reservationId: first.reservation.id, checks: all, notes: '', signature: { name: member1.name, accepted: true, termsVersion: settings.termsVersion, image: `data:image/png;base64,${png}` } })).status, 409);
    for (const slot of ['right', 'drivetrain', 'damage']) assert.equal((await member('photo', t1, upload(slot))).status, 200);
    const pickup = { requestId: uid(), reservationId: first.reservation.id, checks: all, notes: '原有刮痕', signature: { name: member1.name, accepted: true, termsVersion: settings.termsVersion, image: `data:image/png;base64,${png}` } };
    assert.equal((await member('pickup', t1, { ...pickup, requestId: uid(), checks: { ...all, brakes: false } })).status, 400);
    assert.equal((await member('pickup', t1, { ...pickup, requestId: uid(), signature: { ...pickup.signature, termsVersion: 'stale' } })).status, 409);
    assert.equal((await member('pickup', t1, { ...pickup, requestId: uid(), signature: { ...pickup.signature, image: 'data:image/png;base64,ZmFrZQ==' } })).status, 400);
    assert.equal((await staff('member', { id: member1.id, studentId: 'S001', name: '測試社員一', contact: 'test', validUntil: until, active: false, reason: '暫停資格' })).status, 200);
    assert.equal((await member('pickup', t1, { ...pickup, requestId: uid() })).status, 403);
    await staff('member', { id: member1.id, studentId: 'S001', name: '測試社員一', contact: 'test', validUntil: until, active: true, reason: '恢復資格' });
    const begun = await member('pickup', t1, pickup);
    assert.equal(begun.status, 200); assert.equal(begun.reservation.status, 'in_use');
    assert.equal((await call('/api/summary')).status, 410);
    assert.equal((await call('/api/admin/records', undefined, true)).summary.borrowed, 0, 'numbered loans stay out of the legacy count');
    assert.equal((await member('pickup', t1, pickup)).reservation.pickedUpAt, begun.reservation.pickedUpAt);
    const read = await member('photo_read', t1, { id: photo.photo.id }); assert.equal(read.photo.data, cameraPng);
    assert.equal((await member('return', t1, { requestId: uid(), reservationId: first.reservation.id, checks: all, notes: '', abnormal: false })).status, 409);
    await staff('member', { id: member1.id, studentId: 'S001', name: '測試社員一', contact: 'test', validUntil: until, active: false, reason: '期中停權' });
    for (const slot of ['left', 'right', 'drivetrain', 'damage']) assert.equal((await member('photo', t1, { ...upload(slot), phase: 'return' })).status, 200);
    const back = { requestId: uid(), reservationId: first.reservation.id, checks: { ...all, brakes: false }, notes: '煞車需檢查', abnormal: false };
    const returned = await member('return', t1, back);
    assert.equal(returned.reservation.status, 'inspection'); assert.equal(returned.reservation.photos.length, 8);
    assert.equal((await member('return', t1, back)).reservation.returnedAt, returned.reservation.returnedAt);
    assert.equal((await member('reserve', t2, { requestId: uid(), assetIds: [asset.id], start: new Date(Date.now() + 1000).toISOString(), end: new Date(Date.now() + 3600000).toISOString() })).status, 409);
    assert.equal((await staff('list')).notifications.filter(n => !n.resolvedAt).length, 1);
    assert.equal((await staff('resolve', { requestId: uid(), reservationId: first.reservation.id, reason: '測試完成檢查', state: 'available' })).reservation.status, 'returned');
    assert.equal((await staff('asset', { id: asset.id, code: 'B-RENAMED', name: '測試車', kind: 'bike', state: 'available', reason: '測試變更歷史編號' })).status, 409);
    assert.equal((await staff('asset', { id: asset.id, code: 'B-01', name: '測試車', kind: 'accessory', state: 'available', reason: '測試變更歷史類型' })).status, 409);
    assert.equal((await staff('list')).notifications.filter(n => !n.resolvedAt).length, 0);
    assert.equal((await member('me', t1)).reservations[0].photos.length, 8);
    assert.equal((await member('me', t2)).reservations.length, 0);
    await app.close(); await start();
    assert.equal((await member('photo_read', t1, { id: photo.photo.id })).photo.data, cameraPng);
    assert.equal((await member('reserve', t1, reserve)).reservation.id, first.reservation.id);
    bearer = (await call('/api/admin/login', { username: 'officer', password: 'test-password-123' })).token;
    const backup = await call('/api/admin/export', undefined, true);
    assert.equal(backup.lifecycle.photos.length, 8);
    assert.ok(backup.lifecycle.members[0].tokenHash);
    assert.equal(JSON.stringify(await staff('list')).includes(t1), false);
  } finally { await app?.close(); cleanupTestDir(dir, 'bike-lifecycle-'); }
});

test('SQLite HTTP serializes competing reservations and blocks adjacent pickup during overdue use', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bike-lifecycle-race-'));
  let app, base, bearer;
  const call = async (path, body, admin = false) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, ...await response.json() }; };
  const staff = (action, payload) => call('/api/admin/lifecycle', { action, payload }, true);
  const member = (action, token, payload) => call('/api/lifecycle', { action, token, payload });
  const photoData = drawnPng();
  const all = { frame: true, tires: true, brakes: true, gears: true, accessories: true };
  try {
    app = createApp({ dbPath: join(dir, 'db.sqlite'), rateLimit: 1000 }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
    app.addAdmin('officer', 'test-password-123'); bearer = (await call('/api/admin/login', { username: 'officer', password: 'test-password-123' })).token;
    const asset = (await staff('asset', { code: 'B-02', name: '測試車', kind: 'bike', state: 'available', reason: '盤點' })).asset;
    const termsVersion = (await staff('settings', { location: '測試', instructions: '測試', terms: '測試規範' })).settings.termsVersion;
    const t1 = randomBytes(32).toString('hex'), t2 = randomBytes(32).toString('hex');
    for (const [studentId, name, token] of [['R001', '社員甲', t1], ['R002', '社員乙', t2]]) await staff('member', { studentId, name, contact: 'test', validUntil: new Date(Date.now() + 86400000).toISOString(), active: true, token, reason: '測試' });
    const startAt = new Date(Date.now() + 300).toISOString(), endAt = new Date(Date.now() + 1800).toISOString(), after = new Date(Date.now() + 6000).toISOString();
    const racers = await Promise.all([member('reserve', t1, { requestId: randomUUID(), assetIds: [asset.id], start: startAt, end: endAt }), member('reserve', t2, { requestId: randomUUID(), assetIds: [asset.id], start: startAt, end: endAt })]);
    assert.deepEqual(racers.map(r => r.status).sort(), [200, 409]);
    const winner = racers[0].status === 200 ? { token: t1, name: '社員甲', reservation: racers[0].reservation } : { token: t2, name: '社員乙', reservation: racers[1].reservation };
    const loser = racers[0].status === 200 ? { token: t2, name: '社員乙' } : { token: t1, name: '社員甲' };
    const adjacent = await member('reserve', loser.token, { requestId: randomUUID(), assetIds: [asset.id], start: endAt, end: after });
    assert.equal(adjacent.status, 200);
    await delay(Math.max(0, Date.parse(startAt) - Date.now() + 20));
    for (const slot of ['left', 'right', 'drivetrain', 'damage']) assert.equal((await member('photo', winner.token, { requestId: randomUUID(), reservationId: winner.reservation.id, assetId: asset.id, phase: 'pickup', slot, mime: 'image/png', data: photoData })).status, 200);
    const sign = name => ({ name, accepted: true, termsVersion, image: `data:image/png;base64,${photoData}` });
    assert.equal((await member('pickup', winner.token, { requestId: randomUUID(), reservationId: winner.reservation.id, checks: all, notes: '', signature: sign(winner.name) })).status, 200);
    await delay(Math.max(0, Date.parse(endAt) - Date.now() + 20));
    for (const slot of ['left', 'right', 'drivetrain', 'damage']) assert.equal((await member('photo', loser.token, { requestId: randomUUID(), reservationId: adjacent.reservation.id, assetId: asset.id, phase: 'pickup', slot, mime: 'image/png', data: photoData })).status, 200);
    assert.equal((await member('pickup', loser.token, { requestId: randomUUID(), reservationId: adjacent.reservation.id, checks: all, notes: '', signature: sign(loser.name) })).status, 409);
    for (const slot of ['left', 'right', 'drivetrain', 'damage']) assert.equal((await member('photo', winner.token, { requestId: randomUUID(), reservationId: winner.reservation.id, assetId: asset.id, phase: 'return', slot, mime: 'image/png', data: photoData })).status, 200);
    assert.equal((await member('return', winner.token, { requestId: randomUUID(), reservationId: winner.reservation.id, checks: all, notes: '', abnormal: false })).status, 200);
    assert.equal((await member('pickup', loser.token, { requestId: randomUUID(), reservationId: adjacent.reservation.id, checks: all, notes: '', signature: sign(loser.name) })).status, 200);
  } finally { await app?.close(); cleanupTestDir(dir, 'bike-lifecycle-race-'); }
});

test('SQLite photo budget reserves mandatory slots and releases reservations without touching originals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bike-lifecycle-budget-'));
  let app, base, bearer;
  const call = async (path, body, admin = false) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, ...await response.json() }; };
  const staff = (action, payload = {}) => call('/api/admin/lifecycle', { action, payload }, true);
  const member = (action, token, payload = {}) => call('/api/lifecycle', { action, token, payload });
  const MiB = 1024 * 1024;
  try {
    app = createApp({ dbPath: join(dir, 'db.sqlite') }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
    app.addAdmin('officer', 'test-password-123'); bearer = (await call('/api/admin/login', { username: 'officer', password: 'test-password-123' })).token;
    const staged = (await staff('asset', { code: 'B-STAGED', name: '待盤點車', kind: 'bike', state: 'inspection', reason: '新車盤點' })).asset;
    assert.equal((await staff('asset', { id: staged.id, code: staged.code, name: staged.name, kind: staged.kind, state: 'available', reason: '盤點完成' })).status, 200);
    const other = (await staff('asset', { code: 'B-OTHER', name: '第二台車', kind: 'bike', state: 'available', reason: '盤點完成' })).asset;
    await staff('settings', { location: '測試', instructions: '測試', terms: '測試規範' });
    const token1 = randomBytes(32).toString('hex'), token2 = randomBytes(32).toString('hex'), validUntil = new Date(Date.now() + 86400000).toISOString();
    const owner = (await staff('member', { studentId: 'BUDGET1', name: '容量測試一', contact: 'test', validUntil, active: true, token: token1, reason: '測試' })).member;
    await staff('member', { studentId: 'BUDGET2', name: '容量測試二', contact: 'test', validUntil, active: true, token: token2, reason: '測試' });
    // Metadata-only synthetic history exercises capacity arithmetic without allocating huge image files.
    const oldId = randomUUID(), past = new Date(Date.now() - 86400000).toISOString();
    app.db.prepare("INSERT INTO lifecycle_reservations(id,memberId,borrower,start,end,status,createdAt,returnedAt) VALUES(?,?,?,?,?,'returned',?,?)").run(oldId, owner.id, JSON.stringify({ studentId: owner.studentId, name: owner.name, contact: owner.contact }), past, past, past, past);
    app.db.prepare('INSERT INTO lifecycle_photos VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), oldId, staged.id, 'return', 'left', 'image/jpeg', 120 * MiB, 'synthetic', past, Buffer.of(1));
    const start = new Date(Date.now() + 300).toISOString(), end = new Date(Date.now() + 3600000).toISOString();
    const first = await member('reserve', token1, { requestId: randomUUID(), assetIds: [staged.id], start, end });
    assert.equal(first.status, 200);
    let usage = (await staff('list')).storage;
    assert.deepEqual(usage, { usedBytes: 120 * MiB, reservedBytes: 64 * MiB, budgetBytes: 192 * MiB, maxPhotoBytes: 8 * MiB });
    assert.equal((await member('reserve', token2, { requestId: randomUUID(), assetIds: [other.id], start, end })).status, 409);
    await delay(Math.max(0, Date.parse(start) - Date.now() + 20));
    const syntheticPhoto = slot => app.db.prepare('INSERT INTO lifecycle_photos VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), first.reservation.id, staged.id, 'pickup', slot, 'image/jpeg', 8 * MiB, 'synthetic', new Date().toISOString(), Buffer.of(1));
    syntheticPhoto('left'); syntheticPhoto('left');
    usage = (await staff('list')).storage;
    assert.equal(usage.usedBytes + usage.reservedBytes, 192 * MiB);
    assert.equal(usage.reservedBytes, 56 * MiB, 'second image for the same slot does not release return or pickup headroom');
    assert.equal((await member('photo', token1, { requestId: randomUUID(), reservationId: first.reservation.id, assetId: staged.id, phase: 'pickup', slot: 'left', mime: 'image/png', data: drawnPng() })).status, 409);
    assert.equal((await member('cancel', token1, { requestId: randomUUID(), reservationId: first.reservation.id, reason: '容量測試取消' })).status, 200);
    assert.equal((await staff('list')).storage.reservedBytes, 0);
    assert.equal((await staff('list')).storage.usedBytes, 136 * MiB, 'historical originals remain counted');
  } finally { await app?.close(); cleanupTestDir(dir, 'bike-lifecycle-budget-'); }
});
