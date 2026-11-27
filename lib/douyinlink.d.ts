/**
 * 抖音链接 → 主动发言上下文（2026-11-26）。
 *
 * 与 bililink 同形态：不下载视频，只拿元数据（标题/作者/时长/点赞/简介）。
 * 数据来自 dshBili 的 douyinMeta（内部走 amagi 服务，本地签名、无头可用）。
 * 拿不到就静默跳过，不影响正常聊天。
 */
import type { Context } from '@deepseek-ai/cordis';
export interface DouyinMetaLike {
    title: string;
    uploader?: string;
    durationSec?: number;
    description?: string;
    url: string;
    likes?: number;
}
export interface DouyinStoryboardLike {
    imagePath: string;
    timeline: Array<{
        index: number;
        label: string;
    }>;
}
export interface DouyinAnalysisLike {
    meta: DouyinMetaLike;
    storyboard?: DouyinStoryboardLike;
    audioPath?: string;
}
/** dshBili 暴露的服务（只依赖这一小部分） */
export interface DouyinServiceLike {
    douyinMeta?: (input: string) => Promise<DouyinMetaLike>;
    douyinAnalyze?: (input: string) => Promise<DouyinAnalysisLike>;
}
export interface DouyinLinkOptions {
    ctx: Context;
    enabled: boolean;
    log: (level: 'debug' | 'info' | 'warn', message: string) => void;
}
/** 从一段文本里抽第一个抖音链接 */
export declare function extractDouyinLink(text: string): string | undefined;
/** 注入给模型的上下文块（纯函数，方便单测） */
export declare function formatDouyinBlock(meta: DouyinMetaLike, storyboard?: DouyinStoryboardLike): string;
export declare class DouyinLink {
    private readonly options;
    /** 最近解析过的链接（按会话），让"没 @ 我"时也能接上刚才的视频 */
    private readonly recent;
    private readonly cache;
    private readonly analysisCache;
    constructor(options: DouyinLinkOptions);
    private service;
    private meta;
    /** 抖音完整分析（带 15s 预算；失败退回元数据） */
    private analyze;
    /** 消息里有抖音链接就返回注入块（传 chatKey 时会记进"最近发过"） */
    blockFor(text: string, chatKey?: string): Promise<string | undefined>;
    /** 观察层：看到链接就后台解析一次（不阻塞回复） */
    note(chatKey: string, text: string, meta?: DouyinMetaLike): Promise<void>;
    /** 这个会话最近发过的抖音视频（10 分钟内） */
    recentOf(chatKey: string): {
        title: string;
        url: string;
        link: string;
    } | undefined;
}
