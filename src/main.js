'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen, safeStorage, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');

const { AGENTS, buildEnv, resolveLaunch, agentArgs, locate, agentEnv } = require('./agents');
const { listSessions, claudeLive, claudePids, claudeFindPid, claudeSessionExists, copyConversation, nativeTitle, samePath, normPath } = require('./sessions');
const { History } = require('./history');
const { backendFor, wslDistros, shQuote } = require('./backend');
const { Engine, ENGINE_AGENTS } = require('./engine');
const workspace = require('./workspace');

// Test hooks: an isolated data folder, and a screenshot-then-quit smoke run.
if (process.env.NI_TERM_USERDATA) app.setPath('userData', process.env.NI_TERM_USERDATA);
const SMOKE_SHOT = process.env.NI_TERM_SMOKE || null;

// The taskbar groups windows, and a pinned shortcut, by this id: the installer's, set here
// too so a run from source matches the shortcut --install-shortcut writes.
const APP_ID = 'com.ni.agentterminal';
app.setAppUserModelId(APP_ID);

// --install-shortcut (npm run shortcut): writes a Start menu shortcut, which can be pinned,
// and quits. From source it starts this checkout with its own Electron, so it keeps working
// after code changes; from a build it starts that .exe.
function installShortcut() {
  const fromSource = process.defaultApp;
  const name = fromSource ? 'NI Agent Terminal (source)' : 'NI Agent Terminal';
  const file = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`);
  // A shortcut icon must be an .ico: one 256 px PNG entry.
  const png = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 256, height: 256 }).toPNG();
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  const icon = path.join(app.getPath('userData'), 'shortcut.ico');
  fs.mkdirSync(path.dirname(icon), { recursive: true });
  fs.writeFileSync(icon, Buffer.concat([head, png]));
  const ok = shell.writeShortcutLink(file, {
    target: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    args: fromSource ? `"${app.getAppPath()}"` : '',
    cwd: fromSource ? app.getAppPath() : path.dirname(process.execPath),
    icon,
    iconIndex: 0,
    appUserModelId: APP_ID,
    description: 'Multi-tab terminal for coding agents',
  });
  console.log(ok ? `Start menu shortcut written: ${file}` : `Could not write ${file}`);
  return ok;
}

if (process.argv.includes('--install-shortcut')) {
  process.exit(installShortcut() ? 0 : 1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userData = app.getPath('userData');
const settingsFile = path.join(userData, 'settings.json');
const stateFile = path.join(userData, 'state.json');
const tmpDir = path.join(userData, 'tmp');

const DEFAULT_AGENTS = {
  claude: { enabled: true, command: '' },
  codex: { enabled: true, command: '' },
  cursor: { enabled: true, command: '' },
  opencode: { enabled: false, command: '' },
  shell: { enabled: true, command: '' },
};

const DEFAULT_SETTINGS = {
  // Setup (workspace folders + agents) is shown on first start until it is saved.
  setupDone: false,
  workspaces: [],
  agents: DEFAULT_AGENTS,
  restoreTabs: true,
  copyOnSelect: false,
  fontSize: 14,
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
  scrollback: 20000,
  extraArgs: { claude: '', codex: '', cursor: '', opencode: '', shell: '' },
  startupTabs: ['claude', 'codex', 'cursor'],
  // Where new tabs run their agents: 'windows' or 'wsl:<distro>'.
  backend: 'windows',
  // How far back History → Agents lists conversations.
  agentsDays: 40,
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function normalizeSettings(s) {
  const out = { ...DEFAULT_SETTINGS, ...s };
  out.extraArgs = { ...DEFAULT_SETTINGS.extraArgs, ...(s.extraArgs || {}) };
  // 1.1 had a single workspaceRoot (the ni-agentic-development folder).
  if (!Array.isArray(out.workspaces)) out.workspaces = [];
  if (!out.workspaces.length && s.workspaceRoot) out.workspaces = [s.workspaceRoot];
  out.workspaces = out.workspaces.filter((p) => typeof p === 'string' && p.trim());
  delete out.workspaceRoot;
  out.backend = typeof out.backend === 'string' && /^(windows|wsl:.+)$/.test(out.backend) ? out.backend : 'windows';
  out.agentsDays = Math.max(1, Number(out.agentsDays) || DEFAULT_SETTINGS.agentsDays);
  const agents = {};
  for (const id of Object.keys(DEFAULT_AGENTS)) {
    const a = (s.agents && s.agents[id]) || {};
    agents[id] = {
      enabled: a.enabled !== false,
      command: typeof a.command === 'string' ? a.command.trim() : '',
      ...normalizeAccounts(id, a),
    };
  }
  out.agents = agents;
  return out;
}

// Accounts of one agent: [{ id, name, configDir, apiKeyEnc? }]. A Claude / Codex account is
// a config folder ('' = the normal login); a Cursor account is an API key, kept encrypted
// (apiKeyEnc), with no key = the normal login. A new chat asks which one to use; a
// conversation keeps the one it last ran under (its history record).
function normalizeAccounts(agentId, a) {
  const kind = AGENTS[agentId].accountKind;
  if (!kind) return { accounts: [] };
  const seen = new Set();
  const freshId = () => `acct-${crypto.randomUUID().slice(0, 8)}`;
  let accounts = (Array.isArray(a.accounts) ? a.accounts : [])
    .filter((x) => x && typeof x === 'object')
    .map((x, i) => {
      let id = typeof x.id === 'string' && x.id.trim() ? x.id.trim() : i === 0 ? 'default' : freshId();
      if (seen.has(id)) id = freshId();
      seen.add(id);
      const acct = {
        id,
        name: (typeof x.name === 'string' && x.name.trim()) || (i === 0 ? 'Default' : `Account ${i + 1}`),
        configDir: kind === 'dir' && typeof x.configDir === 'string' ? x.configDir.trim() : '',
      };
      if (kind === 'key' && typeof x.apiKeyEnc === 'string' && x.apiKeyEnc) acct.apiKeyEnc = x.apiKeyEnc;
      return acct;
    });
  if (!accounts.length) {
    accounts = [{ id: 'default', name: 'Default', configDir: '' }];
    // 1.2 had one account folder per agent: keep it as a second account.
    const legacy = kind === 'dir' && typeof a.configDir === 'string' ? a.configDir.trim() : '';
    if (legacy) accounts.push({ id: 'account-2', name: path.basename(legacy) || 'Account 2', configDir: legacy });
  }
  return { accounts };
}

// Settings as the window sees them: API keys are never sent, only whether one is saved.
function publicSettings() {
  const agents = {};
  for (const [id, a] of Object.entries(settings.agents)) {
    agents[id] = { ...a, accounts: (a.accounts || []).map(({ apiKeyEnc, ...x }) => ({ ...x, hasKey: !!apiKeyEnc })) };
  }
  return { ...settings, agents };
}

function encryptKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows cannot encrypt the API key here, so it was not saved.');
  return safeStorage.encryptString(key).toString('base64');
}

function decryptKey(enc) {
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch (_) {
    return null;
  }
}

let settings = normalizeSettings(readJson(settingsFile, {}));

// The portable build unpacks to a temp folder; PORTABLE_EXECUTABLE_DIR is where the user put the .exe.
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));

// ---------------------------------------------------------------------------
// Backends and stores
// ---------------------------------------------------------------------------

const backend = (key) => backendFor(key, tmpDir);
const newBackend = () => backend(settings.backend);
// Records from before backends ran on Windows.
const backendOf = (rec) => backend(rec && rec.backend);
const engineFor = (b) => new Engine(b, userData);

// An agent's store as Windows reaches it, for one of its accounts (configDir: the agent's
// own path, '' for the normal login): for a linked account, the shared one it links to.
// Cursor keeps one chats folder; OpenCode a database.
async function storeDir(b, agent, configDir) {
  if (agent === 'cursor') return b.kind === 'windows' && process.env.CURSOR_CHATS_DIR ? process.env.CURSOR_CHATS_DIR : b.toWin(b.agentPath('.cursor', 'chats'));
  if (agent === 'opencode') return b.toWin(b.opencodeDb());
  if (!AGENTS[agent].configEnv) return null;
  return b.toWin(await b.storeRoot(configDir || b.configDir(agent)));
}

// The workspace folder a working directory belongs to, else the first one.
function workspaceFor(cwd) {
  return workspace.containingRoot(settings.workspaces, cwd) || settings.workspaces[0] || null;
}

function agentCfg(id) {
  return settings.agents[id] || { enabled: true, command: '', accounts: [] };
}

const sameDir = (a, b) => (!a && !b) || (!!a && !!b && samePath(a, b));

function accountById(agentId, accountId) {
  return (agentCfg(agentId).accounts || []).find((x) => x.id === accountId) || null;
}

// The account used when nothing says which: the first one.
function firstAccount(agentId) {
  return (agentCfg(agentId).accounts || [])[0] || null;
}

// The account a conversation runs under: the one it was started with, else (records
// from before accounts, or a removed account) the one with the same config folder.
function accountForRecord(rec) {
  const kind = rec && AGENTS[rec.agent] && AGENTS[rec.agent].accountKind;
  if (!kind) return null;
  const byId = rec.accountId && accountById(rec.agent, rec.accountId);
  if (byId) return byId;
  if (kind === 'dir') return (agentCfg(rec.agent).accounts || []).find((x) => sameDir(x.configDir, rec.configDir)) || null;
  return null;
}

// Where each command resolves in the backend: { claude: path|null, ... }.
async function locateAll(b, commands) {
  const ids = Object.keys(AGENTS);
  if (b.kind === 'windows') {
    const env = buildEnv({});
    return Object.fromEntries(ids.map((id) => [id, locate(id, commands[id], env)]));
  }
  await b.ready();
  // A WSL shell tab with no command runs the login shell, which is always there.
  const names = ids.map((id) => (commands[id] || '').trim() || (id === 'shell' ? 'bash' : AGENTS[id].command));
  const found = await b.locate(names);
  return Object.fromEntries(ids.map((id, i) => [id, found[i]]));
}

async function agentStatus() {
  const b = newBackend();
  // An unreachable WSL distro lists every agent as not found rather than failing the window.
  const found = await locateAll(b, Object.fromEntries(Object.keys(AGENTS).map((id) => [id, agentCfg(id).command]))).catch(() => ({}));
  return Object.values(AGENTS).map((a) => {
    const cfg = agentCfg(a.id);
    return {
      id: a.id,
      label: a.label,
      color: a.color,
      enabled: cfg.enabled,
      available: !!found[a.id],
      path: found[a.id],
      defaultCommand: b.kind === 'wsl' && a.id === 'shell' ? 'login shell' : a.command,
      accountKind: a.accountKind || null,
      configEnv: a.configEnv || null,
      keyEnv: a.keyEnv || null,
      defaultConfigDir: a.configEnv && b.home ? b.configDir(a.id) : null,
    };
  });
}

const history = new History(path.join(userData, 'history'));
const sessions = new Map(); // tabId -> live pty session
let win = null;
let closing = false;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function publicRecord(rec) {
  if (!rec) return null;
  const roots = [...settings.workspaces, ...(rec.workspaceRoot ? [rec.workspaceRoot] : [])];
  const acct = accountForRecord(rec);
  return {
    ...rec,
    backendLabel: rec.backend && rec.backend !== 'windows' ? backendOf(rec).label : null,
    cwdLabel: workspace.labelFor(roots, rec.cwd),
    branch: workspace.readBranch(rec.cwd),
    accountId: acct ? acct.id : rec.accountId || null,
    accountName: acct ? acct.name : rec.configDir ? path.basename(rec.configDir) : null,
  };
}

// ---------------------------------------------------------------------------
// Conversation tracking
// ---------------------------------------------------------------------------
// A tab is one agent process, but the agent can go through several conversations:
// /clear and /new start a fresh one, /resume switches to an older one. Every couple of
// seconds each live tab is matched against the agent's own store, and the tab moves
// to the history record of the conversation it is on now, so each conversation
// is listed and resumable on its own.
//
// Claude: ~/.claude/sessions/<pid>.json names the current session exactly.
// Codex / Cursor / OpenCode: a conversation created in the tab's folder is attributed to
// the tab in which Enter was pressed just before it appeared (or that had just started).
// Each tab reads its own backend's store: s.store, with the folder as the agent sees it (s.agentCwd).

const TRACK_MS = 2000;
const TITLE_MS = 20000;
const OPENCODE_MS = 5000;

// OpenCode's sessions per backend, refreshed through Python while an OpenCode tab runs.
const opencodeCache = new Map(); // backend key -> { at, busy, list }
function opencodeList(b, cwd, since) {
  const c = opencodeCache.get(b.key);
  return c ? c.list.filter((x) => x.t >= since && samePath(x.cwd, cwd)) : [];
}
function refreshOpencode() {
  const live = [...sessions.values()].filter((s) => s.agent === 'opencode');
  for (const b of new Set(live.map((s) => s.backend))) {
    const c = opencodeCache.get(b.key) || { at: 0, busy: false, list: [] };
    opencodeCache.set(b.key, c);
    if (c.busy || Date.now() - c.at < OPENCODE_MS) continue;
    c.busy = true;
    const since = Math.min(...live.filter((s) => s.backend === b).map((s) => s.since)) - 5000;
    engineFor(b).opencodeSessions(since)
      .then((list) => { c.list = list; })
      .catch(() => {})
      .finally(() => { c.busy = false; c.at = Date.now(); });
  }
}

function listFor(s, since) {
  return s.agent === 'opencode' ? opencodeList(s.backend, s.agentCwd, since) : listSessions(s.agent, s.agentCwd, since, s.store);
}

function titleFor(s, nativeId) {
  if (s.agent !== 'opencode') return nativeTitle(s.agent, s.agentCwd, nativeId, s.store);
  const c = opencodeCache.get(s.backend.key);
  const hit = c && c.list.find((x) => x.id === nativeId);
  return (hit && hit.title) || null;
}

function liveTabOf(agent, nativeId, exceptTab) {
  for (const [tabId, s] of sessions) {
    if (tabId === exceptTab || s.agent !== agent) continue;
    const rec = history.get(s.recordId);
    if (rec && rec.nativeId === nativeId) return tabId;
  }
  return null;
}

// Which live tab created this conversation, and how sure we are.
function ownerOf(agent, cwd, birth) {
  let best = null;
  for (const [tabId, s] of sessions) {
    if (s.agent !== agent) continue;
    const rec = history.get(s.recordId);
    if (!rec || !samePath(rec.cwd, cwd)) continue;
    // The agent writes a new conversation right after the Enter that started it.
    for (const e of s.enters) {
      if (birth >= e - 1500 && birth <= e + 15000 && (!best || !best.byEnter || e > best.at)) best = { tabId, at: e, byEnter: true };
    }
    // Some agents create their conversation as soon as they start.
    if (!best && birth >= s.since - 2000 && birth <= s.since + 30000) best = { tabId, at: s.since, byEnter: false };
  }
  return best;
}

// A record this run created that never became a real conversation: the agent never
// wrote it, or only slash commands were sent. It is replaced rather than kept.
function isThrowaway(rec, s) {
  if (rec.createdAt < s.since - 1000) return false;
  if (rec.agent === 'claude' && rec.nativeId && !claudeSessionExists(s.agentCwd, rec.nativeId, s.store)) return true;
  return history.prompts(rec.id).every((p) => p.text.startsWith('/'));
}

function switchConversation(tabId, s, rec, target) {
  const other = history.findByNative(s.agent, target.id);
  if (other && other.id !== rec.id && liveTabOf(s.agent, target.id, tabId)) return; // open in another tab
  const now = Date.now();
  let next;
  let replacedId = null;
  if (other && other.id !== rec.id) {
    // Switched to (or turned out to be) a conversation already in history.
    if (!rec.nativeId || isThrowaway(rec, s)) {
      next = history.merge(rec.id, other.id, 'continued in this tab');
      replacedId = rec.id;
    } else {
      history.endRun(rec.id);
      history.beginRun(other.id, 'switched to this conversation', { switched: true });
      history.movePrompts(rec.id, other.id, target.birth - 1500);
      next = other;
    }
  } else if (!rec.nativeId || isThrowaway(rec, s)) {
    // First sight of the conversation, or the earlier one was empty: fill it in.
    next = history.update(rec.id, { nativeId: target.id, title: rec.nativeId ? null : rec.title });
  } else {
    next = history.create({ agent: s.agent, cwd: rec.cwd, nativeId: target.id, workspaceRoot: rec.workspaceRoot, configDir: rec.configDir, accountId: rec.accountId, backend: rec.backend, parentId: rec.id });
    history.endRun(rec.id);
    history.beginRun(next.id, 'new conversation in this tab', { switched: true });
    history.movePrompts(rec.id, next.id, target.birth - 1500);
  }
  s.recordId = next.id;
  s.lastSwitchAt = now;
  s.titleAt = 0;
  if (SMOKE_SHOT) console.log(`[track ${tabId}] ${rec.id.slice(0, 8)}/${rec.nativeId} -> ${next.id.slice(0, 8)}/${target.id}`);
  send('session:update', {
    tabId,
    record: publicRecord(history.get(next.id)),
    previousId: next.id !== rec.id ? rec.id : null,
    replacedId,
    at: target.birth, // about when the new conversation began
  });
}

// Claude's pid file: the tab's own pid on Windows (npm shims are unwrapped), else (WSL
// runs wsl.exe) the one claudeFindPid picks. A found pid is the tab's, so no time checks.
function claudeLiveOf(tabId, s, rec) {
  if (!s.claudePid && claudeLive(s.pty.pid, s.agentCwd, s.since, s.store)) s.claudePid = s.pty.pid;
  if (!s.claudePid && s.backend.kind === 'wsl') {
    const taken = new Set([...sessions.entries()].filter(([id, o]) => id !== tabId && o.claudePid).map(([, o]) => o.claudePid));
    s.claudePid = claudeFindPid(s.agentCwd, s.store, rec.nativeId, taken, s.pidsBefore) || null;
  }
  const live = s.claudePid && claudeLive(s.claudePid, s.agentCwd, s.claudePid === s.pty.pid ? s.since : 0, s.store);
  // Its file is gone (that Claude exited inside the tab): look again.
  if (s.claudePid && !live && s.backend.kind === 'wsl') s.claudePid = null;
  return live;
}

function trackTab(tabId, s, listCached) {
  const rec = history.get(s.recordId);
  if (!rec) return;
  const now = Date.now();
  const enteredThisRun = s.enters.some((e) => e > s.since);
  let target = null;

  if (s.agent === 'claude') {
    const live = claudeLiveOf(tabId, s, rec);
    if (live) {
      s.exact = true;
      const birth = s.enters.length ? s.enters[s.enters.length - 1] : now;
      if (live.sessionId !== rec.nativeId && (!rec.nativeId || enteredThisRun)) target = { id: live.sessionId, birth };
      if (live.status !== s.status) {
        s.status = live.status;
        send('session:status', { tabId, status: live.status });
      }
    }
  }
  if (!target && !s.exact) {
    const cands = listCached(s).filter((c) => c.t >= s.since - 2000 && c.id !== rec.nativeId && !liveTabOf(s.agent, c.id, tabId));
    const mine = cands
      .filter((c) => c.birth >= Math.max(s.since, s.lastSwitchAt) - 2000)
      .map((c) => ({ c, owner: ownerOf(s.agent, rec.cwd, c.birth) }))
      .filter((x) => x.owner && x.owner.tabId === tabId)
      .sort((a, b) => b.c.birth - a.c.birth);
    if (!rec.nativeId) {
      // A conversation this tab created, else one it continued (Last / Pick… / /resume).
      const created = mine[0] && mine[0].c;
      const continued = s.mode !== 'new' ? cands.find((c) => c.birth < s.since - 2000) : null;
      target = created || continued || null;
    } else if (enteredThisRun) {
      const fresh = mine.find((x) => x.owner.byEnter && !history.findByNative(s.agent, x.c.id));
      if (fresh) target = fresh.c;
    }
  }
  if (target) switchConversation(tabId, s, rec, target);

  const cur = history.get(s.recordId);
  if (cur && cur.nativeId && !cur.customTitle && now - s.titleAt > (cur.title ? TITLE_MS : TRACK_MS)) {
    s.titleAt = now;
    const title = titleFor(s, cur.nativeId);
    if (title && title !== cur.title) {
      history.update(cur.id, { title });
      send('session:update', { tabId, record: publicRecord(cur) });
    }
  }
}

function trackSessions() {
  refreshOpencode();
  const cache = new Map();
  const listCached = (s) => {
    const key = `${s.agent}|${normPath(s.agentCwd)}|${s.store || ''}`;
    if (!cache.has(key)) {
      let since = Date.now();
      for (const o of sessions.values()) if (o.agent === s.agent) since = Math.min(since, o.since);
      cache.set(key, listFor(s, since - 5000));
    }
    return cache.get(key);
  };
  for (const [tabId, s] of [...sessions]) {
    if (s.agent === 'shell' || sessions.get(tabId) !== s) continue;
    try {
      trackTab(tabId, s, listCached);
    } catch (err) {
      if (SMOKE_SHOT) console.log(`[track ${tabId}] ${err.stack}`);
    }
  }
}
setInterval(trackSessions, TRACK_MS);

const TAIL_CHARS = 2 * 1024 * 1024;

// `prompt`: a first message for the agent, sent as a launch argument (a handoff).
async function startPty({ tabId, agent, cwd, recordId, mode, accountId, cols, rows, prompt }) {
  if (!AGENTS[agent]) throw new Error(`Unknown agent ${agent}`);

  const cfg = agentCfg(agent);
  let rec = recordId ? history.get(recordId) : null;
  let runMode = mode || 'new';
  const b = rec ? backendOf(rec) : newBackend();
  await b.ready();
  // The account folder is kept with the record: the conversation lives in that
  // folder's store, so resuming it later must use the same one.
  const acct = rec ? null : accountById(agent, accountId) || firstAccount(agent);
  const configDir = rec ? rec.configDir : (acct && acct.configDir) || null;
  const store = await storeDir(b, agent, configDir);
  // Only now, with nothing left to await: a second start of the same tab must not slip in between.
  stopPty(tabId);

  if (rec) {
    cwd = rec.cwd;
    if (agent === 'claude' && rec.nativeId) {
      // A Claude session that never received a message was never written to disk;
      // start it fresh under the same id instead of failing to resume.
      runMode = claudeSessionExists(b.toAgent(rec.cwd), rec.nativeId, store) ? 'resume' : 'new';
    } else if (rec.nativeId) {
      runMode = 'resume';
    } else if (runMode === 'resume') {
      runMode = 'new';
    }
  } else {
    if (!cwd || !fs.existsSync(cwd)) cwd = settings.workspaces.find((p) => fs.existsSync(p)) || require('os').homedir();
    const nativeId = agent === 'claude' && runMode === 'new' ? crypto.randomUUID() : null;
    rec = history.create({ agent, cwd, nativeId, workspaceRoot: workspaceFor(cwd), configDir, accountId: acct ? acct.id : null, backend: b.key });
  }
  // Cursor's account is an API key; a record whose account was removed uses the current one.
  const keyAcct = AGENTS[agent].accountKind === 'key' ? accountForRecord(rec) || firstAccount(agent) : null;
  const apiKey = keyAcct ? decryptKey(keyAcct.apiKeyEnc) : null;
  if (keyAcct && keyAcct.apiKeyEnc && !apiKey) throw new Error(`The API key of ${AGENTS[agent].label} account "${keyAcct.name}" cannot be read. Enter it again in Setup.`);
  if (!fs.existsSync(cwd)) throw new Error(`Working folder no longer exists: ${cwd}`);
  if (rec.configDir && !fs.existsSync(b.toWin(rec.configDir))) fs.mkdirSync(b.toWin(rec.configDir), { recursive: true });

  const root = workspaceFor(cwd);
  const tabEnv = {
    AGENT_TERMINAL: '1',
    AGENT_TERMINAL_WORKSPACE: root ? b.toAgent(root) : '',
    AGENT_TERMINAL_SESSION: rec.id,
    // Names used by 1.x; kept so existing scripts and instructions keep working.
    NI_WORKSPACE: root ? b.toAgent(root) : '',
    NI_AGENT_TERMINAL: '1',
    NI_AGENT_TERMINAL_SESSION: rec.id,
    ...agentEnv(agent, rec.configDir, apiKey, b.kind === 'wsl'),
  };
  const run = { mode: runMode, nativeId: rec.nativeId, extraArgs: settings.extraArgs[agent], prompt, inlineSettings: b.toAgent(inlineSettingsFile()) };
  let launch;
  let env;
  if (b.kind === 'wsl') {
    const command = cfg.command || (agent === 'shell' ? '' : AGENTS[agent].command);
    launch = b.launch({ cwd, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', ...tabEnv }, command, args: agentArgs(agent, { ...run, file: command }) });
    env = buildEnv(launch.env);
  } else {
    env = buildEnv(tabEnv);
    launch = { ...resolveLaunch(agent, run, env, cfg.command), cwd };
  }

  const proc = pty.spawn(launch.file, launch.args, {
    name: 'xterm-256color',
    cols: Math.max(cols || 120, 20),
    rows: Math.max(rows || 30, 5),
    cwd: launch.cwd,
    env,
    useConpty: true,
  });

  const s = {
    pty: proc,
    agent,
    mode: runMode,
    backend: b,
    agentCwd: b.toAgent(cwd),
    store,
    configDir: rec.configDir || null,
    recordId: rec.id,
    since: Date.now(),
    lastSwitchAt: 0,
    titleAt: 0,
    enters: [], // when Enter was sent, newest last; ties new conversations to this tab
    exact: false, // Claude's pid file is being read
    claudePid: null,
    pidsBefore: agent === 'claude' && b.kind === 'wsl' ? claudePids(store) : null,
    status: null, // Claude's own 'busy' / 'idle'
    buf: '',
    flushTimer: null,
    tail: [], // the latest output, to redraw the tab after the window reloads
    tailLength: 0,
    detached: false, // the window is reloading: output only goes to the tail
  };
  let markExited;
  s.exited = new Promise((resolve) => { markExited = resolve; });
  sessions.set(tabId, s);
  history.beginRun(rec.id, launch.display);

  if (SMOKE_SHOT) console.log(`[${process.uptime().toFixed(2)}s pty ${tabId}] spawn ${launch.file} ${launch.args} cwd=${cwd} ${cols}x${rows}`);
  proc.onData((data) => {
    if (SMOKE_SHOT) console.log(`[${process.uptime().toFixed(2)}s pty ${tabId}] +${Date.now() - s.since}ms ${data.length}b`);
    // s.recordId, not rec: the tab may have moved on to another conversation.
    history.append(s.recordId, data);
    s.tail.push(data);
    s.tailLength += data.length;
    while (s.tailLength - s.tail[0].length > TAIL_CHARS) s.tailLength -= s.tail.shift().length;
    if (s.detached) return;
    // Coalesce chunks so a busy TUI redraw is one IPC message, not hundreds.
    s.buf += data;
    if (!s.flushTimer) {
      s.flushTimer = setTimeout(() => {
        s.flushTimer = null;
        const out = s.buf;
        s.buf = '';
        send('pty:data', { tabId, data: out });
      }, 8);
    }
  });

  proc.onExit(({ exitCode }) => {
    markExited();
    if (SMOKE_SHOT) console.log(`[${process.uptime().toFixed(2)}s pty ${tabId}] exit ${exitCode}`);
    if (sessions.get(tabId) !== s) return;
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
      send('pty:data', { tabId, data: s.buf });
      s.buf = '';
    }
    sessions.delete(tabId);
    history.endRun(s.recordId, exitCode);
    if (!closing) send('pty:exit', { tabId, exitCode, record: publicRecord(history.get(s.recordId)) });
  });

  return { record: publicRecord(rec), display: launch.display, mode: runMode };
}

// Claude's --settings for every tab: its classic TUI, which keeps output in the normal buffer.
function inlineSettingsFile() {
  const file = path.join(userData, 'claude-inline-settings.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ tui: 'default' }));
  return file;
}

// Paths dropped on a tab, quoted for its shell and translated for its backend.
function dropText(tabId, paths) {
  const s = sessions.get(tabId);
  if (!s) return '';
  if (s.backend.kind === 'windows') return paths.map((p) => (/[\s&()^'"]/.test(p) ? `"${p}"` : p)).join(' ') + ' ';
  return paths.map((p) => shQuote(s.backend.toAgent(p))).join(' ') + ' ';
}

// Resolves once the process has exited (or after a few seconds).
function stopPty(tabId) {
  const s = sessions.get(tabId);
  if (!s) return Promise.resolve();
  sessions.delete(tabId);
  clearTimeout(s.flushTimer);
  history.endRun(s.recordId, null);
  try {
    s.pty.kill();
  } catch (_) { /* already exited */ }
  return Promise.race([s.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

// Moves a conversation to another account of its agent: the tab's process is stopped,
// the conversation is copied into that account's store (Claude, Codex), and the record
// follows the account, so the next start resumes it there.
async function switchAccount({ tabId, recordId, accountId }) {
  const s = tabId ? sessions.get(tabId) : null;
  const rec = history.get(s ? s.recordId : recordId);
  if (!rec) throw new Error('Session not found');
  const agent = AGENTS[rec.agent];
  if (!agent.accountKind) throw new Error(`${agent.label} has no accounts`);
  const acct = accountById(rec.agent, accountId);
  if (!acct) throw new Error('That account no longer exists. Check Setup.');
  for (const [id, other] of sessions) {
    if (id !== tabId && other.recordId === rec.id) throw new Error('This conversation is running in another tab. Switch that tab instead.');
  }
  if (s) await stopPty(tabId);
  let copied = true;
  if (agent.accountKind === 'dir' && !sameDir(rec.configDir, acct.configDir)) {
    const b = backendOf(rec);
    await b.ready();
    const to = await storeDir(b, rec.agent, acct.configDir);
    fs.mkdirSync(to, { recursive: true });
    copied = !rec.nativeId || copyConversation(rec.agent, b.toAgent(rec.cwd), rec.nativeId, await storeDir(b, rec.agent, rec.configDir), to);
  }
  history.update(rec.id, { accountId: acct.id, configDir: agent.accountKind === 'dir' ? acct.configDir || null : rec.configDir });
  return { record: publicRecord(rec), copied };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, arg) => {
    try {
      return { ok: true, value: await fn(arg) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

handle('app:init', async () => {
  const state = readJson(stateFile, { tabs: [] });
  // `live`: its agent is still running here (the window was reloaded), so the tab attaches to it.
  const restore = (state.tabs || [])
    .map((t) => ({
      ...t,
      live: sessions.has(t.tabId),
      record: t.recordId ? publicRecord(history.get(t.recordId)) : null,
      chain: (Array.isArray(t.chain) ? t.chain : []).filter((id) => history.get(id)),
    }))
    .filter((t) => (settings.restoreTabs || t.live) && AGENTS[t.agent] && (t.record || !t.recordId));
  return {
    version: app.getVersion(),
    settings: publicSettings(),
    workspace: workspace.describe(settings.workspaces),
    agents: await agentStatus(),
    restore,
    activeIndex: state.activeIndex || 0,
    userData,
  };
});

handle('pty:start', (opts) => startPty(opts));
handle('pty:dropText', ({ tabId, paths }) => dropText(tabId, paths || []));

// The clipboard's image saved as a PNG, as text to paste into the tab: its path, quoted and
// translated for the tab's backend. For agents that cannot read the Windows clipboard
// themselves (Codex in WSL): they attach a pasted image path. Kept until clearTmp.
handle('clipboard:imagePath', (tabId) => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return '';
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  fs.writeFileSync(file, img.toPNG());
  return dropText(tabId, [file]);
});
handle('pty:kill', (tabId) => { stopPty(tabId); });

// Reloading the window (new renderer code) keeps every agent running: their processes belong
// to this process. Output is held back until the reloaded tab attaches and takes the tail,
// so nothing is lost or drawn twice.
handle('app:reload', () => {
  for (const s of sessions.values()) s.detached = true;
  win.webContents.reload();
});
handle('pty:attach', (tabId) => {
  const s = sessions.get(tabId);
  if (!s) return null;
  s.detached = false;
  clearTimeout(s.flushTimer);
  s.flushTimer = null;
  s.buf = '';
  return { data: s.tail.join(''), status: s.status, record: publicRecord(history.get(s.recordId)) };
});
handle('pty:switchAccount', (opts) => switchAccount(opts || {}));
ipcMain.on('pty:write', (_e, { tabId, data }) => {
  const s = sessions.get(tabId);
  if (SMOKE_SHOT) console.log(`[${process.uptime().toFixed(2)}s pty ${tabId}] write ${JSON.stringify(data)}`);
  if (!s) return;
  if (typeof data === 'string' && data.includes('\r') && !data.startsWith('\x1b[200~')) {
    s.enters.push(Date.now());
    if (s.enters.length > 8) s.enters.shift();
  }
  s.pty.write(data);
});
ipcMain.on('pty:resize', (_e, { tabId, cols, rows }) => {
  const s = sessions.get(tabId);
  if (s && cols > 0 && rows > 0) {
    try {
      s.pty.resize(cols, rows);
    } catch (_) { /* exited between messages */ }
  }
});

handle('history:list', (filter) => history.list(filter || {}).map(publicRecord));
handle('history:folders', () => history.folders().map((f) => ({ ...f, label: workspace.labelFor(settings.workspaces, f.cwd) })));
handle('history:get', (ids) => (ids || []).map((id) => publicRecord(history.get(id))).filter(Boolean));

// Conversations in the agents' own stores for this folder that history has no record of,
// e.g. ones started outside the app, or before conversation tracking existed.
// In the new-tab backend; OpenCode's are in the Agents view.
const IMPORT_DAYS = 60;
async function importable(cwd) {
  const since = Date.now() - IMPORT_DAYS * 86400000;
  const b = newBackend();
  await b.ready();
  const agentCwd = b.toAgent(cwd);
  const out = [];
  for (const agent of ['claude', 'codex', 'cursor']) {
    const cfg = agentCfg(agent);
    if (!cfg.enabled) continue;
    // Look in the default store and in every account's folder.
    const kind = AGENTS[agent].accountKind;
    const dirs = kind === 'dir'
      ? [null, ...(cfg.accounts || []).map((x) => x.configDir || null)].filter((d, i, all) => all.findIndex((o) => sameDir(o, d)) === i)
      : [null];
    for (const dir of dirs) {
      const acct = kind === 'dir' ? (cfg.accounts || []).find((x) => sameDir(x.configDir, dir)) : null;
      const store = await storeDir(b, agent, dir);
      for (const c of listSessions(agent, agentCwd, since, store)) {
        if (history.findByNative(agent, c.id) || liveTabOf(agent, c.id, null) || out.some((x) => x.agent === agent && x.id === c.id)) continue;
        const title = nativeTitle(agent, agentCwd, c.id, store) || c.title || null;
        // A Claude session holding nothing but a /clear has no title to show.
        if (agent === 'claude' && !title) continue;
        out.push({ agent, id: c.id, title, birth: c.birth, t: c.t, configDir: dir, accountId: acct ? acct.id : null, backend: b.key });
      }
    }
  }
  return out.sort((a, b) => b.t - a.t);
}
handle('history:importable', (cwd) => (cwd && fs.existsSync(cwd) ? importable(cwd) : []));
handle('history:import', async (cwd) => {
  let n = 0;
  for (const c of await importable(cwd)) {
    const rec = history.create({
      agent: c.agent,
      cwd,
      nativeId: c.id,
      title: c.title,
      workspaceRoot: workspaceFor(cwd),
      configDir: c.configDir,
      accountId: c.accountId,
      backend: c.backend,
      imported: true,
      createdAt: Math.min(c.birth || c.t, c.t),
    });
    history.update(rec.id, { lastActiveAt: c.t });
    n++;
  }
  return n;
});
handle('history:read', (id) => {
  const r = history.read(id);
  return r && { ...r, record: publicRecord(r.record) };
});
handle('history:delete', (id) => {
  for (const s of sessions.values()) if (s.recordId === id) throw new Error('Close the tab running this session first.');
  return history.remove(id);
});
handle('history:rename', ({ id, title }) => publicRecord(history.update(id, { customTitle: title || null })));
handle('history:prompts', (ids) => history.prompts(ids));
ipcMain.on('history:addPrompt', (_e, { tabId, text }) => {
  // Attribute the prompt to whatever conversation the tab is running right now.
  const s = sessions.get(tabId);
  if (s && history.addPrompt(s.recordId, text)) send('history:prompt', { tabId, recordId: s.recordId });
});
handle('history:snapshot', ({ id, text, cleared }) => history.writeSnapshot(id, text, { cleared }));
handle('history:openFolder', (arg) => {
  const rec = typeof arg === 'string' && history.get(arg);
  if (rec) {
    const target = history.logPath(rec);
    if (fs.existsSync(target)) return shell.showItemInFolder(target);
    return shell.openPath(path.dirname(target));
  }
  // { cwd }: that folder's history; nothing: the history root.
  const dir = arg && arg.cwd ? history.folderDir(arg.cwd) : history.root;
  return shell.openPath(fs.existsSync(dir) ? dir : history.root);
});
handle('history:export', async (id) => {
  const r = history.read(id);
  if (!r) throw new Error('Session not found');
  const name = `${r.record.agent}-${new Date(r.record.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  const res = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: 'Text', extensions: ['txt'] }] });
  if (res.canceled || !res.filePath) return false;
  const text = r.text || stripAnsi(r.raw || '');
  fs.writeFileSync(res.filePath, text);
  return res.filePath;
});

