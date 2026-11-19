'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, arg) {
  const res = await ipcRenderer.invoke(channel, arg);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

function on(channel, fn) {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  init: () => call('app:init'),
  devtools: () => call('app:devtools'),
  closedOk: () => ipcRenderer.send('app:closed-ok'),
  onBeforeClose: (fn) => on('app:before-close', fn),
  onNotice: (fn) => on('app:notice', fn),

  start: (opts) => call('pty:start', opts),
  kill: (tabId) => call('pty:kill', tabId),
  switchAccount: (opts) => call('pty:switchAccount', opts),
  write: (tabId, data) => ipcRenderer.send('pty:write', { tabId, data }),
  resize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  onData: (fn) => on('pty:data', fn),
  onExit: (fn) => on('pty:exit', fn),
  onSessionUpdate: (fn) => on('session:update', fn),
  onStatus: (fn) => on('session:status', fn),
  dropText: (tabId, paths) => call('pty:dropText', { tabId, paths }),

  historyList: (filter) => call('history:list', filter),
  historyFolders: () => call('history:folders'),
  historyGet: (ids) => call('history:get', ids),
  historyImportable: (cwd) => call('history:importable', cwd),
  historyImport: (cwd) => call('history:import', cwd),
  historyRead: (id) => call('history:read', id),
  historyDelete: (id) => call('history:delete', id),
  historyRename: (id, title) => call('history:rename', { id, title }),
  historyPrompts: (ids) => call('history:prompts', ids),
  addPrompt: (tabId, text) => ipcRenderer.send('history:addPrompt', { tabId, text }),
  onPrompt: (fn) => on('history:prompt', fn),
  historySnapshot: (id, text, cleared) => call('history:snapshot', { id, text, cleared: !!cleared }),
  historyOpenFolder: (arg) => call('history:openFolder', arg),
  historyExport: (id) => call('history:export', id),

  saveSettings: (patch) => call('settings:save', patch),
  setupInfo: () => call('setup:info'),
  setupLocate: (backend, commands) => call('setup:locate', { backend, commands }),
  setupDescribe: (roots) => call('setup:describe', roots),
  pickFolder: (opts) => call('workspace:pickFolder', opts),
  pickFile: (opts) => call('dialog:pickFile', opts),
  refreshWorkspace: () => call('workspace:refresh'),
  saveState: (state) => call('state:save', state),
  openPath: (p) => call('shell:openPath', p),
  openExternal: (url) => call('shell:openExternal', url),

  storesList: (hiddenOnly) => call('stores:list', { hiddenOnly }),
  storesPreview: (tool, id) => call('stores:preview', { tool, id }),
  storesHide: (keys, hidden) => call('stores:hide', { keys, hidden }),
  storesBoard: () => call('stores:board'),
  storesOpen: (opts) => call('stores:open', opts),
  storesPlan: (request) => call('stores:plan', request),
  storesHandoff: (opts) => call('stores:handoff', opts),
  storesClaudeAccounts: (opts) => call('stores:claudeAccounts', opts),

  pathForFile: (file) => webUtils.getPathForFile(file),
  clipboardRead: () => call('clipboard:read'),
  clipboardWrite: (text) => call('clipboard:write', text),
  clipboardImagePath: (tabId) => call('clipboard:imagePath', tabId),
});
