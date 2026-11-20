$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hub-tools.ps1')
$env:AGENT_HUB_AVAILABLE_TOOLS = $null
try {
    $settings = Get-HubSettings
    $hubBackend = Get-HubBackend $settings
    $available = @(Get-HubAvailableTools $hubBackend)
    if (-not @(Get-HubRequestedTools $settings | Where-Object { $_ -in $available })) {
        throw "None of the agents switched on in NI Agent Terminal's Setup is installed in the $($hubBackend.Scope) backend."
    }
} catch {
    # Launched from a shortcut, so keep the failure readable.
    Write-Host $_.Exception.Message
    [void](Read-Host 'Press Enter to close this launcher')
    exit 1
}
$env:AGENT_HUB_AVAILABLE_TOOLS = $available -join ','
# The board reads the session stores, so it runs in the backend that holds them.
$board = if ($hubBackend.Kind -eq 'windows') { @('python', (Join-Path $hubEngineDir 'board.py')) }
         else { @('wsl.exe', '-d', $hubBackend.Distro, '--cd', $hubEngineDir, '--', 'python3', 'board.py') }
$tabs = @('new-tab', '--title', 'history', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'recent-history.ps1'),
          ';', 'new-tab', '--title', 'active') + $board
& $args[0] -w new @tabs
