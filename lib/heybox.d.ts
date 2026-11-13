/**
 * 小黑盒（xiaoheihe）分享链接解析。
 *
 * 背景：群里常有人发 `https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?...&link_id=<id>&...`
 * 这种链接，模型拿到后只能 blind 抓页面（多数情况是 JS 壳或风控页）。这里直接用官方
 * 接口 `/v3/bbs/app/link/tree?link_id=` 取标题 + 摘要 + 正文首段，拼成一段可注入的文字，
 * 让模型不必自己去猜链接里有什么。
 *
 * 接口契约来源（社区整理）：
 *   https://github.com/AaronZ345/xiaoheihe-cli/blob/main/docs/api-contract.md
 *   - GET /bbs/app/link/tree : 完整正文；`link.text` 是文本块序列化 JSON，`description` 是摘要
 * 抽取顺序参考：
 *   https://github.com/butlanys/xiaoheihe-telegraph-bot（正文 → 原图 → 热评）
 *
 * 设计约定（与 bililink.ts 一致）：
 *   - 纯解析，不做网络重试策略；失败返回 null，由调用方决定要不要退回"裸链接"
 *   - 只读接口，任何字段缺失都不抛异常
 */
/** 从任意文本里抽第一个小黑盒链接与 link_id。 */
export interface HeyboxRef {
    url: string;
    linkId: string;
}
export declare function extractHeyboxLink(text: string): HeyboxRef | null;
export interface HeyboxPost {
    linkId: string;
    title: string;
    /** 作者昵称，取不到就是空串 */
    author: string;
    /** 摘要：优先 description，其次正文首段 */
    summary: string;
    /** 正文前几段（已去掉图片块等噪声），最多 3 段 */
    paragraphs: string[];
}
/**
 * 拉取一条小黑盒帖子。失败（风控 / 结构变更 / 超时）返回 null，不抛。
 * `fetchImpl` 仅用于单测注入。
 */
export declare function fetchHeyboxPost(linkId: string, options?: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<HeyboxPost | null>;
/** 渲染成可注入上下文的一段文字（不含任何指令性语句，只陈述事实）。 */
export declare function renderHeyboxBlock(post: HeyboxPost): string;
