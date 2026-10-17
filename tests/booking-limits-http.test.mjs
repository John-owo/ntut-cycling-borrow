import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';

test('SQLite booking: terms consent on every booking, two non-overlapping bookings per student', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bike-booking-limits-'));
  const app = createApp({ dbPath: join(dir, 'db.sqlite'), rateLimit: 1000 });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let bearer;
  const call = async (path, body, admin = false) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, ...await response.json() }; };
  const staff = (action, payload = {}) => call('/api/admin/lifecycle', { action, payload }, true);
  const member = (action, token, payload = {}) => call('/api/lifecycle', { action, token, payload });
  const key = () => randomBytes(32).toString('hex'), hour = 3600000, at = ms => new Date(Date.now() + ms).toISOString();
  try {
    app.addAdmin('officer', 'test-password-123');
    bearer = (await call('/api/admin/login', { username: 'officer', password: 'test-password-123' })).token;
    const policy = (await staff('settings', { location: '測試社辦', terms: '測試規範' })).settings;
    assert.equal(policy.bookingConsent, true);
    const bikes = []; for (let i = 1; i <= 4; i++) bikes.push((await staff('asset', { code: `B-${i}`, name: `測試車${i}`, kind: 'bike', state: 'available', reason: '盤點' })).asset);
    const apply = async (studentId, bike, start, end, extra = {}) => { const k = key(); return { ...await member('apply', null, { requestId: randomUUID(), studentId, name: '測試社員', assetIds: [bike.id], start: at(start), end: at(end), key: k, accepted: true, termsVersion: policy.termsVersion, ...extra }), key: k }; };

    const { accepted, ...noConsent } = { requestId: randomUUID(), studentId: 'T1', name: '測試社員', assetIds: [bikes[0].id], start: at(hour), end: at(2 * hour), key: key(), accepted: true };
    assert.equal((await member('apply', null, noConsent)).status, 409, 'consent is required');
    assert.equal((await apply('T1', bikes[0], hour, 2 * hour, { accepted: false })).status, 409);
    const stale = await apply('T1', bikes[0], hour, 2 * hour, { termsVersion: '0'.repeat(64) });
    assert.equal(stale.status, 409); assert.match(stale.error, /規範/);

    const first = await apply('T1', bikes[0], hour, 3 * hour);
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(first.reservation.consent.termsVersion, policy.termsVersion); assert.ok(Date.parse(first.reservation.consent.acceptedAt));
    const overlap = await apply('T1', bikes[1], 2 * hour, 4 * hour);
    assert.equal(overlap.status, 409); assert.match(overlap.error, /時段重疊/);
    const second = await apply('T1', bikes[1], 3 * hour, 5 * hour);
    assert.equal(second.status, 200, 'back-to-back is not an overlap');
    const third = await apply('t1', bikes[2], 6 * hour, 7 * hour);
    assert.equal(third.status, 409); assert.match(third.error, /兩筆/);
    assert.equal((await apply('T2', bikes[2], 2 * hour, 4 * hour)).status, 200, 'another student is unaffected');
    assert.equal((await member('cancel', second.key, { requestId: randomUUID(), reservationId: second.reservation.id, reason: '改期' })).reservation.status, 'cancelled');
    assert.equal((await apply('T1', bikes[0], 6 * hour, 7 * hour)).status, 200, 'a cancelled booking frees its slot; same bike is fine when times do not overlap');

    const token = key();
    await staff('member', { studentId: 'M1', name: '社員一', contact: 'ig', validUntil: at(9 * 24 * hour), active: true, token, reason: '核對' });
    const reserve = (bike, start, end, extra = {}) => member('reserve', token, { requestId: randomUUID(), assetIds: [bike.id], start: at(start), end: at(end), accepted: true, termsVersion: policy.termsVersion, ...extra });
    assert.equal((await reserve(bikes[3], hour, 2 * hour, { accepted: false })).status, 409);
    assert.equal((await reserve(bikes[3], hour, 2 * hour)).reservation.consent.termsVersion, policy.termsVersion);
    assert.equal((await reserve(bikes[3], 10 * hour, 11 * hour)).status, 200);
    assert.equal((await reserve(bikes[3], 12 * hour, 13 * hour)).status, 409);
  } finally { await app.close?.(); app.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('SQLite booking: an overdue bike blocks new bookings until it is returned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bike-booking-overdue-'));
  const app = createApp({ dbPath: join(dir, 'db.sqlite'), rateLimit: 1000 });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let bearer;
  const call = async (path, body, admin = false) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, ...await response.json() }; };
  const staff = (action, payload = {}) => call('/api/admin/lifecycle', { action, payload }, true);
  const key = () => randomBytes(32).toString('hex'), hour = 3600000, at = ms => new Date(Date.now() + ms).toISOString();
  try {
    app.addAdmin('officer', 'test-password-123');
    bearer = (await call('/api/admin/login', { username: 'officer', password: 'test-password-123' })).token;
    const policy = (await staff('settings', { location: '測試社辦', terms: '測試規範' })).settings;
    const bikes = []; for (let i = 1; i <= 3; i++) bikes.push((await staff('asset', { code: `O-${i}`, name: `測試車${i}`, kind: 'bike', state: 'available', reason: '盤點' })).asset);
    const apply = (studentId, bike, start, end) => call('/api/lifecycle', { action: 'apply', token: null, payload: { requestId: randomUUID(), studentId, name: '測試社員', assetIds: [bike.id], start: at(start), end: at(end), key: key(), accepted: true, termsVersion: policy.termsVersion } });
    const out = (await apply('O1', bikes[0], hour, 2 * hour)).reservation;
    // Fixture: the bike went out and its return time has passed.
    app.db.prepare("UPDATE lifecycle_reservations SET status='in_use',start=?,end=?,pickedUpAt=? WHERE id=?").run(at(-3 * hour), at(-hour), at(-3 * hour), out.id);
    const blocked = await apply('o1', bikes[1], 3 * hour, 4 * hour);
    assert.equal(blocked.status, 409); assert.match(blocked.error, /逾期/);
    assert.equal((await apply('O2', bikes[1], 3 * hour, 4 * hour)).status, 200, 'another student is unaffected');
    app.db.prepare("UPDATE lifecycle_reservations SET status='returned',returnedAt=? WHERE id=?").run(at(0), out.id);
    assert.equal((await apply('O1', bikes[2], 5 * hour, 6 * hour)).status, 200, 'returning the bike lifts the block');
  } finally { app.server.closeAllConnections(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
