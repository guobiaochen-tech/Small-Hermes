import { config } from './config.js';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

/**
 * 调用 Tavily 搜索
 */
export async function webSearch(query: string): Promise<SearchResult[]> {
  const apiKey = config.tavily.apiKey;
  if (!apiKey) throw new Error('Tavily API key 未配置');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 5,
      include_answer: true,
      include_raw_content: false,
    }),
  });

  if (!res.ok) throw new Error(`Tavily API 错误: ${res.status}`);
  const data = await res.json();

  const results: SearchResult[] = (data.results || []).map((r: any) => ({
    title: r.title || '',
    url: r.url || '',
    content: r.content || '',
  }));

  return results;
}

/**
 * 格式化搜索结果给模型用
 */
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `搜索关键词: ${query}\n\n搜索结果: 无相关结果`;
  }
  
  let text = `搜索关键词: ${query}\n\n搜索结果:`;
  
  // 只取前 3 条最相关的结果
  for (let i = 0; i < Math.min(results.length, 3); i++) {
    const r = results[i];
    // 限制每条结果的长度，避免 token 消耗过大
    const title = r.title.length > 80 ? r.title.slice(0, 80) + '...' : r.title;
    const content = r.content.length > 300 ? r.content.slice(0, 300) + '...' : r.content;
    text += `\n\n${i + 1}. ${title}\n   ${content}`;
  }
  
  return text;
}
