// Original borrowing photos live in the club's Google Drive. This handler checks the image bytes, asks the
// database whether the member may add the photo, stores it in Drive, then records the Drive file. The
// database stays the authority for every rule; Drive only holds the bytes. Runs on Supabase Edge (Deno)
// and in Node tests: it only uses fetch, Web Crypto, atob/btoa and Response.
const maxPhotoBytes = 8 * 1024 * 1024;
const maxBodyChars = 11_400_000;
const mimes = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const photoKeys = ['requestId', 'reservationId', 'assetId', 'phase', 'slot', 'mime', 'data'];
const tokenPattern = /^[a-f0-9]{64}$/;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

class Failure extends Error { constructor(status, message) { super(message); this.status = status; } }
const reply = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...cors, 'Cache-Control': 'no-store', ...(body === null ? {} : { 'Content-Type': 'application/json' }) } });

const decodeBase64 = text => { const raw = atob(text), bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); return bytes; };
const encodeBase64 = bytes => { let raw = ''; for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(raw); };
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const startsWith = (bytes, hex, offset = 0) => hex.match(/../g).every((h, i) => bytes[offset + i] === parseInt(h, 16));
const signatureMatches = (mime, bytes) => mime === 'image/jpeg' ? startsWith(bytes, 'ffd8ff')
  : mime === 'image/png' ? startsWith(bytes, '89504e470d0a1a0a')
  : startsWith(bytes, '52494646') && startsWith(bytes, '57454250', 8);
const taipeiStamp = date => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

// The service role key: legacy JWT secret or the first new-style secret key.
function serviceKey(env) {
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try { const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}'); return keys.default || Object.values(keys)[0] || ''; } catch { return ''; }
}

export function driveClient({ clientId, clientSecret, refreshToken, folderId, fetch: doFetch }) {
  let cached = null;
  const ready = () => { if (!clientId || !clientSecret || !refreshToken || !folderId) throw new Failure(503, 'Photo storage is not configured; contact officers'); };
  async function token() {
    ready();
    if (cached && cached.expires > Date.now() + 60000) return cached.value;
    const response = await doFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Failure(502, 'Photo storage sign-in failed; contact officers');
    cached = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return cached.value;
  }
  async function call(url, init = {}) {
    const response = await doFetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await token()}` } });
    if (!response.ok) throw new Failure(502, 'Photo storage unavailable; try again later');
    return response;
  }
  return {
    async upload(bytes, { name, mime, properties }) {
      const boundary = `photo-${crypto.randomUUID()}`, encoder = new TextEncoder();
      const head = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: mime, parents: [folderId], appProperties: properties })}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
      const tail = encoder.encode(`\r\n--${boundary}--`), body = new Uint8Array(head.length + bytes.length + tail.length);
      body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
      const file = await (await call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size&supportsAllDrives=true', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).json();
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(file.id || '')) throw new Failure(502, 'Photo storage unavailable; try again later');
      if (Number(file.size) !== bytes.length) { await this.remove(file.id).catch(() => {}); throw new Failure(502, 'Photo storage unavailable; try again later'); }
      return file.id;
    },
    async download(id) { return new Uint8Array(await (await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`)).arrayBuffer()); },
    async remove(id) { await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: 'DELETE' }); },
  };
}

