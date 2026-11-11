#!/usr/bin/env bash
# 一键启动：Redux DevTools server（后台）+ Agent REPL（前台，开启 --devtools）。
#
# 用法：
#   ./devtools-run.sh
#
# 注意：DevTools 页面显示 "No store found" 是因为当前没有 Agent 进程连接到 server。
# 单次执行模式几秒就退出，页面来不及看到；本脚本用 REPL 保持进程常驻。

set -euo pipefail
cd "$(dirname "$0")"

SERVER_PID=""

if curl -sf -o /dev/null http://localhost:8000; then
	echo "DevTools server 已在 8000 端口运行，直接复用。"
else
	npm run devtools &
	SERVER_PID=$!
	trap 'if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi' EXIT INT TERM

	for _ in $(seq 1 40); do
		if curl -sf -o /dev/null http://localhost:8000; then break; fi
		sleep 0.5
	done
	echo "DevTools server 已启动：http://localhost:8000"
fi

echo "DevTools UI: http://127.0.0.1:8000（不要用 https / localhost，避免浏览器升级成 wss）"
echo "现在启动 Agent（保持本终端运行，action 会实时同步到 DevTools 页面）。"
npm run dev -- --devtools
