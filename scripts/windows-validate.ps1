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
Invoke-Checked 'npm.cmd' @('run', 'doctor')
Invoke-Checked 'npm.cmd' @('run', 'agent:check')
Write-Host 'Local checks passed. See docs/windows-validation.md for login, random cloud probe, and real-save upload.'