export function createPhotoHandler({ env, fetch: doFetch = fetch, drive = null, now = () => new Date() }) {
  const base = (env('SUPABASE_URL') || '').replace(/\/+$/, '');
  const storage = drive || driveClient({ clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET'), refreshToken: env('GOOGLE_REFRESH_TOKEN'), folderId: env('GOOGLE_DRIVE_FOLDER_ID'), fetch: doFetch });

  async function rpc(name, body, headers) {
    const response = await doFetch(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Failure(response.status >= 500 ? 502 : response.status, data.message || data.msg || 'Photo request failed');
    return data;
  }
  const service = (action, token, payload) => {
    const key = serviceKey(env);
    if (!base || !key) throw new Failure(503, 'Photo storage is not configured; contact officers');
    return rpc('lifecycle_photo_service', { p_action: action, p_token: token, p_payload: payload }, { apikey: key, ...(key.split('.').length === 3 ? { Authorization: `Bearer ${key}` } : {}) });
  };

  async function withBytes(photo) {
    if (!photo || typeof photo !== 'object') throw new Failure(502, 'Photo request failed');
    if (typeof photo.data === 'string' || !photo.driveFileId) return { photo };
    const bytes = await storage.download(photo.driveFileId);
    if (bytes.length !== photo.size || await sha256(bytes) !== photo.sha256) throw new Failure(502, 'Stored photo does not match its record; contact officers');
    const { driveFileId, ...meta } = photo;
    return { photo: { ...meta, data: encodeBase64(bytes) } };
  }

  async function upload(token, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(k => !photoKeys.includes(k)) || photoKeys.some(k => typeof payload[k] !== 'string')) throw new Failure(400, 'Invalid photo');
    if (!mimes[payload.mime]) throw new Failure(400, 'Invalid photo type');
    if (payload.data.length > 11184812 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.data)) throw new Failure(400, 'Invalid photo data');
    const bytes = decodeBase64(payload.data);
    if (bytes.length < 12 || bytes.length > maxPhotoBytes) throw new Failure(400, 'Photo size limit');
    if (!signatureMatches(payload.mime, bytes)) throw new Failure(400, 'Photo signature mismatch');
    const { data, ...fields } = payload, meta = { ...fields, size: bytes.length, sha256: await sha256(bytes) };
    const check = await service('check', token, meta);
    if (check.result) return check.result;
    const stamp = taipeiStamp(now()), name = `${stamp}_${meta.phase}_${meta.slot}_${meta.reservationId.slice(0, 8)}.${mimes[meta.mime]}`;
    const fileId = await storage.upload(bytes, { name, mime: meta.mime, properties: { reservationId: meta.reservationId, phase: meta.phase, slot: meta.slot, sha256: meta.sha256 } });
    let commit;
    try { commit = await service('commit', token, { ...meta, driveFileId: fileId }); }
    catch (error) { await storage.remove(fileId).catch(() => {}); throw error; }
    if (!commit.stored) await storage.remove(fileId).catch(() => {});
    return commit.result;
  }

  return async request => {
    if (request.method === 'OPTIONS') return reply(204, null);
    if (request.method !== 'POST') return reply(405, { message: 'POST required' });
    try {
      const text = await request.text();
      if (text.length > maxBodyChars) throw new Failure(413, 'Photo size limit');
      let body;
      try { body = JSON.parse(text); } catch { throw new Failure(400, 'Invalid request'); }
      if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['action', 'token', 'payload', 'admin'].includes(k))) throw new Failure(400, 'Invalid request');
      const { action, token = null, payload, admin = false } = body;
      if (action === 'photo_read' && admin === true) {
        const auth = request.headers.get('authorization'), apikey = request.headers.get('apikey');
        if (!auth || !apikey) throw new Failure(401, 'Officer sign-in required');
        if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || Object.keys(payload).length !== 1) throw new Failure(400, 'Invalid payload');
        const result = await rpc('lifecycle_admin', { p_action: 'photo_read', p_payload: { id: payload.id } }, { apikey, Authorization: auth });
        return reply(200, await withBytes(result.photo));
      }
      if (admin !== false) throw new Failure(400, 'Invalid request');
      if (typeof token !== 'string' || !tokenPattern.test(token)) throw new Failure(400, 'Invalid member token');
      if (action === 'photo') return reply(200, await upload(token, payload));
      if (action === 'photo_read') return reply(200, await withBytes((await service('read', token, payload)).photo));
      throw new Failure(400, 'Unknown photo action');
    } catch (error) {
      if (error instanceof Failure) return reply(error.status, { message: error.message });
      console.error('lifecycle-photo', error?.name || 'Error');
      return reply(502, { message: 'Photo storage unavailable; try again later' });
    }
  };
}
