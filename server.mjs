// jarvis-apps: the collection's own app server, what Creative Cloud's servers are to Creative Cloud. JARVIS
// reads the catalog and downloads the apps (Frame, Vision, what comes next) with a read key; the owner's
// Mac publishes new builds with a separate publish key. No dependencies: Node's own http, fs and crypto.
//
//   GET    /health                                      -> { ok }                       (no key)
//   GET    /v1/catalog[?platform=mac-x64]               -> { apps: [...] }              read key
//   GET    /v1/icon/<app>                               -> the app's icon (PNG)         read key
//   GET    /v1/download/<app>/<version>/<platform>      -> the build as a zip, Range    read key
//   PUT    /v1/files/<app>/<version>/<platform>         <- the zip; X-Sha256 must match publish key
//   POST   /v1/release                                  <- { id, name, version, ... }   publish key
//   DELETE /v1/release/<app>/<version>/<platform>                                      publish key
//
// Keys come from the environment (APPS_KEY, APPS_PUBLISH_KEY) and are never written anywhere; without them
// every /v1 route answers 503, so a server without keys gives nothing away. Data lives in DATA_DIR: the
// catalog (catalog.json), the builds (files/<app>/<version>/<platform>.zip) and the icons (icons/<app>.png).
// Each app keeps its KEEP_VERSIONS newest releases per platform; older builds are deleted.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';

const PORT = +(process.env.PORT ?? 8080);
const DATA = process.env.DATA_DIR ?? '/data';
const KEEP = Math.max(1, +(process.env.KEEP_VERSIONS ?? 3));
const MAX_UPLOAD = +(process.env.MAX_UPLOAD ?? 3 * 1024 ** 3);
const READ_KEY = process.env.APPS_KEY ?? '';
const PUBLISH_KEY = process.env.APPS_PUBLISH_KEY ?? '';

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
// the platforms a build can be for: Macs now, Windows and Linux later
const PLATFORM = /^(mac|win|linux)-(x64|arm64|universal)$/;
const SHA = /^[0-9a-f]{64}$/;

const CATALOG = join(DATA, 'catalog.json');
const FILES = join(DATA, 'files');
const ICONS = join(DATA, 'icons');
const TMP = join(DATA, 'tmp');
for (const d of [FILES, ICONS, TMP]) mkdirSync(d, { recursive: true });

