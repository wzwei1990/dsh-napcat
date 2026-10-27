/**
 * 记忆条目的评分与合并（纯函数）——决定"哪些保留、哪些淡出"。
 *
 * 思路（参考 mem0 的 importance / Letta 的相关性 / Zep 的时间有效性）：
 * - 每条记忆带 score（模型给的权重 0~1）、hits（被再次提及/复用的次数）、lastSeenAt（最近一次出现）
 * - 有效分 = 权重 60% + 频率 25% + 新鲜度 15%
 * - 合并时同名/同义条目**累加 hits 并取更强的内容**，不是简单覆盖
 * - 淘汰：有效分低 + 太久没出现 → 丢弃；同类超过上限按有效分截断
 */
/** 归一化：去空白/标点、全角转半角、转小写（用于判重）。 */
export function normalizeKey(text) {
    return text
        .replace(/[\s\u3000]+/g, '')
        .replace(/[，。、；：！？,.;:!?"'“”‘’()（）\[\]【】]/g, '')
        .toLowerCase();
}
/** 新鲜度：最近出现得越近越接近 1；超过 forgetAfterMs 记为 0（半衰期式衰减）。 */
export function recencyScore(lastSeenAt, now, halfLifeMs = 7 * 24 * 3600_000) {
    const age = Math.max(0, now - lastSeenAt);
    return Math.pow(0.5, age / halfLifeMs);
}
/** 有效分：权重 60% + 频率 25% + 新鲜度 15%。 */
export function effectiveScore(item, now) {
    const weight = Math.min(1, Math.max(0, item.score));
    const frequency = Math.min(1, item.hits / 5);
    const fresh = recencyScore(item.lastSeenAt, now);
    return weight * 0.6 + frequency * 0.25 + fresh * 0.15;
}
/** 合并一条新观察进已有列表：同 key 就更新（累加 hits、取更完整文本、权重取较高），否则追加。 */
/** 权重归一：>1 视为 1~5 制，否则按 0~1。 */
export function normalizeWeight(weight, fallback = 0.6) {
    if (weight === undefined || !Number.isFinite(weight))
        return fallback;
    // 调用方传的是 1~5 制（>=1 就按 5 分制换算）；<1 视为已经是 0~1
    const value = weight >= 1 ? weight / 5 : weight;
    return Math.min(1, Math.max(0.05, value));
}
export function mergeItem(list, incoming, now) {
    const text = incoming.text.trim();
    if (text === '')
        return [...list];
    const key = normalizeKey(text);
    if (key === '')
        return [...list];
    const index = list.findIndex(item => item.key === key);
    if (index < 0) {
        return [...list, {
                kind: incoming.kind,
                key,
                text,
                score: normalizeWeight(incoming.weight),
                hits: 1,
                createdAt: now,
                updatedAt: now,
                lastSeenAt: now,
                ...(incoming.expiresAt === undefined ? {} : { expiresAt: incoming.expiresAt }),
            }];
    }
    const next = [...list];
    const prev = list[index];
    const nextScore = Math.max(prev.score, normalizeWeight(incoming.weight, prev.score));
    next[index] = {
        ...prev,
        // 文本取更长的那个（信息更全），但要保留"被更新"的语义
        text: text.length > prev.text.length ? text : prev.text,
        score: nextScore,
        hits: prev.hits + 1,
        updatedAt: now,
        lastSeenAt: now,
        expiresAt: incoming.expiresAt ?? prev.expiresAt,
    };
    return next;
}
/** 淘汰：先按"低分 + 太久没出现"删除，再按上限取有效分最高的。 */
export function pruneItems(list, options = {}) {
    const now = options.now ?? Date.now();
    const maxPerKind = options.maxPerKind ?? 30;
    const minScore = options.minScore ?? 0.25;
    const forgetAfterMs = options.forgetAfterMs ?? 45 * 24 * 3600_000;
    const kept = list.filter(item => {
        // 显式过期（todo 到期 / event 淡出）优先于评分
        if (item.expiresAt !== undefined && item.expiresAt <= now)
            return false;
        const stale = now - item.lastSeenAt > forgetAfterMs;
        if (stale && effectiveScore(item, now) < minScore)
            return false;
        return true;
    });
    const byKind = new Map();
    for (const item of kept) {
        const bucket = byKind.get(item.kind) ?? [];
        bucket.push(item);
        byKind.set(item.kind, bucket);
    }
    const result = [];
    for (const [, bucket] of byKind) {
        bucket.sort((left, right) => effectiveScore(right, now) - effectiveScore(left, now));
        result.push(...bucket.slice(0, maxPerKind));
    }
    return { items: result, dropped: list.length - result.length };
}
/** 取某类里有效分最高的前 N 条（注入用）。 */
export function topItems(list, kind, limit, now = Date.now()) {
    return list
        .filter(item => item.kind === kind)
        .slice()
        .sort((left, right) => effectiveScore(right, now) - effectiveScore(left, now))
        .slice(0, limit);
}
