# Engine calls and handoff launches for the picker. Native sessions are read by
# ..\src\py\handoff_sync.py, never rewritten.
$syncRunnerWin = Join-Path $tmpWin 'sync-python.sh'
$syncRunnerWsl = "$tmpWsl/sync-python.sh"
$syncRunner = @'
#!/bin/bash
for p in python3 python; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; assert sys.version_info >= (3, 8)' 2>/dev/null; then
        # Native Python cannot open /c/... paths when MSYS declines conversion
        # (notably apostrophes in a clone path). These arguments are all file paths.
        case "$OSTYPE" in
            msys*|cygwin*)
                paths=()
                for path in "$@"; do paths+=("$(cygpath -w "$path")"); done
                set -- "${paths[@]}" ;;
        esac
        exec "$p" "$@"
    fi
done
echo 'Python 3.8 or newer is required for conversation synchronization.' >&2
exit 127
'@ -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($syncRunnerWin, $syncRunner)
$syncEngineWsl = ConvertTo-WslPath (Join-Path $hubEngineDir 'handoff_sync.py')

# Runs the engine ('list', 'hide', or $null to plan a transfer) and returns its JSON result.
# The engine gets the agents' stores and the terminal's data folder with the backend; from
# those it derives what both tools share: the ledger, the hidden list, each conversation's account.
function Invoke-HubEngine($mode, $request) {
    $request += @{
        codex_root = $stores.codex; claude_root = $stores.claude; opencode_db = $stores.opencode
        data_dir = ConvertTo-WslPath $hubDataDir; scope = $hubBackend.Scope
    }
    $requestWin = Join-Path $tmpWin 'sync-request.json'
    $resultWin = Join-Path $tmpWin 'sync-result.json'
    [System.IO.File]::WriteAllText($requestWin, ($request | ConvertTo-Json -Depth 8))
    Remove-Item $resultWin -ErrorAction SilentlyContinue
    $modeArgs = @(if ($mode) { $mode })
    Invoke-Bash $syncRunnerWsl $syncEngineWsl @modeArgs (ConvertTo-WslPath $requestWin) (ConvertTo-WslPath $resultWin) | Out-Host
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $resultWin)) { throw 'The conversation engine failed; nothing was launched.' }
    $result = Get-Content $resultWin -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($result.status -eq 'error') { throw $result.message }
    $result
}

$syncLaunchWin = Join-Path $tmpWin 'sync-launch.sh'
$syncLaunchWsl = "$tmpWsl/sync-launch.sh"
$syncLaunch = @'
#!/bin/bash
# $1 = target tool, $2 = file holding the handoff prompt ('-' for a plain resume), $3 = native
# session id ('-' for a new one), $4 = Claude config directory ('-' = first account, run with
# it unset). '-' preserves empty positions through Windows PowerShell 5's native argument
# marshalling, which drops empty strings. The prompt travels in a file: it holds backticks
# and a path, which must not pass through wt.exe and two shells.
prompt=
[ "$2" = '-' ] || prompt=$(cat "$2")
[ "$3" = '-' ] && set -- "$1" "$2" "" "$4"
case "$1" in
    codex)
        if [ -n "$3" ]; then
            if [ -n "$prompt" ]; then exec codex -c tui.fullscreen_transcript=false resume "$3" "$prompt"; fi
            exec codex -c tui.fullscreen_transcript=false resume "$3"
        fi
        exec codex -c tui.fullscreen_transcript=false "$prompt" ;;
    claude)
        if [ "$4" = '-' ] || [ -z "$4" ]; then unset CLAUDE_CONFIG_DIR; else export CLAUDE_CONFIG_DIR="$4"; fi
        if [ -n "$3" ]; then
            if [ -n "$prompt" ]; then exec claude --resume "$3" "$prompt"; fi
            exec claude --resume "$3"
        fi
        exec claude "$prompt" ;;
    opencode)
        if [ -n "$3" ]; then
            if [ -n "$prompt" ]; then exec opencode --session "$3" --prompt "$prompt"; fi
            exec opencode --session "$3"
        fi
        exec opencode --prompt "$prompt" ;;
    *) echo "Unknown tool: $1" >&2; exit 1 ;;
esac
'@ -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($syncLaunchWin, $syncLaunch)

