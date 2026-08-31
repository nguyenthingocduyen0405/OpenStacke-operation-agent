$ErrorActionPreference = 'Stop'

$sourceModel = 'hf.co/joey51/kanana-1.5-2.1b-instruct-2505-Q4_K_M-GGUF:latest'

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  throw 'Chưa tìm thấy Ollama. Hãy cài Ollama rồi mở lại PowerShell.'
}

Write-Host 'Đang tải Kanana 1.5 2.1B Q4_K_M (khoảng 1.5 GB)...'
ollama pull $sourceModel
if ($LASTEXITCODE -ne 0) { throw 'Không thể tải model Kanana.' }

Push-Location $PSScriptRoot
try {
  ollama create kanana-chat -f Modelfile
  if ($LASTEXITCODE -ne 0) { throw 'Không thể tạo model kanana-chat.' }
} finally {
  Pop-Location
}

Write-Host 'Hoàn tất. Kiểm tra bằng lệnh: ollama run kanana-chat'
