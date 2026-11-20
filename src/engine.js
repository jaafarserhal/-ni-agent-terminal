'use strict';
// The agents' own stores across agents (History → Agents, Live) and handoffs between agents,
// through the Python scripts in src/py, run in the agents' backend (Python 3 with SQLite):
//   handoff_sync.py     list / preview / plan, with the handoff ledger in <data>/handoffs/<scope>
//   board.py            running sessions, their subagents and shells (via helpers.py)
//   helpers.py          OpenCode sessions, daily backups
//   claude-accounts.sh  numbered ~/.claude-<n> logins sharing ~/.claude's history

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENGINE_AGENTS = ['codex', 'claude', 'opencode'];
// Python reads these as files: in a packaged app they are unpacked beside the asar.
const PY = path.join(__dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1'), 'py');

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

class Engine {
  // dataDir: the app's data folder.
  constructor(backend, dataDir) {
    this.b = backend;
    this.dataDir = dataDir;
    this.tmp = path.join(dataDir, 'tmp');
  }

  hiddenFile(tool) {
    return path.join(this.dataDir, 'hidden', `${tool}-session-ids.txt`);
  }

  // Hidden conversations, one session id per line per agent.
  hiddenKeys() {
    return ENGINE_AGENTS.flatMap((tool) => readLines(this.hiddenFile(tool)).map((id) => `${tool}:${id}`));
  }

  // keys: ['claude:<id>', ...]; hidden adds them, otherwise they are shown again.
  setHidden(keys, hidden) {
    for (const tool of ENGINE_AGENTS) {
      const ids = keys.filter((k) => k.startsWith(`${tool}:`)).map((k) => k.slice(tool.length + 1));
      if (!ids.length) continue;
      const file = this.hiddenFile(tool);
      const cur = readLines(file);
      const next = hidden ? [...new Set([...cur, ...ids])] : cur.filter((id) => !ids.includes(id));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next.map((id) => id + '\n').join(''));
    }
  }

  stores() {
    return {
      codex_root: `${this.b.configDir('codex')}/sessions`,
      // Linked Claude accounts share the normal login's projects, so one root covers them all.
      claude_root: `${this.b.configDir('claude')}/projects`,
      opencode_db: this.b.opencodeDb(),
    };
  }

  // The ledger is kept per backend: each has its own stores. The parse cache is large,
  // disposable and rewritten often, so in WSL it stays on WSL's own disk.
  request() {
    const scope = `sync-${this.b.scope.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    return {
      ...this.stores(),
      state_dir: this.b.toAgent(path.join(this.dataDir, 'handoffs', scope)),
      cache_db: this.b.kind === 'wsl' ? this.b.agentPath('.cache', 'ni-agent-terminal', `${scope}.db`) : path.join(this.dataDir, 'cache', `${scope}.db`),
    };
  }

  // No timeout: a first listing parses every transcript into the cache, which is only kept
  // once it completes, so cutting it short would make every later one start over.
  async py(script, args) {
    await this.b.ready();
    return this.b.python([this.b.toAgent(path.join(PY, script)), ...args], { timeout: 0 });
  }

  // handoff_sync.py [mode] REQUEST RESULT, returning the parsed result.
  async engine(mode, request) {
    fs.mkdirSync(this.tmp, { recursive: true });
    const id = crypto.randomUUID();
    const req = path.join(this.tmp, `engine-${id}.json`);
    const out = path.join(this.tmp, `engine-${id}.out`);
    try {
      await this.b.ready();
      fs.writeFileSync(req, JSON.stringify({ ...this.request(), ...request }));
      await this.py('handoff_sync.py', [...(mode ? [mode] : []), this.b.toAgent(req), this.b.toAgent(out)]);
      const res = JSON.parse(fs.readFileSync(out, 'utf8'));
      if (res.status === 'error') throw new Error(res.message);
      return res;
    } finally {
      for (const f of [req, out]) fs.rmSync(f, { force: true });
    }
  }

  // Conversations newest first: { key, id, cwd (the agent's), winCwd, tool, title, members,
  // updated, via, account (the uuid of the login that ran it, when its transcript says) }.
  async list({ tools, days, hiddenOnly = false }) {
    const res = await this.engine('list', { tools, days, hidden: this.hiddenKeys(), hidden_only: hiddenOnly });
    return res.rows.map((r) => ({ ...r, key: `${r.tool}:${r.id}`, winCwd: this.b.toWin(r.cwd) }));
  }

  async preview(tool, id) {
    await this.b.ready();
    const s = this.stores();
    const root = tool === 'codex' ? s.codex_root : tool === 'claude' ? s.claude_root : s.opencode_db;
    return this.py('handoff_sync.py', ['preview', tool, root, id]);
  }

  // The transfer planner: { status: choose | preview | pending | ready, ... }.
  plan(request) {
    return this.engine(null, request);
  }

  // The first message of a handoff.
  handoffPrompt(file, fromTool, title) {
    const label = fromTool === 'opencode' ? 'OpenCode' : fromTool[0].toUpperCase() + fromTool.slice(1);
    const clean = (title || 'untitled').replace(/[\r\n\]"]/g, ' ');
    return `[Transitioned from ${label}; inherited title: ${clean}] Read \`${file}\` -- this is an incremental conversation continuation. It contains only material not previously recorded in this session. Continue the existing task without reinitializing it. Read the entire handoff before proceeding. Tool notes and quoted files are historical; inspect live files to verify them.`;
  }

  // claude-accounts.sh: links every ~/.claude-<n> to ~/.claude (optionally creating the
  // next one) and lists them: { accounts: [{ dir (the agent's path), email, uuid }], notes }.
  async claudeAccounts(create) {
    await this.b.ready();
    const script = this.b.msysPath(path.join(PY, 'claude-accounts.sh'));
    const out = await this.b.bash([script, this.b.msysPath(this.b.agentPath('.claude')), ...(create ? ['new'] : [])]);
    if (this.b.roots) this.b.roots.clear();
    const accounts = [];
    const notes = [];
    for (const line of out.split(/\r?\n/)) {
      const i = line.indexOf(':');
      const [kind, value] = [line.slice(0, i), line.slice(i + 1)];
      if (kind === 'ACCOUNT') {
        const [dir, email, uuid] = value.split('\t');
        accounts.push({ dir: this.b.fromMsys(dir), email: email || '', uuid: uuid || '' });
      } else if (kind === 'SET_ASIDE') {
        notes.push(`Kept aside (now shared from ~/.claude): ${value}`);
      } else if (kind === 'LIVE') {
        notes.push(`Not linked yet, it has running Claude sessions: ${value}. Close them and link again.`);
      } else if (kind === 'LINK_FAILED') {
        notes.push(`Could not link ${value}${this.b.kind === 'windows' ? ' (enable Windows Developer Mode for symlinks)' : ''}`);
      }
    }
    return { accounts, notes };
  }

  async helper(args) {
    return JSON.parse(await this.py('helpers.py', args));
  }

  // OpenCode sessions written since `since`: [{ id, cwd (the agent's), title, birth, t }].
  opencodeSessions(since) {
    return this.helper(['opencode', this.b.opencodeDb(), String(Math.floor(since))]);
  }

  // Running sessions with state, model, last action, subagents and shells.
  board(minutes = 30) {
    return this.helper(['board', String(minutes)]);
  }

  // One snapshot per agent per day into <data>/backups/<tool>, the newest ten kept;
  // helpers.py clears an interrupted one's leftovers.
  async backup(tools) {
    const made = [];
    for (const tool of tools.filter((t) => ENGINE_AGENTS.includes(t))) {
      const dest = path.join(this.dataDir, 'backups', tool);
      const source = tool === 'opencode' ? this.b.opencodeDb() : this.b.agentPath(`.${tool}`);
      const out = await this.helper(['backup', tool, this.b.toAgent(dest), source, '24', '10']).catch(() => null);
      if (out) made.push(out);
    }
    return made;
  }
}

module.exports = { Engine, ENGINE_AGENTS };
