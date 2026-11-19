'use strict';
// Native session discovery and titles.
//
// Each agent can switch conversations while it runs (/clear, /new, /resume), so the
// app keeps asking the agent's own store which conversation a tab is on. `dir` is that
// store as Windows reaches it (under \\wsl$\<distro> for a WSL tab): the agent's config
// folder (CLAUDE_CONFIG_DIR / CODEX_HOME) or Cursor's chats folder. `cwd` is the folder
// as the agent sees it (/mnt/c/... in WSL), which is what its store records:
//   claude  ~/.claude/sessions/<pid>.json names the live process's current session
//           exactly; the project folder's *.jsonl files are the fallback.
//   codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, whose first line holds id + cwd.
//   cursor  ~/.cursor/chats/<ws>/<chatId>/meta.json, which holds cwd + createdAtMs.
// OpenCode keeps one SQLite database, read through Python (see engine.js).

const fs = require('fs');
const path = require('path');

// A POSIX path (an agent's own path in WSL) is kept as is: resolving it would make it C:\...
const absPath = (p) => (p.startsWith('/') ? p : path.resolve(p));
const normPath = (p) => absPath(p).replace(/[\\/]+$/, '').toLowerCase();
const samePath = (a, b) => !!a && !!b && normPath(a) === normPath(b);

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}

function safeReaddir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function readRange(file, start, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, start);
    return buf.slice(0, n).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const readHead = (file, bytes = 65536) => readRange(file, 0, bytes);

function readTail(file, bytes) {
  const st = safeStat(file);
  if (!st) return '';
  const start = Math.max(0, st.size - bytes);
  const text = readRange(file, start, st.size - start);
  // Drop the partial first line when the read started mid-file.
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
}

