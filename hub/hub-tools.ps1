# Shared by the launcher, the picker and the tests.
#
# The hub keeps no settings or state of its own. It reads NI Agent Terminal's settings.json
# (backend, enabled agents, Claude accounts, workspace folders) and runs the same engine
# (..\src\py) on the same data folder, so both tools show the same conversations, handoffs,
# hidden list and accounts. Set things up in the terminal's Setup.

$hubDataDir = if ($env:NI_TERM_USERDATA) { $env:NI_TERM_USERDATA } else { Join-Path $env:APPDATA 'NI Agent Terminal' }
$hubEngineDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\py'
$hubTools = 'codex', 'claude', 'opencode'

function Get-HubSettings {
    $file = Join-Path $hubDataDir 'settings.json'
    if (-not (Test-Path -LiteralPath $file)) { throw "NI Agent Terminal is not set up yet: $file was not found. Start it once and finish Setup; the hub uses its settings." }
    Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
}

# Git for Windows' folder, whose bash runs the helper scripts on the windows backend: in
# Program Files, or wherever the git.exe on PATH lives (a per-user install).
function Get-HubGitRoot {
    $root = Join-Path $env:ProgramFiles 'Git'
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $root 'bin\bash.exe')) -and $git) { $root = Split-Path (Split-Path $git.Source) }
    if (-not (Test-Path (Join-Path $root 'bin\bash.exe'))) { throw 'The windows backend needs Git for Windows (its bash runs the helper scripts); git.exe was not found.' }
    $root
}

# 'windows', or the WSL distro the agents run in.
function Get-HubBackend($settings) {
    if ("$($settings.backend)" -match '^wsl:(.+)$') { [pscustomobject]@{ Kind = 'wsl'; Distro = $Matches[1]; Scope = "wsl-$($Matches[1])" } }
    else { [pscustomobject]@{ Kind = 'windows'; Distro = $null; Scope = 'windows' } }
}

function Get-HubRequestedTools($settings) {
    @($hubTools | Where-Object { $settings.agents.$_.enabled })
}

# CLI discovery. Native tools must be resolved after the PowerShell profile initializes
# version managers; Git Bash's PATH can differ from that environment. start-hub publishes
# the result in AGENT_HUB_AVAILABLE_TOOLS, which Windows Terminal passes to the picker tab,
# so only a standalone picker probes itself.
function Get-HubAvailableTools($backend) {
    if ($null -ne $env:AGENT_HUB_AVAILABLE_TOOLS) { return @($env:AGENT_HUB_AVAILABLE_TOOLS -split ',' | Where-Object { $_ }) }
    if ($backend.Kind -eq 'windows') {
        $shell = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { 'pwsh.exe' } else { 'powershell.exe' }
        $probe = "'codex','claude','opencode' | ForEach-Object { if (Get-Command `$_ -ErrorAction SilentlyContinue) { Write-Output ('HUB_TOOL:' + `$_) } }; 'HUB_PROBE_OK'"
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
        $output = @(& $shell -NoLogo -NonInteractive -EncodedCommand $encoded)
    } else {
        $output = @(& wsl.exe -d $backend.Distro --exec bash -lic 'for tool in codex claude opencode; do command -v "$tool" >/dev/null 2>&1 && echo HUB_TOOL:$tool; done; echo HUB_PROBE_OK')
    }
    # Without the marker the probe itself broke; failing beats hiding every tool.
    if ('HUB_PROBE_OK' -notin @($output | ForEach-Object { "$_".Trim() })) { throw "CLI probe failed in the $($backend.Scope) backend; output: $($output -join ' | ')" }
    @($output | ForEach-Object { if ("$_" -match '^HUB_TOOL:(codex|claude|opencode)$') { $Matches[1] } })
}

# Claude accounts as the terminal's Setup lists them: logins that share one session history
# (Setup's Link accounts). Dir is the account's CLAUDE_CONFIG_DIR in the backend; the normal
# login has none and runs with the variable unset.
function Get-HubClaudeAccounts($settings) {
    @(foreach ($account in @($settings.agents.claude.accounts)) {
        [pscustomobject]@{ Id = $account.id; Name = $account.name; Dir = "$($account.configDir)"; Color = Get-HubClaudeAccountColor $account.name }
    })
}

# Tab and prompt color from the account name: the hue is a hash of it, so an account keeps
# its color whatever the order accounts are listed in. Saturation and brightness are fixed
# and calm. Claude Code may retitle a tab; its color stays.
function Get-HubClaudeAccountColor([string]$key) {
    $hash = [Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($key.ToLowerInvariant()))
    $hue = [BitConverter]::ToUInt32($hash, 0) % 360
    $saturation = 0.45; $value = 0.78
    # HSV to RGB
    $chroma = $value * $saturation
    $x = $chroma * (1 - [Math]::Abs(($hue / 60) % 2 - 1))
    $r, $g, $b = switch ([Math]::Floor($hue / 60)) {
        0 { $chroma, $x, 0 }  1 { $x, $chroma, 0 }  2 { 0, $chroma, $x }
        3 { 0, $x, $chroma }  4 { $x, 0, $chroma }  5 { $chroma, 0, $x }
    }
    '#{0:X2}{1:X2}{2:X2}' -f ($r, $g, $b | ForEach-Object { [int][Math]::Round(($_ + $value - $chroma) * 255) })
}

