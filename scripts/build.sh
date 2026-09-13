#!/usr/bin/env bash
# 编译打包脚本（bash，需要 Git Bash / WSL）
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -d node_modules ] || npm install
npm run build