// An account folder as the agent sees it: ~ expanded, and in WSL a \\wsl$ or C:\ path translated.
function agentDir(b, dir) {
  const d = (dir || '').trim();
  if (!d) return '';
  if (d === '~' || /^~[\\/]/.test(d)) return b.agentPath(...d.slice(2).split(/[\\/]/).filter(Boolean));
  return b.toAgent(d);
}

handle('settings:save', async (patch) => {
  const p = patch || {};
  const b = backend(p.backend || settings.backend);
  // Account folders are translated for the backend; other settings save without it.
  if (p.agents) await b.ready();
  const agents = { ...settings.agents };
  for (const [id, a] of Object.entries(p.agents || {})) {
    if (!agents[id]) continue;
    const next = { ...agents[id], ...a };
    if (Array.isArray(a.accounts)) {
      // A Cursor key arrives as plain apiKey (new or replaced) or as clearKey; an
      // account sent with neither keeps the key it has.
      next.accounts = a.accounts.map((x) => {
        const old = (agents[id].accounts || []).find((o) => o.id === x.id) || {};
        const acct = { id: x.id, name: x.name, configDir: agentDir(b, x.configDir) };
        if (typeof x.apiKey === 'string' && x.apiKey.trim()) acct.apiKeyEnc = encryptKey(x.apiKey.trim());
        else if (!x.clearKey && old.apiKeyEnc) acct.apiKeyEnc = old.apiKeyEnc;
        return acct;
      });
    }
    agents[id] = next;
  }
  settings = normalizeSettings({ ...settings, ...p, agents, extraArgs: { ...settings.extraArgs, ...(p.extraArgs || {}) } });
  writeJson(settingsFile, settings);
  return { settings: publicSettings(), workspace: workspace.describe(settings.workspaces), agents: await agentStatus() };
});

