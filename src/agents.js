'use strict';
// Agent definitions, environment and command resolution.
//
// Each agent's command can be overridden in Setup, and each agent can have several
// accounts. A Claude / Codex account is a config folder (its own login and
// conversation store), passed through the environment variable named by configEnv.
// Cursor Agent keeps one config folder, so a Cursor account is an API key (keyEnv).
// `prompt` is a first message to send on launch: a handoff from another conversation.
// `inline` flags keep a full-screen TUI in the terminal's normal buffer for this launch only,
// whatever the user's own settings say: in the alternate screen with mouse tracking the
// app has no scrollback, the wheel goes to the agent, and text cannot be selected to copy.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const positional = (prompt) => [prompt];

const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    command: 'claude',
    color: '#d97757',
    accountKind: 'dir',
    configEnv: 'CLAUDE_CONFIG_DIR',
    // Claude accepts a caller-chosen session id, so the id is known before launch.
    presetId: true,
    // A settings file (main.js writes it), not inline JSON: quotes do not survive every launch form.
    inline: (settingsFile) => ['--settings', settingsFile],
    prompt: positional,
    args(mode, nativeId) {
      if (mode === 'resume' && nativeId) return ['--resume', nativeId];
      if (mode === 'new' && nativeId) return ['--session-id', nativeId];
      if (mode === 'continue') return ['--continue'];
      if (mode === 'picker') return ['--resume'];
      return [];
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    color: '#10a37f',
    accountKind: 'dir',
    configEnv: 'CODEX_HOME',
    presetId: false,
    // Before the subcommand. A config override, not --no-alt-screen: an older Codex ignores
    // an unknown key but rejects an unknown flag.
    inline: () => ['-c', 'tui.fullscreen_transcript=false'],
    prompt: positional,
    args(mode, nativeId) {
      if (mode === 'resume' && nativeId) return ['resume', nativeId];
      if (mode === 'continue') return ['resume', '--last'];
      if (mode === 'picker') return ['resume'];
      return [];
    },
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    command: 'cursor-agent',
    color: '#7c8cff',
    accountKind: 'key',
    keyEnv: 'CURSOR_API_KEY',
    presetId: false,
    prompt: positional,
    args(mode, nativeId) {
      if (mode === 'resume' && nativeId) return ['--resume', nativeId];
      if (mode === 'continue') return ['resume'];
      if (mode === 'picker') return ['ls'];
      return [];
    },
  },
  // One SQLite store for every folder; its conversations are found through Python (engine.js).
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    color: '#e0a03c',
    presetId: false,
    prompt: (prompt) => ['--prompt', prompt],
    args(mode, nativeId) {
      if (mode === 'resume' && nativeId) return ['--session', nativeId];
      if (mode === 'continue') return ['--continue'];
      return [];
    },
  },
  shell: {
    id: 'shell',
    label: 'Shell',
    command: 'powershell.exe',
    color: '#8a8f98',
    presetId: false,
    args(mode, nativeId, file) {
      return /^(powershell|pwsh)(.exe)?$/i.test(path.basename(file || '')) ? ['-NoLogo'] : [];
    },
  },
};

// Folders where the agent installers put their shims; a GUI launched from
// Explorer does not always inherit a PATH that already contains them.
function extraPathDirs() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'cursor-agent'));
  dirs.push(path.join(HOME, '.local', 'bin'), path.join(HOME, '.opencode', 'bin'));
  return dirs;
}

const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_NEW_ROOT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_SESSION_*',
  'CLAUDE_CODE_SSE_PORT',
  'CODEX_NEW_ROOT',
  'CODEX_SANDBOX*',
  'CODEX_THREAD_ID',
  'CURSOR_AGENT_SESSION*',
  'AI_AGENT',
  'NI_TERM_*',
];