# Hands the picked conversations to $tool: only what the destination has not seen goes into
# a handoff file, which its first message (the engine's prompt) tells it to read. A linked
# destination is resumed, under the account it last ran with; a new Claude one asks for the account.
function Invoke-HubTransfer($tool, $items, $cwd) {
    try {
        if ($tool -notin $availableTools) { throw "$tool is unavailable in the $backend backend. Install it before transferring a conversation." }
        $request = @{ sources = @($items | ForEach-Object { "$($_.Tool):$($_.Id)" }); tool = $tool; preview = $true }
        Write-Host 'Checking conversation synchronization...'
        $plan = Invoke-HubEngine $null $request
        if ($plan.status -eq 'choose') {
            # Only real branches require a choice; one known destination resumes automatically.
            # The planner lists them most recently modified first.
            $labels = @($plan.candidates | ForEach-Object { ("{0}  {1} - {2} [{3}]" -f $_.updated, $_.title, $_.cwd, $_.id) -replace '[\r\n\t]', ' ' }) + '+ start a separate branch'
            $index = Select-HubRow $labels "continue in $tool"
            if ($null -eq $index) { return }
            $request.target = if ($index -lt @($plan.candidates).Count) { @($plan.candidates)[$index].key } else { '__NEW__' }
            $plan = Invoke-HubEngine $null $request
        }
        $account = $null
        if ($plan.status -eq 'preview') {
            if (-not $plan.target -and $items.Count -gt 1) {
                $cwd = Select-CombinedCwd $items
                if (-not $cwd) { return }
            }
            if ($tool -eq 'claude' -and -not $plan.target) {
                $account = Select-HubNewAccount $claudeAccounts
                if ($account -eq $false) { return }
            }
            $request.preview = $false
            $plan = Invoke-HubEngine $null $request
        }
        if ($plan.status -eq 'pending') {
            Write-Host "$($plan.message) No new context has been marked as delivered."
            if ($plan.age -lt 30) { Start-Sleep -Milliseconds 1200; return }
            $answer = Read-Host 'Retry the previous launch? This may open another tab if it is still running. [y/N]'
            if ($answer -ne 'y') { return }
            $request.retry = $true
            $plan = Invoke-HubEngine $null $request
        }
        if ($plan.status -ne 'ready') { throw "Unexpected synchronization status: $($plan.status)" }
        if ($plan.legacy -and $plan.handoff) { Write-Host 'This destination predates exact tracking; its first synchronization may repeat older material.' }
        $resumeId = '-'
        if ($plan.target) {
            $resumeId = $plan.target.id
            $cwd = $plan.target.cwd
            if ($tool -eq 'claude') { $account = @($claudeAccounts | Where-Object { $_.Id -eq $plan.target.accountId })[0] }
        }
        $title = "$($plan.title)" -replace '[\r\n\]"]', ' '   # '"' would break native argument passing to wt.exe
        $configDir = if ($account -and $account.Dir) { $account.Dir } else { '-' }
        if ($backend -eq 'windows') {
            # Run the CLI in the destination PowerShell profile, just like normal
            # Windows launches. Keep prompts and IDs out of native shell quoting.
            $launchData = @{ tool = $tool; configDir = $(if ($configDir -ne '-') { $configDir }); prompt = $plan.prompt; resume = $resumeId }
            $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($launchData | ConvertTo-Json -Compress)))
            $nativeLaunchWin = Join-Path $tmpWin ("sync-launch-{0}.ps1" -f [Guid]::NewGuid().ToString('N'))
            $nativeLaunch = @'
$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$cliArgs = @()
if ($data.tool -eq 'claude') {
    if ($data.configDir) { $env:CLAUDE_CONFIG_DIR = $data.configDir } else { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
}
if ($data.tool -eq 'codex') { $cliArgs += @('-c', 'tui.fullscreen_transcript=false') }
if ($data.resume -ne '-') {
    switch ($data.tool) {
        codex { $cliArgs += @('resume', $data.resume) }
        claude { $cliArgs += @('--resume', $data.resume) }
        opencode { $cliArgs += @('--session', $data.resume) }
    }
}
if ($data.prompt) {
    if ($data.tool -eq 'opencode') { $cliArgs += '--prompt' }
    $cliArgs += $data.prompt
}
& $data.tool @cliArgs
'@
            [IO.File]::WriteAllText($nativeLaunchWin, $nativeLaunch.Replace('__PAYLOAD__', $payload))
            $command = "& '" + $nativeLaunchWin.Replace("'", "''") + "'"
        } else {
            $promptArg = '-'
            if ($plan.prompt) {
                $promptWin = Join-Path $tmpWin ("sync-prompt-{0}.txt" -f [Guid]::NewGuid().ToString('N'))
                [IO.File]::WriteAllText($promptWin, $plan.prompt)
                $promptArg = ConvertTo-WslPath $promptWin
            }
            $command = New-BashCommand @($syncLaunchWsl, $tool, $promptArg, $resumeId, $configDir)
        }
        Write-Host $(if ($plan.handoff) { "Continuing with $($plan.count) new messages/tool notes." } else { 'Already synchronized; resuming without adding a prompt.' })
        Open-WtTab "${tool}: $title" $cwd $command $account.Color
    } catch {
        Write-Host "Conversation transfer stopped: $($_.Exception.Message)" -ForegroundColor Red
        Start-Sleep -Milliseconds 1800
    }
}
