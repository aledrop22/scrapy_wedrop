$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryDir = Split-Path -Parent $projectDir
$pythonPath = Join-Path $repositoryDir ".venv\Scripts\python.exe"
$taskName = "WeDrop Daily Catalog Scrape"
$packagePath = Join-Path $projectDir "wedrop\__main__.py"

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "Python virtual environment not found at $pythonPath"
}

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "Pacote wedrop não encontrado em $packagePath"
}

$action = New-ScheduledTaskAction `
    -Execute $pythonPath `
    -Argument "-m wedrop diaria" `
    -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today)
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -WakeToRun `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Mapeia o catálogo WeDrop, atualiza data.json e sincroniza o SQLite e Supabase." `
    -Force | Out-Null

Write-Output "Tarefa '$taskName' registrada para executar diariamente à meia-noite."
Write-Output "A sessão do usuário deve permanecer iniciada; o computador pode estar bloqueado."
Write-Output "Logs detalhados: $(Join-Path $projectDir 'logs\scraper_runs.log')"
