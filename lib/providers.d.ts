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
    searchUser?: (query: string) => Promise<Array<{
        mid: number;
        name: string;
        fans?: number;
    }>>;
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
    /** 空间接口风控剩余时间（ms），0=正常 */
    spaceRiskRemainingMs?: () => number;
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
    /** 最近一次失败原因（供上层日志） */
    lastError: string;
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
     *   2) canHandle 认得的（链接 / id 这类强特征）
     *   3) 都不认得时（例如中文名字）：**逐个尝试 resolve**，谁认得算谁的
     * 这样"订阅半佛仙人"也能落到 B 站，而不是报"没有可用的数据源"。
     */
    resolveTarget(target: string, preferred?: string): Promise<{
        provider: FeedProvider;
        resolved: {
            key: string;
            name: string;
            latestPubdate?: number;
        };
    } | undefined>;
    /** 同步挑选（只按强特征，给不需要解析的场景用） */
    pick(target: string, preferred?: string): FeedProvider | undefined;
    get(id: string): FeedProvider | undefined;
    labels(): string;
}