// The first JSONL line, however long: Codex's session_meta line embeds the full base
// instructions and is regularly over 20 KB. Returns null until the line is complete.
function readFirstLine(file, max = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    const buf = Buffer.alloc(65536);
    let pos = 0;
    while (pos < max) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) return null;
      const nl = buf.indexOf(10);
      if (nl >= 0 && nl < n) {
        chunks.push(Buffer.from(buf.slice(0, nl)));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(Buffer.from(buf.slice(0, n)));
      pos += n;
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

function claudeProjectDir(cwd, dir) {
  return path.join(dir, 'projects', absPath(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

function claudeSessionFile(cwd, id, dir) {
  const own = path.join(claudeProjectDir(cwd, dir), `${id}.jsonl`);
  if (safeStat(own)) return own;
  // The session may have been started from another folder.
  const base = path.join(dir, 'projects');
  for (const d of safeReaddir(base)) {
    const f = path.join(base, d.name, `${id}.jsonl`);
    if (d.isDirectory() && safeStat(f)) return f;
  }
  return null;
}

function claudeSessionExists(cwd, id, dir) {
  return !!id && !!claudeSessionFile(cwd, id, dir);
}

// A running Claude process's pid file: { sessionId, status ('busy' | 'idle'), name, ... }.
// Claude rewrites it on /clear and /resume, so it follows the conversation exactly.
// `since` (0: no check) skips a file left behind by an earlier process with the same pid.
function claudeLive(pid, cwd, since, dir) {
  if (!pid) return null;
  const file = path.join(dir, 'sessions', `${pid}.json`);
  const st = safeStat(file);
  if (!st || st.mtimeMs < since - 10000) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.pid !== undefined && Number(j.pid) !== Number(pid)) return null;
    if (j.cwd && cwd && !samePath(j.cwd, cwd)) return null;
    if (j.startedAt && j.startedAt < since - 10000) return null;
    return typeof j.sessionId === 'string' ? j : null;
  } catch (_) {
    return null; // being rewritten
  }
}

// The Claude pid files present now, so a tab can tell which one its own Claude adds.
function claudePids(dir) {
  return new Set(safeReaddir(path.join(dir, 'sessions')).filter((e) => /^\d+\.json$/.test(e.name)).map((e) => Number(e.name.slice(0, -5))));
}

// The pid of the Claude process a tab started, when the tab's own pid is not Claude's (a
// WSL tab runs wsl.exe): the pid file in its folder on the session it was launched with,
// else the earliest other one, among those that appeared after it started (not in `before`:
// a restarted tab's previous process may still have its file) that no other tab owns.
// Clock-free: WSL's clock can drift from Windows' after sleep.
function claudeFindPid(cwd, dir, nativeId, taken, before) {
  let fresh = null;
  for (const pid of claudePids(dir)) {
    if (taken.has(pid) || before.has(pid)) continue;
    const j = claudeLive(pid, cwd, 0, dir);
    if (!j) continue;
    if (nativeId && j.sessionId === nativeId) return pid;
    if (!fresh || j.startedAt < fresh.startedAt) fresh = { pid, startedAt: j.startedAt || 0 };
  }
  return fresh && fresh.pid;
}

function claudeSessions(cwd, since, configDir) {
  const dir = claudeProjectDir(cwd, configDir);
  const out = [];
  for (const e of safeReaddir(dir)) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const st = safeStat(path.join(dir, e.name));
    if (st && st.mtimeMs >= since) out.push({ id: e.name.slice(0, -6), birth: st.birthtimeMs || st.ctimeMs, t: st.mtimeMs });
  }
  return out;
}

function claudeTitle(cwd, nativeId, dir) {
  const file = claudeSessionFile(cwd, nativeId, dir);
  if (!file) return null;
  // Claude appends ai-title / custom-title lines as the conversation goes; the last one wins.
  const tail = readTail(file, 512 * 1024).split('\n');
  let ai = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line.includes('-title"') && !line.includes('"summary"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.type === 'custom-title' && j.customTitle) return j.customTitle;
      if (!ai && j.type === 'ai-title' && j.aiTitle) ai = j.aiTitle;
      if (!ai && j.type === 'summary' && j.summary) ai = j.summary;
    } catch (_) { /* skip */ }
  }
  if (ai) return ai;
  for (const line of readHead(file, 262144).split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const j = JSON.parse(line);
      const c = j.message && j.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x.type === 'text') || {}).text : null;
      if (text && !text.startsWith('<')) return text.replace(/\s+/g, ' ').slice(0, 80);
    } catch (_) { /* skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexDayDirs(since, configDir) {
  const base = path.join(configDir, 'sessions');
  const dirs = new Set();
  const now = Date.now();
  for (let t = Math.max(since - 86400000, now - 40 * 86400000); ; t += 86400000) {
    const d = new Date(Math.min(t, now));
    dirs.add(path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
    if (t >= now) break;
  }
  return [...dirs];
}

const codexMetaCache = new Map(); // rollout path -> { id, cwd }

function codexMeta(file, name) {
  if (codexMetaCache.has(file)) return codexMetaCache.get(file);
  const idMatch = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  const first = readFirstLine(file);
  if (first === null) return null; // first line still being written
  const meta = { id: idMatch ? idMatch[1] : null, cwd: null };
  try {
    const j = JSON.parse(first);
    const p = j.payload || j;
    meta.id = p.id || p.session_id || meta.id;
    meta.cwd = p.cwd || null;
  } catch (_) {
    const m = first.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (m) {
      try {
        meta.cwd = JSON.parse(`"${m[1]}"`);
      } catch (_) { /* leave null */ }
    }
  }
  codexMetaCache.set(file, meta);
  return meta;
}

// When a rollout was created, from its name (rollout-2026-11-16T15-15-35-<id>.jsonl, local
// time): over \\wsl$ a file's birth time is only its last write.
function rolloutBirth(name) {
  const m = /^rollout-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(name);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

function codexSessions(cwd, since, configDir) {
  const out = [];
  for (const dir of codexDayDirs(since, configDir)) {
    for (const e of safeReaddir(dir)) {
      if (!e.isFile() || !/^rollout-.*\.jsonl$/.test(e.name)) continue;
      const file = path.join(dir, e.name);
      const st = safeStat(file);
      if (!st || st.mtimeMs < since) continue;
      const meta = codexMeta(file, e.name);
      if (!meta || !meta.id || !samePath(meta.cwd, cwd)) continue;
      out.push({ id: meta.id, birth: rolloutBirth(e.name) || st.birthtimeMs || st.ctimeMs, t: st.mtimeMs });
    }
  }
  return out;
}

const codexIndexes = new Map(); // session_index.jsonl path -> { mtime, names }
function codexTitle(nativeId, dir) {
  const file = path.join(dir, 'session_index.jsonl');
  const st = safeStat(file);
  if (!st) return null;
  let codexIndex = codexIndexes.get(file) || { mtime: -1, names: new Map() };
  if (st.mtimeMs !== codexIndex.mtime) {
    const names = new Map();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.id && j.thread_name) names.set(j.id, j.thread_name);
        } catch (_) { /* skip */ }
      }
    } catch (_) { /* unreadable */ }
    codexIndex = { mtime: st.mtimeMs, names };
    codexIndexes.set(file, codexIndex);
  }
  return codexIndex.names.get(nativeId) || null;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

