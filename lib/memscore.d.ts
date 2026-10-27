/**
 * 记忆条目的评分与合并（纯函数）——决定"哪些保留、哪些淡出"。
 *
 * 思路（参考 mem0 的 importance / Letta 的相关性 / Zep 的时间有效性）：
 * - 每条记忆带 score（模型给的权重 0~1）、hits（被再次提及/复用的次数）、lastSeenAt（最近一次出现）
 * - 有效分 = 权重 60% + 频率 25% + 新鲜度 15%
 * - 合并时同名/同义条目**累加 hits 并取更强的内容**，不是简单覆盖
 * - 淘汰：有效分低 + 太久没出现 → 丢弃；同类超过上限按有效分截断
 */
export type MemoryKind = 'summary' | 'glossary' | 'setting' | 'person' | 'preference' | 'style' | 'todo' | 'event';
export interface MemoryItem {
    kind: MemoryKind;
    /** 归一化后的键（人名/词条用小写去标点） */
    key: string;
    /** 展示文本 */
    text: string;
    /** 模型给的重要性 0~1（缺省 0.6） */
    score: number;
    /** 被再次提及的次数（合并时累加） */
    hits: number;
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number;
    /** 过期时间（todo 到期 / event 淡出用）；不填=不过期 */
    expiresAt?: number;
}
export interface PruneOptions {
    /** 每类最多保留多少条 */
    maxPerKind?: number;
    /** 有效分低于这个值 + 太久没出现就淘汰 */
    minScore?: number;
    /** 多久没出现算"太久"（毫秒） */
    forgetAfterMs?: number;
    now?: number;
}
/** 归一化：去空白/标点、全角转半角、转小写（用于判重）。 */
export declare function normalizeKey(text: string): string;
/** 新鲜度：最近出现得越近越接近 1；超过 forgetAfterMs 记为 0（半衰期式衰减）。 */
export declare function recencyScore(lastSeenAt: number, now: number, halfLifeMs?: number): number;
/** 有效分：权重 60% + 频率 25% + 新鲜度 15%。 */
export declare function effectiveScore(item: MemoryItem, now: number): number;
/** 合并一条新观察进已有列表：同 key 就更新（累加 hits、取更完整文本、权重取较高），否则追加。 */
/** 权重归一：>1 视为 1~5 制，否则按 0~1。 */
export declare function normalizeWeight(weight: number | undefined, fallback?: number): number;
export declare function mergeItem(list: readonly MemoryItem[], incoming: {
    kind: MemoryKind;
    text: string;
    weight?: number;
    expiresAt?: number;
}, now: number): MemoryItem[];
/** 淘汰：先按"低分 + 太久没出现"删除，再按上限取有效分最高的。 */
export declare function pruneItems(list: readonly MemoryItem[], options?: PruneOptions): {
    items: MemoryItem[];
    dropped: number;
};
/** 取某类里有效分最高的前 N 条（注入用）。 */
export declare function topItems(list: readonly MemoryItem[], kind: MemoryKind, limit: number, now?: number): MemoryItem[];
