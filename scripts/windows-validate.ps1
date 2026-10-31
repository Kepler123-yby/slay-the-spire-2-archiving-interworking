$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
function Invoke-Checked([string]$Command, [string[]]$CommandArgs) {
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE). Stop before real save operations." }
}
Invoke-Checked 'node' @('--version')
Invoke-Checked 'npm.cmd' @('ci')
Invoke-Checked 'npm.cmd' @('run', 'setup:quark')
Invoke-Checked 'npm.cmd' @('test')
Invoke-Checked 'npm.cmd' @('run', 'test:ui')
Invoke-Checked 'npm.cmd' @('run', 'doctor')
Write-Host 'Ordinary terminal: use the Agent binding panel after npm.cmd start. agent:check is optional for direct-host mode.'
Write-Host 'Local checks passed. See docs/windows-validation.md for login, random cloud probe, and real-save upload.'