function cursorSessions(cwd, since, dir) {
  const out = [];
  for (const ws of safeReaddir(dir)) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(dir, ws.name);
    for (const chat of safeReaddir(wsDir)) {
      if (!chat.isDirectory()) continue;
      const chatDir = path.join(wsDir, chat.name);
      let t = 0;
      for (const f of ['meta.json', 'store.db', 'store.db-wal']) {
        const st = safeStat(path.join(chatDir, f));
        if (st) t = Math.max(t, st.mtimeMs);
      }
      if (t < since) continue;
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(chatDir, 'meta.json'), 'utf8'));
      } catch (_) { /* not written yet */ }
      if (meta.cwd && !samePath(meta.cwd, cwd)) continue;
      const dirSt = safeStat(chatDir);
      out.push({ id: chat.name, birth: meta.createdAtMs || (dirSt ? dirSt.birthtimeMs : t), t, title: meta.title || null });
    }
  }
  return out;
}

function cursorTitle(nativeId, dir) {
  for (const ws of safeReaddir(dir)) {
    const meta = path.join(dir, ws.name, nativeId, 'meta.json');
    if (safeStat(meta)) {
      try {
        return JSON.parse(fs.readFileSync(meta, 'utf8')).title || null;
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Moving a conversation between accounts
// ---------------------------------------------------------------------------

// The rollout file of a Codex conversation, newest day folders first.
function codexSessionFile(id, dir) {
  const base = path.join(dir, 'sessions');
  const names = (p) => safeReaddir(p).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  for (const y of names(base)) {
    for (const m of names(path.join(base, y))) {
      for (const d of names(path.join(base, y, m))) {
        const day = path.join(base, y, m, d);
        const hit = safeReaddir(day).find((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(`${id}.jsonl`));
        if (hit) return path.join(day, hit.name);
      }
    }
  }
  return null;
}

// Copies `src` to the same place under `toBase`, unless the copy there is already newer.
function copyNewer(src, fromBase, toBase) {
  const dest = path.join(toBase, path.relative(fromBase, src));
  const a = safeStat(src);
  const b = safeStat(dest);
  if (!a || (b && b.mtimeMs >= a.mtimeMs)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (a.isDirectory()) fs.cpSync(src, dest, { recursive: true, force: true });
  else fs.copyFileSync(src, dest);
  return true;
}

// Copies a conversation from one account's store to another's, so the other account can
// resume it. Returns whether the conversation was found. Accounts linked to one shared
// history (claude-accounts.sh) find the copy already there, so nothing is copied. Cursor
// and OpenCode keep one store for every account: nothing to copy.
function copyConversation(agentId, cwd, nativeId, fromDir, toDir) {
  if (!nativeId) return false;
  if (agentId === 'claude') {
    const file = claudeSessionFile(cwd, nativeId, fromDir);
    if (!file) return false;
    if (samePath(fromDir, toDir)) return true;
    copyNewer(file, fromDir, toDir);
    // Subagent transcripts and large tool results live next to it in <id>/.
    const side = file.slice(0, -'.jsonl'.length);
    if (safeStat(side)) copyNewer(side, fromDir, toDir);
    return true;
  }
  if (agentId === 'codex') {
    const file = codexSessionFile(nativeId, fromDir);
    if (!file) return false;
    if (!samePath(fromDir, toDir)) copyNewer(file, fromDir, toDir);
    return true;
  }
  return agentId === 'cursor' || agentId === 'opencode';
}

// ---------------------------------------------------------------------------

// Conversations of an agent in a folder that were written to since `since`:
// [{ id, birth, t, title? }], most recently written first.
function listSessions(agentId, cwd, since, dir) {
  let out = [];
  if (agentId === 'claude') out = claudeSessions(cwd, since, dir);
  else if (agentId === 'codex') out = codexSessions(cwd, since, dir);
  else if (agentId === 'cursor') out = cursorSessions(cwd, since, dir);
  return out.sort((a, b) => b.t - a.t);
}

// The title the agent itself gave the conversation, when it keeps one.
function nativeTitle(agentId, cwd, nativeId, dir) {
  if (!nativeId) return null;
  if (agentId === 'claude') return claudeTitle(cwd, nativeId, dir);
  if (agentId === 'codex') return codexTitle(nativeId, dir);
  if (agentId === 'cursor') return cursorTitle(nativeId, dir);
  return null;
}

module.exports = {
  listSessions,
  claudeLive,
  claudePids,
  claudeFindPid,
  claudeSessionExists,
  copyConversation,
  nativeTitle,
  samePath,
  normPath,
};
