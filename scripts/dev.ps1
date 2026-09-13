# 测试运行脚本（PowerShell）
# 用法：在项目根目录运行  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Test-Path "node_modules")) { npm install }
npm run dev