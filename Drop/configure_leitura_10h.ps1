$ErrorActionPreference = "Stop"

# Segunda leitura diária (10h). Não altera a rotina da meia-noite ("WeDrop Daily Catalog Scrape").
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryDir = Split-Path -Parent $projectDir
$pythonPath = Join-Path $repositoryDir ".venv\Scripts\python.exe"
$taskName = "WeDrop Leitura 10h"

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "Python virtual environment not found at $pythonPath"
}

$action = New-ScheduledTaskAction `
    -Execute $pythonPath `
    -Argument "-m wedrop diaria" `
    -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -Daily -At "10:00"
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Segunda leitura incremental do catálogo WeDrop às 10h, sem limite de tempo." `
    -Force | Out-Null

Write-Output "Tarefa '$taskName' registrada para executar diariamente às 10h, sem limite de tempo."
Write-Output "Se a rotina da meia-noite ainda estiver rodando, esta não começa (trava de execução)."