function load() {
  try {
    const c = JSON.parse(readFileSync(CATALOG, 'utf8'));
    return c && typeof c.apps === 'object' ? c : { apps: {} };
  } catch {
    return { apps: {} };
  }
}
function save(c) {
  const tmp = `${CATALOG}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  renameSync(tmp, CATALOG);
}

/* -------------------------------------------------------------------- keys */

const digest = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => a.length > 0 && timingSafeEqual(digest(a), digest(b));
const bearer = (req) => /^Bearer\s+(\S{16,300})$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
// wrong keys from one address: twenty in ten minutes, then a wait
const misses = new Map();
function limited(ip) {
  const now = Date.now();
  if (misses.size > 10_000) misses.clear();
  const m = (misses.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  misses.set(ip, m);
  return m.length >= 20;
}
function missed(ip) {
  misses.set(ip, [...(misses.get(ip) ?? []), Date.now()]);
}

/* -------------------------------------------------------------------- replies */

const HEAD = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
function json(res, status, body) {
  res.writeHead(status, { ...HEAD, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}
const fail = (res, status, error) => json(res, status, { error });

function readJson(req, max = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > max) {
        reject(Object.assign(new Error('Too large.'), { status: 413 }));
        req.destroy();
      } else parts.push(d);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('That is not JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const fileOf = (app, version, platform) => join(FILES, app, version, `${platform}.zip`);
const urlOf = (app, version, platform) => `/v1/download/${app}/${version}/${platform}`;

/** the catalog as JARVIS reads it: per app the newest release per platform */
function catalog(platform) {
  const c = load();
  const apps = Object.values(c.apps)
    .map((a) => {
      const latest = {};
      for (const [p, list] of Object.entries(a.releases ?? {})) {
        if (platform && p !== platform) continue;
        const r = list[0];
        if (r) latest[p] = { version: r.version, size: r.size, sha256: r.sha256, bundleId: r.bundleId ?? null, minOS: r.minOS ?? null, notes: r.notes ?? '', published: r.published, url: urlOf(a.id, r.version, p) };
      }
      return { id: a.id, name: a.name, tagline: a.tagline ?? '', description: a.description ?? '', order: a.order ?? 100, icon: a.icon ? `/v1/icon/${a.id}` : null, latest };
    })
    .filter((a) => Object.keys(a.latest).length)
    .sort((x, y) => x.order - y.order || x.name.localeCompare(y.name));
  return { apps };
}

/** a build, whole or from a byte on (Range), so a broken download goes on where it stopped */
function download(req, res, app, version, platform) {
  const f = fileOf(app, version, platform);
  const rel = load().apps[app]?.releases?.[platform]?.find((r) => r.version === version);
  if (!rel || !existsSync(f)) return fail(res, 404, 'That build is not here.');
  const size = statSync(f).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const headers = { ...HEAD, 'Content-Type': 'application/zip', 'Accept-Ranges': 'bytes', ETag: `"${rel.sha256}"`, 'Content-Disposition': `attachment; filename="${app}-${version}-${platform}.zip"` };
  if (range) {
    const start = +range[1];
    const end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
    if (start >= size || start > end) return res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return createReadStream(f, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(f).pipe(res);
}

/** a build coming in: hashed while it streams, kept only when it is exactly what X-Sha256 says */
function upload(req, res, app, version, platform) {
  const want = String(req.headers['x-sha256'] ?? '').toLowerCase();
  if (!SHA.test(want)) return fail(res, 400, 'X-Sha256 must be the zip\'s SHA-256.');
  const len = +(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(len) && len > MAX_UPLOAD) return fail(res, 413, 'That build is too large.');
  const tmp = join(TMP, `${randomBytes(8).toString('hex')}.part`);
  const out = createWriteStream(tmp);
  const hash = createHash('sha256');
  let size = 0;
  let broken = false;
  req.on('data', (d) => {
    size += d.length;
    hash.update(d);
    if (size > MAX_UPLOAD && !broken) {
      broken = true;
      req.unpipe(out);
      out.destroy();
      rmSync(tmp, { force: true });
      fail(res, 413, 'That build is too large.');
      req.destroy();
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (broken) return;
    const got = hash.digest('hex');
    if (got !== want) {
      rmSync(tmp, { force: true });
      return fail(res, 400, `The upload's SHA-256 is ${got}, not ${want}.`);
    }
    const f = fileOf(app, version, platform);
    mkdirSync(dirname(f), { recursive: true });
    renameSync(tmp, f);
    // the hash beside the build, so a release does not read it all again (the box is small)
    writeFileSync(`${f}.sha256`, got);
    json(res, 200, { ok: true, size, sha256: got });
  });
  req.on('error', () => rmSync(tmp, { force: true }));
}

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** a published build into the catalog (its zip must be up already), the oldest beyond KEEP out */
function release(b) {
  const id = clip(b.id, 41);
  const version = clip(b.version, 60);
  const platform = clip(b.platform, 20);
  if (!ID.test(id) || !VERSION.test(version) || !PLATFORM.test(platform)) throw Object.assign(new Error('id, version (1.2.3) and platform (mac-x64, mac-arm64, win-x64, ...) are needed.'), { status: 400 });
  const name = clip(b.name, 60);
  if (!name) throw Object.assign(new Error('The app needs a name.'), { status: 400 });
  const f = fileOf(id, version, platform);
  if (!existsSync(f)) throw Object.assign(new Error('Upload the build first (PUT /v1/files/...).'), { status: 409 });
  const sha256 = existsSync(`${f}.sha256`) ? readFileSync(`${f}.sha256`, 'utf8').trim() : '';
  if (!SHA.test(sha256)) throw Object.assign(new Error('Upload the build again: its hash is missing.'), { status: 409 });
  const c = load();
  const a = (c.apps[id] ??= { id, name, releases: {} });
  a.name = name;
  if (typeof b.tagline === 'string') a.tagline = clip(b.tagline, 120);
  if (typeof b.description === 'string') a.description = clip(b.description, 2000);
  if (Number.isInteger(b.order)) a.order = b.order;
  if (typeof b.icon === 'string' && b.icon) {
    const png = Buffer.from(b.icon, 'base64');
    if (png.length > 2 * 1024 * 1024 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Object.assign(new Error('The icon must be a PNG of at most 2 MB.'), { status: 400 });
    writeFileSync(join(ICONS, `${id}.png`), png);
    a.icon = true;
  }
  const list = (a.releases[platform] ??= []).filter((r) => r.version !== version);
  list.unshift({ version, size: statSync(f).size, sha256, bundleId: clip(b.bundleId, 200) || null, minOS: clip(b.minOS, 20) || null, notes: clip(b.notes, 2000), published: new Date().toISOString() });
  for (const old of list.splice(KEEP)) rmSync(dirname(fileOf(id, old.version, platform)), { recursive: true, force: true });
  a.releases[platform] = list;
  save(c);
  return { ok: true, release: list[0] };
}

function unrelease(app, version, platform) {
  const c = load();
  const a = c.apps[app];
  const list = a?.releases?.[platform];
  if (!list?.some((r) => r.version === version)) return false;
  a.releases[platform] = list.filter((r) => r.version !== version);
  rmSync(fileOf(app, version, platform), { force: true });
  rmSync(`${fileOf(app, version, platform)}.sha256`, { force: true });
  save(c);
  return true;
}

/* -------------------------------------------------------------------- routes */

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (!url.pathname.startsWith('/v1/')) return fail(res, 404, 'Not here.');
    if (!READ_KEY || !PUBLISH_KEY) return fail(res, 503, 'This server has no keys yet (APPS_KEY, APPS_PUBLISH_KEY).');
    if (limited(ip)) return fail(res, 429, 'Too many wrong keys. Wait a few minutes.');
    const key = bearer(req);
    const publish = same(key, PUBLISH_KEY);
    const read = publish || same(key, READ_KEY);
    if (!read) {
      missed(ip);
      return fail(res, 401, 'That key is not right.');
    }
    const parts = url.pathname.split('/').slice(2); // after /v1/
    const [what, app, version, platform] = parts;
    const valid = (n) => (n >= 1 ? ID.test(app ?? '') : true) && (n >= 2 ? VERSION.test(version ?? '') : true) && (n >= 3 ? PLATFORM.test(platform ?? '') : true);

    if (req.method === 'GET' && what === 'catalog' && parts.length === 1) {
      const p = url.searchParams.get('platform');
      if (p && !PLATFORM.test(p)) return fail(res, 400, 'Unknown platform.');
      return json(res, 200, catalog(p));
    }
    if (req.method === 'GET' && what === 'icon' && parts.length === 2 && valid(1)) {
      const f = join(ICONS, `${app}.png`);
      if (!existsSync(f)) return fail(res, 404, 'No icon.');
      res.writeHead(200, { ...HEAD, 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' });
      return createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && what === 'download' && parts.length === 4 && valid(3)) return download(req, res, app, version, platform);
    // publishing: only with the publish key
    if (!publish && ['PUT', 'POST', 'DELETE'].includes(req.method ?? '')) return fail(res, 403, 'Publishing needs the publish key.');
    if (req.method === 'PUT' && what === 'files' && parts.length === 4 && valid(3)) return upload(req, res, app, version, platform);
    if (req.method === 'POST' && what === 'release' && parts.length === 1) return json(res, 200, release(await readJson(req)));
    if (req.method === 'DELETE' && what === 'release' && parts.length === 4 && valid(3)) return unrelease(app, version, platform) ? json(res, 200, { ok: true }) : fail(res, 404, 'No such release.');
    return fail(res, 404, 'Not here.');
  } catch (e) {
    if (!res.headersSent) fail(res, e.status ?? 500, e.status ? e.message : 'Something went wrong on the server.');
    if (!e.status) console.error(e);
  }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => console.log(`jarvis-apps on :${PORT}, data in ${DATA}${READ_KEY && PUBLISH_KEY ? '' : ' (no keys yet: /v1 answers 503)'}`));
}
