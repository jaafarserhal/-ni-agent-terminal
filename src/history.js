'use strict';
// Session history, saved per working folder and per agent.
//
// Layout under <userData>/history:
//   index.json                                  one record per conversation (all folders)
//   folders/<folder>/folder.json                the folder's full path
//   folders/<folder>/<agent>/<id>.log           raw terminal output (ANSI kept, for replay)
//   folders/<folder>/<agent>/<id>.txt           plain-text transcript, runs appended
//   folders/<folder>/<agent>/<id>.prompts.jsonl prompts / commands typed, one {t, text} per line
//
// <folder> is the folder's name plus a short hash of its full path, e.g. "FRAMEWORK-1a2b3c4d".
//
// A record is one conversation of the agent. Resuming it appends to the same files.
// When the agent starts another conversation inside the same tab (/clear, /new,
// /resume), the tab moves on to another record; see main.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LOG_BYTES = 25 * 1024 * 1024;
const MAX_PROMPT_CHARS = 20000;
const MAX_PROMPTS_READ = 2000;
const EXTS = { log: '.log', text: '.txt', prompts: '.prompts.jsonl' };

function normCwd(cwd) {
  return path.resolve(cwd || '.').replace(/[\\/]+$/, '').toLowerCase();
}

function folderKey(cwd) {
  const base = (path.basename(path.resolve(cwd || '.')) || 'root').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'root';
  return `${base}-${crypto.createHash('sha1').update(normCwd(cwd)).digest('hex').slice(0, 8)}`;
}

function stamp() {
  return new Date().toLocaleString();
}

