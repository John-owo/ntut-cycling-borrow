import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { createApp } from '../server/app.mjs';

function drawnPng(width = 120, height = 40) {
  const pixels = Buffer.alloc(height * (1 + width * 4), 255);
  for (let y = 0; y < height; y++) pixels[y * (1 + width * 4)] = 0;
  for (let x = 10; x < 110; x++) pixels.fill(0, (10 + Math.floor((x - 10) / 5)) * (1 + width * 4) + 1 + x * 4, (10 + Math.floor((x - 10) / 5)) * (1 + width * 4) + 1 + x * 4 + 3);
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const kind = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([kind, data]))); return Buffer.concat([length, kind, data, checksum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test('SQLite self-service booking: applicant key, officer approval, scoped access and key reissue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bike-self-service-'));
  const app = createApp({ dbPath: join(dir, 'db.sqlite'), rateLimit: 1000 });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let bearer;
  const call = async (path, body, admin = false) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, ...await response.json() }; };
  const staff = (action, payload = {}) => call('/api/admin/lifecycle', { action, payload }, true);
  const member = (action, token, payload = {}) => call('/api/lifecycle', { action, token, payload });
  const key = () => randomBytes(32).toString('hex');
  const png = drawnPng(), all = { frame: true, tires: true, brakes: true, gears: true, accessories: true };
  try {
    app.addAdmin('officer', 'test-password-123');
    bearer = (await call('/api/admin/login', { username: 'officer', password: 'test-password-123' })).token;
    await call('/api/admin/settings', { total: 3, contactUrl: '' }, true);
    const policy = (await staff('settings', { location: '測試社辦', instructions: '測試取車', terms: '測試規範' })).settings;
    const bike = (await staff('asset', { code: 'B-1', name: '測試車', kind: 'bike', state: 'available', reason: '盤點' })).asset;
    const other = (await staff('asset', { code: 'B-2', name: '測試車二', kind: 'bike', state: 'available', reason: '盤點' })).asset;
    const k1 = key(), k2 = key();
    const apply = { requestId: randomUUID(), studentId: 't111', name: '自助社員', assetIds: [bike.id], start: new Date(Date.now() + 600).toISOString(), end: new Date(Date.now() + 3600000).toISOString(), key: k1 };
    const first = await member('apply', null, apply);
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(first.reservation.approval, 'pending'); assert.equal(first.reservation.selfService, true);
    assert.deepEqual(first.reservation.borrower, { studentId: 'T111', name: '自助社員', contact: '' });
    assert.equal(JSON.stringify(first).includes(k1), false); assert.equal(JSON.stringify(first).includes('accessHash'), false);
    assert.equal((await member('apply', null, apply)).reservation.id, first.reservation.id, 'retry is idempotent');
    assert.equal((await member('apply', null, { ...apply, requestId: randomUUID(), key: k2 })).status, 409, 'slot already held');
    assert.equal((await member('apply', null, { ...apply, requestId: randomUUID(), assetIds: [other.id], key: k2 })).status, 409, 'one active booking per student');
    assert.equal((await member('apply', null, { ...apply, requestId: randomUUID(), studentId: 'bad id!', key: k2 })).status, 400);
    const calendar = await member('calendar', null, { start: new Date().toISOString(), end: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(calendar.bookings[0].pending, true); assert.equal(JSON.stringify(calendar).includes('自助社員'), false);
    const mine = await member('me', k1);
    assert.equal(mine.reservations.length, 1); assert.equal(mine.reservations[0].id, first.reservation.id);
    assert.equal((await member('reserve', k1, { requestId: randomUUID(), assetIds: [other.id], start: new Date(Date.now() + 7200000).toISOString(), end: new Date(Date.now() + 9000000).toISOString() })).status, 403);
    await delay(700);
    const photo = slot => ({ requestId: randomUUID(), reservationId: first.reservation.id, assetId: bike.id, phase: 'pickup', slot, mime: 'image/png', data: png });
    assert.equal((await member('photo', k1, photo('left'))).status, 409, 'pickup photos wait for approval');
    const sign = { requestId: randomUUID(), reservationId: first.reservation.id, checks: all, notes: '', signature: { name: '自助社員', accepted: true, termsVersion: policy.termsVersion, image: 'data:image/png;base64,' + png } };
    assert.equal((await member('pickup', k1, sign)).status, 409);
    const list = await staff('list');
    assert.equal(list.reservations[0].approval, 'pending');
    assert.equal(list.members.find(m => m.studentId === 'T111').name, '自助社員');
    const approved = await staff('approve', { requestId: randomUUID(), reservationId: first.reservation.id });
    assert.equal(approved.reservation.approval, 'approved'); assert.ok(approved.reservation.approvedAt);
    assert.equal((await staff('approve', { requestId: randomUUID(), reservationId: first.reservation.id })).status, 409);
    for (const slot of ['left', 'right', 'drivetrain', 'damage']) assert.equal((await member('photo', k1, photo(slot))).status, 200);
    assert.equal((await member('pickup', k1, { ...sign, requestId: randomUUID(), signature: { ...sign.signature, name: '別人' } })).status, 409, 'signature must match applicant name');
    assert.equal((await member('pickup', k1, sign)).reservation.status, 'in_use');
    // A lost device: officer issues a new key; the old one stops working.
    const k3 = key();
    assert.equal((await staff('access', { requestId: randomUUID(), reservationId: first.reservation.id, key: k3 })).status, 200);
    assert.equal((await member('me', k1)).status, 401);
    const photos = (await member('me', k3)).reservations[0].photos;
    assert.equal(photos.length, 4);
    assert.equal((await member('photo_read', k3, { id: photos[0].id })).photo.data, png);
    // A second applicant's key cannot read the first booking's evidence.
    const k4 = key();
    const second = await member('apply', null, { requestId: randomUUID(), studentId: 'T222', name: '另一位', assetIds: [other.id], start: new Date(Date.now() + 7200000).toISOString(), end: new Date(Date.now() + 9000000).toISOString(), key: k4 });
    assert.equal(second.status, 200);
    assert.equal((await member('photo_read', k4, { id: photos[0].id })).status, 404);
    assert.equal((await member('return', k4, { requestId: randomUUID(), reservationId: first.reservation.id, checks: all, notes: '', abnormal: false })).status, 404);
    assert.equal((await member('cancel', k4, { requestId: randomUUID(), reservationId: second.reservation.id, reason: '改期' })).reservation.status, 'cancelled');
    for (const slot of ['left', 'right', 'drivetrain', 'damage']) assert.equal((await member('photo', k3, { ...photo(slot), phase: 'return' })).status, 200);
    assert.equal((await member('return', k3, { requestId: randomUUID(), reservationId: first.reservation.id, checks: all, notes: '', abnormal: false })).reservation.status, 'returned');
    assert.equal((await staff('access', { requestId: randomUUID(), reservationId: first.reservation.id, key: key() })).status, 409, 'closed bookings keep their key');
    // Officers can still block a student ID.
    const blocked = list.members.find(m => m.studentId === 'T111');
    await staff('member', { id: blocked.id, studentId: 'T111', name: '自助社員', contact: blocked.contact || '-', validUntil: blocked.validUntil, active: false, reason: '停權測試' });
    assert.equal((await member('apply', null, { requestId: randomUUID(), studentId: 'T111', name: '自助社員', assetIds: [bike.id], start: new Date(Date.now() + 7200000).toISOString(), end: new Date(Date.now() + 9000000).toISOString(), key: key() })).status, 403);
  } finally {
    app.server.closeAllConnections(); await app.close();
    assert.equal(resolve(dirname(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('bike-self-service-'));
    rmSync(dir, { recursive: true, force: true });
  }
});