// What Setup needs: the current choices, folders worth suggesting, and where each
// agent's command resolves to.
handle('setup:info', async () => {
  const suggested = settings.workspaces.length ? [] : workspace.suggestRoots(exeDir);
  return {
    settings: publicSettings(), suggested, agents: await agentStatus(), home: workspace.home(),
    distros: await wslDistros(),
  };
});
// Resolves typed commands without saving them, in the backend Setup shows:
// { backend, commands: { claude: 'claude', … } } -> { claude: path|null, … }.
handle('setup:locate', async ({ backend: key, commands }) => {
  const b = backend(key);
  const found = await locateAll(b, commands || {});
  return { found, configDirs: { claude: b.configDir('claude'), codex: b.configDir('codex') } };
});

// ---------------------------------------------------------------------------
// History → Agents and Live: the agents' own stores, across agents (engine.js)
// ---------------------------------------------------------------------------

const engineAgents = () => ENGINE_AGENTS.filter((t) => agentCfg(t).enabled);

// A conversation from the agents' stores as a history record, so a tab can resume it:
// the one already recorded, else a new imported one in the new-tab backend under `accountId`.
function recordForNative(tool, id, cwd, title, accountId) {
  const b = newBackend();
  const rec = history.findByNative(tool, id);
  if (rec) return rec;
  const acct = accountById(tool, accountId) || firstAccount(tool);
  return history.create({
    agent: tool, cwd: b.toWin(cwd), nativeId: id, title: title || null, workspaceRoot: workspaceFor(b.toWin(cwd)),
    configDir: AGENTS[tool].accountKind === 'dir' && acct ? acct.configDir || null : null, accountId: acct ? acct.id : null,
    backend: b.key, imported: true,
  });
}

