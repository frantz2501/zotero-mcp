# zotero-mcp Windows autostart at logon (equivalent of the Linux systemd unit)
# Usage:   powershell -ExecutionPolicy Bypass -File windows\install-autostart.ps1
# Remove:  powershell -ExecutionPolicy Bypass -File windows\install-autostart.ps1 -Uninstall
#
# The exe is a console app; launching it directly from a scheduled task would
# open a console window. It is wrapped in a tiny VBS that runs it hidden.
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$taskName = 'zotero-mcp'
$appDir = Join-Path $env:APPDATA 'zotero-mcp'
$exe = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\zotero-mcp.exe'))

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task $taskName (the running server, if any, stays until logoff)."
    exit 0
}

if (-not (Test-Path $exe)) {
    Write-Error "zotero-mcp.exe not found at $exe - run 'node windows\build.mjs' first."
}

# Hidden-launch wrapper
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
$vbs = Join-Path $appDir 'zotero-mcp-hidden.vbs'
Set-Content -Path $vbs -Value ('CreateObject("WScript.Shell").Run """' + $exe + '""", 0, False')

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'zotero-mcp MCP server (HTTP on localhost)' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "zotero-mcp will start hidden at every logon and is running now."
Write-Host "Config   : $appDir\config.json (or zotero-mcp.json next to the exe)"
Write-Host "Check    : curl http://127.0.0.1:3334/"
Write-Host "Remove   : powershell -File windows\install-autostart.ps1 -Uninstall"
