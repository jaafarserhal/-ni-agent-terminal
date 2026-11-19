'use strict';
// Where agents run: natively on Windows, or inside a WSL distro. A backend maps the app's
// Windows paths to the agent's own (C:\x -> /mnt/c/x) and back (/home/u -> \\wsl$\<distro>\home\u),
// and runs processes there. A history record keeps the backend key it ran in, so a
// conversation always resumes next to the store that holds it.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${path.basename(file)} failed: ${(stderr || '').trim() || err.message}`;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// wsl.exe -l prints UTF-16LE, the default distro first.
async function wslDistros() {
  try {
    const out = await run('wsl.exe', ['-l', '-q'], { encoding: 'utf16le', timeout: 15000 });
    return out.split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

const DEFAULT_DIRS = { claude: '.claude', codex: '.codex' };
const CONFIG_ENV = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
const PYTHON_HELP = 'History → Agents, Live, handoffs and backups need Python 3 with SQLite';

class WindowsBackend {
  constructor() {
    this.key = 'windows';
    this.kind = 'windows';
    this.label = 'Windows';
    this.scope = 'windows'; // names this backend's handoff ledger (engine.js)
    this.home = os.homedir();
    this.gitBash = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  }

  ready() {
    return Promise.resolve(this);
  }

  // Node follows Windows symlinks itself.
  storeRoot(dir) {
    return Promise.resolve(dir);
  }

  toAgent(p) {
    return p;
  }

  toWin(p) {
    return p;
  }

  agentPath(...parts) {
    return path.join(this.home, ...parts);
  }

  // The normal login's folder: the inherited CLAUDE_CONFIG_DIR / CODEX_HOME, as tabs inherit it.
  configDir(agent) {
    return process.env[CONFIG_ENV[agent]] || this.agentPath(DEFAULT_DIRS[agent]);
  }

  opencodeDb() {
    const data = process.env.XDG_DATA_HOME || this.agentPath('.local', 'share');
    const db = process.env.OPENCODE_DB;
    return db && path.isAbsolute(db) ? db : path.join(data, 'opencode', db || 'opencode.db');
  }

  // Git for Windows' bash runs the shell scripts in src/py; path arguments are /c/... (msysPath).
  bash(args, opts) {
    if (!fs.existsSync(this.gitBash)) throw new Error(`Git for Windows is needed for this: ${this.gitBash} not found`);
    return run(this.gitBash, args, opts);
  }

  // `python`, else the py launcher; the Store's python.exe alias only prints a hint and fails.
  async python(args, opts) {
    if (!this.pythonCmd) {
      for (const cmd of [['python'], ['py', '-3']]) {
        const ok = await run(cmd[0], [...cmd.slice(1), '-c', 'import sqlite3'], { timeout: 15000 }).then(() => true, () => false);
        if (ok) {
          this.pythonCmd = cmd;
          break;
        }
      }
      if (!this.pythonCmd) throw new Error(`Python 3 was not found on Windows. ${PYTHON_HELP} (python.org, or winget install Python.Python.3.12).`);
    }
    return run(this.pythonCmd[0], [...this.pythonCmd.slice(1), ...args], opts);
  }

  msysPath(p) {
    return /^[a-zA-Z]:[\\/]/.test(p) ? `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}` : p;
  }

  fromMsys(p) {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    return m ? `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}` : p;
  }
}

class WslBackend {
  constructor(distro, launchDir) {
    this.key = `wsl:${distro}`;
    this.kind = 'wsl';
    this.distro = distro;
    this.label = `WSL · ${distro}`;
    this.scope = `wsl-${distro}`;
    this.unc = `\\\\wsl$\\${distro}`;
    this.launchDir = launchDir;
    this.home = null;
    this.data = null;
    this.opencodeOverride = '';
    this._ready = null;
    this.roots = new Map(); // agent's config folder -> Promise of the folder its store is in
  }

  // A linked account's projects/ and sessions/ are Linux symlinks into ~/.claude, which
  // Windows cannot follow over \\wsl$ (ENOENT): the folder they point into, resolved in
  // WSL, else `dir` itself. Cleared when accounts are linked (engine.js).
  storeRoot(dir) {
    if (!this.roots.has(dir)) {
      const script = 'for n in projects sessions; do printf "@@%s\\n" "$(readlink -f -- "$1/$n")"; done';
      this.roots.set(dir, this.bash(['-c', script, 'bash', dir], { timeout: 15000 }).then((out) => {
        const parents = out.split('\n').filter((l) => l.startsWith('@@')).map((l) => l.slice(2).trim()).filter(Boolean).map((p) => p.replace(/\/[^/]+$/, ''));
        return parents.length === 2 && parents[0] === parents[1] ? parents[0] : dir;
      }, () => dir));
    }
    return this.roots.get(dir);
  }

  // Resolves the home folder and data paths in a login shell, once.
  ready() {
    if (!this._ready) {
      const script = 'printf "@@%s\\n" "$HOME" "${XDG_DATA_HOME:-$HOME/.local/share}" "${OPENCODE_DB:-}"';
      this._ready = run('wsl.exe', ['-d', this.distro, '--exec', 'bash', '-lc', script], { timeout: 30000 }).then((out) => {
        const [home, data, db] = out.split('\n').filter((l) => l.startsWith('@@')).map((l) => l.slice(2).trim());
        if (!home) throw new Error(`Could not read the home folder of WSL distro "${this.distro}"`);
        this.home = home;
        this.data = data;
        this.opencodeOverride = db;
        return this;
      });
      this._ready.catch(() => { this._ready = null; });
    }
    return this._ready;
  }

  toAgent(p) {
    if (!p) return p;
    const unc = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+(\\.*)?$/i.exec(p);
    if (unc) return (unc[1] || '/').replace(/\\/g, '/');
    const drive = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p);
    if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`.replace(/\/+$/, '') || '/';
    return p.replace(/\\/g, '/');
  }

  toWin(p) {
    if (!p) return p;
    const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (mnt) return `${mnt[1].toUpperCase()}:${(mnt[2] || '/').replace(/\//g, '\\')}`;
    if (p.startsWith('/')) return this.unc + p.replace(/\//g, '\\');
    return p;
  }

  agentPath(...parts) {
    return [this.home, ...parts].join('/');
  }

  configDir(agent) {
    return this.agentPath(DEFAULT_DIRS[agent]);
  }

  opencodeDb() {
    const db = this.opencodeOverride;
    return db && db.startsWith('/') ? db : `${this.data}/opencode/${db || 'opencode.db'}`;
  }

  bash(args, opts) {
    return run('wsl.exe', ['-d', this.distro, '--exec', 'bash', ...args], opts);
  }

  python(args, opts) {
    return run('wsl.exe', ['-d', this.distro, '--exec', 'python3', ...args], opts).catch((err) => {
      if (/ENOENT|No such file|not found/i.test(err.message) && !/Traceback/.test(err.message)) {
        throw new Error(`python3 was not found in WSL distro "${this.distro}". ${PYTHON_HELP} (sudo apt install python3).`);
      }
      throw err;
    });
  }

  msysPath(p) {
    return this.toAgent(p);
  }

  fromMsys(p) {
    return p;
  }

  // The command runs from a script file, so wsl.exe never re-quotes it or its prompt; it is
  // resolved by the login shell's PATH. `env` reaches WSL through WSLENV, so values (an API
  // key) never touch the disk; null unsets a variable the login shell may set (the first
  // Claude account runs without CLAUDE_CONFIG_DIR). Returns the Windows env to add.
  launch({ cwd, env, command, args }) {
    fs.mkdirSync(this.launchDir, { recursive: true });
    const file = path.join(this.launchDir, `launch-${crypto.randomUUID()}.sh`);
    const lines = [`rm -f -- ${shQuote(this.toAgent(file))}`, `cd -- ${shQuote(this.toAgent(cwd))} || exit 1`];
    const pass = Object.keys(env).filter((k) => env[k] !== null);
    for (const k of Object.keys(env).filter((k) => env[k] === null)) lines.push(`unset ${k}`);
    lines.push(command ? `exec ${[command, ...args].map(shQuote).join(' ')}` : 'exec "${SHELL:-bash}" -l');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const all = ['-d', this.distro, '--exec', 'bash', '-li', this.toAgent(file)];
    const wslenv = [process.env.WSLENV, ...pass].filter(Boolean).join(':');
    return {
      file: 'wsl.exe',
      args: all.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' '),
      cwd: os.homedir(),
      env: { ...Object.fromEntries(pass.map((k) => [k, env[k]])), WSLENV: wslenv },
      display: [command || 'shell', ...args].join(' '),
    };
  }

  // Where each command resolves in the login shell, or null.
  async locate(commands) {
    const script = 'for c in "$@"; do printf "@@%s\\n" "$(command -v -- "$c" 2>/dev/null)"; done';
    try {
      const out = await this.bash(['-lic', script, 'bash', ...commands], { timeout: 30000 });
      const found = out.split('\n').filter((l) => l.startsWith('@@')).map((l) => l.slice(2).trim() || null);
      return commands.map((_, i) => found[i] || null);
    } catch (_) {
      return commands.map(() => null);
    }
  }
}

const windows = new WindowsBackend();
const wsl = new Map();

// The backend a key names: 'windows' or 'wsl:<distro>'.
function backendFor(key, launchDir) {
  if (!key || key === 'windows') return windows;
  const distro = key.replace(/^wsl:/, '');
  if (!wsl.has(distro)) wsl.set(distro, new WslBackend(distro, launchDir));
  return wsl.get(distro);
}

module.exports = { backendFor, wslDistros, shQuote, run };
