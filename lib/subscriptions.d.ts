export type FeedType = 'video' | 'dynamic';
export interface FeedItem {
    /** 平台内唯一 id（bvid / 动态 id …） */
    id: string;
    kind: FeedType;
    title: string;
    url: string;
    pubdate: number;
    extra?: string;
}
/** 一个数据源（B 站、抖音…）要实现的东西 */
export interface FeedProvider {
    /** 稳定标识，写进订阅记录，比如 bili */
    id: string;
    /** 展示名（日志/提示用） */
    label: string;
    /** 这个输入是不是本平台能处理的（链接、mid、名字…） */
    canHandle(target: string): boolean;
    /** 输入 → 稳定 key + 展示名（例如 mid + UP 名） */
    resolve(target: string): Promise<{
        key: string;
        name: string;
        latestPubdate?: number;
    }>;
    /** 拉最近内容（按发布时间倒序） */
    latest(key: string, types: readonly FeedType[]): Promise<FeedItem[]>;
}
export interface Subscription {
    id: string;
    /** provider id（bili / douyin …） */
    provider: string;
    /** provider 内部的稳定 key（B 站是 mid） */
    key: string;
    name: string;
    types: FeedType[];
    /** 推送目标（群），空数组 = 只进队列不主动推送 */
    groups: string[];
    lastSeenPubdate: number;
    recentIds: string[];
    failures: number;
    nextCheckAt: number;
    enabled: boolean;
    createdAt: number;
}
export interface QueueItem extends FeedItem {
    provider: string;
    providerLabel: string;
    subKey: string;
    subName: string;
    groups: string[];
    addedAt: number;
    deliveredTo: string[];
}
export interface SubscriptionStoreOptions {
    /** 数据目录，缺省 ~/.dsh/dsh-napcat/subscriptions */
    dir?: string;
    log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}
export declare class SubscriptionStore {
    private readonly options;
    private readonly subsFile;
    private readonly queueFile;
    private loaded;
    private subs;
    private queue;
    constructor(options?: SubscriptionStoreOptions);
    private log;
    load(): Promise<void>;
    private save;
    list(): Subscription[];
    find(id: string): Subscription | undefined;
    findByKey(provider: string, key: string): Subscription | undefined;
    upsert(input: {
        provider: string;
        key: string;
        name: string;
        types?: FeedType[];
        groups?: string[];
        lastSeenPubdate?: number;
        now?: number;
    }): Promise<{
        subscription: Subscription;
        created: boolean;
    }>;
    remove(identifier: {
        id?: string;
        provider?: string;
        key?: string;
        group?: string;
    }): Promise<number>;
    update(subscription: Subscription): Promise<void>;
    due(now?: number, limit?: number): Subscription[];
    pending(consumer?: string, limit?: number, target?: string): QueueItem[];
    ack(ids: readonly string[], consumer: string, keep?: number): Promise<void>;
    /**
     * 启动清理（2026-11-13）：
     *   ① 丢掉 `groups` 为空的订阅（用户确认过：这类"只进队列不推送"的订阅是历史尾巴，没人要）
     *   ② 丢掉 subKey 已不存在于订阅表的队列项（孤儿）
     *   ③ 丢掉超过 maxAgeMs 的旧队列项（默认 24h；旧内容再推出去只会是噪音）
     * 只写变化过的文件，返回实际删掉的条数，供调用方打日志。
     */
    pruneStale(options?: {
        maxAgeMs?: number;
        now?: number;
    }): Promise<{
        subs: number;
        orphans: number;
        expired: number;
    }>;
    push(items: readonly Omit<QueueItem, 'addedAt' | 'deliveredTo'>[]): Promise<number>;
}
export interface PollOptions {
    store: SubscriptionStore;
    provider: FeedProvider;
    intervalMinutes: number;
    backoffMinutes?: number[];
    log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}
export interface PollResult {
    subscription: Subscription;
    added: number;
    error?: string;
}
/** 检查一个订阅：拉最新 → 与基线比较 → 写队列 */
export declare function pollSubscription(subscription: Subscription, options: PollOptions): Promise<PollResult>;