// Which Claude account each login is, by its uuid: every account folder's .claude.json names
// its login. The normal login's file sits beside its folder (~/.claude.json), unless the app
// inherited CLAUDE_CONFIG_DIR.
function claudeLogins(b) {
  const logins = new Map();
  for (const acct of agentCfg('claude').accounts || []) {
    const inside = acct.configDir || (b.kind === 'windows' && process.env.CLAUDE_CONFIG_DIR);
    const file = b.toWin(inside ? `${inside}/.claude.json` : `${b.configDir('claude')}.json`);
    const uuid = (readJson(file, {}).oauthAccount || {}).accountUuid;
    if (uuid) logins.set(uuid, acct);
  }
  return logins;
}

// History → All: every conversation once. The agents' stores give the rows, where a
// conversation handed between agents is one row under the agent used last; the history
// records they do not cover (Shell, Cursor, another backend, older ones) follow as they are.
// A row resumes under the account its record last ran with, else the login its transcript
// names, else the first account. Without Python only the records are listed, with the reason.
handle('history:all', async ({ hiddenOnly } = {}) => {
  const b = newBackend();
  const engine = engineFor(b);
  const res = await engine.list({ tools: engineAgents(), days: settings.agentsDays, hiddenOnly: !!hiddenOnly })
    .then((rows) => ({ rows, logins: claudeLogins(b) }), (err) => ({ rows: [], logins: new Map(), error: err.message }));
  const covered = new Set([...res.rows.flatMap((r) => r.members), ...engine.hiddenKeys()]);
  return {
    error: res.error || null,
    rows: res.rows.map((r) => {
      const rec = history.findByNative(r.tool, r.id);
      const acct = (rec && accountForRecord(rec)) || res.logins.get(r.account) || firstAccount(r.tool);
      return { ...r, record: publicRecord(rec), accountId: acct ? acct.id : null, cwdLabel: workspace.labelFor(settings.workspaces, r.winCwd) };
    }),
    records: hiddenOnly ? [] : history.list({}).filter((rec) => !covered.has(`${rec.agent}:${rec.nativeId}`)).map(publicRecord),
  };
});
handle('stores:preview', ({ tool, id }) => engineFor(newBackend()).preview(tool, id));
handle('stores:hide', ({ keys, hidden }) => engineFor(newBackend()).setHidden(keys || [], hidden !== false));
handle('stores:board', () => engineFor(newBackend()).board());

