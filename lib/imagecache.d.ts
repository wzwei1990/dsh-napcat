/**
 * 群聊图片缓存：把群里的图片（含表情包）落到会话目录，供之后 read_image / 视觉模型回看。
 *
 * 约束（防止把磁盘吃满）：
 * - 每条消息最多存 3 张
 * - 单张 ≤ maxBytes（默认 2MB）
 * - 每个聊天每天 ≤ dailyCap 张（默认 100）
 * - 超过 retentionDays 的目录在启动/写入时清理
 * - 按 URL 取 hash 去重（同一张图重复发只存一份）
 */
import type { LogLevel } from './onebot.js';
export interface ImageCacheOptions {
    /** 会话 cwd（图片落在 <cwd>/napcat-inbox/imgs/） */
    cwd: string;
    maxBytes: number;
    dailyCap: number;
    retentionDays: number;
    log: (level: LogLevel, message: string) => void;
}
export interface CachedImage {
    /** 绝对路径 */
    path: string;
    /** 相对 imgs 根目录的名字（用于写进聊天记录） */
    name: string;
    bytes: number;
}
/** 每天目录名：YYYYMMDD（本地时区）。 */
export declare function dayKey(now: number): string;
/** 用图片 URL 生成稳定短 hash（同一张图重复发只存一份）。 */
export declare function urlHash(url: string): string;
export declare class ImageCache {
    private readonly opts;
    constructor(opts: ImageCacheOptions);
    private get root();
    /** 清理超过保留天数的日期目录 + 收件箱根目录里的旧媒体。 */
    sweep(now?: number): Promise<number>;
    /** 当天已存张数。 */
    countToday(now?: number): Promise<number>;
    /** 存一张图；超限/去重命中时返回 undefined 或已有路径。 */
    save(input: {
        url: string;
        chatKey: string;
        nick: string;
        name: string;
        now?: number;
    }): Promise<CachedImage | undefined>;
    /** 把纯文本证据写一份（表情包名称之类），便于以后统计常用表情。 */
    noteFace(chatKey: string, nick: string, face: string, now?: number): Promise<void>;
    /** 写一小段统计（可选调用）。 */
    writeSummary(text: string): Promise<void>;
}
