'use strict';
/* global Terminal, FitAddon, SearchAddon, WebLinksAddon */

const ipc = window.api;
const $ = (sel) => document.querySelector(sel);

const THEME = {
  background: '#111317',
  foreground: '#d6d9de',
  cursor: '#d6d9de',
  cursorAccent: '#111317',
  selectionBackground: '#3a4f72',
  black: '#1b1e24', red: '#ef6b6b', green: '#7bc27b', yellow: '#e5c07b',
  blue: '#5b9dff', magenta: '#c49cf2', cyan: '#56c6d6', white: '#d6d9de',
  brightBlack: '#5f6570', brightRed: '#ff8a8a', brightGreen: '#98d998', brightYellow: '#f0d595',
  brightBlue: '#82b5ff', brightMagenta: '#d7b8ff', brightCyan: '#7fdbe8', brightWhite: '#ffffff',
};

// Menu order; Ctrl+Shift+1…5 follow it.
const AGENT_KEYS = ['claude', 'codex', 'cursor', 'shell', 'opencode'];
const BADGE = { claude: 'C', codex: 'X', cursor: 'Cu', opencode: 'O', shell: '>' };
// Agents whose conversations the engine (src/py) lists and hands off.
const ENGINE_AGENTS = ['claude', 'codex', 'opencode'];

const state = {
  settings: null,
  workspace: null,
  agents: {},
  tabs: [],
  activeId: null,
  historyScope: 'tab', // 'tab' | 'folder' | 'all'
  historyAgent: 'all',
  historyQuery: '',
  historyFolder: null, // folder picked in the Folder view; null follows the active tab
  agentsHidden: false, // the Agents view lists hidden conversations instead
  agentsMarked: new Set(), // Agents view rows marked (Ctrl+click) to combine
  viewer: null,
  nextTabId: 1,
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function agentColor(agent) {
  return (state.agents[agent] && state.agents[agent].color) || '#8a8f98';
}

function agentLabel(agent) {
  return (state.agents[agent] && state.agents[agent].label) || agent;
}

// Agents switched on in Setup, in menu order.
function enabledAgents() {
  return AGENT_KEYS.filter((a) => !state.agents[a] || state.agents[a].enabled !== false);
}

// Accounts set up in Setup for an agent (Claude / Codex: config folders, Cursor: API keys).
function accountsOf(agent) {
  const a = state.settings && state.settings.agents && state.settings.agents[agent];
  return (a && a.accounts) || [];
}

// The account new tabs of this agent use.
function activeAccountOf(agent) {
  const a = state.settings && state.settings.agents && state.settings.agents[agent];
  const list = accountsOf(agent);
  return list.find((x) => x.id === (a && a.activeAccount)) || list[0] || null;
}

// Accounts are only shown once an agent has more than one.
function multiAccount(agent) {
  return accountsOf(agent).length > 1;
}

// The account a tab runs under: its conversation's, else the one it will start with.
function tabAccount(tab) {
  const list = accountsOf(tab.agent);
  const id = tab.record ? tab.record.accountId : tab.accountId;
  const found = list.find((x) => x.id === id);
  if (found) return found;
  if (tab.record && tab.record.accountName) return { id: null, name: tab.record.accountName };
  return activeAccountOf(tab.agent);
}

function recordTitle(rec) {
  if (!rec) return 'New session';
  return rec.customTitle || rec.title || `${agentLabel(rec.agent)} session`;
}

function relTime(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ms).toLocaleDateString();
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

function closePopovers() {
  $('#new-menu').classList.add('hidden');
  $('#ctx').classList.add('hidden');
}

function showContextMenu(x, y, items) {
  const ctx = $('#ctx');
  ctx.replaceChildren(
    ...items.map((it) =>
      it === '-'
        ? el('hr')
        : el('button', { onclick: () => { closePopovers(); it.run(); } }, el('span', {}, it.label), it.hint ? el('small', {}, it.hint) : null)
    )
  );
  ctx.classList.remove('hidden');
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  ctx.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

// ---------------------------------------------------------------------------
// link colors
// ---------------------------------------------------------------------------
// Web links are drawn in the theme's blue wherever they appear, whatever program printed
// them; WebLinksAddon only underlines one under the mouse. After each render the visible
// rows are scanned (a wrapped line as one) and each link gets a decoration that recolors
// its cells. Decorations follow their lines into the scrollback; ones whose cells no longer
// hold that link (a TUI redrew the screen) are dropped.

// WebLinksAddon's own pattern, so a colored link is exactly a clickable one.
const URL_RE = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;
const LINK_COLOR = THEME.blue;

// A clicked web link, in the default browser.
function openLink(uri) {
  ipc.openExternal(uri).catch((err) => toast(err.message));
}

function colorLinks(term) {
  const decorated = new Set(); // { d: decoration, x, width }
  let timer = null;

  // The visible rows' text, grouped into logical lines, with the cell of each character.
  function logicalLines(buf, first, last) {
    const out = [];
    const cell = buf.getNullCell();
    let start = first;
    while (start > 0 && buf.getLine(start) && buf.getLine(start).isWrapped) start--;
    let cur = null;
    for (let y = start; y <= last; y++) {
      const line = buf.getLine(y);
      if (!line) break;
      if (!line.isWrapped || !cur) {
        cur = { text: '', cells: [] };
        out.push(cur);
      }
      for (let x = 0; x < line.length; x++) {
        line.getCell(x, cell);
        if (!cell.getWidth()) continue;
        const ch = cell.getChars() || ' ';
        cur.text += ch;
        for (let i = 0; i < ch.length; i++) cur.cells.push({ y, x, w: cell.getWidth() });
      }
    }
    return out;
  }

  function scan() {
    timer = null;
    const buf = term.buffer.active;
    const first = buf.viewportY;
    const last = first + term.rows - 1;
    const want = new Map(); // "line:col" -> { y, x, width }: one per row a link spans
    for (const { text, cells } of logicalLines(buf, first, last)) {
      for (const m of text.matchAll(new RegExp(URL_RE.source, 'g'))) {
        let seg = null;
        for (const c of cells.slice(m.index, m.index + m[0].length)) {
          if (seg && seg.y === c.y) seg.width = c.x + c.w - seg.x;
          else want.set(`${c.y}:${c.x}`, (seg = { y: c.y, x: c.x, width: c.w }));
        }
      }
    }
    // What is already drawn stays; a visible one whose cells no longer hold its link goes.
    for (const e of decorated) {
      const y = e.d.marker.line; // -1 once trimmed off the scrollback
      const seg = want.get(`${y}:${e.x}`);
      if (seg && seg.width === e.width) want.delete(`${y}:${e.x}`);
      else if (y < 0 || (y >= first && y <= last)) {
        e.d.dispose();
        decorated.delete(e);
      }
    }
    const base = buf.baseY + buf.cursorY;
    for (const seg of want.values()) {
      const marker = term.registerMarker(seg.y - base);
      const d = marker && term.registerDecoration({ marker, x: seg.x, width: seg.width, foregroundColor: LINK_COLOR });
      if (!d) continue;
      d.onDispose(() => marker.dispose());
      decorated.add({ d, x: seg.x, width: seg.width });
    }
  }

  // Links only change when output is written, the view scrolls or lines rewrap. Coalesced:
  // a busy agent writes many times a second.
  const soon = () => {
    if (!timer) timer = setTimeout(scan, 120);
  };
  term.onWriteParsed(soon);
  term.onScroll(soon);
  term.onResize(soon);
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

// prompt: a first message the agent is launched with (a handoff), sent on the first start only.
function createTab({ agent, cwd, record, mode, chain, accountId, prompt, activate = true }) {
  const id = `t${state.nextTabId++}`;
  const host = el('div', { class: 'term-host hidden-tab' });
  $('#terminals').append(host);

  const term = new Terminal({
    fontFamily: state.settings.fontFamily,
    fontSize: state.settings.fontSize,
    scrollback: state.settings.scrollback,
    theme: THEME,
    cursorBlink: true,
    allowProposedApi: true,
    macOptionIsMeta: true,
    windowsPty: { backend: 'conpty' },
    // Hyperlinks a program prints (OSC 8; Claude prints its links this way). xterm's own
    // handler asks "could potentially be dangerous" and then opens a blank window.
    linkHandler: { activate: (_e, uri) => openLink(uri) },
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => openLink(uri), { urlRegex: URL_RE }));
  term.open(host);
  colorLinks(term);

  const tab = {
    id, agent, cwd, mode: mode || (record ? 'resume' : 'new'),
    record: record || null, term, fit, search, host,
    // Account a new conversation starts under (null: the agent's current one).
    accountId: accountId || null,
    prompt: prompt || null,
    status: null, // Claude's 'busy' / 'idle'
    started: false, running: false, exitCode: null, dirty: false, lastSnapshot: 0,
    node: null, exitBar: null, input: newInput(),
    // Every conversation this tab has gone through (/clear, /new, /resume), oldest first.
    chain: [...new Set([...(chain || []), ...(record ? [record.id] : [])])],
    // Where the current conversation's output starts in the buffer (null: the top).
    snapMarker: null,
    enterMarks: [],
  };
  state.tabs.push(tab);

  term.onData((data) => {
    if (tab.running) {
      const enter = data.includes('\r') && !data.startsWith('\x1b[200~');
      // Save the transcript before the agent acts on Enter: /clear wipes the screen,
      // and the conversation it ends should keep what was on it.
      if (enter) snapshot(tab, true);
      trackInput(tab, data);
      ipc.write(tab.id, data);
      if (enter) markEnter(tab);
    } else if (tab.started && (data === '\r' || data === '\n')) restartTab(tab);
  });
  term.onResize(({ cols, rows }) => tab.running && ipc.resize(tab.id, cols, rows));
  term.onTitleChange(() => renderTabs());
  // An agent's own copy (Claude's /copy, a TUI selection) arrives as OSC 52, which xterm.js
  // ignores: put it on the clipboard. Requests to read the clipboard ('?') are refused.
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (b64 && b64 !== '?') {
      try {
        ipc.clipboardWrite(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
      } catch (_) { /* not base64 */ }
    }
    return true;
  });
  term.attachCustomKeyEventHandler((e) => handleTermKey(tab, e));

  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      ipc.clipboardWrite(term.getSelection());
      term.clearSelection();
      toast('Copied');
    } else {
      pasteInto(tab, true);
    }
  });
  // Once the selection is made, not on every change while dragging.
  host.addEventListener('mouseup', () => {
    if (state.settings.copyOnSelect && term.hasSelection()) ipc.clipboardWrite(term.getSelection());
  });
  host.addEventListener('dragover', (e) => e.preventDefault());
  host.addEventListener('drop', (e) => {
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => ipc.pathForFile(f)).filter(Boolean);
    // Quoted for the tab's shell, as WSL paths in a WSL tab.
    if (paths.length && tab.running) ipc.dropText(tab.id, paths).then((text) => text && ipc.write(tab.id, text));
    term.focus();
  });

  renderTabs();
  if (activate) activateTab(id);
  saveState();
  return tab;
}

async function startTab(tab) {
  if (tab.running) return;
  tab.started = true;
  tab.exitCode = null;
  tab.input = newInput();
  if (tab.exitBar) {
    tab.exitBar.remove();
    tab.exitBar = null;
  }
  try {
    tab.fit.fit();
  } catch (_) { /* host not laid out yet */ }
  // A tab restarted in place still shows the last run, which history already holds.
  setSnapMarker(tab, hasOutput(tab) ? tab.term.registerMarker(0) : null);
  try {
    const res = await ipc.start({
      tabId: tab.id,
      agent: tab.agent,
      cwd: tab.cwd,
      recordId: tab.record && tab.record.id,
      mode: tab.mode,
      accountId: tab.accountId,
      prompt: tab.prompt,
      cols: tab.term.cols,
      rows: tab.term.rows,
    });
    tab.prompt = null;
    tab.record = res.record;
    if (!tab.chain.includes(res.record.id)) tab.chain.push(res.record.id);
    tab.cwd = res.record.cwd;
    tab.running = true;
    tab.mode = 'resume';
    ipc.resize(tab.id, tab.term.cols, tab.term.rows);
  } catch (err) {
    tab.term.writeln(`\x1b[31m${err.message}\x1b[0m`);
    tab.term.writeln('\x1b[2mPress Enter to retry, or close this tab.\x1b[0m');
  }
  renderTabs();
  renderStatus();
  renderHistory();
  saveState();
}

