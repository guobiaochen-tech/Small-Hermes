#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Small Hermes — 一键启动
#  开机后只需运行这一个脚本（或双击）
#  Ollama → Express 后端 (:3000) → Vite 前端 (:5173) → 浏览器
# ═══════════════════════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
LAUNCH_BROWSER="${LAUNCH_BROWSER:-1}"

echo "🏛️  Small Hermes 启动中…"
echo ""

# ─── 1. 确保 Ollama 在运行 ──────────────────────────────────────
if ! curl -s "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    echo "🔄 启动 Ollama…"
    ollama serve &>/dev/null &
    for i in $(seq 1 30); do
        if curl -s "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
fi

if ! curl -s "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    echo "❌ Ollama 启动失败，请手动运行 ollama serve"
    exit 1
fi
echo "✅ Ollama 就绪"

# ─── 2. 检查依赖 ────────────────────────────────────────────────
cd "$SCRIPT_DIR"
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖…"
    npm install
fi

# ─── 3. 启动前后端 ──────────────────────────────────────────────
echo "🚀 启动 Small Hermes…"
echo "   后端:  http://localhost:3000"
echo "   前端:  http://localhost:5173"
echo ""

npm run dev &
DEV_PID=$!

# 等 Vite 就绪
for i in $(seq 1 20); do
    if curl -s "http://localhost:5173" >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

if ! curl -s "http://localhost:5173" >/dev/null 2>&1; then
    echo "⚠️  前端启动较慢，请稍后刷新 http://localhost:5173"
else
    echo "✅ 前端就绪"
fi

# ─── 4. 打开浏览器 ──────────────────────────────────────────────
if [ "$LAUNCH_BROWSER" = "1" ]; then
    sleep 1
    open "http://localhost:5173"
    echo "✅ 浏览器已打开"
fi

echo ""
echo "🎉 Small Hermes 已启动！按 Ctrl+C 停止"
echo ""

wait "$DEV_PID"
