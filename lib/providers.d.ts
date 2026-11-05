/**
 * 数据源注册表（平台无关，2026-11-05）。
 *
 * 现在只有 B 站；以后加抖音/微博 = 再实现一个 FeedProvider 并注册，
 * 订阅表、轮询、推送全都不用改。
 *
 * 关键：这里**不点名**任何插件。B 站 provider 通过宿主服务 `dshBili` 取数据，
 * 没有该服务时 provider 就不注册（工具提示"没有可用的数据源"）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FeedItem, FeedProvider, FeedType } from './subscriptions.js';
/** dsh-bili 暴露的服务（只依赖这一小部分） */
export interface BiliServiceLike {
    resolveUp?: (target: string) => Promise<{
        mid: number;
        name: string;
        fans?: number;
    }>;
    upVideos?: (mid: number, page?: number, pageSize?: number) => Promise<Array<{
        bvid: string;
        title: string;
        pubdate: number;
        durationSec: number;
        url: string;
    }>>;
    upDynamics?: (mid: number, limit?: number) => Promise<Array<{
        id: string;
        type: string;
        text: string;
        pubdate: number;
        url: string;
        imageCount: number;
    }>>;
    search?: (query: string, options?: {
        page?: number;
        order?: string;
        duration?: number;
    }) => Promise<{
        hits: Array<{
            bvid: string;
            title: string;
            up: string;
            mid: number;
            play: number;
            durationSec: number;
            url: string;
        }>;
        total: number;
    }>;
}
export interface ProviderRegistryOptions {
    ctx: Context;
    log: (level: 'debug' | 'info' | 'warn', message: string) => void;
}
/** B 站 provider：数据来自 dshBili 服务 */
export declare class BiliFeedProvider implements FeedProvider {
    readonly id = "bili";
    readonly label = "B\u7AD9";
    private readonly service;
    constructor(service: BiliServiceLike);
    canHandle(target: string): boolean;
    resolve(target: string): Promise<{
        key: string;
        name: string;
        latestPubdate?: number;
    }>;
    latest(key: string, types: readonly FeedType[]): Promise<FeedItem[]>;
}
export declare class ProviderRegistry {
    private readonly options;
    private readonly providers;
    constructor(options: ProviderRegistryOptions);
    private service;
    /** 按需发现 provider（每次调用都检查，装上数据源后无需重启注册流程） */
    available(): FeedProvider[];
    /** 注册额外 provider（未来抖音等在这里加） */
    register(provider: FeedProvider): void;
    /**
     * 按输入挑 provider：
     *   1) 显式指定 id
     *   2) 能处理该输入的 provider（多个时取第一个）
     * 找不到返回 undefined（调用方给出"没有可用数据源"的提示，不点名插件）
     */
    pick(target: string, preferred?: string): FeedProvider | undefined;
    get(id: string): FeedProvider | undefined;
    labels(): string;
}