function buildEnv(extra) {
  const env = { ...process.env };
  const sep = path.delimiter;
  const current = (env.Path || env.PATH || '').split(sep).filter(Boolean);
  for (const d of extraPathDirs()) {
    if (!current.some((c) => c.toLowerCase() === d.toLowerCase())) current.push(d);
  }
  delete env.PATH;
  env.Path = current.join(sep);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  delete env.ELECTRON_RUN_AS_NODE;
  // If this app was itself launched from inside an agent session, the per-session
  // markers would leak into every tab: Claude, for one, then treats the tab as a child
  // session and stops saving its transcript, which breaks resume and history.
  for (const name of Object.keys(env)) {
    if (SESSION_MARKERS.some((m) => (m.endsWith('*') ? name.startsWith(m.slice(0, -1)) : name === m))) delete env[name];
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

function which(name, env) {
  if (!name) return null;
  if (path.isAbsolute(name)) {
    try {
      return fs.statSync(name).isFile() ? name : null;
    } catch (_) {
      return null;
    }
  }
  const dirs = (env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = path.extname(name) ? [''] : ['.exe', '.cmd', '.bat', '.ps1'];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

// Quote one argument for a Windows command line (CommandLineToArgvW rules).
function quoteArg(arg) {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

// npm writes .cmd shims that just forward to an .exe or a node script. Launching
// the target directly avoids cmd.exe's "Terminate batch job (Y/N)?" on Ctrl+C.
function unwrapShim(cmdPath) {
  let text;
  try {
    text = fs.readFileSync(cmdPath, 'utf8');
  } catch (_) {
    return null;
  }
  const dir = path.dirname(cmdPath);
  const exe = text.match(/"%dp0%\\([^"]+\.exe)"/i);
  if (exe) {
    const target = path.join(dir, exe[1]);
    if (fs.existsSync(target)) return { file: target, pre: [] };
  }
  const js = text.match(/"%dp0%\\([^"]+\.js)"/i);
  if (js) {
    const target = path.join(dir, js[1]);
    const nodeExe = fs.existsSync(path.join(dir, 'node.exe')) ? path.join(dir, 'node.exe') : 'node.exe';
    if (fs.existsSync(target)) return { file: nodeExe, pre: [target] };
  }
  return null;
}

// The agent's arguments for a launch; `file` is the resolved command (the shell's flags depend on it).
// `inlineSettings`: the agent's path to the Claude settings file that keeps it inline.
function agentArgs(agentId, { mode, nativeId, extraArgs, prompt, file, inlineSettings }) {
  const agent = AGENTS[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  return [
    ...(agent.inline ? agent.inline(inlineSettings) : []),
    ...agent.args(mode, nativeId, file),
    ...splitArgs(extraArgs),
    ...(prompt && agent.prompt ? agent.prompt(prompt) : []),
  ];
}

// Returns { file, args } where args is a single pre-quoted string, which is how
// node-pty passes a command line through unchanged on Windows.
// `command` overrides the agent's default command (a name on PATH or a full path).
function resolveLaunch(agentId, launch, env, command) {
  const cmd = (command || '').trim() || AGENTS[agentId].command;
  const resolved = which(cmd, env);
  if (!resolved) {
    throw new Error(`'${cmd}' was not found${path.isAbsolute(cmd) ? '' : ' on PATH'}. Install it, or set its path in Setup (Settings → Workspaces & agents).`);
  }
  const args = agentArgs(agentId, { ...launch, file: resolved });
  const ext = path.extname(resolved).toLowerCase();

  if (ext === '.cmd' || ext === '.bat') {
    const shim = unwrapShim(resolved);
    if (shim) {
      const file = which(shim.file, env) || shim.file;
      return { file, args: [...shim.pre, ...args].map(quoteArg).join(' '), display: [path.basename(cmd), ...args].join(' ') };
    }
    const inner = [resolved, ...args].map(quoteArg).join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', args: `/d /s /c "${inner}"`, display: [path.basename(cmd), ...args].join(' ') };
  }
  if (ext === '.ps1') {
    const all = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args];
    return { file: 'powershell.exe', args: all.map(quoteArg).join(' '), display: [path.basename(cmd), ...args].join(' ') };
  }
  return { file: resolved, args: args.map(quoteArg).join(' '), display: [path.basename(cmd), ...args].join(' ') };
}

// Splits a user-entered extra-arguments string, honouring double quotes.
function splitArgs(str) {
  if (!str || !str.trim()) return [];
  const out = [];
  const re = /"((?:\\"|[^"])*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2]);
  return out;
}

// Where an agent's command resolves to, or null when it is not installed.
function locate(agentId, command, env) {
  const agent = AGENTS[agentId];
  return agent ? which((command || '').trim() || agent.command, env) : null;
}

// Environment for an agent running under one of its accounts: a separate config
// folder (Claude, Codex) or an API key (Cursor). With `unsetDefault` the normal login
// unsets the folder variable (null), as Claude's first account only finds ~/.claude.json
// without it; otherwise it inherits whatever the app was started with.
function agentEnv(agentId, configDir, apiKey, unsetDefault) {
  const agent = AGENTS[agentId];
  const env = {};
  if (agent && agent.configEnv && (configDir || unsetDefault)) env[agent.configEnv] = configDir || null;
  if (agent && agent.keyEnv && apiKey) env[agent.keyEnv] = apiKey;
  return env;
}

module.exports = { AGENTS, buildEnv, resolveLaunch, agentArgs, locate, agentEnv, splitArgs };