function restartTab(tab) {
  tab.term.write('\r\n');
  startTab(tab);
}

function activateTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  closeViewer();
  state.activeId = id;
  tab.node && tab.node.classList.remove('activity');
  tab.activity = false;
  for (const t of state.tabs) t.host.classList.toggle('hidden-tab', t.id !== id);
  // Not requestAnimationFrame: Chromium pauses it while the window is hidden or
  // occluded, which would leave a restored tab's agent unstarted until it is painted.
  setTimeout(() => {
    try {
      tab.fit.fit();
    } catch (_) { /* ignore */ }
    if (!tab.started) startTab(tab);
    tab.term.focus();
  }, 0);
  renderTabs();
  renderStatus();
  // The Folder view follows the active tab's folder.
  state.historyFolder = null;
  if (state.historyScope !== 'all') renderHistory();
  saveState();
}

async function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  snapshot(tab, true);
  if (tab.running) await ipc.kill(tab.id).catch(() => {});
  tab.term.dispose();
  tab.host.remove();
  state.tabs.splice(idx, 1);
  if (state.activeId === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1];
    state.activeId = null;
    if (next) activateTab(next.id);
  }
  renderTabs();
  renderStatus();
  renderHistory();
  saveState();
}

function cycleTab(delta) {
  if (!state.tabs.length) return;
  const idx = state.tabs.findIndex((t) => t.id === state.activeId);
  const next = state.tabs[(idx + delta + state.tabs.length) % state.tabs.length];
  activateTab(next.id);
}

function tabLabel(tab) {
  const rec = tab.record;
  const where = rec ? rec.cwdLabel : labelForCwd(tab.cwd);
  const title = rec && (rec.customTitle || rec.title);
  const acct = multiAccount(tab.agent) ? tabAccount(tab) : null;
  const wsl = rec && rec.backendLabel ? 'WSL' : null;
  return { main: title || agentLabel(tab.agent), sub: [where, acct && acct.name, wsl].filter(Boolean).join(' · ') };
}

function labelForCwd(cwd) {
  if (!cwd) return state.workspace && state.workspace.root ? 'workspace' : '';
  const d = state.workspace && state.workspace.dirs.find((x) => sameCwd(x.path, cwd));
  return d ? d.name : cwd.split(/[\\/]/).pop();
}

