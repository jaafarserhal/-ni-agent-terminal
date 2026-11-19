'use strict';
// Workspace folders.
//
// The user picks one or more workspace folders in Setup. New tabs open in the first
// one, and every Git repository found inside them (the folder itself, its children,
// and their children, e.g. repos/<name>) is offered in the folder picker.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'bin', 'obj', 'target', '.venv', 'venv', '__pycache__']);
const MAX_REPOS = 200;

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function readBranch(repoDir) {
  try {
    const gitPath = path.join(repoDir, '.git');
    let gitDir = gitPath;
    if (fs.statSync(gitPath).isFile()) {
      const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(repoDir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref: refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 8);
  } catch (_) {
    return null;
  }
}

function children(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name));
  } catch (_) {
    return [];
  }
}

// Git repositories up to two levels below `root` ('repo'), and the folders in between that
// hold some ('folder'), which are worked in as well; a repository is not searched further.
function findDirs(root) {
  const out = [];
  for (const child of children(root)) {
    if (out.length >= MAX_REPOS) break;
    if (isGitRepo(child)) {
      out.push({ path: child, kind: 'repo' });
      continue;
    }
    const repos = children(child).filter(isGitRepo);
    if (repos.length) out.push({ path: child, kind: 'folder' }, ...repos.map((r) => ({ path: r, kind: 'repo' })));
  }
  return out;
}

// roots: workspace folder paths, in the user's order.
function describe(roots) {
  const list = (roots || []).filter(Boolean);
  const dirs = [];
  // A workspace folder is listed as itself, with what it holds, even inside another one.
  const found = list.filter((r, i) => isDir(r) && list.findIndex((o) => norm(o) === norm(r)) === i);
  const seen = new Set(found.map(norm));
  for (const root of found) {
    dirs.push({ path: root, name: path.basename(root) || root, kind: 'root', root, branch: readBranch(root) });
    const repos = findDirs(root)
      .filter((d) => !seen.has(norm(d.path)))
      .map((d) => {
        seen.add(norm(d.path));
        return { path: d.path, name: labelFor([root], d.path), kind: d.kind, root, branch: readBranch(d.path) };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    dirs.push(...repos);
  }
  return {
    roots: list,
    root: list[0] || null,
    valid: list.length > 0 && list.every(isDir),
    missing: list.filter((r) => !isDir(r)),
    dirs,
  };
}

// The workspace folder that contains `cwd` (the deepest one), or null.
function containingRoot(roots, cwd) {
  if (!cwd) return null;
  let best = null;
  for (const root of roots || []) {
    if (!root) continue;
    const rel = path.relative(root, cwd);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!best || root.length > best.length) best = root;
  }
  return best;
}

// Short label for a working directory, relative to the workspace folder holding it.
// A leading "repos/" (a common layout for checkouts) is dropped.
function labelFor(roots, cwd) {
  if (!cwd) return '';
  const root = containingRoot(Array.isArray(roots) ? roots : [roots], cwd);
  if (root) {
    const rel = path.relative(root, cwd);
    if (!rel) return path.basename(root) || root;
    const parts = rel.split(path.sep);
    return parts[0] === 'repos' && parts[1] ? parts.slice(1).join('/') : parts.join('/');
  }
  return path.basename(cwd) || cwd;
}

// Folders to offer in Setup when none is chosen yet: $AGENT_TERMINAL_WORKSPACE /
// $NI_WORKSPACE, then a folder above the exe that holds AGENTS.md or CLAUDE.md.
function suggestRoots(exeDir) {
  const out = [];
  for (const v of [process.env.AGENT_TERMINAL_WORKSPACE, process.env.NI_WORKSPACE]) {
    if (v && isDir(v)) out.push(v);
  }
  for (let d = exeDir; d && path.dirname(d) !== d; d = path.dirname(d)) {
    if (['AGENTS.md', 'CLAUDE.md'].some((f) => fs.existsSync(path.join(d, f)))) {
      out.push(d);
      break;
    }
  }
  return [...new Map(out.map((p) => [norm(p), p])).values()];
}

const home = () => os.homedir();

module.exports = { describe, labelFor, containingRoot, readBranch, suggestRoots, isDir, home };
