# Small Hermes 🏛️

本地模型聊天应用，支持飞书互通。

## 快速开始

```bash
# 1. 确保 Ollama 运行中，并拉取模型
ollama pull gemma4:26b

# 2. 安装依赖
npm install

# 3. 配置 .env（飞书密钥已预填）

# 4. 启动开发模式（前后端同时运行）
npm run dev
```

## 架构

```
飞书用户 → Webhook → Small Hermes 后端 → Ollama (Gemma4 26B)
Web UI ──→ /api/chat → Small Hermes 后端 ──→┘
```

- **后端**: Express + Feishu Node SDK + Ollama
- **前端**: React + Vite，暗色聊天界面
- **模型**: Ollama 本地运行 Gemma4 26B

## 飞书配置

1. 在飞书开放平台配置事件订阅 URL: `https://your-domain/webhook/feishu`
2. 订阅事件: `im.message.receive_v1`
3. 本地开发用 ngrok 内网穿透: `ngrok http 3000`

## API

| 端点 | 说明 |
|------|------|
| `POST /api/chat` | 流式聊天 (SSE) |
| `GET /api/health` | 健康检查 |
| `POST /webhook/feishu` | 飞书事件回调 |