function renderTabs() {
  const wrap = $('#tabs');
  wrap.replaceChildren();
  for (const tab of state.tabs) {
    const { main, sub } = tabLabel(tab);
    const node = el(
      'div',
      {
        class: `tab${tab.id === state.activeId ? ' active' : ''}${tab.started && !tab.running ? ' exited' : ''}${tab.activity ? ' activity' : ''}${tab.running && ['busy', 'shell'].includes(tab.status) ? ' working' : ''}`,
        style: `--c:${agentColor(tab.agent)}`,
        role: 'tab',
        title: `${agentLabel(tab.agent)}${multiAccount(tab.agent) ? ` (${tabAccount(tab).name})` : ''} · ${tab.cwd || ''}${tab.record && tab.record.backendLabel ? ` · ${tab.record.backendLabel}` : ''}${tab.status ? ` · ${tab.status}` : ''}`,
        draggable: 'true',
        onmousedown: (e) => {
          if (e.button === 0 && !e.target.closest('.close')) activateTab(tab.id);
          if (e.button === 1) {
            e.preventDefault();
            closeTab(tab.id);
          }
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          tabMenu(tab, e.clientX, e.clientY);
        },
        ondragstart: (e) => {
          e.dataTransfer.setData('text/tab', tab.id);
          node.classList.add('dragging');
        },
        ondragend: () => node.classList.remove('dragging'),
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => {
          const from = e.dataTransfer.getData('text/tab');
          if (!from || from === tab.id) return;
          const a = state.tabs.findIndex((t) => t.id === from);
          const [moved] = state.tabs.splice(a, 1);
          state.tabs.splice(state.tabs.indexOf(tab), 0, moved);
          renderTabs();
          saveState();
        },
      },
      el('span', { class: 'badge' }, BADGE[tab.agent] || '?'),
      el('span', { class: 'label' }, main, el('small', {}, sub)),
      el('span', { class: 'busy' }),
      el(
        'button',
        { class: 'close', title: 'Close (Ctrl+Shift+W)', onclick: (e) => { e.stopPropagation(); closeTab(tab.id); } },
        el('span', {}, '✕')
      )
    );
    tab.node = node;
    wrap.append(node);
  }
  $('#empty').classList.toggle('hidden', state.tabs.length > 0);
  const active = wrap.querySelector('.tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function tabMenu(tab, x, y) {
  showContextMenu(x, y, [
    { label: 'Rename…', run: () => renameRecord(tab.record, tab) },
    { label: tab.running ? 'Restart (resume)' : 'Resume', run: async () => { if (tab.running) await ipc.kill(tab.id); tab.running = false; restartTab(tab); } },
    { label: `New ${agentLabel(tab.agent)} here`, run: () => createTab({ agent: tab.agent, cwd: tab.cwd }) },
    { label: 'Duplicate folder in…', run: () => openNewMenu(tab.cwd) },
    ...accountMenuItems(tab),
    '-',
    { label: 'Open folder', run: () => ipc.openPath(tab.cwd) },
    { label: 'Prompt history', hint: 'Ctrl+Shift+H', run: () => { activateTab(tab.id); state.historyScope = 'tab'; toggleHistory(true); } },
    { label: 'Sessions in this folder', run: () => { state.historyScope = 'folder'; state.historyFolder = tab.cwd; state.historyAgent = tab.agent; toggleHistory(true); } },
    { label: 'Save transcript…', run: () => { snapshot(tab, true); tab.record && ipc.historyExport(tab.record.id); } },
    '-',
    { label: 'Close', hint: 'Ctrl+Shift+W', run: () => closeTab(tab.id) },
  ]);
}

// "Switch to <account>" entries for a tab's menus; none while the agent has one account.
function accountMenuItems(tab) {
  if (!tab || !multiAccount(tab.agent)) return [];
  const cur = tabAccount(tab);
  const next = nextAccount(tab);
  return [
    '-',
    ...accountsOf(tab.agent).map((a) =>
      a.id === cur.id
        ? { label: `✓ ${a.name}`, hint: 'current account', run: () => {} }
        : { label: `Switch to ${a.name}`, hint: next && a.id === next.id ? 'Ctrl+Shift+A' : '', run: () => switchTabAccount(tab, a.id) }
    ),
  ];
}

function nextAccount(tab) {
  const list = accountsOf(tab.agent);
  if (list.length < 2) return null;
  const i = list.findIndex((a) => a.id === tabAccount(tab).id);
  return list[(i + 1) % list.length];
}

// Runs the tab's conversation under another account: the agent is stopped, the
// conversation is copied into that account's store, and it is resumed there.
async function switchTabAccount(tab, accountId) {
  const acct = accountsOf(tab.agent).find((a) => a.id === accountId);
  if (!acct) return;
  const label = `${agentLabel(tab.agent)} → ${acct.name}`;
  if (!tab.record) {
    // Not started yet: it simply starts under that account.
    tab.accountId = acct.id;
    applySaved(await ipc.saveSettings({ agents: { [tab.agent]: { activeAccount: acct.id } } }));
    saveState();
    return toast(label);
  }
  if (tab.running) await snapshot(tab, true);
  let res;
  try {
    res = await ipc.switchAccount({ tabId: tab.running ? tab.id : null, recordId: tab.record.id, accountId: acct.id });
  } catch (err) {
    return toast(err.message);
  }
  state.settings = res.settings;
  tab.record = res.record;
  tab.accountId = acct.id;
  tab.running = false;
  tab.term.write(`\r\n\x1b[2m[Switching to ${agentLabel(tab.agent)} account "${acct.name}"]\x1b[0m\r\n`);
  if (!res.copied) toast(`${label}: the conversation was not found in the old account, so it may start fresh`);
  else toast(label);
  if (tab.started) startTab(tab);
  renderTabs();
  renderStatus();
  renderEmptyActions();
  saveState();
}

function hasOutput(tab) {
  const buf = tab.term.buffer.normal;
  return buf.length > tab.term.rows || buf.cursorY > 0 || buf.cursorX > 0;
}

function setSnapMarker(tab, marker) {
  if (tab.snapMarker && tab.snapMarker !== marker && !tab.enterMarks.some((m) => m.marker === tab.snapMarker)) tab.snapMarker.dispose();
  tab.snapMarker = marker;
}

// Remembers where the cursor was at each Enter, so a conversation the agent starts
// on that Enter can be cut out of the scrollback from there.
function markEnter(tab) {
  const marker = tab.term.registerMarker(0);
  if (!marker) return;
  tab.enterMarks.push({ t: Date.now(), marker });
  while (tab.enterMarks.length > 4) {
    const old = tab.enterMarks.shift();
    if (old.marker !== tab.snapMarker) old.marker.dispose();
  }
}

// Plain-text copy of the current conversation's part of the scrollback; this is what
// History shows as "Text".
function snapshot(tab, force) {
  if (!tab.record || !tab.started) return;
  if (!force && !tab.dirty) return;
  tab.dirty = false;
  tab.lastSnapshot = Date.now();
  const buf = tab.term.buffer.normal.length > 1 ? tab.term.buffer.normal : tab.term.buffer.active;
  const m = tab.snapMarker;
  // A disposed marker was trimmed off the top, so everything left is newer than it.
  const from = m && !m.isDisposed && m.line >= 0 ? Math.min(m.line, buf.length) : 0;
  const lines = [];
  for (let i = from; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return;
  // Most of the scrollback is gone: the screen was cleared. Keep the transcript saved so
  // far and append from here instead of overwriting it with the shorter screen.
  const last = tab.lastSnap;
  const cleared = !!last && last.recordId === tab.record.id && last.from === from && last.lines > 40 && lines.length < last.lines / 2;
  tab.lastSnap = { recordId: tab.record.id, from, lines: lines.length };
  return ipc.historySnapshot(tab.record.id, lines.join('\n') + '\n', cleared).catch(() => {});
}

// ---------------------------------------------------------------------------
// prompt capture
// ---------------------------------------------------------------------------
// Rebuilds the line being typed from the keystrokes sent to the pty, so each tab keeps
// a history of the prompts / commands sent from it. Edits made by the program itself
// (Up/Down history recall, Tab completion in a shell) can't be followed from the input
// alone: such a line is read back from the screen in a shell tab and skipped in an agent tab.

function newInput() {
  return { text: '', cur: 0, lost: false, lastEsc: 0 };
}

function insertInput(inp, str) {
  inp.text = inp.text.slice(0, inp.cur) + str + inp.text.slice(inp.cur);
  inp.cur += str.length;
}

function trackInput(tab, data) {
  const inp = tab.input;
  let i = 0;
  while (i < data.length) {
    if (data.startsWith('\x1b[200~', i)) {
      const end = data.indexOf('\x1b[201~', i + 6);
      insertInput(inp, data.slice(i + 6, end < 0 ? data.length : end).replace(/\r\n?/g, '\n'));
      i = end < 0 ? data.length : end + 6;
      continue;
    }
    const ch = data[i];
    if (ch === '\x1b') {
      // CSI (arrows, Home/End/Delete, focus and mouse reports), SS3 arrows, or Alt+key.
      const m = /^\x1b(?:\[([0-9;<>?]*)([~@-Z\\a-z^_`{|}])|O([A-Za-z])|([\s\S]))?/.exec(data.slice(i));
      i += m[0].length;
      const key = m[2] === '~' ? m[1] : m[2] || m[3];
      if (key === 'D') inp.cur = Math.max(0, inp.cur - 1);
      else if (key === 'C') inp.cur = Math.min(inp.text.length, inp.cur + 1);
      else if (key === 'H' || key === '1' || key === '7') inp.cur = 0;
      else if (key === 'F' || key === '4' || key === '8') inp.cur = inp.text.length;
      else if (key === '3') inp.text = inp.text.slice(0, inp.cur) + inp.text.slice(inp.cur + 1);
      else if (key === 'A' || key === 'B') inp.lost = true;
      else if (m[4] === '\r') insertInput(inp, '\n'); // Alt+Enter
      else if (m[4]) inp.lost = true; // Alt+key: word moves and the like
      else if (m[0] === '\x1b') {
        // A double Esc clears the prompt in Claude and Codex.
        const now = Date.now();
        if (now - inp.lastEsc < 800) Object.assign(inp, newInput());
        else inp.lastEsc = now;
      }
      continue;
    }
    i++;
    if (ch === '\r') commitInput(tab);
    else if (ch === '\x7f' || ch === '\b') {
      if (inp.cur > 0) {
        inp.text = inp.text.slice(0, inp.cur - 1) + inp.text.slice(inp.cur);
        inp.cur--;
      }
    } else if (ch === '\x03') Object.assign(inp, newInput());
    else if (ch === '\x15') {
      inp.text = inp.text.slice(inp.cur);
      inp.cur = 0;
    } else if (ch === '\x0b') inp.text = inp.text.slice(0, inp.cur);
    else if (ch === '\x17') {
      const before = inp.text.slice(0, inp.cur).replace(/\S+\s*$/, '');
      inp.text = before + inp.text.slice(inp.cur);
      inp.cur = before.length;
    } else if (ch === '\x01') inp.cur = 0;
    else if (ch === '\x05') inp.cur = inp.text.length;
    else if (ch === '\n') insertInput(inp, '\n');
    else if (ch === '\t') {
      if (tab.agent === 'shell') inp.lost = true;
    } else if (ch >= ' ') insertInput(inp, ch);
  }
}

// The command on the shell prompt line under the cursor, without the "PS C:\...> " prefix.
function readShellLine(tab) {
  const buf = tab.term.buffer.active;
  let y = buf.baseY + buf.cursorY;
  let line = buf.getLine(y);
  if (!line) return null;
  let text = line.translateToString(true);
  while (line.isWrapped && y > 0) {
    line = buf.getLine(--y);
    text = line.translateToString(false) + text;
  }
  const m = /^PS [^>]*>\s?([\s\S]*)$/.exec(text);
  return m ? m[1] : null;
}

function commitInput(tab) {
  const inp = tab.input;
  tab.input = newInput();
  let text = inp.lost ? (tab.agent === 'shell' ? readShellLine(tab) : null) : inp.text;
  if (!text) return;
  text = text.trim();
  // A lone key is a menu answer (1/2/3, y/n) rather than a prompt.
  if (!text || (tab.agent !== 'shell' && text.length < 2)) return;
  ipc.addPrompt(tab.id, text);
}

// ---------------------------------------------------------------------------
// keyboard & clipboard
// ---------------------------------------------------------------------------

async function pasteInto(tab, fromMouse) {
  const clip = await ipc.clipboardRead();
  if (clip.text) tab.term.paste(clip.text);
  else if (clip.hasImage && tab.running) {
    // With only an image on the clipboard, let the agent read it itself (Ctrl+V). In WSL only
    // Claude can reach the Windows clipboard: the others get a saved PNG's path, which they attach.
    const wsl = tab.record && tab.record.backend && tab.record.backend !== 'windows';
    if (wsl && tab.agent !== 'claude') {
      if (tab.agent !== 'shell') tab.term.paste(await ipc.clipboardImagePath(tab.id));
    } else if (!fromMouse) {
      ipc.write(tab.id, '\x16');
    }
  }
  tab.term.focus();
}

function handleTermKey(tab, e) {
  if (e.type !== 'keydown') return true;
  if (handleScrollKey(tab.term, e)) return false;
  const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
  const k = e.key.toLowerCase();

  if (ctrl && !e.shiftKey && k === 'c' && tab.term.hasSelection()) {
    ipc.clipboardWrite(tab.term.getSelection());
    tab.term.clearSelection();
    return false;
  }
  if (ctrl && e.shiftKey && k === 'c') {
    if (tab.term.hasSelection()) ipc.clipboardWrite(tab.term.getSelection());
    return false;
  }
  if (ctrl && k === 'v') {
    e.preventDefault();
    pasteInto(tab, false);
    return false;
  }
  // Multi-line prompts (Shift+Enter, Ctrl+Enter): agents read ESC+CR (Claude, Cursor) or LF
  // (Codex) as a newline. preventDefault: otherwise the key's keypress still reaches xterm
  // as a plain Enter, which submits. A shell keeps them as Enter, as other terminals do.
  if ((e.shiftKey || e.ctrlKey) && !(e.shiftKey && e.ctrlKey) && !e.altKey && e.key === 'Enter' && tab.running && tab.agent !== 'shell') {
    e.preventDefault();
    ipc.write(tab.id, tab.agent === 'codex' ? '\n' : '\x1b\r');
    insertInput(tab.input, '\n');
    return false;
  }
  if (isAppShortcut(e)) return false;
  return true;
}

function handleScrollKey(term, e) {
  if (e.type !== 'keydown' || !e.shiftKey || e.altKey || e.metaKey) return false;
  let scroll;
  if (e.ctrlKey && e.key === 'Home') scroll = () => term.scrollToTop();
  else if (e.ctrlKey && e.key === 'End') scroll = () => term.scrollToBottom();
  else if (!e.ctrlKey && e.key === 'PageUp') scroll = () => term.scrollPages(-1);
  else if (!e.ctrlKey && e.key === 'PageDown') scroll = () => term.scrollPages(1);
  if (!scroll) return false;
  e.preventDefault();
  scroll();
  return true;
}

function isAppShortcut(e) {
  const ctrl = e.ctrlKey && !e.altKey;
  const k = e.key.toLowerCase();
  if (ctrl && e.key === 'Tab') return true;
  if (ctrl && (e.key === 'PageUp' || e.key === 'PageDown')) return true;
  if (ctrl && e.shiftKey && ['t', 'w', 'h', 'f', 'i', 'a', ',', '1', '2', '3', '4', '5', '!', '@', '#', '$', '%'].includes(k)) return true;
  if (ctrl && !e.shiftKey && ['=', '+', '-', '0'].includes(e.key)) return true;
  if (ctrl && e.shiftKey && /^Digit[1-5]$/.test(e.code)) return true;
  return false;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#modal').classList.contains('hidden')) return closeModal();
    if (!$('#new-menu').classList.contains('hidden') || !$('#ctx').classList.contains('hidden')) return closePopovers();
    if (state.viewer) return closeViewer();
    if (!$('#find').classList.contains('hidden')) return closeFind();
  }
  if (!isAppShortcut(e)) return;
  e.preventDefault();
  const k = e.key.toLowerCase();
  if (e.key === 'Tab') return cycleTab(e.shiftKey ? -1 : 1);
  if (e.key === 'PageUp') return cycleTab(-1);
  if (e.key === 'PageDown') return cycleTab(1);
  if (e.shiftKey && /^Digit[1-5]$/.test(e.code)) {
    const agent = AGENT_KEYS[Number(e.code.slice(5)) - 1];
    if (!enabledAgents().includes(agent)) return toast(`${agentLabel(agent)} is switched off (Settings → Workspaces & agents)`);
    const cur = activeTab();
    return createTab({ agent, cwd: cur ? cur.cwd : defaultCwd() });
  }
  if (e.shiftKey && k === 't') return openNewMenu();
  if (e.shiftKey && k === 'w') return state.activeId && closeTab(state.activeId);
  if (e.shiftKey && k === 'h') return toggleHistory();
  if (e.shiftKey && k === 'f') return openFind();
  if (e.shiftKey && k === 'i') return ipc.devtools();
  if (e.shiftKey && k === 'a') {
    const tab = activeTab();
    if (!tab || tab.agent === 'shell') return;
    const next = nextAccount(tab);
    if (!next) return toast(`${agentLabel(tab.agent)} has one account. Add another in Settings → Workspaces & agents.`);
    return switchTabAccount(tab, next.id);
  }
  if (e.shiftKey && k === ',') return openSettings();
  if (e.key === '=' || e.key === '+') return setFontSize(state.settings.fontSize + 1);
  if (e.key === '-') return setFontSize(state.settings.fontSize - 1);
  if (e.key === '0') return setFontSize(14);
});

function setFontSize(size) {
  size = Math.max(8, Math.min(32, size));
  state.settings.fontSize = size;
  for (const t of state.tabs) t.term.options.fontSize = size;
  fitActive();
  ipc.saveSettings({ fontSize: size });
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

function openFind() {
  if (!activeTab()) return;
  $('#find').classList.remove('hidden');
  const inp = $('#find-input');
  inp.focus();
  inp.select();
}
function closeFind() {
  $('#find').classList.add('hidden');
  const t = activeTab();
  if (t) {
    t.search.clearDecorations();
    t.term.focus();
  }
}
function findStep(back) {
  const t = activeTab();
  const q = $('#find-input').value;
  if (!t || !q) return;
  const opts = { decorations: { matchOverviewRuler: '#e5c07b', activeMatchColorOverviewRuler: '#5b9dff', matchBackground: '#5a4a1f', activeMatchBackground: '#3a4f72' } };
  const hit = back ? t.search.findPrevious(q, opts) : t.search.findNext(q, opts);
  $('#find-input').style.borderColor = hit ? '' : 'var(--danger)';
}
$('#find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') findStep(e.shiftKey);
  if (e.key === 'Escape') closeFind();
});
$('#find-input').addEventListener('input', () => findStep(false));
$('#find-next').onclick = () => findStep(false);
$('#find-prev').onclick = () => findStep(true);
$('#find-close').onclick = closeFind;

// ---------------------------------------------------------------------------
// new tab menu
// ---------------------------------------------------------------------------

function defaultCwd() {
  return (state.workspace && state.workspace.root) || null;
}

// One group per workspace folder: the folder itself, then the Git repositories in it.
function fillCwdSelect(select, selected) {
  select.replaceChildren();
  const ws = state.workspace;
  const branch = (d) => (d.branch ? ' · ' + d.branch : '');
  if (ws && ws.dirs.length) {
    for (const rootDir of ws.dirs.filter((d) => d.kind === 'root')) {
      const group = el('optgroup', { label: rootDir.path });
      group.append(el('option', { value: rootDir.path }, `${rootDir.name} (workspace)${branch(rootDir)}`));
      for (const d of ws.dirs.filter((x) => x.kind === 'repo' && x.root === rootDir.root)) {
        group.append(el('option', { value: d.path }, `${d.name}${branch(d)}`));
      }
      select.append(group);
    }
  }
  if (selected && ![...select.options].some((o) => o.value.toLowerCase() === selected.toLowerCase())) {
    select.append(el('option', { value: selected }, selected));
  }
  if (!select.options.length) select.append(el('option', { value: '' }, 'Home folder'));
  if (selected) {
    const opt = [...select.options].find((o) => o.value.toLowerCase() === selected.toLowerCase());
    if (opt) opt.selected = true;
  }
}

function openNewMenu(cwd) {
  const menu = $('#new-menu');
  const cur = activeTab();
  fillCwdSelect($('#new-cwd'), cwd || (cur && cur.cwd) || defaultCwd());
  const list = $('#new-agents');
  list.replaceChildren();
  enabledAgents().forEach((agent) => {
    const i = AGENT_KEYS.indexOf(agent);
    const info = state.agents[agent] || { available: false, label: agent };
    let acctSelect = null;
    if (multiAccount(agent)) {
      const cur = activeAccountOf(agent);
      acctSelect = el('select', { class: 'acct-select', title: 'Account' },
        ...accountsOf(agent).map((a) => el('option', { value: a.id, selected: a.id === cur.id }, a.name)));
    }
    const go = async (mode) => {
      closePopovers();
      const accountId = acctSelect ? acctSelect.value : null;
      // The account picked here becomes the one Ctrl+Shift+1…5 use as well.
      if (accountId && accountId !== activeAccountOf(agent).id) {
        applySaved(await ipc.saveSettings({ agents: { [agent]: { activeAccount: accountId } } }));
      }
      createTab({ agent, cwd: $('#new-cwd').value || null, mode, accountId });
    };
    list.append(
      el(
        'div',
        { class: `agent-row${info.available ? '' : ' unavailable'}`, style: `--c:${agentColor(agent)}` },
        el('span', { class: 'badge' }, BADGE[agent]),
        el(
          'button',
          { class: 'main-btn', onclick: () => go('new'), title: info.available ? info.path || '' : 'Not found. Set its command in Settings → Workspaces & agents.' },
          el('b', {}, info.label),
          el('small', {}, info.available ? `New session · Ctrl+Shift+${i + 1}` : 'Not found · set its path in Setup')
        ),
        acctSelect,
        agent !== 'shell'
          ? el(
              'div',
              { class: 'alt' },
              el('button', { class: 'small-btn', title: 'Continue the most recent conversation in this folder', onclick: () => go('continue') }, 'Last'),
              agent !== 'opencode' ? el('button', { class: 'small-btn', title: "Open the agent's own session picker", onclick: () => go('picker') }, 'Pick…') : null
            )
          : null
      )
    );
  });
  menu.classList.toggle('with-accounts', enabledAgents().some(multiAccount));
  menu.classList.remove('hidden');
  const btn = $('#btn-new').getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(btn.left, window.innerWidth - menu.offsetWidth - 10)) + 'px';
}

$('#btn-new').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('#new-menu').classList.contains('hidden')) openNewMenu();
  else closePopovers();
});
$('#new-browse').addEventListener('click', async () => {
  const dir = await ipc.pickFolder();
  if (dir) fillCwdSelect($('#new-cwd'), dir);
});
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('#btn-new')) closePopovers();
});

// ---------------------------------------------------------------------------
// history panel
// ---------------------------------------------------------------------------

function toggleHistory(force) {
  const side = $('#history');
  const show = force === undefined ? side.classList.contains('hidden') : force;
  side.classList.toggle('hidden', !show);
  $('#btn-history').classList.toggle('on', show);
  if (show) renderHistory();
  fitActive();
}

function dayKey(ms) {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 86400000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

const sameCwd = (a, b) => !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The folder shown in the Folder view: the one picked there, else the active tab's.
function historyFolderCwd() {
  const tab = activeTab();
  return state.historyFolder || (tab && tab.cwd) || defaultCwd();
}

let historyRender = 0;
async function renderHistory() {
  if ($('#history').classList.contains('hidden')) return;
  const token = ++historyRender;
  const scope = state.historyScope;
  for (const b of document.querySelectorAll('#history-scope button')) b.classList.toggle('on', b.dataset.scope === scope);
  $('#history-filter').classList.toggle('hidden', scope === 'tab');
  $('#history-tabhead').classList.toggle('hidden', scope !== 'tab');
  $('#history-folder-row').classList.toggle('hidden', scope !== 'folder');
  $('#history-agents-row').classList.toggle('hidden', scope !== 'agents');
  $('#history-search').classList.toggle('hidden', scope === 'live');
  $('#history-search').placeholder =
    scope === 'tab' ? 'Search prompts in this tab' : scope === 'folder' ? 'Search sessions in this folder' : 'Search title, folder or id';
  if (scope === 'tab') return renderTabPrompts(token);
  // The stores' views only know the engine's agents.
  const storeScope = scope === 'agents' || scope === 'live';
  for (const b of document.querySelectorAll('#history-filter button')) {
    b.classList.toggle('on', b.dataset.agent === state.historyAgent);
    b.classList.toggle('hidden', storeScope && b.dataset.agent !== 'all' && !ENGINE_AGENTS.includes(b.dataset.agent));
  }
  if (scope === 'agents') return renderAgents(token);
  if (scope === 'live') return renderLive(token);

  const cwd = scope === 'folder' ? historyFolderCwd() : null;
  if (scope === 'folder') renderFolderRow(token, cwd);
  let recs = await ipc.historyList({ agent: state.historyAgent, cwd });
  if (token !== historyRender) return;
  const q = state.historyQuery.trim().toLowerCase();
  if (q) {
    recs = recs.filter((r) =>
      [recordTitle(r), r.cwd, r.cwdLabel, r.nativeId, r.branch].some((v) => v && String(v).toLowerCase().includes(q))
    );
  }
  const list = $('#history-list');
  list.replaceChildren();
  if (!recs.length) {
    const msg = q
      ? 'No matching sessions.'
      : scope === 'folder'
        ? 'No sessions in this folder yet. Every conversation started here is recorded.'
        : 'No sessions yet. Every tab you open is recorded here.';
    list.append(el('div', { class: 'h-empty' }, msg));
    return;
  }
  const groups = new Map();
  for (const r of recs) {
    const key = dayKey(r.lastActiveAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [key, items] of groups) {
    list.append(el('div', { class: 'h-group' }, key));
    for (const r of items) list.append(historyItem(r, { hideFolder: scope === 'folder' }));
  }
}

// Folder picker: workspace folders first, then any other folder that has history.
let importCache = { cwd: null, at: 0, items: [] };
async function renderFolderRow(token, cwd) {
  const folders = await ipc.historyFolders();
  if (token !== historyRender) return;
  const select = $('#history-folder-select');
  const counts = new Map(folders.map((f) => [f.cwd.toLowerCase(), f]));
  const opts = [];
  const seen = new Set();
  const add = (path, label) => {
    const key = path.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const f = [...counts.values()].find((x) => sameCwd(x.cwd, path));
    opts.push(el('option', { value: path }, `${label}${f ? ` · ${f.count}` : ''}`));
  };
  const ws = state.workspace;
  if (ws && ws.dirs) {
    for (const d of ws.dirs) add(d.path, d.kind === 'root' ? `${d.name} (workspace)` : d.name);
  }
  for (const f of folders) add(f.cwd, f.label || f.cwd);
  if (cwd) add(cwd, labelForCwd(cwd));
  select.replaceChildren(...opts);
  const cur = [...select.options].find((o) => sameCwd(o.value, cwd));
  if (cur) cur.selected = true;

  // Conversations the agents have for this folder that history does not list yet.
  const btn = $('#history-import');
  if (!cwd) return btn.classList.add('hidden');
  if (!sameCwd(importCache.cwd, cwd) || Date.now() - importCache.at > 30000) {
    importCache = { cwd, at: Date.now(), items: [] };
    importCache.items = await ipc.historyImportable(cwd).catch(() => []);
  }
  if (token !== historyRender) return;
  const n = importCache.items.length;
  btn.classList.toggle('hidden', !n);
  btn.textContent = `Import ${n}`;
  btn.title = n
    ? `Add ${plural(n, 'conversation')} found in the agents' own stores for this folder:\n` +
      importCache.items.slice(0, 12).map((c) => `• ${agentLabel(c.agent)}: ${c.title || c.id}`).join('\n')
    : '';
}

$('#history-folder-select').addEventListener('change', (e) => {
  state.historyFolder = e.target.value;
  renderHistory();
});
$('#history-import').addEventListener('click', async () => {
  const cwd = historyFolderCwd();
  try {
    const n = await ipc.historyImport(cwd);
    importCache = { cwd: null, at: 0, items: [] };
    toast(`Imported ${plural(n, 'conversation')}`);
  } catch (err) {
    toast(err.message);
  }
  renderHistory();
});

async function renderTabPrompts(token) {
  const tab = activeTab();
  const head = $('#history-tabhead');
  const list = $('#history-list');
  if (!tab) {
    head.replaceChildren();
    list.replaceChildren(el('div', { class: 'h-empty' }, 'Open a tab to see the prompts sent from it.'));
    return;
  }
  const chain = tab.chain.length ? tab.chain : tab.record ? [tab.record.id] : [];
  const [all, convs] = await Promise.all([
    chain.length ? ipc.historyPrompts(chain) : [],
    chain.length > 1 ? ipc.historyGet(chain) : [],
  ]);
  if (token !== historyRender) return;
  const { main, sub } = tabLabel(tab);
  head.style.setProperty('--c', agentColor(tab.agent));
  head.replaceChildren(
    el('span', { class: 'dot' }),
    el('div', { class: 'th-text' },
      el('div', { class: 't' }, main),
      el('div', { class: 'm' }, [
        agentLabel(tab.agent),
        sub,
        convs.length > 1 ? plural(convs.length, 'conversation') : null,
        plural(all.length, 'prompt'),
      ].filter(Boolean).join(' · '))),
    all.length
      ? el('button', {
          class: 'small-btn',
          title: 'Copy every prompt sent from this tab',
          onclick: () => {
            ipc.clipboardWrite(all.map((p) => p.text).join(tab.agent === 'shell' ? '\n' : '\n\n'));
            toast(`Copied ${all.length} prompts`);
          },
        }, 'Copy all')
      : null
  );

  const q = state.historyQuery.trim().toLowerCase();
  const items = (q ? all.filter((p) => p.text.toLowerCase().includes(q)) : all).slice().reverse();
  list.replaceChildren();

  // Every conversation this tab went through (/clear, /new, /resume), newest first.
  const byId = new Map(convs.map((r) => [r.id, r]));
  if (convs.length > 1 && !q) {
    list.append(el('div', { class: 'h-group' }, 'Conversations in this tab'));
    for (const id of chain.slice().reverse()) {
      const r = byId.get(id);
      if (r) list.append(historyItem(r, { hideFolder: true, current: tab.record && tab.record.id === id }));
    }
  }

  if (!items.length) {
    list.append(el('div', { class: 'h-empty' }, q ? 'No matching prompts.' : 'Nothing sent from this tab yet. Every prompt or command you enter is recorded here.'));
    return;
  }
  let group = null;
  let conv = null;
  for (const p of items) {
    const key = dayKey(p.t);
    if (key !== group) {
      group = key;
      conv = null;
      list.append(el('div', { class: 'h-group' }, key));
    }
    if (convs.length > 1 && p.recordId !== conv) {
      conv = p.recordId;
      const r = byId.get(conv);
      list.append(el('div', { class: 'h-conv', style: `--c:${agentColor(tab.agent)}` }, r ? recordTitle(r) : 'Conversation'));
    }
    list.append(promptItem(tab, p));
  }
}

function promptItem(tab, p) {
  const insert = (send) => {
    if (!tab.running) return toast('This tab is not running. Resume it first.');
    if (send) submitText(tab, p.text);
    else tab.term.paste(p.text);
    tab.term.focus();
  };
  return el(
    'div',
    {
      class: 'p-item',
      title: `${new Date(p.t).toLocaleString()}\nClick to insert · double-click to send`,
      onclick: (e) => !e.target.closest('.acts') && e.detail === 1 && insert(false),
      // The first click of the double-click already inserted the text.
      ondblclick: (e) => !e.target.closest('.acts') && tab.running && sendEnter(tab),
    },
    el('span', { class: 'p-time' }, new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    el('div', { class: 'p-text' }, p.text),
    el(
      'span',
      { class: 'acts' },
      el('button', { title: 'Copy', onclick: () => { ipc.clipboardWrite(p.text); toast('Copied'); } }, '⧉'),
      el('button', { title: 'Send again', onclick: () => insert(true) }, '⏎')
    )
  );
}

// Pastes text into a running tab and sends it.
function submitText(tab, text) {
  tab.term.paste(text);
  // Give the agent a moment to take the paste before Enter.
  setTimeout(() => tab.running && sendEnter(tab), 60);
}

function sendEnter(tab) {
  trackInput(tab, '\r');
  ipc.write(tab.id, '\r');
}

function historyItem(rec, { hideFolder = false, current = false } = {}) {
  const openTab = state.tabs.find((t) => t.record && t.record.id === rec.id);
  const meta = [
    rec.agent !== 'shell' || state.historyAgent === 'all' ? agentLabel(rec.agent) : null,
    multiAccount(rec.agent) && rec.accountName ? rec.accountName : null,
    hideFolder ? null : rec.cwdLabel,
    rec.branch,
    relTime(rec.lastActiveAt),
    rec.runs > 1 ? `${rec.runs} runs` : null,
    rec.prompts ? plural(rec.prompts, 'prompt') : null,
    rec.imported ? 'imported' : null,
  ].filter(Boolean);
  return el(
    'div',
    {
      class: `h-item${openTab ? ' open' : ''}${current ? ' current' : ''}`,
      style: `--c:${agentColor(rec.agent)}`,
      title: `${rec.cwd}\n${rec.nativeId ? 'Session ' + rec.nativeId : 'Native session id not detected yet'}\nDouble-click to resume`,
      onclick: (e) => {
        if (e.target.closest('.acts')) return;
        if (openTab) activateTab(openTab.id);
        else openViewer(rec.id);
      },
      ondblclick: () => resumeRecord(rec),
      oncontextmenu: (e) => {
        e.preventDefault();
        recordMenu(rec, e.clientX, e.clientY);
      },
    },
    el('span', { class: 'dot' }),
    el('span', { class: 't' }, recordTitle(rec)),
    el(
      'span',
      { class: 'acts' },
      current
        ? el('span', { class: 'here' }, 'current')
        : openTab
          ? el('span', { class: 'open-pill' }, 'open')
          : el('button', { title: 'Resume in a new tab', onclick: () => resumeRecord(rec) }, '▶'),
      el('button', { title: 'More', onclick: (e) => recordMenu(rec, e.clientX, e.clientY) }, '⋯')
    ),
    el('span', { class: 'm' }, meta.join(' · '))
  );
}

function recordMenu(rec, x, y) {
  showContextMenu(x, y, [
    { label: 'Resume', run: () => resumeRecord(rec) },
    { label: 'View transcript', run: () => openViewer(rec.id) },
    { label: 'Rename…', run: () => renameRecord(rec) },
    '-',
    { label: 'Export as text…', run: () => ipc.historyExport(rec.id) },
    { label: 'Show log file', run: () => ipc.historyOpenFolder(rec.id) },
    { label: 'Copy resume command', run: () => copyResumeCommand(rec) },
    '-',
    { label: 'Delete from history', run: () => deleteRecord(rec) },
  ]);
}

function resumeRecord(rec) {
  const open = state.tabs.find((t) => t.record && t.record.id === rec.id);
  if (open) return activateTab(open.id);
  createTab({ agent: rec.agent, cwd: rec.cwd, record: rec, mode: 'resume' });
}

function resumeCommand(rec) {
  const id = rec.nativeId;
  if (!id) return null;
  if (rec.agent === 'claude') return `claude --resume ${id}`;
  if (rec.agent === 'codex') return `codex resume ${id}`;
  if (rec.agent === 'cursor') return `cursor-agent --resume ${id}`;
  return null;
}

function copyResumeCommand(rec) {
  const cmd = resumeCommand(rec);
  if (!cmd) return toast('No native session id recorded for this session yet');
  ipc.clipboardWrite(`cd "${rec.cwd}"; ${cmd}`);
  toast('Resume command copied');
}

function renameRecord(rec, tab) {
  if (!rec) return;
  const input = el('input', { value: rec.customTitle || rec.title || '', placeholder: recordTitle(rec), spellcheck: 'false' });
  openModal('Rename session', [el('label', { class: 'field' }, input)], [
    { label: 'Cancel' },
    {
      label: 'Save',
      primary: true,
      run: async () => {
        const updated = await ipc.historyRename(rec.id, input.value.trim());
        for (const t of state.tabs) if (t.record && t.record.id === rec.id) t.record = updated;
        renderTabs();
        renderHistory();
      },
    },
  ]);
  setTimeout(() => input.select(), 0);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && $('#modal-actions .primary-btn').click());
  void tab;
}

function deleteRecord(rec) {
  openModal('Delete session from history?', [
    el('p', {}, `"${recordTitle(rec)}" and its saved transcript will be removed from NI Agent Terminal.`),
    el('p', { class: 'help' }, `The conversation in ${agentLabel(rec.agent)}'s own store is not touched.`),
  ], [
    { label: 'Cancel' },
    {
      label: 'Delete',
      primary: true,
      run: async () => {
        try {
          await ipc.historyDelete(rec.id);
          if (state.viewer && state.viewer.id === rec.id) closeViewer();
          for (const t of state.tabs) t.chain = t.chain.filter((id) => id !== rec.id);
          importCache = { cwd: null, at: 0, items: [] };
          saveState();
          renderHistory();
        } catch (err) {
          toast(err.message);
        }
      },
    },
  ]);
}

$('#btn-history').onclick = () => toggleHistory();
$('#history-folder').onclick = () => ipc.historyOpenFolder(state.historyScope === 'folder' ? { cwd: historyFolderCwd() } : null);
$('#history-scope').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.historyScope = b.dataset.scope;
  renderHistory();
});
$('#history-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.historyAgent = b.dataset.agent;
  renderHistory();
});
$('#history-search').addEventListener('input', (e) => {
  state.historyQuery = e.target.value;
  renderHistory();
});

// ---------------------------------------------------------------------------
// Agents view: the agents' own stores, through the engine (engine.js)
// ---------------------------------------------------------------------------
// One row per conversation across Claude, Codex and OpenCode: sessions joined by a
// handoff are one row, under the agent used last.
// Open resumes a row in its own agent; Continue in… hands it to another agent through the
// handoff ledger; Ctrl+click marks rows to combine into one conversation.

let agentsCache = { at: 0, hidden: false, rows: null, error: null };
let agentsLoading = null;

function agentRows(force) {
  const fresh = agentsCache.rows && agentsCache.hidden === state.agentsHidden && Date.now() - agentsCache.at < 20000;
  if (fresh && !force) return Promise.resolve(agentsCache);
  if (!agentsLoading) {
    const hidden = state.agentsHidden;
    agentsLoading = ipc.storesList(hidden)
      .then((rows) => ({ rows, error: null }), (err) => ({ rows: [], error: err.message }))
      .then((r) => {
        agentsCache = { at: Date.now(), hidden, ...r };
        agentsLoading = null;
        return agentsCache;
      });
  }
  return agentsLoading;
}

function invalidateAgents() {
  agentsCache.at = 0;
}

const agentTabOf = (r) => state.tabs.find((t) => t.agent === r.tool && t.record && t.record.nativeId === r.id);

async function renderAgents(token) {
  const list = $('#history-list');
  if (!agentsCache.rows || agentsCache.hidden !== state.agentsHidden) list.replaceChildren(el('div', { class: 'h-empty' }, 'Reading the agents\' stores…'));
  renderAgentsBar();
  const { rows, error } = await agentRows(false);
  if (token !== historyRender) return;
  const q = state.historyQuery.trim().toLowerCase();
  const shown = rows.filter((r) =>
    (state.historyAgent === 'all' || r.tool === state.historyAgent) &&
    (!q || [r.title, r.cwd, r.cwdLabel, r.id, r.tool].some((v) => v && v.toLowerCase().includes(q))));
  list.replaceChildren();
  if (error) return list.append(el('div', { class: 'h-empty' }, error));
  if (!shown.length) {
    return list.append(el('div', { class: 'h-empty' }, q ? 'No matching conversations.' : state.agentsHidden ? 'No hidden conversations.' : 'No conversations in the agents\' stores yet.'));
  }
  for (const r of shown) list.append(agentItem(r));
}

function renderAgentsBar() {
  const n = state.agentsMarked.size;
  const marked = $('#history-agents-marked');
  marked.replaceChildren(
    ...(n
      ? [
          el('span', {}, `${n} marked`),
          el('button', { class: 'small-btn', title: 'Combine the marked conversations into one', onclick: (e) => combineMenu(e.clientX, e.clientY) }, 'Combine into…'),
          el('button', { class: 'small-btn', onclick: () => { state.agentsMarked.clear(); renderHistory(); } }, 'Clear'),
        ]
      : [el('span', { class: 'help' }, 'Ctrl+click marks rows to combine')])
  );
  $('#history-agents-hidden').classList.toggle('on', state.agentsHidden);
}

function agentItem(r) {
  const open = agentTabOf(r);
  const meta = [
    relTime(r.updated * 1000),
    agentLabel(r.tool),
    r.cwdLabel,
    r.via.length ? `via ${r.via.map(agentLabel).join(', ')}` : null,
    r.accounts.length ? r.accounts.join(' › ') : null,
    `…${r.id.slice(-6)}`,
  ].filter(Boolean);
  return el(
    'div',
    {
      class: `h-item${open ? ' open' : ''}${state.agentsMarked.has(r.key) ? ' marked' : ''}`,
      style: `--c:${agentColor(r.tool)}`,
      title: `${r.cwd}\nSession ${r.id}\nClick to preview · double-click to open · Ctrl+click to mark for combining`,
      onclick: (e) => {
        if (e.target.closest('.acts')) return;
        if (e.ctrlKey) return toggleMark(r);
        if (open) activateTab(open.id);
        else openAgentPreview(r);
      },
      ondblclick: (e) => !e.ctrlKey && openRow(r),
      oncontextmenu: (e) => {
        e.preventDefault();
        agentMenu(r, e.clientX, e.clientY);
      },
    },
    el('span', { class: 'dot' }),
    el('span', { class: 't' }, r.title),
    el(
      'span',
      { class: 'acts' },
      open ? el('span', { class: 'open-pill' }, 'open') : el('button', { title: `Open in ${agentLabel(r.tool)}`, onclick: () => openRow(r) }, '▶'),
      el('button', { title: 'Open with… / Continue in…', onclick: (e) => agentMenu(r, e.clientX, e.clientY) }, '⋯')
    ),
    el('span', { class: 'm' }, meta.join(' · '))
  );
}

function toggleMark(r) {
  if (!state.agentsMarked.delete(r.key)) state.agentsMarked.add(r.key);
  renderHistory();
}

// Destinations: the row's own agent, then the others;
// Claude once per account when there are several.
function agentTargets(ownTool) {
  const tools = [ownTool, ...ENGINE_AGENTS.filter((t) => t !== ownTool && enabledAgents().includes(t))].filter(Boolean);
  return tools.flatMap((tool) =>
    tool === 'claude' && multiAccount('claude')
      ? [activeAccountOf('claude'), ...accountsOf('claude').filter((a) => a.id !== activeAccountOf('claude').id)].map((a) => ({ tool, accountId: a.id, label: `Claude · ${a.name}` }))
      : [{ tool, accountId: null, label: agentLabel(tool) }]);
}

function agentMenu(r, x, y) {
  const targets = agentTargets(r.tool);
  showContextMenu(x, y, [
    ...targets.filter((t) => t.tool === r.tool).map((t, i) => ({
      label: `Open in ${t.label}`,
      hint: i === 0 ? 'double-click' : 'same conversation',
      run: () => openRow(r, t.accountId),
    })),
    ...(targets.some((t) => t.tool !== r.tool) ? ['-'] : []),
    ...targets.filter((t) => t.tool !== r.tool).map((t) => ({ label: `Continue in ${t.label}…`, hint: 'handoff', run: () => transfer([r], t.tool, t.accountId) })),
    '-',
    { label: 'Preview', run: () => openAgentPreview(r) },
    { label: state.agentsMarked.has(r.key) ? 'Unmark' : 'Mark to combine', hint: 'Ctrl+click', run: () => toggleMark(r) },
    { label: state.agentsHidden ? 'Show in the list again' : 'Hide', run: () => hideRows([r], !state.agentsHidden) },
    { label: 'Copy session id', run: () => { ipc.clipboardWrite(r.id); toast('Copied'); } },
  ]);
}

function combineMenu(x, y) {
  const items = agentsCache.rows.filter((r) => state.agentsMarked.has(r.key));
  if (items.length < 2) return toast('Mark at least two conversations to combine');
  showContextMenu(x, y, agentTargets(null).map((t) => ({ label: `Combine into ${t.label}…`, run: () => transfer(items, t.tool, t.accountId) })));
}

async function hideRows(rows, hidden) {
  await ipc.storesHide(rows.flatMap((r) => r.members), hidden);
  for (const r of rows) state.agentsMarked.delete(r.key);
  invalidateAgents();
  toast(hidden ? 'Hidden' : 'Shown again');
  renderHistory();
}

async function openAgentPreview(r) {
  closePopovers();
  state.viewer = { native: r, data: { text: 'Reading the last turns…' }, mode: 'text' };
  $('#viewer').classList.remove('hidden');
  $('#viewer-mode').classList.add('hidden');
  $('#viewer-export').classList.add('hidden');
  $('#viewer-dot').style.setProperty('--c', agentColor(r.tool));
  $('#viewer-name').textContent = r.title;
  $('#viewer-meta').textContent = [agentLabel(r.tool), r.cwd, `session ${r.id}`, r.via.length ? `via ${r.via.map(agentLabel).join(', ')}` : null].filter(Boolean).join(' · ');
  renderViewer();
  const text = await ipc.storesPreview(r.tool, r.id).catch((err) => err.message);
  if (state.viewer && state.viewer.native === r) {
    state.viewer.data.text = text.trim() || 'No chat turns found.';
    renderViewer();
    $('#viewer-text').scrollTop = 0;
  }
}

// Resumes a conversation of the agents' stores (r: { tool, id, cwd, title }) in its own agent:
// a Claude one under `accountId`, else (double-click, ▶) under the account new tabs use, as
// the menu's first entry says. `prompt` (a handoff) is sent to it. A tab already on it is
// used as it is; without a prompt, naming another account switches that tab.
async function openNative(r, accountId, prompt) {
  const open = agentTabOf(r);
  if (open) {
    if (!prompt && accountId && accountId !== tabAccount(open).id) return switchTabAccount(open, accountId);
    activateTab(open.id); // starts a restored tab that never ran, with its prompt
    if (prompt && open.running) submitText(open, prompt);
    else if (prompt) {
      open.prompt = prompt;
      if (open.started) restartTab(open);
    }
    return;
  }
  if (!accountId && r.tool === 'claude' && multiAccount('claude')) accountId = activeAccountOf('claude').id;
  const res = await ipc.storesOpen({ tool: r.tool, id: r.id, cwd: r.cwd, title: r.title, accountId });
  state.settings = res.settings;
  invalidateAgents();
  createTab({ agent: r.tool, cwd: res.record.cwd, record: res.record, mode: 'resume', prompt });
}

const openRow = (r, accountId) => openNative(r, accountId).catch((err) => toast(err.message));

// A choice in a modal: resolves to the picked option's value, or null when cancelled.
function chooseModal(title, intro, options) {
  return new Promise((resolve) => {
    const body = [
      intro ? el('p', { class: 'help' }, intro) : null,
      el('div', { class: 'choose-list' }, ...options.map((o) =>
        el('button', { class: 'choose-item', onclick: () => { modalOnClose = null; closeModal(); resolve(o.value); } },
          el('b', {}, o.label), o.sub ? el('small', {}, o.sub) : null))),
    ].filter(Boolean);
    openModal(title, body, [{ label: 'Cancel' }]);
    modalOnClose = () => resolve(null);
  });
}

// Hands conversations to `tool` through the transfer planner: only the
// messages and tool notes the destination has not seen go into a handoff file, which the
// destination is told to read. An existing linked destination is resumed rather than a new one started.
async function transfer(items, tool, accountId) {
  const req = { sources: items.map((r) => r.key), tool, preview: true };
  let plan;
  let cwd = null;
  try {
    toast('Checking conversation synchronization…');
    plan = await ipc.storesPlan(req);
    if (plan.status === 'choose') {
      req.target = await chooseModal(`Continue in which ${agentLabel(tool)} conversation?`, 'These conversations already carry this work. Choose one, or explicitly start a separate branch.', [
        ...plan.candidates.map((c) => ({ label: c.title, sub: `${c.updated} · ${c.cwd} · ${c.id}`, value: c.key })),
        { label: '+ Start a separate branch', value: '__NEW__' },
      ]);
      if (!req.target) return;
      plan = await ipc.storesPlan(req);
    }
    if (plan.status === 'preview') {
      if (!plan.target && items.length > 1) {
        const cwds = [...new Set(items.map((r) => r.cwd))];
        cwd = cwds.length > 1 ? await chooseModal('Start the combined conversation in which folder?', null, cwds.map((c) => ({ label: c, value: c }))) : cwds[0];
        if (!cwd) return;
      }
      req.preview = false;
      plan = await ipc.storesPlan(req);
    }
    if (plan.status === 'pending') {
      if (plan.age < 30) return toast(`${plan.message} No new context has been marked as delivered.`);
      const retry = await chooseModal('Retry the previous transfer?', `${plan.message} Retrying may open the destination twice if it is still starting.`, [{ label: 'Retry', value: true }]);
      if (!retry) return;
      req.retry = true;
      plan = await ipc.storesPlan(req);
    }
    if (plan.status !== 'ready') throw new Error(`Unexpected synchronization status: ${plan.status}`);
    const h = await ipc.storesHandoff({ plan, items, cwd });
    state.agentsMarked.clear();
    invalidateAgents();
    toast(plan.handoff ? `Continuing with ${plan.count} new messages/tool notes` : 'Already synchronized; resuming without adding a prompt');
    if (plan.target) await openNative({ tool, id: plan.target.id, cwd: plan.target.cwd, title: h.title }, accountId, h.prompt);
    else createTab({ agent: tool, cwd: h.cwd, mode: 'new', prompt: h.prompt, accountId });
  } catch (err) {
    toast(`Conversation transfer stopped: ${err.message}`);
  }
}

$('#history-agents-hidden').onclick = () => {
  state.agentsHidden = !state.agentsHidden;
  state.agentsMarked.clear();
  renderHistory();
};
$('#history-agents-reload').onclick = async () => {
  await agentRows(true);
  renderHistory();
};

// ---------------------------------------------------------------------------
// Live view: running sessions
// ---------------------------------------------------------------------------

function shortAge(since) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - since));
  return s >= 86400 ? `${Math.floor(s / 86400)}d` : s >= 3600 ? `${Math.floor(s / 3600)}h` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
}

let liveRows = null;
let liveBusy = false;
async function renderLive(token) {
  const list = $('#history-list');
  if (!liveRows) list.replaceChildren(el('div', { class: 'h-empty' }, 'Reading running sessions…'));
  // Each read runs Python in the backend; a slow one is not stacked on.
  if (liveBusy) return;
  liveBusy = true;
  const res = await ipc.storesBoard().then((rows) => ({ rows }), (err) => ({ error: err.message })).finally(() => { liveBusy = false; });
  if (token !== historyRender) return;
  liveRows = res.rows || [];
  list.replaceChildren();
  if (res.error) return list.append(el('div', { class: 'h-empty' }, res.error));
  const rows = liveRows.filter((r) => state.historyAgent === 'all' || r.label === state.historyAgent).sort((a, b) => b.since - a.since);
  if (!rows.length) return list.append(el('div', { class: 'h-empty' }, 'No active sessions.'));
  const item = (r, parent) =>
    el('div', { class: `lv-item${parent ? ' child' : ''}`, style: `--c:${agentColor(parent ? parent.label : r.label)};--d:${r.depth || 0}` },
      el('span', { class: `lv-state ${r.state}` }, r.state),
      el('span', { class: 't' }, parent ? `${r.label}: ${r.title}` : r.title || r.project),
      el('span', { class: 'm' }, [parent ? null : agentLabel(r.label), parent ? null : r.project, r.model, shortAge(r.since)].filter(Boolean).join(' · ')),
      r.detail ? el('span', { class: 'lv-detail' }, r.detail) : null);
  for (const r of rows) {
    list.append(item(r));
    for (const c of r.children.slice().sort((a, b) => b.since - a.since)) list.append(item(c, r));
  }
}
setInterval(() => {
  if (state.historyScope === 'live' && !$('#history').classList.contains('hidden')) renderHistory();
}, 3000);

// ---------------------------------------------------------------------------
// transcript viewer
// ---------------------------------------------------------------------------

let viewerTerm = null;
let viewerFit = null;

async function openViewer(id) {
  const data = await ipc.historyRead(id);
  if (!data) return toast('Session not found');
  closePopovers();
  state.viewer = { id, data, mode: data.text ? 'text' : 'raw' };
  const rec = data.record;
  $('#viewer-mode').classList.remove('hidden');
  $('#viewer-export').classList.remove('hidden');
  $('#viewer').classList.remove('hidden');
  $('#viewer-dot').style.setProperty('--c', agentColor(rec.agent));
  $('#viewer-name').textContent = recordTitle(rec);
  $('#viewer-meta').textContent = [
    agentLabel(rec.agent),
    rec.cwd,
    `started ${new Date(rec.createdAt).toLocaleString()}`,
    rec.nativeId ? `session ${rec.nativeId}` : null,
  ].filter(Boolean).join(' · ');
  renderViewer();
}

function renderViewer() {
  const v = state.viewer;
  if (!v) return;
  for (const b of document.querySelectorAll('#viewer-mode button')) b.classList.toggle('on', b.dataset.mode === v.mode);
  const pre = $('#viewer-text');
  const host = $('#viewer-term');
  if (v.mode === 'text') {
    host.classList.add('hidden');
    pre.classList.remove('hidden');
    pre.textContent = v.data.text || 'No text snapshot was saved for this session. Use Replay to view the raw recording.';
    pre.scrollTop = pre.scrollHeight;
  } else {
    pre.classList.add('hidden');
    host.classList.remove('hidden');
    if (viewerTerm) viewerTerm.dispose();
    viewerTerm = new Terminal({
      fontFamily: state.settings.fontFamily,
      fontSize: state.settings.fontSize,
      scrollback: 100000,
      theme: THEME,
      disableStdin: true,
      cursorBlink: false,
    });
    viewerFit = new FitAddon.FitAddon();
    viewerTerm.loadAddon(viewerFit);
    viewerTerm.open(host);
    viewerTerm.attachCustomKeyEventHandler((e) => !handleScrollKey(viewerTerm, e));
    requestAnimationFrame(() => {
      viewerFit.fit();
      viewerTerm.write(v.data.raw || 'No recording found for this session.');
    });
  }
}

function closeViewer() {
  if (!state.viewer) return;
  state.viewer = null;
  $('#viewer').classList.add('hidden');
  if (viewerTerm) {
    viewerTerm.dispose();
    viewerTerm = null;
  }
  const t = activeTab();
  if (t) t.term.focus();
}

$('#viewer-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !state.viewer) return;
  state.viewer.mode = b.dataset.mode;
  renderViewer();
});
$('#viewer-close').onclick = closeViewer;
$('#viewer-export').onclick = () => state.viewer && ipc.historyExport(state.viewer.id);
$('#viewer-resume').onclick = () => {
  const v = state.viewer;
  if (!v) return;
  closeViewer();
  if (v.native) openRow(v.native);
  else resumeRecord(v.data.record);
};

// ---------------------------------------------------------------------------
// status bar
// ---------------------------------------------------------------------------

function renderStatus() {
  const tab = activeTab();
  const agentEl = $('#st-agent');
  if (!tab) {
    agentEl.textContent = '';
    $('#st-cwd').textContent = '';
    $('#st-branch').textContent = '';
    $('#st-session').textContent = '';
  } else {
    const rec = tab.record;
    agentEl.textContent = agentLabel(tab.agent) + (tab.started && !tab.running ? ' (exited)' : '');
    agentEl.style.setProperty('--c', agentColor(tab.agent));
    $('#st-cwd').textContent = tab.cwd || '';
    $('#st-branch').textContent = rec && rec.branch ? `⎇ ${rec.branch}` : '';
    $('#st-session').textContent = rec && rec.nativeId ? rec.nativeId.slice(0, 8) : tab.agent === 'shell' ? '' : 'session: detecting…';
  }
  const acctEl = $('#st-account');
  const showAcct = !!tab && multiAccount(tab.agent);
  acctEl.classList.toggle('hidden', !showAcct);
  acctEl.textContent = showAcct ? `⇄ ${tabAccount(tab).name}` : '';
  const ws = state.workspace;
  const st = $('#st-ws');
  if (ws && ws.roots && ws.roots.length) {
    const extra = ws.roots.length > 1 ? ` +${ws.roots.length - 1}` : '';
    st.textContent = `workspace: ${ws.roots[0]}${extra}${ws.missing && ws.missing.length ? ' (folder missing)' : ''}`;
    st.title = `Workspace folders (click to change):\n${ws.roots.join('\n')}`;
  } else {
    st.textContent = 'workspace: not set (click to choose)';
    st.title = 'Choose workspace folders';
  }
}
$('#st-cwd').onclick = () => { const t = activeTab(); if (t && t.cwd) ipc.openPath(t.cwd); };
$('#st-session').onclick = () => { const t = activeTab(); if (t && t.record) copyResumeCommand(t.record); };
$('#st-ws').onclick = () => openSetup();
$('#st-account').onclick = (e) => {
  const tab = activeTab();
  if (!tab) return;
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu(r.left, r.top - 8, [
    ...accountMenuItems(tab).slice(1),
    '-',
    { label: 'Manage accounts…', run: () => openSetup() },
  ]);
  // Open upwards from the status bar.
  const ctx = $('#ctx');
  ctx.style.top = Math.max(8, r.top - ctx.offsetHeight - 4) + 'px';
};

// ---------------------------------------------------------------------------
// modal & settings
// ---------------------------------------------------------------------------

// opts.locked: no closing by Esc or a click outside (first-run Setup).
// opts.wide: a wider card.
let modalLocked = false;
function openModal(title, body, actions, opts = {}) {
  modalLocked = !!opts.locked;
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(...body);
  $('#modal .modal-card').classList.toggle('wide', !!opts.wide);
  $('#modal-actions').replaceChildren(
    ...actions.map((a) =>
      el('button', {
        class: a.primary ? 'primary-btn' : 'small-btn',
        onclick: async () => {
          if (a.run && (await a.run()) === false) return;
          modalLocked = false;
          closeModal();
        },
      }, a.label)
    )
  );
  $('#modal').classList.remove('hidden');
}

let modalOnClose = null;
function closeModal() {
  if (modalLocked) return;
  $('#modal').classList.add('hidden');
  const done = modalOnClose;
  modalOnClose = null;
  if (done) done();
  const t = activeTab();
  if (t) t.term.focus();
}
$('#modal').addEventListener('mousedown', (e) => e.target.id === 'modal' && closeModal());

function applySaved(res) {
  state.settings = res.settings;
  state.workspace = res.workspace;
  for (const a of res.agents) state.agents[a.id] = a;
  renderEmptyActions();
  renderTabs();
  renderStatus();
  renderHistory();
}

function openSettings() {
  const s = state.settings;
  const restore = el('input', { type: 'checkbox' });
  const copyOnSelect = el('input', { type: 'checkbox' });
  copyOnSelect.checked = !!s.copyOnSelect;
  restore.checked = !!s.restoreTabs;
  const fontSize = el('input', { type: 'number', min: 8, max: 32, value: s.fontSize });
  const agentsDays = el('input', { type: 'number', min: 1, max: 3650, value: s.agentsDays });
  const startup = {};
  const extra = {};
  for (const a of AGENT_KEYS) {
    startup[a] = el('input', { type: 'checkbox' });
    startup[a].checked = (s.startupTabs || []).includes(a);
    extra[a] = el('input', { value: s.extraArgs[a] || '', spellcheck: 'false', placeholder: a === 'claude' ? 'e.g. --permission-mode acceptEdits' : a === 'codex' ? 'e.g. --model gpt-5-codex' : '' });
  }
  const ws = state.workspace;
  const wsSummary = ws && ws.roots && ws.roots.length ? ws.roots.join('\n') : 'No workspace folder set';
  const agentsSummary = enabledAgents().map(agentLabel).join(', ') || 'none';
  openModal('Settings', [
    el('div', { class: 'field' }, el('span', {}, 'Workspaces & agents'),
      el('div', { class: 'row setup-summary' },
        el('div', { class: 'grow' }, el('div', { class: 'mono-sm' }, wsSummary), el('div', { class: 'help' }, `Agents: ${agentsSummary}`)),
        el('button', { class: 'small-btn', onclick: () => openSetup() }, 'Change…'))),
    el('label', { class: 'check' }, restore, 'Reopen and resume last tabs on startup'),
    el('label', { class: 'check' }, copyOnSelect, 'Copy selected text to the clipboard as soon as it is selected'),
    el('div', { class: 'field' }, el('span', {}, 'Tabs to open when there is nothing to restore'),
      el('div', { class: 'row' }, ...enabledAgents().map((a) => el('label', { class: 'check' }, startup[a], agentLabel(a))))),
    el('label', { class: 'field' }, el('span', {}, 'Font size'), fontSize),
    el('label', { class: 'field' }, el('span', {}, 'Days of conversations in History → Agents'), agentsDays),
    ...enabledAgents().map((a) => el('label', { class: 'field' }, el('span', {}, `${agentLabel(a)} extra arguments`), extra[a])),
    el('div', { class: 'help' }, `Data folder: ${state.userData}`),
  ], [
    { label: 'Cancel' },
    {
      label: 'Save',
      primary: true,
      run: async () => {
        const patch = {
          restoreTabs: restore.checked,
          copyOnSelect: copyOnSelect.checked,
          fontSize: Number(fontSize.value) || 14,
          agentsDays: Number(agentsDays.value) || 40,
          startupTabs: AGENT_KEYS.filter((a) => startup[a].checked),
          extraArgs: Object.fromEntries(AGENT_KEYS.map((a) => [a, extra[a].value.trim()])),
        };
        applySaved(await ipc.saveSettings(patch));
        invalidateAgents();
        setFontSize(state.settings.fontSize);
      },
    },
  ]);
}
$('#btn-settings').onclick = openSettings;

// ---------------------------------------------------------------------------
// setup: workspace folders and agents (first start, or Settings → Change…)
// ---------------------------------------------------------------------------

const AGENT_HINTS = {
  claude: 'Claude Code CLI (npm i -g @anthropic-ai/claude-code)',
  codex: 'OpenAI Codex CLI (npm i -g @openai/codex)',
  cursor: 'Cursor Agent CLI (cursor-agent)',
  opencode: 'OpenCode CLI (opencode). Its conversations are read with Python 3 (SQLite).',
  shell: 'Plain shell tab: powershell.exe, pwsh.exe or cmd.exe; in WSL, your login shell',
};

// The accounts of one agent in Setup. Claude / Codex: a name and a config folder each;
// Cursor: a name and an API key. The radio button picks the account new tabs use.
function accountEditor(agent, st, cfg) {
  const isDir = st.accountKind === 'dir';
  const list = (cfg.accounts && cfg.accounts.length ? cfg.accounts : [{ id: 'default', name: 'Default', configDir: '' }])
    .map((x) => ({ id: x.id, name: x.name, configDir: x.configDir || '', uuid: x.uuid || '', hasKey: !!x.hasKey, apiKey: '', clearKey: false }));
  let active = list.some((x) => x.id === cfg.activeAccount) ? cfg.activeAccount : list[0].id;
  const wrap = el('div', { class: 'acct-list' });
  const newId = () => `acct-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const render = () => {
    wrap.replaceChildren(...list.map((x, i) => {
      const radio = el('input', { type: 'radio', name: `acct-${agent}`, title: 'New tabs use this account', checked: x.id === active });
      radio.addEventListener('change', () => { active = x.id; });
      const name = el('input', { class: 'acct-name', value: x.name, placeholder: `Account ${i + 1}`, spellcheck: 'false', title: 'Name shown on tabs and in the status bar' });
      name.addEventListener('input', () => { x.name = name.value; });
      let detail;
      if (isDir) {
        const dir = el('input', { class: 'grow', value: x.configDir, placeholder: `Normal login (${st.defaultConfigDir})`, spellcheck: 'false' });
        dir.addEventListener('input', () => { x.configDir = dir.value; });
        const browse = el('button', {
          class: 'small-btn',
          onclick: async () => {
            const d = await ipc.pickFolder({ title: `${agentLabel(agent)} account folder (${st.configEnv})`, defaultPath: x.configDir || st.defaultConfigDir });
            if (d) dir.value = x.configDir = d;
          },
        }, 'Browse…');
        detail = [dir, browse];
      } else {
        const key = el('input', {
          class: 'grow', type: 'password', value: x.apiKey, spellcheck: 'false', autocomplete: 'off',
          placeholder: x.hasKey ? 'Key saved (type to replace)' : 'No key: normal login',
        });
        key.addEventListener('input', () => { x.apiKey = key.value; });
        const clear = x.hasKey
          ? el('button', { class: 'small-btn', title: 'Forget the saved key', onclick: () => { x.hasKey = false; x.clearKey = true; x.apiKey = ''; render(); } }, 'Clear')
          : null;
        detail = [key, clear];
      }
      const remove = list.length > 1
        ? el('button', {
            class: 'small-btn',
            title: isDir ? 'Remove this account (its folder and conversations stay on disk)' : 'Remove this account',
            onclick: () => {
              list.splice(i, 1);
              if (active === x.id) active = list[0].id;
              render();
            },
          }, '✕')
        : null;
      return el('div', { class: 'acct-row' }, radio, name, ...detail, remove);
    }));
  };
  const add = el('button', {
    class: 'small-btn',
    onclick: () => {
      const n = list.length + 1;
      list.push({ id: newId(), name: `Account ${n}`, configDir: isDir ? `${st.defaultConfigDir}-${n}` : '', hasKey: false, apiKey: '', clearKey: false });
      render();
    },
  }, 'Add account');
  render();

  const help = isDir
    ? `Each account is a config folder (${st.configEnv}) with its own login. An empty folder is your normal login. Sign in once in a tab of a new account. The selected account is used by new tabs. To switch a tab, press Ctrl+Shift+A or click the account in the status bar: its conversation resumes under the other login, copied there unless the accounts share one history.${agent === 'claude' ? ' Link accounts shares ~/.claude\'s history with every ~/.claude-<n> login.' : ''}`
    : `Each account is a Cursor API key (${st.keyEnv}, from the Cursor dashboard → Integrations). An account with no key is your normal login. Keys are stored encrypted for your Windows user. The selected account is used by new tabs. To switch a tab, press Ctrl+Shift+A or click the account in the status bar.`;
  const node = el('div', { class: 'field' }, el('span', {}, 'Accounts'), wrap, el('div', { class: 'row' }, add), el('div', { class: 'help' }, help));

  const normDir = (p) => (p.trim() || st.defaultConfigDir || '').replace(/[\\/]+$/, '').toLowerCase();
  return {
    node,
    refresh: render,
    // Accounts claude-accounts.sh reported, the first being the normal login: each takes
    // its login's uuid (which labels its conversations), and missing ones are added.
    merge(found) {
      found.forEach((a, i) => {
        const dir = i === 0 ? '' : a.dir;
        const short = a.email ? a.email.split('@')[0] : '';
        let x = list.find((o) => normDir(o.configDir) === normDir(dir || st.defaultConfigDir || ''));
        if (!x) {
          x = { id: newId(), name: short || dir.split(/[\\/]/).pop(), configDir: dir, uuid: '', hasKey: false, apiKey: '', clearKey: false };
          list.push(x);
        } else if (short && /^(Default|Account \d+)$/.test(x.name)) {
          x.name = short;
        }
        x.uuid = a.uuid || x.uuid;
      });
      render();
    },
    // Why these accounts cannot be saved, or null.
    problem() {
      if (isDir) {
        const seen = new Map();
        for (const x of list) {
          const k = normDir(x.configDir);
          if (seen.has(k)) return `"${seen.get(k)}" and "${x.name}" use the same folder`;
          seen.set(k, x.name);
        }
      } else {
        const noKey = list.filter((x) => !x.hasKey && !x.apiKey.trim());
        if (noKey.length > 1) return `only one account can be without an API key ("${noKey[0].name}", "${noKey[1].name}")`;
      }
      return null;
    },
    value() {
      return {
        accounts: list.map((x, i) => ({
          id: x.id,
          name: x.name.trim() || `Account ${i + 1}`,
          configDir: isDir ? x.configDir.trim() : '',
          ...(x.uuid ? { uuid: x.uuid } : {}),
          ...(x.apiKey.trim() ? { apiKey: x.apiKey.trim() } : {}),
          ...(x.clearKey ? { clearKey: true } : {}),
        })),
        activeAccount: active,
      };
    },
  };
}

async function openSetup({ first = false } = {}) {
  const info = await ipc.setupInfo();
  const s = info.settings;
  const status = Object.fromEntries(info.agents.map((a) => [a.id, a]));
  let roots = s.workspaces.length ? [...s.workspaces] : [...info.suggested];

  // ---- workspace folders ----
  const wsList = el('div', { class: 'ws-list' });
  const renderRoots = async () => {
    const desc = await ipc.setupDescribe(roots).catch(() => ({ dirs: [], missing: [] }));
    const repoCount = (r) => desc.dirs.filter((d) => d.kind === 'repo' && d.root === r).length;
    wsList.replaceChildren(
      ...(roots.length
        ? roots.map((r, i) =>
            el('div', { class: 'ws-row' },
              el('div', { class: 'grow' },
                el('div', { class: 'mono-sm' }, r),
                el('div', { class: 'help' },
                  (desc.missing || []).includes(r)
                    ? 'Folder not found'
                    : `${i === 0 ? 'Default for new tabs · ' : ''}${repoCount(r)} Git ${repoCount(r) === 1 ? 'repository' : 'repositories'} inside`)),
              i > 0 ? el('button', { class: 'small-btn', title: 'Make this the default folder', onclick: () => { roots.unshift(roots.splice(i, 1)[0]); renderRoots(); } }, '↑') : null,
              el('button', { class: 'small-btn', title: 'Remove', onclick: () => { roots.splice(i, 1); renderRoots(); } }, '✕')))
        : [el('div', { class: 'help ws-empty' }, 'No folder yet. Tabs would open in your home folder.')])
    );
  };
  const addFolder = el('button', {
    class: 'small-btn',
    onclick: async () => {
      const dir = await ipc.pickFolder({ title: 'Add a workspace folder', defaultPath: roots[0] || info.home });
      if (dir && !roots.some((r) => sameCwd(r, dir))) roots.push(dir);
      renderRoots();
    },
  }, 'Add folder…');

  // ---- where agents run ----
  const backendSel = el('select', {},
    el('option', { value: 'windows' }, 'Windows (native CLIs)'),
    ...[...new Set([...info.distros, ...(s.backend.startsWith('wsl:') ? [s.backend.slice(4)] : [])])].map((d) => el('option', { value: `wsl:${d}` }, `WSL · ${d}`)));
  backendSel.value = s.backend;
  backendSel.addEventListener('change', () => locateSoon());

  // ---- agents ----
  const rows = {};
  const locateSoon = (() => {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const res = await ipc.setupLocate(backendSel.value, Object.fromEntries(AGENT_KEYS.map((a) => [a, rows[a].command.value.trim()]))).catch(() => ({ found: {}, configDirs: {} }));
        for (const a of AGENT_KEYS) {
          rows[a].setFound(res.found[a]);
          if (rows[a].accounts && res.configDirs[a]) {
            status[a].defaultConfigDir = res.configDirs[a];
            rows[a].accounts.refresh();
          }
        }
      }, 250);
    };
  })();
  const agentCards = AGENT_KEYS.map((a) => {
    const st = status[a] || {};
    const cfg = (s.agents && s.agents[a]) || {};
    const enabled = el('input', { type: 'checkbox' });
    enabled.checked = cfg.enabled !== false;
    const found = el('span', { class: 'found' });
    const setFound = (p) => {
      found.textContent = p ? `found · ${p}` : 'not found';
      found.classList.toggle('missing', !p);
      found.title = p || 'Not on PATH. Install it, or enter the full path to its .exe / .cmd.';
    };
    setFound(st.path);
    const command = el('input', { value: cfg.command || '', placeholder: `${st.defaultCommand || a} (from PATH)`, spellcheck: 'false' });
    command.addEventListener('input', locateSoon);
    const browseCmd = el('button', {
      class: 'small-btn',
      onclick: async () => {
        const f = await ipc.pickFile({ title: `${agentLabel(a)} command`, defaultPath: command.value || st.path || undefined });
        if (f) {
          command.value = f;
          locateSoon();
        }
      },
    }, 'Browse…');
    const accounts = st.accountKind ? accountEditor(a, st, cfg) : null;
    // claude-accounts.sh in the chosen backend: link (or create) ~/.claude-<n> logins.
    const linkNote = el('div', { class: 'help' });
    const linkAccounts = async (create) => {
      linkNote.textContent = 'Linking…';
      try {
        const res = await ipc.storesClaudeAccounts({ backend: backendSel.value, create });
        accounts.merge(res.accounts);
        linkNote.textContent = [`${plural(res.accounts.length, 'account')} share ~/.claude's history.`, ...res.notes].join(' ');
      } catch (err) {
        linkNote.textContent = err.message;
      }
    };
    const link = a === 'claude' ? el('button', { class: 'small-btn', title: 'Link every ~/.claude-<n> login to ~/.claude\'s history (keeps each login; sets aside, never deletes)', onclick: () => linkAccounts(false) }, 'Link accounts') : null;
    const addLinked = a === 'claude' ? el('button', { class: 'small-btn', title: 'Create the next ~/.claude-<n> and link it; sign in once in a tab of it', onclick: () => linkAccounts(true) }, 'New linked account') : null;
    const body = el('div', { class: 'agent-body' },
      el('label', { class: 'field' }, el('span', {}, 'Command'), el('div', { class: 'row' }, command, browseCmd)),
      accounts && accounts.node,
      link ? el('div', { class: 'row' }, link, addLinked) : null,
      link ? linkNote : null);
    const card = el('div', { class: 'agent-card', style: `--c:${agentColor(a)}` },
      el('div', { class: 'agent-head' },
        el('label', { class: 'check' }, enabled, el('span', { class: 'badge' }, BADGE[a]), el('b', {}, agentLabel(a))),
        found),
      el('div', { class: 'help' }, AGENT_HINTS[a]),
      body);
    const sync = () => card.classList.toggle('off', !enabled.checked);
    enabled.addEventListener('change', sync);
    sync();
    rows[a] = { enabled, command, accounts, setFound };
    return card;
  });

  renderRoots();
  if (backendSel.value !== s.backend) locateSoon();
  const body = [
    first ? el('p', { class: 'setup-intro' }, 'Choose the folders the agents work in and how each agent is started. You can change this later in Settings.') : null,
    el('div', { class: 'setup-section' },
      el('h4', {}, 'Workspace folders'),
      el('div', { class: 'help' }, 'New tabs open in the first folder. Git repositories inside these folders (up to two levels down, e.g. repos/<name>) are listed in the new-tab folder picker and the History Folder view.'),
      wsList,
      el('div', { class: 'row' }, addFolder)),
    el('div', { class: 'setup-section' },
      el('h4', {}, 'Where agents run'),
      el('div', { class: 'help' }, 'New tabs run their agent here. In WSL, the CLIs installed inside the distro run in its login shell, and their stores are read over \\\\wsl$. A conversation always resumes where it was started.'),
      el('div', { class: 'row' }, backendSel)),
    el('div', { class: 'setup-section' }, el('h4', {}, 'Agents'), ...agentCards),
  ].filter(Boolean);

  const save = async () => {
    const agents = {};
    for (const a of AGENT_KEYS) {
      agents[a] = { enabled: rows[a].enabled.checked, command: rows[a].command.value.trim() };
      if (rows[a].accounts) {
        const problem = rows[a].accounts.problem();
        if (problem && agents[a].enabled) {
          toast(`${agentLabel(a)}: ${problem}`);
          return false;
        }
        Object.assign(agents[a], rows[a].accounts.value());
      }
    }
    if (!AGENT_KEYS.some((a) => agents[a].enabled)) {
      toast('Enable at least one agent');
      return false;
    }
    const startupTabs = (state.settings.startupTabs || []).filter((a) => agents[a].enabled);
    let res;
    try {
      res = await ipc.saveSettings({ setupDone: true, workspaces: roots, agents, startupTabs, backend: backendSel.value });
      invalidateAgents();
    } catch (err) {
      toast(err.message);
      return false;
    }
    applySaved(res);
    if (first && !state.tabs.length) openStartupTabs();
    return true;
  };
  openModal(first ? 'Welcome: set up NI Agent Terminal' : 'Workspaces & agents', body, [
    first
      ? { label: 'Skip for now', run: async () => { applySaved(await ipc.saveSettings({ setupDone: true })); if (!state.tabs.length) openStartupTabs(); } }
      : { label: 'Cancel' },
    { label: first ? 'Start' : 'Save', primary: true, run: save },
  ], { wide: true, locked: first });
}