// A listed conversation as a record to resume, under `accountId`: its own account by
// default, another one to carry on under that login.
handle('stores:open', async ({ tool, id, cwd, title, accountId }) => {
  const rec = recordForNative(tool, id, cwd, title, accountId);
  if (accountId && accountId !== (accountForRecord(rec) || {}).id) await switchAccount({ recordId: rec.id, accountId });
  return publicRecord(history.get(rec.id));
});

// The transfer planner. request: { sources: ['claude:<id>', ...], tool, target?, preview?, retry? }.
handle('stores:plan', (request) => engineFor(newBackend()).plan(request));

// What a tab needs to continue a planned transfer: the handoff prompt (when there is new
// material), the conversation's title and, for a new destination, its folder. items: the source rows.
handle('stores:handoff', ({ plan, items, cwd }) => {
  const b = newBackend();
  const title = plan.target ? plan.target.title : items.length > 1 ? `combined x${items.length}` : items[0].title;
  return { title, cwd: b.toWin(cwd || items[0].cwd), prompt: plan.handoff ? engineFor(b).handoffPrompt(plan.handoff, items[0].tool, title) : null };
});

// claude-accounts.sh: links every ~/.claude-<n> to ~/.claude's history and lists the logins.
// Setup passes the backend it shows, which may not be saved yet.
handle('stores:claudeAccounts', ({ backend: key, create }) => engineFor(backend(key)).claudeAccounts(!!create));
handle('setup:describe', (roots) => workspace.describe(roots || []));

