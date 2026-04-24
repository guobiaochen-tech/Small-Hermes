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
  let text = `搜索关键词: ${query}\n\n搜索结果:\n`;
  for (const r of results) {
    text += `\n---\n标题: ${r.title}\n链接: ${r.url}\n摘要: ${r.content}\n`;
  }
  return text;
}
