import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';

/**
 * 向量命中结果（与 RAGStore 的 RagHit 对齐的元信息由调用方补全）。
 */
export interface VecHit {
  id: number; // 对应 chunk 的自增 id（与 struct 表 id 对齐）
  distance: number; // L2 距离（越小越相似）
}

/**
 * 基于 sqlite-vec 的向量存储（IT15，详见 detail.md §10「向量 RAG」）。
 *
 * 说明：
 * - 底层是 sqlite-vec 的虚拟表 `vec0`，向量以 JSON 数组文本存储。
 * - `load()` 负责加载扩展；加载失败时返回 false，由调用方降级为关键词检索（不崩溃）。
 * - 使用 Node 24 内置 `node:sqlite`（`allowExtension: true` 允许加载扩展）。
 * - vec0 的 rowid 必须为整数自增，插入时省略 rowid。
 */
export class VectorStore {
  private db: DatabaseSync;
  private loaded = false;

  constructor() {
    this.db = new DatabaseSync(':memory:', { allowExtension: true });
  }

  /** 加载 sqlite-vec 扩展；成功返回 true，失败（如平台不支持）返回 false 且不抛。 */
  load(): boolean {
    if (this.loaded) return true;
    try {
      this.db.loadExtension(getLoadablePath());
      this.loaded = true;
      return true;
    } catch {
      this.loaded = false;
      return false;
    }
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** 建向量表（按维度 dim）。重复调用安全。 */
  private ensureTable(dim: number): void {
    if (!this.loaded) return;
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}])`);
  }

  /** 插入一个向量（返回自增 id）。失败（未加载/维度不符）返回 null。 */
  upsert(vector: number[]): number | null {
    if (!this.loaded || !Array.isArray(vector) || vector.length === 0) return null;
    this.ensureTable(vector.length);
    try {
      const res = this.db
        .prepare('INSERT INTO vec_chunks(embedding) VALUES(?)')
        .run(JSON.stringify(vector));
      return Number(res.lastInsertRowid);
    } catch {
      return null;
    }
  }

  /** 清空向量表（reload 时重建索引用）。成功返回 true。 */
  clear(): boolean {
    if (!this.loaded) return false;
    try {
      this.db.exec('DROP TABLE IF EXISTS vec_chunks');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * KNN 检索：返回按距离升序的 topK 命中（与查询向量最相似）。
   * 未加载 / 空表返回空数组。
   */
  search(vector: number[], topK = 3): VecHit[] {
    if (!this.loaded || !Array.isArray(vector) || vector.length === 0) return [];
    try {
      const rows = this.db
        .prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ?')
        .all(JSON.stringify(vector), topK) as Array<{ rowid: number; distance: number }>;
      return rows.map((r) => ({ id: r.rowid, distance: r.distance }));
    } catch {
      return [];
    }
  }

  close(): void {
    this.db.close();
  }
}