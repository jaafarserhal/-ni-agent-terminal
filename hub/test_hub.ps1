# Checks the hub's logic without the picker, Windows Terminal or an agent CLI: settings,
# destinations, and (with Git for Windows and Python) the engine boundary on stand-in
# conversations in a throwaway data folder: listing, hiding, handoff launches, accounts.
$ErrorActionPreference = 'Stop'
function Assert-True($condition, $message) { if (-not $condition) { throw $message } }
$root = Join-Path $env:TEMP ("hub-check-$PID with space")
$oldData = $env:NI_TERM_USERDATA
$oldClaude = $env:CLAUDE_CONFIG_DIR
try {
    $homeWin = Join-Path $root 'home'
    $claudeWin = Join-Path $homeWin '.claude\projects\p'
    $codexWin = Join-Path $homeWin '.codex\sessions'
    $otherWin = Join-Path $homeWin '.claude-2'
    $tmpWin = Join-Path $root 'tmp'
    $env:NI_TERM_USERDATA = Join-Path $root 'data'
    Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
    New-Item -ItemType Directory $claudeWin, $codexWin, $otherWin, $tmpWin, $env:NI_TERM_USERDATA -Force | Out-Null
    . (Join-Path $PSScriptRoot 'hub-tools.ps1')

    $missing = $false
    try { $null = Get-HubSettings } catch { $missing = "$_" -like '*not set up yet*' }
    Assert-True $missing 'A missing settings file did not ask for the terminal Setup.'
    $settingsFile = Join-Path $hubDataDir 'settings.json'
    @{ backend = 'windows'; agentsDays = 40; workspaces = @($homeWin)
       agents = @{ claude = @{ enabled = $true; accounts = @(@{ id = 'first'; name = 'Main'; configDir = '' }, @{ id = 'second'; name = "Dev O'Brien"; configDir = $otherWin }) }
                   codex = @{ enabled = $true; accounts = @() }; opencode = @{ enabled = $false; accounts = @() } } } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $settingsFile -Encoding UTF8
    $settings = Get-HubSettings
    $hubBackend = Get-HubBackend $settings
    Assert-True ($hubBackend.Kind -eq 'windows' -and (Get-HubBackend ([pscustomobject]@{ backend = 'wsl:Ubuntu' })).Scope -eq 'wsl-Ubuntu') 'Backend was not read from the settings.'
    Assert-True ((@(Get-HubRequestedTools $settings) -join ',') -eq 'codex,claude') 'Enabled agents were not read from the settings.'
    $claudeAccounts = @(Get-HubClaudeAccounts $settings)
    Assert-True ($claudeAccounts.Count -eq 2 -and -not $claudeAccounts[0].Dir -and $claudeAccounts[1].Dir -eq $otherWin -and $claudeAccounts[0].Color -ne $claudeAccounts[1].Color) 'Claude accounts were not read from the settings.'

    $targets = @(Get-HubTransferTargets 'claude' @('codex', 'claude') $claudeAccounts 'second')
    Assert-True (($targets.Label -join '|') -eq "Open (claude - Dev O'Brien)|claude - Main|codex") 'A Claude row did not offer its own account first, then the other login, then other agents.'
    $targets = @(Get-HubTransferTargets 'codex' @('codex', 'claude') $claudeAccounts '')
    Assert-True (($targets.Label -join '|') -eq 'Open (codex)|claude') 'A handoff to Claude offered accounts; the destination decides that.'
    Assert-True (@(Get-HubTransferTargets 'codex' @('codex') @() '').Count -eq 1) 'Disabled destinations were included.'

    $gitBash = try { Join-Path (Get-HubGitRoot) 'bin\bash.exe' } catch { $null }
    if (-not $gitBash -or -not (Get-Command python -ErrorAction SilentlyContinue)) {
        Write-Host 'Settings and destination checks passed. Skipped the engine boundary: it needs Git for Windows and Python.'
        return
    }
    # The picker's own functions, without running the picker.
    $backend = 'windows'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'recent-history.ps1'), [ref]$null, [ref]$null)
    foreach ($name in 'ConvertTo-WslPath', 'ConvertFrom-WslPath', 'New-BashCommand', 'Get-ShortAge', 'Get-Conversations', 'Hide-Conversations') {
        Invoke-Expression $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true).Extent.Text
    }
    $toolColors = @{ claude = 208; codex = 78; opencode = 75 }
    function Invoke-Bash { & $gitBash @args }
    $script:launches = @()
    function Open-WtTab($title, $cwd, $command, $color) { $script:launches += [pscustomobject]@{ Title = $title; Command = $command; Color = $color } }
    $script:choice = 0
    function Select-HubRow($labels, $prompt) { $script:choice }
    function Get-LaunchData {
        $file = $script:launches[-1].Command -replace "^& '|'$"
        $payload = (Get-Content $file -Raw) -replace "(?s).*FromBase64String\('([^']+)'\).*", '$1'
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
    }
    $tmpWsl = ConvertTo-WslPath $tmpWin
    $bashHome = ConvertTo-WslPath $homeWin
    $stores = @{ codex = "$bashHome/.codex/sessions"; claude = "$bashHome/.claude/projects"; opencode = "$bashHome/missing.db" }
    $availableTools = $enabledTools = @('codex', 'claude')
    $hubDays = 40
    . (Join-Path $PSScriptRoot 'handoff-sync.ps1')

    # A Claude conversation created by the first login and continued by the second.
    $claudeId = '22222222-2222-2222-2222-222222222222'
    [IO.File]::WriteAllText((Join-Path $homeWin '.claude.json'), '{ "oauthAccount": { "accountUuid": "u-first" } }')
    [IO.File]::WriteAllText((Join-Path $otherWin '.claude.json'), '{ "oauthAccount": { "accountUuid": "u-second" } }')
    $lines = @(@{ type = 'user'; cwd = $homeWin; message = @{ content = 'Original task' } }, @{ type = 'session-owner'; accountUuid = 'u-first' }, @{ type = 'bridge-session'; ownerAccountUuid = 'u-second' })
    [IO.File]::WriteAllText((Join-Path $claudeWin "$claudeId.jsonl"), (($lines | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 5 }) -join "`n") + "`n")

    $rows = @(Get-Conversations)
    $cells = $rows[0] -split "`t"
    Assert-True ($rows.Count -eq 1 -and $cells[1] -eq $claudeId -and $cells[3] -eq 'claude' -and $cells[4] -eq 'Original task') 'The conversation was not listed.'
    Assert-True ($cells[7] -eq 'second' -and $cells[0] -like "*@Dev O'Brien*") 'The row does not resume under the login its transcript names.'
    Add-HubLaunch "claude:$claudeId" 'first'
    Assert-True (((@(Get-Conversations)[0]) -split "`t")[7] -eq 'first') 'Opening under another account from the hub was not remembered.'

    Hide-Conversations $rows
    Assert-True (@(Get-Conversations).Count -eq 0 -and @(Get-Conversations 'hidden').Count -eq 1) 'Hide did not move the conversation to the hidden list.'
    Assert-True (Test-Path (Join-Path $hubDataDir 'hidden\claude-session-ids.txt')) 'The hidden list is not in the data folder the terminal reads.'
    $null = Invoke-HubEngine 'hide' @{ keys = @("claude:$claudeId"); hide = $false }
    Assert-True (@(Get-Conversations).Count -eq 1) 'Show did not bring the conversation back.'

    # Claude -> Codex: a new destination, launched with the engine's prompt.
    $items = @([pscustomobject]@{ Id = $claudeId; Tool = 'claude'; Title = 'Original task'; Cwd = $homeWin; AccountId = 'first' })
    Invoke-HubTransfer 'codex' $items $homeWin
    Assert-True ($script:launches.Count -eq 1) 'The handoff did not launch.'
    $data = Get-LaunchData
    Assert-True ($data.tool -eq 'codex' -and $data.resume -eq '-') 'The handoff did not launch a new Codex session.'
    $handoff = @(Get-ChildItem (Join-Path $hubDataDir 'handoffs\sync-windows\handoffs') -Filter 'terminal-transfer-*.md')
    Assert-True ($handoff.Count -eq 1 -and $data.prompt.StartsWith('[Transitioned from Claude; inherited title: Original task]') -and $data.prompt.Contains($handoff[0].Name)) 'The launch does not carry the prompt naming the payload in the shared ledger.'

    # Codex -> Claude: a new Claude chat asks which account; the second is picked.
    $codexId = '11111111-1111-1111-1111-111111111111'
    $lines = @(@{ type = 'session_meta'; payload = @{ id = $codexId; cwd = $homeWin } },
               @{ type = 'response_item'; payload = @{ type = 'message'; role = 'user'; content = @(@{ type = 'input_text'; text = 'Codex task' }) } })
    [IO.File]::WriteAllText((Join-Path $codexWin "rollout-$codexId.jsonl"), (($lines | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 }) -join "`n") + "`n")
    $codexItems = @([pscustomobject]@{ Id = $codexId; Tool = 'codex'; Title = 'Codex task'; Cwd = $homeWin })
    $script:choice = 1
    Invoke-HubTransfer 'claude' $codexItems $homeWin
    Assert-True ($script:launches.Count -eq 2) 'The handoff to Claude did not launch.'
    $data = Get-LaunchData
    Assert-True ($data.tool -eq 'claude' -and $data.configDir -eq $otherWin -and $script:launches[-1].Color -eq $claudeAccounts[1].Color) 'A new Claude chat did not run under the account that was picked.'

    $first = New-HubClaudeCommand 'claude' $claudeAccounts[0]
    $second = New-HubClaudeCommand 'claude' $claudeAccounts[1]
    Assert-True ($first -like 'Remove-Item Env:CLAUDE_CONFIG_DIR*' -and $second.Contains($otherWin)) 'Claude commands do not select the account folder.'
    Write-Host 'Hub settings, destinations, listing, hiding, handoff launches and account rules passed.'
} finally {
    $env:NI_TERM_USERDATA = $oldData
    $env:CLAUDE_CONFIG_DIR = $oldClaude
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
