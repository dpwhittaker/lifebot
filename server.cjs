/**
 * lifebot backend server.
 *
 * Listens on 127.0.0.1:8003. Fronted by claude-hub at /lifebot/* (stripPrefix
 * is on, so paths arrive without the /lifebot prefix).
 *
 *   GET  /                        → static SPA (index.html from .serve/)
 *   GET  /<asset>                 → static file from .serve/ (with mime + cache)
 *   POST /logs                    → append JSON-per-line body to logs/current.log
 *   GET  /threads                 → list thread summaries
 *   GET  /threads/:id             → full thread JSON
 *   PUT  /threads/:id             → upsert thread JSON
 *   DELETE /threads/:id           → delete thread JSON
 *   POST /threads/:id/commits     → append a commit to thread.history
 *   GET  /groups                  → list group summaries
 *   GET  /groups/:id              → full group JSON (with people)
 *   PUT  /groups/:id              → upsert group JSON
 *   DELETE /groups/:id            → delete group + cleanup voiceprints
 *   PUT  /groups/:gid/people/:pid → upsert one person inside a group
 *   DELETE /groups/:gid/people/:pid
 *   PUT/GET/DELETE /groups/:gid/people/:pid/voiceprint → wav upload/fetch/delete
 *
 * Run as a systemd service (lifebot.service) or directly: `node server.js`.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.LIFEBOT_PORT) || 8003;
const ROOT = __dirname;
const STATIC_DIR = path.join(ROOT, '.serve');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'current.log');
const THREADS_DIR = path.join(ROOT, 'threads');
const GROUPS_DIR = path.join(ROOT, 'groups');
const VOICEPRINTS_DIR = path.join(ROOT, 'voiceprints');

for (const d of [LOG_DIR, THREADS_DIR, GROUPS_DIR, VOICEPRINTS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- helpers ----------

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, res, maxBytes, cb) {
  let bytes = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('payload too large');
      req.destroy();
      cb(null, new Error('too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return cb(null);
    try {
      cb(JSON.parse(text));
    } catch (e) {
      sendJson(res, 400, { error: 'invalid JSON: ' + e.message });
      cb(null, e);
    }
  });
  req.on('error', (e) => {
    if (!res.headersSent) sendJson(res, 500, { error: 'read error: ' + e.message });
    cb(null, e);
  });
}

function readBinaryBody(req, res, maxBytes, cb) {
  let bytes = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('payload too large');
      req.destroy();
      cb(null, new Error('too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    cb(Buffer.concat(chunks));
  });
  req.on('error', (e) => {
    if (!res.headersSent) sendJson(res, 500, { error: 'read error: ' + e.message });
    cb(null, e);
  });
}

function writeJsonAtomic(file, obj, cb) {
  const tmp = file + '.tmp';
  fs.writeFile(tmp, JSON.stringify(obj, null, 2), (err) => {
    if (err) return cb(err);
    fs.rename(tmp, file, cb);
  });
}

// ---------- threads ----------

function threadFile(id) {
  return ID_RE.test(id) ? path.join(THREADS_DIR, `${id}.json`) : null;
}

function handleListThreads(_req, res) {
  fs.readdir(THREADS_DIR, (err, files) => {
    if (err) return sendJson(res, 500, { error: err.message });
    const summaries = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(THREADS_DIR, f), 'utf8'));
        summaries.push({
          id: t.id,
          name: t.name ?? '(unnamed)',
          group: t.group ?? undefined,
          roster: Array.isArray(t.roster) ? t.roster : undefined,
          schedule: Array.isArray(t.schedule) ? t.schedule : undefined,
          summary: typeof t.summary === 'string' ? t.summary : undefined,
          updatedAt: t.updatedAt ?? null,
          systemPromptPreview: (t.systemPrompt ?? '').slice(0, 200),
          commitCount: Array.isArray(t.history) ? t.history.length : 0,
        });
      } catch {}
    }
    summaries.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    sendJson(res, 200, { threads: summaries });
  });
}

function handleGetThread(_req, res, id) {
  const file = threadFile(id);
  if (!file) return sendJson(res, 400, { error: 'invalid thread id' });
  fs.readFile(file, 'utf8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 500, { error: err.message });
    }
    try { sendJson(res, 200, JSON.parse(data)); }
    catch (e) { sendJson(res, 500, { error: 'corrupt: ' + e.message }); }
  });
}

function handlePutThread(req, res, id) {
  const file = threadFile(id);
  if (!file) return sendJson(res, 400, { error: 'invalid thread id' });
  readJsonBody(req, res, 4 * 1024 * 1024, (body, err) => {
    if (err || body == null) return;
    if (typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'expected object body' });
    }
    body.id = id;
    body.updatedAt = new Date().toISOString();
    writeJsonAtomic(file, body, (writeErr) => {
      if (writeErr) sendJson(res, 500, { error: writeErr.message });
      else sendJson(res, 200, body);
    });
  });
}

function handleDeleteThread(_req, res, id) {
  const file = threadFile(id);
  if (!file) return sendJson(res, 400, { error: 'invalid thread id' });
  fs.unlink(file, (err) => {
    if (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 500, { error: err.message });
    }
    sendJson(res, 204, '');
  });
}

function handleAppendCommit(req, res, id) {
  const file = threadFile(id);
  if (!file) return sendJson(res, 400, { error: 'invalid thread id' });
  readJsonBody(req, res, 256 * 1024, (entry, err) => {
    if (err || entry == null) return;
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      return sendJson(res, 400, { error: 'expected commit object' });
    }
    fs.readFile(file, 'utf8', (readErr, data) => {
      if (readErr) {
        if (readErr.code === 'ENOENT') return sendJson(res, 404, { error: 'thread not found' });
        return sendJson(res, 500, { error: readErr.message });
      }
      let thread;
      try { thread = JSON.parse(data); }
      catch (parseErr) { return sendJson(res, 500, { error: 'corrupt: ' + parseErr.message }); }
      if (!Array.isArray(thread.history)) thread.history = [];
      thread.history.push({ ...entry, at: entry.at ?? new Date().toISOString() });
      thread.updatedAt = new Date().toISOString();
      writeJsonAtomic(file, thread, (writeErr) => {
        if (writeErr) sendJson(res, 500, { error: writeErr.message });
        else sendJson(res, 200, { history: thread.history.length });
      });
    });
  });
}

function routeThreads(req, res, pathOnly) {
  if (pathOnly === '/threads' && req.method === 'GET') {
    handleListThreads(req, res); return true;
  }
  const m = /^\/threads\/([^/]+)(?:\/(commits))?$/.exec(pathOnly);
  if (!m) return false;
  const id = m[1];
  const sub = m[2];
  if (sub === 'commits' && req.method === 'POST') {
    handleAppendCommit(req, res, id); return true;
  }
  if (sub === 'commits') {
    sendJson(res, 405, { error: 'use POST to append a commit' }); return true;
  }
  if (req.method === 'GET') { handleGetThread(req, res, id); return true; }
  if (req.method === 'PUT') { handlePutThread(req, res, id); return true; }
  if (req.method === 'DELETE') { handleDeleteThread(req, res, id); return true; }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

// ---------- groups + people + voiceprints ----------

function groupFile(id) {
  return ID_RE.test(id) ? path.join(GROUPS_DIR, `${id}.json`) : null;
}

function voiceprintPath(gid, pid) {
  if (!ID_RE.test(gid) || !ID_RE.test(pid)) return null;
  return path.join(VOICEPRINTS_DIR, gid, `${pid}.wav`);
}

function readGroup(id) {
  const file = groupFile(id);
  if (!file || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function writeGroup(group, cb) {
  const file = groupFile(group.id);
  if (!file) return cb(new Error('invalid group id'));
  group.updatedAt = new Date().toISOString();
  writeJsonAtomic(file, group, cb);
}

function handleListGroups(_req, res) {
  fs.readdir(GROUPS_DIR, (err, files) => {
    if (err) return sendJson(res, 500, { error: err.message });
    const groups = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const g = JSON.parse(fs.readFileSync(path.join(GROUPS_DIR, f), 'utf8'));
        groups.push({
          id: g.id,
          name: g.name ?? '(unnamed)',
          parent: g.parent ?? undefined,
          peopleCount: Array.isArray(g.people) ? g.people.length : 0,
          updatedAt: g.updatedAt ?? null,
        });
      } catch {}
    }
    groups.sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, { groups });
  });
}

function handleGetGroup(_req, res, id) {
  const g = readGroup(id);
  if (!g) return sendJson(res, 404, { error: 'group not found' });
  sendJson(res, 200, g);
}

function handlePutGroup(req, res, id) {
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'invalid group id' });
  readJsonBody(req, res, 1024 * 1024, (body, err) => {
    if (err || body == null) return;
    if (typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'expected object body' });
    }
    body.id = id;
    if (!Array.isArray(body.people)) body.people = [];
    writeGroup(body, (writeErr) => {
      if (writeErr) sendJson(res, 500, { error: writeErr.message });
      else sendJson(res, 200, body);
    });
  });
}

function handleDeleteGroup(_req, res, id) {
  const file = groupFile(id);
  if (!file) return sendJson(res, 400, { error: 'invalid group id' });
  fs.unlink(file, (err) => {
    if (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 500, { error: err.message });
    }
    fs.rm(path.join(VOICEPRINTS_DIR, id), { recursive: true, force: true }, () => {});
    sendJson(res, 204, '');
  });
}

function handlePutPerson(req, res, gid, pid) {
  if (!ID_RE.test(gid)) return sendJson(res, 400, { error: 'invalid group id' });
  if (!ID_RE.test(pid)) return sendJson(res, 400, { error: 'invalid person id' });
  readJsonBody(req, res, 64 * 1024, (body, err) => {
    if (err || body == null) return;
    if (typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'expected object body' });
    }
    const group = readGroup(gid);
    if (!group) return sendJson(res, 404, { error: 'group not found' });
    if (!Array.isArray(group.people)) group.people = [];
    const next = { ...body, id: pid };
    const idx = group.people.findIndex((p) => p && p.id === pid);
    if (idx >= 0) group.people[idx] = { ...group.people[idx], ...next };
    else group.people.push(next);
    writeGroup(group, (writeErr) => {
      if (writeErr) sendJson(res, 500, { error: writeErr.message });
      else sendJson(res, 200, next);
    });
  });
}

function handleDeletePerson(_req, res, gid, pid) {
  if (!ID_RE.test(gid)) return sendJson(res, 400, { error: 'invalid group id' });
  if (!ID_RE.test(pid)) return sendJson(res, 400, { error: 'invalid person id' });
  const group = readGroup(gid);
  if (!group) return sendJson(res, 404, { error: 'group not found' });
  if (!Array.isArray(group.people)) group.people = [];
  const idx = group.people.findIndex((p) => p && p.id === pid);
  if (idx < 0) return sendJson(res, 404, { error: 'person not found' });
  group.people.splice(idx, 1);
  const vfile = voiceprintPath(gid, pid);
  if (vfile) fs.unlink(vfile, () => {});
  writeGroup(group, (writeErr) => {
    if (writeErr) sendJson(res, 500, { error: writeErr.message });
    else sendJson(res, 204, '');
  });
}

function handlePutVoiceprint(req, res, gid, pid) {
  const file = voiceprintPath(gid, pid);
  if (!file) return sendJson(res, 400, { error: 'invalid id' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  readBinaryBody(req, res, 5 * 1024 * 1024, (buf, err) => {
    if (err || !buf) return;
    if (buf.length === 0) return sendJson(res, 400, { error: 'empty' });
    const tmp = file + '.tmp';
    fs.writeFile(tmp, buf, (writeErr) => {
      if (writeErr) return sendJson(res, 500, { error: writeErr.message });
      fs.rename(tmp, file, (renameErr) => {
        if (renameErr) return sendJson(res, 500, { error: renameErr.message });
        const group = readGroup(gid);
        if (group && Array.isArray(group.people)) {
          const person = group.people.find((p) => p && p.id === pid);
          if (person) {
            person.hasVoiceprint = true;
            writeGroup(group, () => sendJson(res, 200, { bytes: buf.length }));
            return;
          }
        }
        sendJson(res, 200, { bytes: buf.length });
      });
    });
  });
}

function handleGetVoiceprint(_req, res, gid, pid) {
  const file = voiceprintPath(gid, pid);
  if (!file) return sendJson(res, 400, { error: 'invalid id' });
  fs.readFile(file, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 500, { error: err.message });
    }
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function handleDeleteVoiceprint(_req, res, gid, pid) {
  const file = voiceprintPath(gid, pid);
  if (!file) return sendJson(res, 400, { error: 'invalid id' });
  fs.unlink(file, (err) => {
    if (err && err.code !== 'ENOENT') return sendJson(res, 500, { error: err.message });
    const group = readGroup(gid);
    if (group && Array.isArray(group.people)) {
      const person = group.people.find((p) => p && p.id === pid);
      if (person && person.hasVoiceprint) {
        person.hasVoiceprint = false;
        writeGroup(group, () => sendJson(res, 204, ''));
        return;
      }
    }
    sendJson(res, 204, '');
  });
}

function routeGroups(req, res, pathOnly) {
  if (pathOnly === '/groups' && req.method === 'GET') {
    handleListGroups(req, res); return true;
  }
  const voiceMatch = /^\/groups\/([^/]+)\/people\/([^/]+)\/voiceprint$/.exec(pathOnly);
  if (voiceMatch) {
    const [, gid, pid] = voiceMatch;
    if (req.method === 'PUT') { handlePutVoiceprint(req, res, gid, pid); return true; }
    if (req.method === 'GET') { handleGetVoiceprint(req, res, gid, pid); return true; }
    if (req.method === 'DELETE') { handleDeleteVoiceprint(req, res, gid, pid); return true; }
    sendJson(res, 405, { error: 'method not allowed' }); return true;
  }
  const peopleMatch = /^\/groups\/([^/]+)\/people\/([^/]+)$/.exec(pathOnly);
  if (peopleMatch) {
    const [, gid, pid] = peopleMatch;
    if (req.method === 'PUT') { handlePutPerson(req, res, gid, pid); return true; }
    if (req.method === 'DELETE') { handleDeletePerson(req, res, gid, pid); return true; }
    sendJson(res, 405, { error: 'method not allowed' }); return true;
  }
  const groupMatch = /^\/groups\/([^/]+)$/.exec(pathOnly);
  if (groupMatch) {
    const [, gid] = groupMatch;
    if (req.method === 'GET') { handleGetGroup(req, res, gid); return true; }
    if (req.method === 'PUT') { handlePutGroup(req, res, gid); return true; }
    if (req.method === 'DELETE') { handleDeleteGroup(req, res, gid); return true; }
    sendJson(res, 405, { error: 'method not allowed' }); return true;
  }
  return false;
}

// ---------- logs ----------

function handleLogPost(req, res) {
  let bytes = 0;
  const chunks = [];
  const MAX_BYTES = 256 * 1024;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('payload too large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    const body = Buffer.concat(chunks).toString('utf8').trim();
    if (!body) { res.writeHead(204); res.end(); return; }
    const stamp = new Date().toISOString();
    const out = body
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => `${stamp} ${l}\n`)
      .join('');
    fs.appendFile(LOG_FILE, out, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('append failed: ' + err.message);
      } else {
        res.writeHead(204); res.end();
      }
    });
  });
  req.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('upload error');
    }
  });
}

// ---------- static ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt':  'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map':  'application/json',
};

function safeJoin(base, rel) {
  const decoded = decodeURIComponent(rel);
  const joined = path.join(base, decoded);
  const realBase = path.resolve(base);
  const realJoined = path.resolve(joined);
  if (realJoined !== realBase && !realJoined.startsWith(realBase + path.sep)) return null;
  return realJoined;
}

function serveStatic(req, res, urlPath) {
  // urlPath starts with '/'. Trim leading slash; default to index.html.
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const abs = safeJoin(STATIC_DIR, rel);
  if (!abs) { res.writeHead(400); res.end('bad path'); return; }
  fs.stat(abs, (err, stat) => {
    if (err || !stat || !stat.isFile()) {
      // SPA fallback: any unknown path that looks app-routed serves index.html.
      // Skip for paths with extensions that look like static asset misses.
      if (!path.extname(urlPath)) {
        const fallback = path.join(STATIC_DIR, 'index.html');
        fs.readFile(fallback, (fbErr, data) => {
          if (fbErr) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(data);
        });
        return;
      }
      res.writeHead(404); res.end('not found'); return;
    }
    const ext = path.extname(abs).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    // Hashed Vite assets get long caching; HTML / manifest stay no-cache.
    const isImmutable = abs.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': isImmutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

// ---------- server ----------

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const pathOnly = url.split('?', 1)[0];

  if (req.method === 'POST' && pathOnly === '/logs') {
    handleLogPost(req, res); return;
  }
  if (pathOnly === '/threads' || pathOnly.startsWith('/threads/')) {
    if (routeThreads(req, res, pathOnly)) return;
  }
  if (pathOnly === '/groups' || pathOnly.startsWith('/groups/')) {
    if (routeGroups(req, res, pathOnly)) return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  serveStatic(req, res, pathOnly);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`lifebot listening on http://127.0.0.1:${PORT} (static=${STATIC_DIR})`);
});

process.once('SIGTERM', () => { server.close(() => process.exit(0)); });
process.once('SIGINT',  () => { server.close(() => process.exit(0)); });