// ---------------------------------------------------------------------------
// layout, persistence, lifecycle
// ---------------------------------------------------------------------------

function fitActive() {
  setTimeout(() => {
    const t = activeTab();
    if (t) {
      try {
        t.fit.fit();
      } catch (_) { /* ignore */ }
    }
    if (viewerTerm && viewerFit) viewerFit.fit();
  });
}
new ResizeObserver(fitActive).observe($('#terminals'));

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 300);
}
function saveStateNow() {
  clearTimeout(saveTimer);
  // Tabs that were never activated have no record yet; keep them as agent + folder.
  const tabs = state.tabs.map((t) =>
    t.record ? { recordId: t.record.id, agent: t.agent, chain: t.chain } : { agent: t.agent, cwd: t.cwd, mode: t.mode, accountId: t.accountId }
  );
  const activeIndex = Math.max(0, state.tabs.findIndex((t) => t.id === state.activeId));
  return ipc.saveState({ tabs, activeIndex }).catch(() => {});
}

ipc.onData(({ tabId, data }) => {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.term.write(data);
  tab.dirty = true;
  if (tab.id !== state.activeId && !tab.activity) {
    tab.activity = true;
    if (tab.node) tab.node.classList.add('activity');
  }
});

ipc.onExit(({ tabId, exitCode, record }) => {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.running = false;
  tab.exitCode = exitCode;
  if (record) tab.record = record;
  snapshot(tab, true);
  tab.term.write(`\r\n\x1b[2m[${agentLabel(tab.agent)} exited with code ${exitCode}]\x1b[0m\r\n`);
  const bar = el(
    'div',
    { class: 'exit-bar' },
    el('span', {}, `Exited (${exitCode}).`),
    el('button', { class: 'primary-btn', onclick: () => restartTab(tab) }, tab.agent === 'shell' ? 'Restart' : 'Resume  ⏎'),
    el('button', { class: 'small-btn', onclick: () => closeTab(tab.id) }, 'Close')
  );
  tab.exitBar = bar;
  tab.host.append(bar);
  renderTabs();
  renderStatus();
  renderHistory();
});

