# Small Hermes 🏛️

本地大模型聊天应用，支持飞书 Bot + Web UI 双端互通。

基于 Ollama 运行本地模型（如 Gemma4 26B），不依赖任何云端服务。

## 特性

- **🤖 飞书 Bot** — 在飞书上直接跟本地模型对话
- **🌐 Web UI** — 暗色主题的聊天界面，支持流式 SSE 输出
- **🔍 联网搜索** — 通过 Tavily API 让模型搜索实时信息（可选）
- **💭 推理过程展示** — 支持显示模型的思考过程（thinking/CoT）
- **⚡ 本地运行** — 数据不出本机，完全离线可用
- **📦 单文件打包** — 支持打包为 Node SEA 可执行文件（可选）

## 快速开始

### 前置要求

- Node.js >= 20
- [Ollama](https://ollama.com) 已安装并运行
- 一个 Ollama 模型（推荐 `gemma4:26b` 或 `qwen2.5:14b`）

### 安装

```bash
# 克隆仓库
git clone https://github.com/guobiaochen-tech/Small-Hermes.git
cd Small-Hermes

# 安装依赖
npm install

# 复制环境变量模板
cp .env.example .env
# 编辑 .env 填入配置（飞书密钥、Tavily API Key 等）
```

### 运行

```bash
# 同时启动后端（:3000）和前端（:5173）
npm run dev
```

打开浏览器访问 `http://localhost:5173` 即可开始对话。

## 飞书配置

1. 在 [飞书开放平台](https://open.feishu.cn) 创建应用，获取 App ID 和 App Secret
2. 配置事件订阅 URL: `https://your-domain/webhook/feishu`
3. 订阅事件: `im.message.receive_v1`
4. 本地开发用 ngrok 内网穿透: `ngrok http 3000`

## 联网搜索

1. 在 [Tavily](https://tavily.com) 注册获取 API Key
2. 填入 `.env` 的 `TAVILY_API_KEY`
3. 模型会自动判断何时需要搜索

## 架构

```
飞书用户 → Webhook → Small Hermes 后端 → Ollama (本地模型)
Web UI ──→ /api/chat → Small Hermes 后端 ──→┘
                         │
                     [Tavily API]（可选）
```

- **后端**: Express + Feishu Node SDK，处理飞书事件和 Web UI API
- **前端**: React + Vite + TypeScript，暗色飞书风格聊天界面
- **模型**: 通过 Ollama API 调用本地模型，支持任何 Ollama 兼容模型
- **搜索**: Tavily API 集成，模型通过 function calling 自主决定搜索

## API

| 端点 | 说明 |
|------|------|
| `POST /api/chat` | 流式聊天 (SSE) |
| `GET /api/health` | 健康检查 |
| `POST /webhook/feishu` | 飞书事件回调 |

## 配置

通过 `.env` 文件配置：

| 变量 | 说明 | 必填 |
|------|------|------|
| `OLLAMA_BASE_URL` | Ollama 地址，默认 `http://localhost:11434` | ✅ |
| `OLLAMA_MODEL` | 模型名称，默认 `gemma4:26b` | ✅ |
| `FEISHU_APP_ID` | 飞书应用 ID | 飞书 Bot |
| `FEISHU_APP_SECRET` | 飞书应用 Secret | 飞书 Bot |
| `TAVILY_API_KEY` | Tavily 搜索 API Key | 联网搜索 |

## 技术栈

- **运行时**: Node.js 24 + TypeScript
- **前端**: React 18 + Vite 6
- **后端**: Express 4 + tsx (TypeScript 即时编译)
- **模型**: Ollama + Gemma4 26B (Q4_K_M)

## License

[MIT](LICENSE)