class History {
  constructor(root) {
    this.root = root;
    this.indexFile = path.join(root, 'index.json');
    fs.mkdirSync(root, { recursive: true });
    this.records = this._load();
    this.streams = new Map();
    this.priorText = new Map();
    this._saveTimer = null;
    this._migrate();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      return Array.isArray(data.records) ? data.records : [];
    } catch (_) {
      return [];
    }
  }

  // Version 1 kept every agent's files in one flat <agent>/ folder. Move them under
  // their working folder. A file that cannot be moved (open elsewhere) stays where it
  // is; paths fall back to the old location and the move is retried on the next start.
  _migrate() {
    const pending = this.records.filter((r) => !r.folder);
    if (!pending.length) return;
    try {
      fs.copyFileSync(this.indexFile, path.join(this.root, 'index.v1.bak.json'));
    } catch (_) { /* no index yet */ }
    for (const rec of pending) {
      const key = folderKey(rec.cwd);
      const dir = this._dir(key, rec.agent);
      let moved = true;
      for (const ext of Object.values(EXTS)) {
        const from = path.join(this.root, rec.agent, rec.id + ext);
        if (!fs.existsSync(from)) continue;
        try {
          fs.renameSync(from, path.join(dir, rec.id + ext));
        } catch (_) {
          moved = false;
        }
      }
      if (moved) {
        rec.folder = key;
        this._writeFolderInfo(rec);
      }
    }
    for (const agent of new Set(pending.map((r) => r.agent))) {
      try {
        fs.rmdirSync(path.join(this.root, agent)); // only succeeds once empty
      } catch (_) { /* still has files */ }
    }
    this._saveNow();
  }

  _saveNow() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    const tmp = this.indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, records: this.records }, null, 2));
    fs.renameSync(tmp, this.indexFile);
  }

  save() {
    if (!this._saveTimer) this._saveTimer = setTimeout(() => this._saveNow(), 500);
  }

  flush() {
    if (this._saveTimer) this._saveNow();
    for (const s of this.streams.values()) s.stream.end();
    this.streams.clear();
  }

  // ---- paths --------------------------------------------------------------

  _dir(key, agent) {
    const folderDir = path.join(this.root, 'folders', key);
    const dir = path.join(folderDir, agent);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _path(rec, kind) {
    const name = rec.id + EXTS[kind];
    if (!rec.folder) return path.join(this.root, rec.agent, name); // not migrated yet
    return path.join(this._dir(rec.folder, rec.agent), name);
  }

  _writeFolderInfo(rec) {
    const file = path.join(this.root, 'folders', rec.folder, 'folder.json');
    if (fs.existsSync(file)) return;
    try {
      fs.writeFileSync(file, JSON.stringify({ cwd: rec.cwd }, null, 2));
    } catch (_) { /* informational only */ }
  }

  logPath(rec) {
    return this._path(rec, 'log');
  }

  textPath(rec) {
    return this._path(rec, 'text');
  }

  promptsPath(rec) {
    return this._path(rec, 'prompts');
  }

  folderDir(cwd) {
    return path.join(this.root, 'folders', folderKey(cwd));
  }

  // ---- records ------------------------------------------------------------

  get(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  findByNative(agent, nativeId) {
    if (!nativeId) return null;
    return this.records.find((r) => r.agent === agent && r.nativeId === nativeId) || null;
  }

  // filter: { agent?, cwd? }; newest first.
  list(filter = {}) {
    const agent = typeof filter === 'string' ? filter : filter.agent;
    const key = filter.cwd ? folderKey(filter.cwd) : null;
    const recs = this.records.filter(
      (r) => (!agent || agent === 'all' || r.agent === agent) && (!key || (r.folder || folderKey(r.cwd)) === key)
    );
    return recs.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  }

  // One entry per working folder that has history: { key, cwd, count, agents, lastActiveAt }.
  folders() {
    const map = new Map();
    for (const r of this.records) {
      const key = r.folder || folderKey(r.cwd);
      let f = map.get(key);
      if (!f) {
        f = { key, cwd: r.cwd, count: 0, agents: {}, lastActiveAt: 0 };
        map.set(key, f);
      }
      f.count++;
      f.agents[r.agent] = (f.agents[r.agent] || 0) + 1;
      f.lastActiveAt = Math.max(f.lastActiveAt, r.lastActiveAt || 0);
    }
    return [...map.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  create({ agent, cwd, nativeId, title, workspaceRoot, configDir, accountId, backend, parentId, imported, createdAt }) {
    const now = Date.now();
    const rec = {
      id: crypto.randomUUID(),
      agent,
      cwd,
      folder: folderKey(cwd),
      workspaceRoot: workspaceRoot || null,
      // Agent config folder (CLAUDE_CONFIG_DIR / CODEX_HOME, the agent's own path) when not the default one.
      configDir: configDir || null,
      // Where the agent runs: 'windows' or 'wsl:<distro>' (backend.js).
      backend: backend || 'windows',
      // The Setup account the conversation runs under (see settings.agents[agent].accounts).
      accountId: accountId || null,
      nativeId: nativeId || null,
      title: title || null,
      customTitle: null,
      parentId: parentId || null,
      imported: imported || false,
      createdAt: createdAt || now,
      lastActiveAt: createdAt || now,
      runs: 0,
      prompts: 0,
      lastExitCode: null,
      bytes: 0,
    };
    this.records.push(rec);
    this._writeFolderInfo(rec);
    this.save();
    return rec;
  }

  update(id, patch) {
    const rec = this.get(id);
    if (!rec) return null;
    Object.assign(rec, patch);
    this.save();
    return rec;
  }

  remove(id) {
    const rec = this.get(id);
    if (!rec) return false;
    this._closeStream(id);
    for (const kind of Object.keys(EXTS)) {
      try {
        fs.unlinkSync(this._path(rec, kind));
      } catch (_) { /* already gone */ }
    }
    this.priorText.delete(id);
    this.records = this.records.filter((r) => r.id !== id);
    this.save();
    return true;
  }

  // ---- prompts ------------------------------------------------------------

  addPrompt(id, text) {
    const rec = this.get(id);
    if (!rec || typeof text !== 'string' || !text.trim()) return null;
    const entry = { t: Date.now(), text: text.slice(0, MAX_PROMPT_CHARS) };
    fs.appendFileSync(this.promptsPath(rec), JSON.stringify(entry) + '\n');
    rec.prompts = (rec.prompts || 0) + 1;
    rec.lastActiveAt = entry.t;
    this.save();
    return entry;
  }

  _readPrompts(rec) {
    let lines;
    try {
      lines = fs.readFileSync(this.promptsPath(rec), 'utf8').split('\n');
    } catch (_) {
      return [];
    }
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.text === 'string') out.push({ t: e.t || 0, text: e.text });
      } catch (_) { /* torn last line after a crash */ }
    }
    return out;
  }

  _writePrompts(rec, entries) {
    const file = this.promptsPath(rec);
    if (!entries.length) {
      try {
        fs.unlinkSync(file);
      } catch (_) { /* none */ }
    } else {
      fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    rec.prompts = entries.length;
  }

  // Oldest first, the most recent MAX_PROMPTS_READ only. `ids` may be one record id or
  // the list of conversations a tab went through; entries then carry their recordId.
  prompts(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const out = [];
    for (const id of list) {
      const rec = this.get(id);
      if (rec) for (const p of this._readPrompts(rec)) out.push({ ...p, recordId: id });
    }
    out.sort((a, b) => a.t - b.t);
    return out.slice(-MAX_PROMPTS_READ);
  }

  // Moves the prompts sent at or after `since` from one record to another: they were
  // typed in the conversation the agent had already switched to.
  movePrompts(fromId, toId, since) {
    const from = this.get(fromId);
    const to = this.get(toId);
    if (!from || !to) return 0;
    const all = this._readPrompts(from);
    const keep = all.filter((p) => p.t < since);
    const move = all.filter((p) => p.t >= since);
    if (!move.length) return 0;
    this._writePrompts(from, keep);
    this._writePrompts(to, [...this._readPrompts(to), ...move].sort((a, b) => a.t - b.t));
    this.save();
    return move.length;
  }

  // ---- runs, output, transcripts -------------------------------------------

  // `label` is the command line for a fresh run, or a note when a running tab moves
  // on to this conversation.
  beginRun(id, label, { switched = false } = {}) {
    const rec = this.get(id);
    if (!rec) return;
    rec.runs = (rec.runs || 0) + 1;
    rec.lastActiveAt = Date.now();
    this._writeFolderInfo(rec);
    this.save();
    const when = stamp();
    // The tab's snapshots only cover this run, so keep the earlier runs' text and append to it.
    let prior = '';
    try {
      prior = fs.readFileSync(this.textPath(rec), 'utf8');
    } catch (_) { /* first run */ }
    const head = switched ? `──── ${when} · ${label} ────` : `──── ${when} · run ${rec.runs} ────`;
    this.priorText.set(id, (prior ? prior.replace(/\s+$/, '') + '\n\n' : '') + head + '\n');
    this.append(id, `\r\n\x1b[2m──── ${when} · ${switched ? label : `run ${rec.runs} · ${label}`} ────\x1b[0m\r\n`);
  }

  append(id, data) {
    const rec = this.get(id);
    if (!rec || rec.bytes >= MAX_LOG_BYTES) return;
    let entry = this.streams.get(id);
    if (!entry) {
      entry = { stream: fs.createWriteStream(this.logPath(rec), { flags: 'a' }) };
      entry.stream.on('error', () => this.streams.delete(id));
      this.streams.set(id, entry);
    }
    entry.stream.write(data);
    rec.bytes = (rec.bytes || 0) + Buffer.byteLength(data);
    rec.lastActiveAt = Date.now();
    if (rec.bytes >= MAX_LOG_BYTES) entry.stream.write('\r\n\x1b[33m[log size limit reached; further output not recorded]\x1b[0m\r\n');
    this.save();
  }

  _closeStream(id) {
    const entry = this.streams.get(id);
    if (entry) {
      entry.stream.end();
      this.streams.delete(id);
    }
  }

  endRun(id, exitCode) {
    const rec = this.get(id);
    if (!rec) return;
    if (exitCode !== undefined) rec.lastExitCode = exitCode;
    rec.lastActiveAt = Date.now();
    this._closeStream(id);
    this.save();
  }

  // Folds a record into another one (a tab that turned out to be running a
  // conversation already in history): log and prompts are appended, `fromId` is removed.
  merge(fromId, intoId, label) {
    const from = this.get(fromId);
    const into = this.get(intoId);
    if (!from || !into || from === into) return into;
    this._closeStream(fromId);
    this.beginRun(intoId, label, { switched: true });
    try {
      const raw = fs.readFileSync(this.logPath(from), 'utf8');
      if (raw) this.append(intoId, raw);
    } catch (_) { /* nothing logged yet */ }
    const moved = this._readPrompts(from);
    if (moved.length) this._writePrompts(into, [...this._readPrompts(into), ...moved].sort((a, b) => a.t - b.t));
    this.remove(fromId);
    return into;
  }

  // `cleared`: the tab's screen was wiped since the last snapshot, so what is saved now
  // becomes fixed and the new text is appended after it.
  writeSnapshot(id, text, { cleared = false } = {}) {
    const rec = this.get(id);
    if (!rec || !text) return;
    const file = this.textPath(rec);
    if (cleared) {
      let saved = '';
      try {
        saved = fs.readFileSync(file, 'utf8');
      } catch (_) { /* nothing saved yet */ }
      this.priorText.set(id, (saved ? saved.replace(/\s+$/, '') + '\n\n' : '') + `──── ${stamp()} · screen cleared ────\n`);
    }
    fs.writeFileSync(file, (this.priorText.get(id) || '') + text);
  }

  read(id) {
    const rec = this.get(id);
    if (!rec) return null;
    let text = null;
    let raw = null;
    try {
      text = fs.readFileSync(this.textPath(rec), 'utf8');
    } catch (_) { /* no snapshot yet */ }
    try {
      const file = this.logPath(rec);
      const st = fs.statSync(file);
      // Replaying more than a few MB into a viewer is slow and rarely useful.
      const limit = 4 * 1024 * 1024;
      const fd = fs.openSync(file, 'r');
      const start = Math.max(0, st.size - limit);
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
    } catch (_) { /* no log yet */ }
    return { record: rec, text, raw };
  }
}

module.exports = { History, folderKey, normCwd };