ipc.onPrompt(({ tabId, recordId }) => {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (tab && tab.record && tab.record.id === recordId) tab.record.prompts = (tab.record.prompts || 0) + 1;
  if (state.historyScope !== 'tab' || tabId === state.activeId) renderHistory();
});

// The tab's conversation was identified, renamed, or the agent moved on to another one.
ipc.onSessionUpdate(({ tabId, record, previousId, replacedId, at }) => {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (tab && record) {
    tab.record = record;
    if (replacedId) {
      // A placeholder record was folded into this one.
      tab.chain = tab.chain.map((id) => (id === replacedId ? record.id : id));
    } else if (previousId) {
      // A new or older conversation in this tab: its transcript starts at the Enter
      // that began it. The previous conversation's text was saved on that Enter.
      const mark = tab.enterMarks.filter((m) => m.t <= (at || Date.now()) + 1000).pop();
      setSnapMarker(tab, mark ? mark.marker : tab.term.registerMarker(0));
      tab.lastSnap = null;
      tab.dirty = true;
    }
    tab.chain = [...new Set([...tab.chain.filter((id) => id !== record.id), record.id])];
  }
  renderTabs();
  renderStatus();
  renderHistory();
  saveState();
});

// Claude's own busy / idle, read from its pid file.
ipc.onStatus(({ tabId, status }) => {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.status = status;
  renderTabs();
});

