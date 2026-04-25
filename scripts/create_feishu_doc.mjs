import * as lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';
dotenv.config();

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID || '',
  appSecret: process.env.FEISHU_APP_SECRET || '',
  disableTokenCache: false,
});

async function createInstallDoc() {
  console.log('创建文档中...');
  const doc = await client.request({
    method: 'POST',
    url: '/open-apis/docx/v1/documents',
    data: {
      folder_token: '',
      title: 'Small Hermes 小白安装教程',
    },
  });
  const docId = doc.data.document.document_id;
  console.log('文档创建成功，ID:', docId);

  // 先清掉默认的空白 block
  await client.request({
    method: 'DELETE',
    url: `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch`,
    params: { document_revision_id: -1 },
    data: {
      start_index: 0,
      end_index: 1,
    },
  }).catch(() => {});

  const content = [
    '这是一个完全用AI写的软件，我只是提要求，不懂前端。',
    '在现在这么多 Agent 的情况下，我不想让云模型知道我的个人信息，所以才有了这个想法。软件功能还在完善中。',
    '',
    { type: 'divider' },
    '',
    { type: 'heading', text: '📦 总共需要装 3 样东西' },
    '',
    '① Node.js — 让代码能运行（5分钟）',
    '② Ollama — 让 AI 模型在你电脑上跑（20-40分钟）',
    '③ Small Hermes — 聊天界面本身（10分钟）',
    '',
    '全部装完大概需要：30分钟～1小时。主要看网速，因为要下载 18GB 的模型。',
    '',
    { type: 'divider' },
    '',
    { type: 'heading', text: '第一步：装 Node.js' },
    '',
    '1. 打开浏览器，访问 https://nodejs.org',
    '2. 点绿色的「LTS」按钮下载',
    '3. 打开安装包，一路点「下一步」直到完成',
    '4. 重启电脑（重要！不重启后面可能识别不到）',
    '',
    '验证方法：打开「终端」App（启动台 → 其他），输入 node -v，如果能显示版本号（比如 v24.15.0），说明装好了。',
    '',
    { type: 'divider' },
    '',
    { type: 'heading', text: '第二步：装 Ollama + 下载模型' },
    '',
    '1. 访问 https://ollama.com，点 Download，下载 macOS 版',
    '2. 打开下载的文件，把 Ollama 图标拖进「应用程序」文件夹',
    '3. 打开 Ollama（第一次会提示安装命令行工具，点确定）',
    '4. 打开「终端」App，输入命令： ollama pull gemma4:26b',
    '5. 等着。这个要下载大概 18GB 的数据，屏幕会一直滚动',
    '6. 等终端重新出现 $ 符号就说明下完了',
    '',
    '下载时间取决于网速，WiFi 快的十几分钟，慢的可能要一小时。',
    '',
    { type: 'divider' },
    '',
    { type: 'heading', text: '第三步：装 Small Hermes' },
    '',
    '1. 打开「终端」，逐条输入以下命令（每输完一条按一次回车）：',
    '',
    'cd ~/Desktop',
    'git clone https://github.com/guobiaochen-tech/Small-Hermes.git',
    'cd Small-Hermes',
    'npm install',
    'npm run dev',
    '',
    '2. 等终端显示类似这样的内容：',
    '   [Vite] Dev server running at: http://localhost:5173',
    '   [Server] Running on port 3000',
    '',
    '3. 打开浏览器，地址栏输入 http://localhost:5173',
    '4. 看到聊天界面了！输入你的问题，点发送',
    '',
    '🎉 恭喜！你已经可以在自己的电脑上和 AI 聊天了！',
    '',
    { type: 'divider' },
    '',
    { type: 'heading', text: '常见问题' },
    '',
    'Q: 终端报 command not found: node',
    '→ Node.js 没装好，或者没重启电脑。重启后再试。',
    '',
    'Q: 终端报 command not found: git',
    '→ 去 https://git-scm.com 下载安装，或者直接下载 ZIP 压缩包解压。',
    '',
    'Q: 浏览器打不开 localhost:5173',
    '→ 确认终端还在运行 npm run dev，不要关掉它。',
    '',
    'Q: 聊天回复很慢',
    '→ 正常。模型在你的电脑上跑，每次回答几秒钟。',
    '',
    { type: 'divider' },
    '',
    { type: 'heading', text: '每次使用时' },
    '',
    '1. 打开 Ollama（确保菜单栏有小图标）',
    '2. 打开「终端」，输入：',
    '   cd ~/Desktop/Small-Hermes',
    '   npm run dev',
    '3. 浏览器打开 http://localhost:5173',
    '4. 开始聊天',
    '',
    '用完直接关掉终端窗口就行。',
    '',
    { type: 'divider' },
    '',
    '遇到问题随时在飞书群里 @我！',
  ];

  // 构建 Feishu Doc block 数组
  const blocks_data = content.map(item => {
    if (typeof item === 'object' && item.type === 'divider') {
      return { block_type: 10, divider: {} };
    }
    if (typeof item === 'object' && item.type === 'heading') {
      return {
        block_type: 3,
        heading3: {
          elements: [{ text_run: { content: item.text, text_element_style: {} } }],
        },
      };
    }
    // text line
    return {
      block_type: 2,
      text: {
        elements: [{ text_run: { content: item, text_element_style: {} } }],
        style: {},
      },
    };
  });

  // 分批添加
  const batchSize = 40;
  for (let i = 0; i < blocks_data.length; i += batchSize) {
    const batch = blocks_data.slice(i, i + batchSize);
    await client.request({
      method: 'POST',
      url: `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
      params: { document_revision_id: -1 },
      data: { children: batch, index: -1 },
    });
    console.log(`已添加第 ${i+1}-${Math.min(i+batchSize, blocks_data.length)} 块`);
  }

  console.log(`\n✅ 文档创建成功！`);
  console.log(`文档链接: https://www.feishu.cn/docx/${docId}`);
}

createInstallDoc().catch(err => {
  console.error('创建失败:', err?.response?.data || err?.message || err);
});
