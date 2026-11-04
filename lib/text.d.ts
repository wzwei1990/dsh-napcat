/** 消息段 → 纯文本、@ 判定、长文分段。 */
import type { ObMessage, ObSegment } from './types.js';
/** 解析 CQ 码字符串（NapCat 配成字符串上报时的兜底；数组更常见）。 */
export declare function parseCq(raw: string): ObSegment[];
/** 归一化成消息段数组。 */
export declare function segmentsOf(message: ObMessage | undefined): ObSegment[];
/** 从一段原始文本里挖出 http(s) 链接（卡片 JSON/XML 里链接常被转义成 \/ 或 &amp;）。 */
export declare function urlsInText(raw: string): string[];
/**
 * 从卡片/富媒体段里挖链接与标题。
 * QQ 群里分享 B 站视频多数不是纯文本，而是：
 *   - json 段（com.tencent.structmsg / 小程序卡片），链接在 meta.news.jumpUrl / meta.detail_1.qqdocurl
 *   - xml 段，链接在 url="..." / brief="..." / qqdocurl 里
 * 只把段转成「[卡片]」会把链接丢掉 → 下游的 B 站联动永远不会触发。
 */
export declare function linksInSegment(seg: ObSegment): string[];
/** 卡片的标题/摘要（给模型一点上下文，别让链接裸奔） */
export declare function cardTitleOf(seg: ObSegment): string;
/** 把消息段拼成给模型看的纯文本（图片/语音等转成占位符；卡片会带上里面的链接）。 */
export declare function toText(message: ObMessage | undefined, selfId?: string, selfName?: string): string;
/** 是否 @ 了指定 QQ（群聊门控用）。 */
export declare function mentions(message: ObMessage | undefined, selfId: string): boolean;
/** 是否引用了指定消息（回复机器人的消息也算"提及"，由调用方决定是否启用）。 */
export declare function repliesTo(message: ObMessage | undefined, messageId: string): boolean;
/**
 * 长文分段：优先按空行切，其次按句号/换行，最后硬切。
 * 返回的每段都不超过 maxChars（maxChars <= 0 时原样返回一段）。
 */
export declare function splitText(text: string, maxChars: number): string[];
/** 在文本里找第一个命中的触发关键字（大小写不敏感，空词忽略）。 */
export declare function findKeyword(text: string, words: readonly string[]): string | undefined;
/** 去掉命中的触发关键字（大小写不敏感，只去掉第一个）。 */
export declare function stripKeyword(text: string, keyword: string): string;
/** 消息是否引用了这批消息 id 中的任意一条。 */
export declare function repliesToAny(message: ObMessage | undefined, ids: readonly string[]): boolean;
/** 稳定的短哈希（djb2 → base36），用于把 cwd 编进会话 id。 */
export declare function shortHash(text: string): string;
/**
 * 解析「群/人性格」配置：每行 `<group:群号|private:QQ>=<人设文本>`，
 * 支持 `#` 注释与空行。返回 key → 文本（key 形如 `group:123`）。
 */
export declare function parsePersonaOverrides(raw: string): Map<string, string>;
/** 会话标题：`MM-DD HH:mm`（本地时间；内容容易乱，所以只标时间）。 */
export declare function titleFrom(text: string, now?: Date): string;
/** 文件名模糊匹配打分（0 = 不匹配）。用户常只记得一部分名字。 */
export declare function scoreFileName(name: string, query: string): number;
/** 按模糊打分排序候选（只返回 score>0）。 */
export declare function rankByFileName<T>(items: readonly T[], query: string, nameOf: (item: T) => string): Array<{
    item: T;
    score: number;
}>;