ipc.onNotice((msg) => toast(msg));

ipc.onBeforeClose(async () => {
  try {
    await Promise.race([
      Promise.all([...state.tabs.map((t) => snapshot(t, true)), saveStateNow()]),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } finally {
    ipc.closedOk();
  }
});

// Periodic snapshots so a crash or power loss still leaves a readable transcript.
setInterval(() => {
  for (const t of state.tabs) if (t.dirty && Date.now() - t.lastSnapshot > 30000) snapshot(t, false);
}, 10000);
setInterval(() => renderHistory(), 60000);

async function boot() {
  const init = await ipc.init();
  state.settings = init.settings;
  state.workspace = init.workspace;
  state.userData = init.userData;
  for (const a of init.agents) state.agents[a.id] = a;
  renderEmptyActions();

  // First start: Setup comes first, and the startup tabs open once it is done.
  if (!state.settings.setupDone) {
    renderTabs();
    renderStatus();
    return openSetup({ first: true });
  }

  if (init.restore.length) {
    init.restore.forEach((t) =>
      createTab({
        agent: t.agent,
        cwd: t.record ? t.record.cwd : t.cwd,
        record: t.record,
        chain: t.chain,
        mode: t.record ? 'resume' : t.mode || 'new',
        accountId: t.record ? null : t.accountId,
        activate: false,
      })
    );
    const idx = Math.min(init.activeIndex || 0, state.tabs.length - 1);
    activateTab(state.tabs[idx].id);
  } else {
    openStartupTabs();
  }
  renderTabs();
  renderStatus();
  const ws = state.workspace;
  if (!ws || !ws.roots || !ws.roots.length) toast('No workspace folder set. Click "workspace" in the status bar to choose one.');
  else if (ws.missing && ws.missing.length) toast(`Workspace folder not found: ${ws.missing[0]}`);
}

function openStartupTabs() {
  const startup = (state.settings.startupTabs || []).filter((a) => enabledAgents().includes(a) && state.agents[a] && state.agents[a].available);
  startup.forEach((a, i) => createTab({ agent: a, cwd: defaultCwd(), activate: i === 0 }));
}

function renderEmptyActions() {
  const empty = $('#empty-actions');
  empty.replaceChildren(
    ...enabledAgents().map((a) => el('button', { class: 'small-btn', onclick: () => createTab({ agent: a, cwd: defaultCwd() }) }, `New ${agentLabel(a)}`)),
    el('button', { class: 'small-btn', onclick: () => openSetup() }, 'Workspaces & agents…')
  );
}

boot().catch((err) => {
  document.body.append(el('pre', { style: 'position:fixed;inset:60px 20px auto;color:#ef6b6b;white-space:pre-wrap' }, err.stack || String(err)));
});
