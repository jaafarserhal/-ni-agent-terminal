# NI Agent Terminal

A Windows multi-tab terminal for **Claude Code**, **Codex**, **Cursor Agent** and **OpenCode** (plus a shell tab), run natively or inside WSL, that works in any folders you choose. Every conversation is recorded in a per-folder, per-agent history and can be resumed exactly through the agent's own session store.

## Run

- `distNI-Agent-Terminal-1.2.1-portable.exe`: single file, no install.
- `distNI-Agent-Terminal-1.2.1-setup.exe`: per-user installer with Start menu entry.

## Setup

On first start a Setup screen asks for:

- **Workspace folders**: any number of folders (a monorepo, a folder of checkouts, a single project…). New tabs open in the first one. Every Git repository inside them, up to two levels down (`<folder>/<repo>` or `<folder>/repos/<repo>`), is listed with its current branch in the new-tab folder picker and in History's *Folder* view, and so is a folder in between that holds repositories (`<folder>/repos`).
- **Agents**, each of them:
  - **On / off**: switched-off agents are hidden from menus and shortcuts.
  - **Command**: a name on `PATH` (default `claude`, `codex`, `cursor-agent`, `powershell.exe`) or a full path to an `.exe` / `.cmd`. Setup shows where each resolves. `%APPDATA%
pm`, `%LOCALAPPDATA%cursor-agent` and `~/.local/bin` are searched as well.
  - **Accounts**: one or more logins per agent, e.g. *Personal* and *Work*. A new chat asks which one to use. See [Accounts](#accounts).

Change all of this later in **Settings → Workspaces & agents**, or click *workspace* in the status bar. If you upgrade from 1.1, the old `ni-agentic-development` folder is carried over as the first workspace folder, and Setup is shown once.

Every tab gets `AGENT_TERMINAL_WORKSPACE=<workspace folder>` and `AGENT_TERMINAL_SESSION=<history id>`. The 1.x names `NI_WORKSPACE` / `NI_AGENT_TERMINAL_SESSION` are still set too. Agent session markers inherited from a parent agent (`CLAUDECODE`, `CLAUDE_CODE_*`, `CODEX_SANDBOX*`, …) are stripped. Otherwise a tab opened from an app started inside Claude Code would run as a child session with transcripts disabled.

## History

Saved per working folder, then per agent, in `%APPDATA%\NI Agent Terminal\history\`:

| File | Content |
|---|---|
| `index.json` | One record per conversation: agent, folder, native session id, title, runs, timestamps |
| `folders\<folder>\folder.json` | The folder's full path (`<folder>` is its name plus a short hash, e.g. `FRAMEWORK-1a2b3c4d`) |
| `folders\<folder>\<agent>\<id>.log` | Raw terminal output of every run (ANSI kept, used by *Replay*), capped at 25 MB |
| `folders\<folder>\<agent>\<id>.txt` | Plain-text transcript, saved on every Enter, every 30 s, on exit and on close; runs are appended |
| `folders\<folder>\<agent>\<id>.prompts.jsonl` | Prompts / commands sent in that conversation, one `{t, text}` per line |

History from 1.0 (flat `<agent>\` folders) is moved into this layout on first start; the old index is kept as `index.v1.bak.json`.

**One record per conversation, not per tab.** Running `/clear` or `/new` in a tab starts a new conversation, and `/resume` switches to another one. The tab follows the switch: the new conversation gets its own record, and the old one stays in History, resumable. A conversation where nothing but slash commands was sent is reused instead of kept.
- Claude: read exactly from Claude's per-process file `~/.claude/sessions/<pid>.json`. Claude also gets its id up front (`--session-id`).
- Codex (`~/.codex/sessions/**/rollout-*.jsonl`) and Cursor (`~/.cursor/chats/*/<id>/meta.json`): a conversation that appears in the tab's folder is matched to the tab in which Enter was just pressed.

Resuming a record runs `claude --resume <id>`, `codex resume <id>` or `cursor-agent --resume <id>`. Titles come from the agents: Claude's AI or custom title, Codex's thread name (`~/.codex/session_index.jsonl`), Cursor's chat title. The *Last* and *Pick…* buttons in the new-tab menu use each agent's own continue/picker. If the conversation picked is already in History, the tab joins that record.

**History panel** (Ctrl+Shift+H):
- *This tab*: every conversation the tab went through (current one marked), then every prompt or command sent from it, newest first, across restarts, resumes and `/clear`. It has search and *Copy all*. Click a prompt to insert it, double-click or ⏎ to send it again. The line is rebuilt from your keystrokes (typing, paste, arrows, Backspace, Ctrl+W/U/K, Shift+Enter). Some lines are skipped: a single-key menu answer in an agent tab, and an agent prompt recalled with Up/Down. In a shell tab, a recalled or Tab-completed line is read back from the screen.
- *Folder*: the sessions started in one folder, which defaults to the active tab's. Pick another folder from the list (workspace folders, the Git repositories in them, any folder with history) and filter by agent. *Import N* appears when an agent's own store has conversations for that folder that History has none for: started outside the app, or lost before 1.1. Imported ones resume like any other.
- *All*: every session in every folder, filterable by agent.

*Files* opens the history folder on disk (the selected folder's, in the *Folder* view).

Open tabs are saved on close and resumed on the next start. A tab only starts its agent when it is first shown.

## Accounts

Each of Claude, Codex and Cursor can have several accounts (Setup → *Accounts* → *Add account*):

- **Claude, Codex**: each account is a config folder, passed as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, with its own login and conversation store. An empty folder is your normal login. *Add account* proposes `~/.claude-2` / `~/.codex-2`; sign in once in a tab of that account.
- **Cursor**: Cursor Agent has a single config folder, so each account is an API key (`CURSOR_API_KEY`, from the Cursor dashboard → Integrations). An account with no key is your normal login. Keys are encrypted for your Windows user (DPAPI) and never shown again.

Once an agent has more than one account, its tabs show the account name, and a new chat asks which account to use. Resuming a conversation never asks: it runs under the account it last ran with.

**Switching a tab's account** (Ctrl+Shift+A cycles; or click the account in the status bar; or the tab's right-click menu): the agent is stopped, the conversation is copied into the other account's store (nothing to copy when the accounts are linked, see [Agents view and WSL](#agents-view-and-wsl)), and it resumes there. Use it to carry on in the same conversation after one account hits its usage limit.

Each history record remembers its account, so resuming it and following its `/clear` / `/new` keep using the right store. A 1.2 *Account folder* is carried over as a second account.

## Agents view and WSL

**Where agents run** (Setup): Windows, or a WSL distro. In WSL each tab runs the CLI installed inside the distro in its login shell, in the tab's folder as WSL sees it (`C:\G\code` is `/mnt/c/G/code`), and the agents' stores are read over `\\wsl$`. Account folders are WSL paths (`~/.claude-2`). Each history record keeps where it ran, so it always resumes there.

Claude and Codex tabs keep their output in the terminal's own buffer (Claude's classic TUI through `--settings`, Codex's `-c tui.fullscreen_transcript=false`), for that launch only: scrollback, find, mouse selection and transcripts work whatever their full-screen settings are.

With **Python 3** (with SQLite) in the backend:
- *History → All* lists every conversation once: this app's own, and every Claude, Codex and OpenCode conversation in the agents' own stores from the last 40 days (Settings), wherever it was started. Conversations joined by a handoff are one entry, under the agent used last. Click previews the last turns; double-click resumes it in that agent, under the account it last ran with. Right-click: open under another Claude account, *Continue in* another agent (a handoff file with only the messages and tool notes it has not seen, kept in `handoffs\`), the saved transcript, hide or show again (*Hidden*). Ctrl+click marks entries; *Combine into…* hands them all to one agent. Without Python, All lists this app's own conversations only.
- *Live* (title bar): a board of running sessions, in or outside the app, with their state, model, last action, subagents and (WSL) shells. A Claude tab's dot pulses while Claude is working.
- *Link accounts* (Setup → Claude): every `~/.claude-<n>` login shares `~/.claude`'s history, keeping its own login, and conversations are labelled with their login. *New linked account* creates the next one. On Windows this needs Git for Windows and Developer Mode (symlinks).
- Each agent's history is snapshotted once a day into `backups\<tool>` (the newest ten kept).

## Keys

| Key | Action |
|---|---|
| Ctrl+Shift+T | New tab menu (folder, agent, Last / Pick…) |
| Ctrl+Shift+1 / 2 / 3 / 4 / 5 | New Claude / Codex / Cursor / Shell / OpenCode in the current tab's folder |
| Ctrl+Tab, Ctrl+PgUp/PgDn | Switch tabs (tabs can also be dragged) |
| Ctrl+Shift+W, middle-click | Close tab |
| Ctrl+Shift+H | History panel (*This tab* prompts / *All sessions*) |
| Ctrl+Shift+A | Switch the tab to the agent's next account |
| Ctrl+Shift+F | Find in terminal |
| Ctrl+Shift+Home / End | Scroll to the beginning / end of the terminal buffer |
| Shift+PgUp / PgDn | Scroll up / down one page |
| Ctrl+C with selection, Ctrl+Shift+C | Copy (or on selection, Settings); an agent's own copy (OSC 52, e.g. Claude's `/copy`) also reaches the clipboard |
| Ctrl+V, right-click | Paste (an image-only clipboard is passed to the agent; in WSL, agents other than Claude get a saved PNG's path) |
| Shift+Enter, Ctrl+Enter | Newline in the agent prompt |
| Ctrl+= / Ctrl+- / Ctrl+0 | Font size |
| Enter on an exited tab | Resume it |

Dropping files on a terminal inserts their quoted paths.

Web links are drawn in the theme's blue in every tab, whatever printed them; clicking one opens it in the browser.

## Develop

```powershell
npm install
npm start               # run from source
npm run shortcut        # Start menu shortcut to run this checkout (pin it to Start or the taskbar)
npm run check           # syntax check
npm test                # src/py tests (Python 3)
npm run dist            # portable + installer exe into dist\
```

After changing window code (`renderer.js`, `index.html`, `styles.css`), click the app icon in the top-left corner: the window reloads on it while tabs stay open and their agents keep running. Code of the main process loads when the app is restarted.

Smoke testing: `NI_TERM_USERDATA` uses an isolated data folder. `NI_TERM_SMOKE=<png>` takes a screenshot and quits after `NI_TERM_SMOKE_DELAY` ms. `NI_TERM_SMOKE_JS` runs a script in the window halfway through.

Build note: without Windows Developer Mode, electron-builder fails to unpack `winCodeSign` (macOS symlinks). Extract it once without the `darwin` folder:

```powershell
$c = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
& .\node_modules\7zip-bin\win\x64\7za.exe x -y "-o$c\winCodeSign-2.6.0" (Get-ChildItem $c -Filter *.7z)[0].FullName '-xr!darwin'
```

Stack: Electron 33, xterm.js 5.5, node-pty 1.1 (ConPTY, N-API prebuilds, so no native rebuild), electron-builder 25.

## License

MIT, see [LICENSE](LICENSE).
