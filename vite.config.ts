import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// 自定义插件：把 Ollama 原始流式响应转成前端期望的 SSE 格式
function ollamaProxy(): Plugin {
  return {
    name: 'ollama-chat-proxy',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res, next) => {
        if (req.method !== 'POST') return next();

        // 收集请求体
        let rawBody = '';
        req.on('data', (chunk: Buffer) => (rawBody += chunk.toString()));
        req.on('end', async () => {
          try {
            const body = JSON.parse(rawBody);
            const { messages, model } = body;

            // 转成 Ollama 格式
            const ollamaReq = JSON.stringify({
              model: model || 'gemma4:26b',
              messages,
              stream: true,
            });

            const ollamaRes = await fetch('http://localhost:11434/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: ollamaReq,
            });

            if (!ollamaRes.ok) {
              res.statusCode = ollamaRes.status;
              res.end(JSON.stringify({ error: 'Ollama error' }));
              return;
            }

            // SSE
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            const reader = ollamaRes.body?.getReader();
            if (!reader) { res.end(); return; }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.message?.content) {
                    res.write(`data: ${JSON.stringify({ content: parsed.message.content })}\n\n`);
                  }
                  if (parsed.message?.thinking) {
                    res.write(`data: ${JSON.stringify({ thinking: parsed.message.thinking })}\n\n`);
                  }
                  if (parsed.done) {
                    if (parsed.eval_count && parsed.eval_duration) {
                      const tps = Math.round(parsed.eval_count / (parsed.eval_duration / 1e9) * 10) / 10;
                      res.write(`data: ${JSON.stringify({ content: `__STATS__${JSON.stringify({ tokens: parsed.eval_count, tps })}` })}\n\n`);
                    }
                  }
                } catch {}
              }
            }
            res.write('data: [DONE]\n\n');
            res.end();
          } catch (err) {
            console.error('[ollama-proxy]', err);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'proxy error' }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), ollamaProxy()],
  root: '.',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',    // 其他 API 仍走 Express
      '/webhook': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'client-dist',
  },
});
