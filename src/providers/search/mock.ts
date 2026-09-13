import type { SearchProvider } from '../interfaces.js';
import type { SearchResult } from '../types.js';

/**
 * 本地模拟检索 Provider（Phase1 占位，无真实搜索服务 key 时使用）。
 * 返回空/本地知识文件命中，供联调，不影响全链路。
 */
export class MockSearchProvider implements SearchProvider {
  readonly id = 'mock-search';

  async search(query: string): Promise<SearchResult[]> {
    // 无外部搜索时不联网；本地命中统一由 RAG 检索负责，此处返回空
    return [
      {
        title: `（模拟检索：${query}）`,
        url: '',
        snippet: '未配置真实搜索 Provider，请接入联网搜索以获取外部资料。',
      },
    ];
  }
}