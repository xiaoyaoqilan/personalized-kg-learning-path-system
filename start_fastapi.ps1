$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
  $python = "python"
}

& $python -m uvicorn backend_fastapi:app --host 127.0.0.1 --port 4177