handle('workspace:pickFolder', async (opts) => {
  const res = await dialog.showOpenDialog(win, {
    title: (opts && opts.title) || undefined,
    defaultPath: (opts && opts.defaultPath) || settings.workspaces[0] || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});
handle('dialog:pickFile', async (opts) => {
  const res = await dialog.showOpenDialog(win, {
    title: (opts && opts.title) || undefined,
    defaultPath: (opts && opts.defaultPath) || undefined,
    properties: ['openFile'],
    filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat', 'ps1'] }, { name: 'All files', extensions: ['*'] }],
  });
  return res.canceled ? null : res.filePaths[0];
});
handle('workspace:refresh', () => workspace.describe(settings.workspaces));

handle('state:save', (state) => writeJson(stateFile, state));
handle('shell:openPath', (p) => shell.openPath(p));
handle('shell:openExternal', (url) => {
  if (!/^https?:\/\//i.test(url || '')) throw new Error(`Only web links open from the terminal: ${url}`);
  return shell.openExternal(url);
});
handle('clipboard:read', () => ({ text: clipboard.readText(), hasImage: !clipboard.readImage().isEmpty() }));
handle('clipboard:write', (text) => clipboard.writeText(text || ''));
handle('app:devtools', () => win && win.webContents.toggleDevTools());

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g, '').replace(/\r(?!\n)/g, '');
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const state = readJson(stateFile, {});
  let bounds = state.bounds || { width: 1360, height: 860 };
  if (bounds.x !== undefined) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return bounds.x < a.x + a.width - 100 && bounds.x + bounds.width > a.x + 100 && bounds.y >= a.y - 20 && bounds.y < a.y + a.height - 100;
    });
    if (!visible) bounds = { width: bounds.width, height: bounds.height };
  }

  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#111317',
    title: 'NI Agent Terminal',
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#16181d', symbolColor: '#c9ccd1', height: 40 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Agents keep streaming while the window is in the background.
      backgroundThrottling: false,
    },
  });
  // Show right away (backgroundColor avoids a white flash). Waiting for 'ready-to-show'
  // is unreliable: on some machines it never fires, which left a windowless instance
  // holding the single-instance lock, so every later launch exited silently.
  if (state.maximized) win.maximize();
  // A smoke run must not take the keyboard from whatever is being used.
  if (SMOKE_SHOT) win.showInactive();
  else win.show();
  if (SMOKE_SHOT) {
    win.webContents.on('console-message', (_e, level, message, line, source) => console.log(`[renderer:${level}] ${message} (${source}:${line})`));
    const delay = Number(process.env.NI_TERM_SMOKE_DELAY || 12000);
    if (process.env.NI_TERM_SMOKE_JS) {
      setTimeout(() => win.webContents.executeJavaScript(process.env.NI_TERM_SMOKE_JS).catch((e) => console.log('smoke js', e)), delay / 2);
    }
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(SMOKE_SHOT, img.toPNG());
      win.close();
    }, delay);
  }
  win.loadFile(path.join(__dirname, 'index.html'));

  // Links printed by agents open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  let readyToClose = false;
  win.on('close', (e) => {
    if (readyToClose) return;
    e.preventDefault();
    const finish = () => {
      if (readyToClose) return;
      readyToClose = true;
      const cur = readJson(stateFile, {});
      writeJson(stateFile, { ...cur, bounds: win.getNormalBounds(), maximized: win.isMaximized() });
      closing = true;
      for (const tabId of [...sessions.keys()]) stopPty(tabId);
      history.flush();
      win.destroy();
    };
    ipcMain.once('app:closed-ok', finish);
    send('app:before-close');
    setTimeout(finish, 2500);
  });
}

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  } else if (app.isReady()) {
    createWindow();
  }
});

// Daily snapshots of each agent's history (helpers.py backup), shortly after start.
function backupStores() {
  engineFor(newBackend()).backup(engineAgents())
    .then((made) => made.length && send('app:notice', `Backed up ${made.map((f) => path.basename(f)).join(', ')}`))
    .catch(() => {});
}

// Day-old launch scripts and engine requests a crash left behind, and pasted screenshots.
function clearTmp() {
  for (const f of fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []) {
    const p = path.join(tmpDir, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { force: true, recursive: true });
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  clearTmp();
  createWindow();
  setTimeout(backupStores, 15000);
});

app.on('window-all-closed', () => {
  history.flush();
  app.quit();
});
