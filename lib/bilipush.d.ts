/**
 * B 站 UP 更新 → QQ 群推送（dsh-napcat 侧，2026-11-05）。
 *
 * 解耦设计：napcat 只是 outbox 的一个消费方，自己定时来取；
 *   - dsh-bili 没装 → 静默跳过（ctx.get('dshBili') 拿不到服务）
 *   - 取到后发消息，再 ack(id, 'napcat:<chatKey>')，避免重复推
 *   - 推送只发到订阅里指定的群（outbox 条目自带 groups）
 */
import type { Context } from '@deepseek-ai/cordis';
/** 队列条目（来自 subscriptions.ts 的 QueueItem，这里只取用得到的字段） */
export interface BiliOutboxItem {
    id: string;
    kind: 'video' | 'dynamic';
    title: string;
    url: string;
    pubdate: number;
    groups: string[];
    subName: string;
    providerLabel: string;
    extra?: string;
}
/** dsh-bili 暴露的订阅服务（只依赖这一小部分） */
export interface BiliSubService {
    pending?: (consumer?: string, limit?: number, target?: string) => BiliOutboxItem[];
    ack?: (ids: string[], consumer: string) => Promise<void>;
}
export interface BiliPushOptions {
    ctx: Context;
    enabled: boolean;
    /** 单次最多推几条 */
    maxPerPush: number;
    /** 免打扰时段（"00:00-08:00"），复用 napcat 的解析 */
    quietRanges: ReadonlyArray<[number, number]>;
    log: (level: 'debug' | 'info' | 'warn', message: string) => void;
}
declare function clockOf(seconds: number): string;
/** 把若干条更新拼成一条群消息 */
export declare function formatPush(items: readonly BiliOutboxItem[]): string;
export declare class BiliPusher {
    private readonly options;
    constructor(options: BiliPushOptions);
    private service;
    /** 是否有可推送的内容（供 tick 判断，不发请求） */
    hasService(): boolean;
    /**
     * 取某个会话的待推送内容（不发消息，交给调用方决定怎么发）。
     * @param chatKey 例如 group:660610917
     */
    take(chatKey: string): {
        items: BiliOutboxItem[];
        consumer: string;
    } | undefined;
    /** 发送成功后标记已投递 */
    ack(consumer: string, items: readonly BiliOutboxItem[]): Promise<void>;
    inQuietHours(minuteOfDay: number): boolean;
}
export { clockOf };
