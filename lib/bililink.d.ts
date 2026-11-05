/**
 * B 站链接 → "看过了"的上下文块。
 *
 * 目标（2026-11-04 与用户确认）：群友发链接时，机器人要能**接话/评价**，
 * 而不是回一张卡片或者复述简介。所以注入只给三类事实：
 *   ① 视频是谁发的、多长、多热
 *   ② 弹幕说明的"高光时段"（哪里被刷屏）
 *   ③ 被反复刷的弹幕（梗）
 * 然后明确要求：像看过一样随口聊，不要播报、不要贴链接。
 */
import type { Context } from '@deepseek-ai/cordis';
/** dshBili 暴露的服务（只依赖这一小部分） */
export interface BiliService {
    danmaku?: (input: string, options?: {
        cid?: number;
    }) => Promise<{
        info: {
            title: string;
            up: string;
            durationSec: number;
            pageUrl: string;
            stats?: {
                view?: number;
            };
        };
        summary: {
            total: number;
            density: number;
            peaks: Array<{
                startSec: number;
                endSec: number;
                count: number;
                samples: string[];
            }>;
            samples: string[];
        };
    }>;
    subtitle?: (input: string, options?: {
        maxChars?: number;
    }) => Promise<{
        text: string;
        bvid?: string;
    }>;
    /** 分镜图（返回绝对路径与时间轴） */
    storyboard?: (input: string) => Promise<{
        imagePath: string;
        title: string;
        durationSec: number;
        timeline: Array<{
            index: number;
            atSec: number;
            label: string;
        }>;
    }>;
}
export interface BiliBlockOptions {
    ctx: Context;
    enabled: boolean;
    log: (level: 'debug' | 'info' | 'warn', message: string) => void;
}
/** 从一段文本里抽第一个 B 站链接（BV / av / b23.tv / 带参数的完整 URL） */
export declare function extractBiliLink(text: string): string | undefined;
export interface BiliData {
    info: {
        title: string;
        up: string;
        durationSec: number;
        pageUrl: string;
        stats?: {
            view?: number;
        };
    };
    summary: {
        total: number;
        density: number;
        peaks: Array<{
            startSec: number;
            endSec: number;
            count: number;
            samples: string[];
        }>;
        samples: string[];
    };
    subtitleText?: string;
    /** 分镜图路径（给模型"看画面"，也方便通道直接发图） */
    storyboardPath?: string;
    storyboardTimeline?: Array<{
        index: number;
        label: string;
    }>;
}
/** 注入块：像看过一样聊天，而不是播报 */
export declare function buildBiliBlock(data: BiliData): string;
export interface BiliContextOptions {
    ctx: Context;
    enabled: boolean;
    /** 字幕最多取多少字（有字幕时补充） */
    subtitleChars: number;
    /** 是否抽分镜（需要 dsh-bili 的 storyboard 能力 + ffmpeg） */
    storyboard: boolean;
    log: (level: 'debug' | 'info' | 'warn', message: string) => void;
}
export declare class BiliLink {
    private readonly options;
    private lastWarnAt;
    constructor(options: BiliContextOptions);
    private service;
    /** 消息里有 B 站链接就返回注入块；失败/无服务静默返回 undefined */
    blockFor(text: string): Promise<string | undefined>;
}
