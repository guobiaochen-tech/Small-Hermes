#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Small Hermes — 一键启动
#  Ollama → Express 后端 (:3000) → Vite 前端 (:5173) → 浏览器
# ═══════════════════════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
LAUNCH_BROWSER="${LAUNCH_BROWSER:-1}"

# ─── ANSI 色 ──────────────────────────────────────────────
BOLD="\033[1m"
DIM="\033[2m"
STONE="\033[38;5;187m"    # 大理石灰 — 主色
GRAY="\033[38;5;244m"     # 中灰
WHITE="\033[38;5;255m"    # 亮白
GREEN="\033[38;5;107m"    # 草绿
AMBER="\033[38;5;179m"    # 琥珀
RED="\033[38;5;124m"      # 砖红
DARK="\033[38;5;236m"     # 深灰装饰线
RESET="\033[0m"

# ─── Banner 大字 ──────────────────────────────────────────
echo ""
echo -e "  ${STONE}${BOLD}╔════════════════════════════════════════════════════════╗${RESET}"
echo -e "  ${STONE}${BOLD}║${RESET}                                                        ${STONE}${BOLD}║${RESET}"
echo -e "  ${STONE}${BOLD}║${RESET}  ${STONE}  _____   _    _ ______ _____  __  __ ______  _____ ${RESET}  ${STONE}${BOLD}║${RESET}"
echo -e "  ${STONE}${BOLD}║${RESET}  ${STONE} / ____| | |  | |  ____|  __ \\|  \\/  |  ____|/ ____|${RESET}  ${STONE}${BOLD}║${RESET}"
echo -e "  ${STONE}${BOLD}║${RESET}  ${STONE}| (___   | |__| | |__  | |__) | \\  / | |__  | (___  ${RESET}  ${STONE}${BOLD}║${RESET}"
echo -e "  ${STONE}${BOLD}║${RESET}  ${STONE} \\___ \\  |  __  |  __| |  _  /| |\\/| |  __|  \\___ \\ ${RESET}  ${STONE}${BOLD}║${RESET}"
echo -e "  ${STONE}${BOLD}║${RESET}  ${STONE} ____) | | |  | | |____| | \\ \\| |  | | |____ ____) |${RESET}  ${STONE}${BOLD}║${RESET}"
echo -e "  ${STONE}${BOLD}║${RESET}  ${STONE}|_____/  |_|  |_|______|_|  \\_\\_|  |_|______|_____/ ${RESET}  ${STONE}${BOLD}║${RESET}"
echo -e "  ${STONE}${BOLD}║${RESET}                                                        ${STONE}${BOLD}║${RESET}"
echo -e "  ${STONE}${BOLD}║${RESET}        ${GRAY}${DIM}Small Hermes  v0.1.0${RESET}                            ${STONE}${BOLD}║${RESET}"
echo -e "  ${STONE}${BOLD}╚════════════════════════════════════════════════════════╝${RESET}"
echo ""

# ─── 进度状态 ─────────────────────────────────────────────
echo -e "  ${STONE}◇${RESET}  ${BOLD}检查运行环境${RESET}"
echo ""

# ─── 1. Ollama ───────────────────────────────────────────
if ! curl -s "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    echo -e "    ${AMBER}●${RESET}  Ollama 未运行，启动中…"
    ollama serve &>/dev/null &
    for i in $(seq 1 30); do
        if curl -s "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
fi

if ! curl -s "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    echo -e "    ${RED}✗${RESET}  Ollama 启动失败，请手动运行 ${WHITE}ollama serve${RESET}"
    exit 1
fi
echo -e "    ${GREEN}✓${RESET}  Ollama    ${GRAY}${DIM}已就绪${RESET}"

# ─── 2. 依赖 ─────────────────────────────────────────────
cd "$SCRIPT_DIR"
if [ ! -d "node_modules" ]; then
    echo -e "    ${AMBER}●${RESET}  安装依赖…"
    npm install --silent
fi
echo -e "    ${GREEN}✓${RESET}  Node.js   ${GRAY}${DIM}依赖已安装${RESET}"
echo ""

# ─── 3. 启动服务 ─────────────────────────────────────────
echo -e "  ${STONE}◇${RESET}  ${BOLD}启动服务${RESET}"
echo ""

npm run dev &
DEV_PID=$!

# 后端
for i in $(seq 1 30); do
    if curl -s "http://localhost:3000" >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

if curl -s "http://localhost:3000" >/dev/null 2>&1; then
    echo -e "    ${GREEN}✓${RESET}  后端 API  ${WHITE}http://localhost:3000${RESET}"
else
    echo -e "    ${RED}✗${RESET}  后端启动超时"
fi

# 前端
for i in $(seq 1 30); do
    if curl -s "http://localhost:5173" >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

if curl -s "http://localhost:5173" >/dev/null 2>&1; then
    echo -e "    ${GREEN}✓${RESET}  前端 UI   ${WHITE}http://localhost:5173${RESET}"
else
    echo -e "    ${AMBER}△${RESET}  前端启动较慢，请稍后手动刷新"
fi
echo ""

# ─── 4. 打开浏览器 ───────────────────────────────────────
if [ "$LAUNCH_BROWSER" = "1" ]; then
    sleep 1
    open "http://localhost:5173"
fi

# ─── 完成 ─────────────────────────────────────────────────
echo -e "  ${DARK}───${RESET}  ${STONE}${BOLD}Small Hermes 已就绪${RESET}  ${DARK}───${RESET}"
echo ""
echo -e "    ${GRAY}对话${RESET}  ${WHITE}http://localhost:5173${RESET}"
echo -e "    ${GRAY}API${RESET}   ${WHITE}http://localhost:3000${RESET}"
echo -e "    ${GRAY}退出${RESET}  ${AMBER}Ctrl+C${RESET}"
echo ""

wait "$DEV_PID"
