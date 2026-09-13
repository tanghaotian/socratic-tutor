#!/usr/bin/env bash
# 测试运行脚本（bash，需要 Git Bash / WSL）
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -d node_modules ] || npm install
npm run dev