# Where Alt-T can take a conversation. Its own tool leads as "Open (...)": for Claude with
# several accounts that is the account it last ran with ($accountId), followed by the other
# accounts (the same conversation under another login). Other tools are handoffs.
function Get-HubTransferTargets([string]$currentTool, [string[]]$enabledTools, $accounts, [string]$accountId) {
    $targets = @(foreach ($tool in @($currentTool) + @($enabledTools | Where-Object { $_ -ne $currentTool })) {
        if ($tool -eq 'claude' -and $tool -eq $currentTool -and @($accounts).Count -gt 1) {
            foreach ($account in @($accounts | Where-Object { $_.Id -eq $accountId }) + @($accounts | Where-Object { $_.Id -ne $accountId })) {
                [pscustomobject]@{ Label = "claude - $($account.Name)"; Tool = $tool; Account = $account }
            }
            continue
        }
        [pscustomobject]@{ Label = $tool; Tool = $tool; Account = $null }
    })
    $targets[0].Label = "Open ($($targets[0].Label))"
    $targets
}

# One choice out of labelled rows, in the picker's own fzf with its mouse bindings. Rows
# carry numeric ids, so labels never become shell commands or selection keys. $null = cancelled.
function Select-HubRow([string[]]$labels, [string]$prompt) {
    $listWin = Join-Path $tmpWin 'choice.txt'
    $pickWin = Join-Path $tmpWin 'choice-pick.txt'
    $shWin = Join-Path $tmpWin 'choice.sh'
    [IO.File]::WriteAllLines($listWin, [string[]]@(for ($i = 0; $i -lt $labels.Count; $i++) { "$($labels[$i])`t$i" }))
    $sh = @"
#!/bin/bash
tr -d '\r' < "`$1" | "$fzfPath" \
    --with-nth=1 --delimiter=`$'\t' --no-multi --no-sort --reverse \
$clickBinds
    --prompt="`$3> " --header='enter: choose | esc: cancel' > "`$2"
"@ -replace "`r`n", "`n"
    [IO.File]::WriteAllText($shWin, $sh)
    Remove-Item -LiteralPath $pickWin -ErrorAction SilentlyContinue
    Invoke-Bash (ConvertTo-WslPath $shWin) (ConvertTo-WslPath $listWin) (ConvertTo-WslPath $pickWin) $prompt
    $picked = @(if (Test-Path -LiteralPath $pickWin) { Get-Content -LiteralPath $pickWin -Encoding UTF8 | Where-Object { $_ } })
    if ($picked) { [int](($picked[0] -split "`t")[1]) }
}

function Select-HubTransferTarget([string]$currentTool, [string[]]$enabledTools, $accounts, [string]$accountId) {
    $targets = @(Get-HubTransferTargets $currentTool $enabledTools $accounts $accountId)
    $index = Select-HubRow @($targets.Label) 'Open with'
    if ($null -ne $index) { $targets[$index] }
}

# The account for a new Claude chat: asked when there are several. $false = cancelled.
function Select-HubNewAccount($accounts) {
    if (@($accounts).Count -le 1) { return @($accounts)[0] }
    $index = Select-HubRow @($accounts.Name) 'New Claude chat: which account?'
    if ($null -eq $index) { $false } else { $accounts[$index] }
}

# The first account must run with CLAUDE_CONFIG_DIR unset: its account file is ~/.claude.json,
# which Claude Code only reads when the variable is absent (a set value moves it into the dir).
function New-HubClaudeCommand($command, $account) {
    if (-not $account -or -not $account.Dir) {
        if ($backend -eq 'windows') { return "Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; " + $command }
        return "unset CLAUDE_CONFIG_DIR; " + $command
    }
    # Escape for the destination shell; wt.exe receives this whole command as one argument.
    if ($backend -eq 'windows') { return "`$env:CLAUDE_CONFIG_DIR = '" + $account.Dir.Replace("'", "''") + "'; " + $command }
    "export CLAUDE_CONFIG_DIR='" + $account.Dir.Replace("'", "'\''") + "'; " + $command
}

# A conversation the hub opened under another account than the one it last ran with. The
# engine reads these when deciding the account to resume under; the running terminal owns
# history\index.json, so the hub appends here instead.
function Add-HubLaunch([string]$key, [string]$accountId) {
    $file = Join-Path $hubDataDir 'history\launches.jsonl'
    [void][IO.Directory]::CreateDirectory((Split-Path $file))
    $entry = @{ key = $key; accountId = $accountId; t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($file, "$entry`n", (New-Object System.Text.UTF8Encoding($false)))
}
