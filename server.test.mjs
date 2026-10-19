// node --test: the server on a free port with a throwaway DATA_DIR and made-up keys and builds.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const DATA = mkdtempSync(join(tmpdir(), 'jarvis-apps-'));
process.env.DATA_DIR = DATA;
process.env.APPS_KEY = 'read-key-for-the-tests-0123456789';
process.env.APPS_PUBLISH_KEY = 'publish-key-for-the-tests-0123456789';
process.env.KEEP_VERSIONS = '2';
const { server } = await import('./server.mjs');
let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(DATA, { recursive: true, force: true });
});

const R = { Authorization: `Bearer ${process.env.APPS_KEY}` };
const P = { Authorization: `Bearer ${process.env.APPS_PUBLISH_KEY}` };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const zip = (n) => Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(n, 7)]);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const put = (app, v, p, body, h = {}) => fetch(`${base}/v1/files/${app}/${v}/${p}`, { method: 'PUT', headers: { ...P, 'X-Sha256': sha(body), ...h }, body });
const rel = (b, h = P) => fetch(`${base}/v1/release`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
async function publish(app, v, p, body, extra = {}) {
  assert.equal((await put(app, v, p, body)).status, 200);
  const r = await rel({ id: app, name: app === 'frame' ? 'Frame' : 'Vision', version: v, platform: p, bundleId: `com.krmkrueger.${app}`, minOS: '14.0', ...extra });
  assert.equal(r.status, 200, await r.clone().text());
}

test('health without a key; everything else needs one', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/v1/catalog`)).status, 401);
  assert.equal((await fetch(`${base}/v1/catalog`, { headers: { Authorization: 'Bearer not-the-right-key-at-all' } })).status, 401);
  assert.equal((await fetch(`${base}/v1/catalog`, { headers: R })).status, 200);
});

test('the read key cannot publish', async () => {
  const body = zip(100);
  assert.equal((await fetch(`${base}/v1/files/frame/0.1.0/mac-x64`, { method: 'PUT', headers: { ...R, 'X-Sha256': sha(body) }, body })).status, 403);
  assert.equal((await rel({ id: 'frame', name: 'Frame', version: '0.1.0', platform: 'mac-x64' }, R)).status, 403);
});

test('an upload must be exactly what its hash says, and a release needs its upload', async () => {
  const body = zip(1000);
  const bad = await put('frame', '0.1.0', 'mac-x64', body, { 'X-Sha256': sha(Buffer.from('other')) });
  assert.equal(bad.status, 400);
  assert.deepEqual(readdirSync(join(DATA, 'tmp')), []);
  assert.equal((await rel({ id: 'frame', name: 'Frame', version: '0.1.0', platform: 'mac-x64' })).status, 409);
  assert.equal((await rel({ id: '../x', name: 'X', version: '0.1.0', platform: 'mac-x64' })).status, 400);
  assert.equal((await rel({ id: 'frame', name: 'Frame', version: 'latest', platform: 'mac-x64' })).status, 400);
  assert.equal((await rel({ id: 'frame', name: 'Frame', version: '0.1.0', platform: 'amiga' })).status, 400);
});

test('publish, then the catalog names the newest per platform, with its download and icon', async () => {
  await publish('frame', '0.1.0', 'mac-x64', zip(2000), { tagline: 'Video, cut on the beat', order: 1, icon: PNG.toString('base64'), notes: 'First' });
  await publish('vision', '0.1.0', 'mac-x64', zip(3000), { tagline: 'Photos and drawings', order: 2 });
  await publish('frame', '0.2.0', 'mac-x64', zip(2100), { notes: 'Auto Save' });
  const c = await (await fetch(`${base}/v1/catalog`, { headers: R })).json();
  assert.deepEqual(c.apps.map((a) => a.id), ['frame', 'vision']);
  const f = c.apps[0];
  assert.equal(f.latest['mac-x64'].version, '0.2.0');
  assert.equal(f.latest['mac-x64'].notes, 'Auto Save');
  assert.equal(f.latest['mac-x64'].sha256, sha(zip(2100)));
  assert.equal(f.latest['mac-x64'].bundleId, 'com.krmkrueger.frame');
  assert.equal(f.tagline, 'Video, cut on the beat');
  assert.equal(f.icon, '/v1/icon/frame');
  assert.equal(c.apps[1].icon, null);
  const icon = await fetch(`${base}${f.icon}`, { headers: R });
  assert.equal(icon.headers.get('content-type'), 'image/png');
  const none = await (await fetch(`${base}/v1/catalog?platform=win-x64`, { headers: R })).json();
  assert.deepEqual(none.apps, []);
});

test('a download whole, and from a byte on (Range), as published', async () => {
  const body = zip(2100);
  const whole = await fetch(`${base}/v1/download/frame/0.2.0/mac-x64`, { headers: R });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('etag'), `"${sha(body)}"`);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), body);
  const part = await fetch(`${base}/v1/download/frame/0.2.0/mac-x64`, { headers: { ...R, Range: 'bytes=1000-' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 1000-${body.length - 1}/${body.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), body.subarray(1000));
  assert.equal((await fetch(`${base}/v1/download/frame/0.2.0/mac-x64`, { headers: { ...R, Range: `bytes=${body.length}-` } })).status, 416);
  assert.equal((await fetch(`${base}/v1/download/frame/9.9.9/mac-x64`, { headers: R })).status, 404);
});

test('only the newest KEEP_VERSIONS stay, older builds are deleted', async () => {
  await publish('frame', '0.3.0', 'mac-x64', zip(2200));
  assert.deepEqual(readdirSync(join(DATA, 'files', 'frame')).sort(), ['0.2.0', '0.3.0']);
  assert.equal((await fetch(`${base}/v1/download/frame/0.1.0/mac-x64`, { headers: R })).status, 404);
});

test('a release can be taken back', async () => {
  assert.equal((await fetch(`${base}/v1/release/frame/0.3.0/mac-x64`, { method: 'DELETE', headers: P })).status, 200);
  const c = await (await fetch(`${base}/v1/catalog`, { headers: R })).json();
  assert.equal(c.apps.find((a) => a.id === 'frame').latest['mac-x64'].version, '0.2.0');
});

test('twenty wrong keys from one address, then a wait', async () => {
  for (let i = 0; i < 20; i++) await fetch(`${base}/v1/catalog`, { headers: { Authorization: `Bearer wrong-key-number-${i}-padding` } });
  assert.equal((await fetch(`${base}/v1/catalog`, { headers: R })).status, 429);
});
