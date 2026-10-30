/**
 * 主动发言（伪人模式）决策引擎。
 *
 * 设计参考（均为开源实现的做法）：
 * - revive-companion：不用固定间隔/纯随机，而用**泊松过程**决定"此刻要不要考虑说话"
 *   （p = 1 - e^(-λ·t)，λ = 每小时期望次数），间隔自然不均；带冷却与静默时段。
 * - koishi-plugin-imx：复读插话用 threshold + chance（0~1）双层控制。
 * - chat-learning：同一内容重复回复有冷却，且按群隔离。
 * - QQ 官方主动消息频控：每群 20 qpm、1000 条/群/天 → 我们保守得多（每小时 ≤ 3 条）。
 *
 * 本文件只做**判定**，不发送任何消息；发送与 __SKIP__ 拦截在 bridge 里。
 */
export interface ProactiveOptions {
    enabled: boolean;
    /** 泊松 λ：每小时期望主动次数（0 = 用固定概率模式） */
    ratePerHour: number;
    /** 固定概率模式：每条群消息触发一次掷骰（0~1；ratePerHour>0 时不用它） */
    chance: number;
    /** 两次主动发言的最小间隔（分钟） */
    cooldownMinutes: number;
    /** 每小时上限 */
    maxPerHour: number;
    /** 静默时段，如 "00:00-08:00,12:00-13:00" */
    quietHours: string;
    /** 近窗口内至少多少条他人消息才考虑（太少=没人聊，别插话） */
    minMessages: number;
    /** 观察窗口（分钟） */
    windowMinutes: number;
    /** 最后一条他人消息距今超过多少秒就不再开口（默认 120；0=不限） */
    freshSeconds?: number;
}
export interface ChatProactiveState {
    /** 上次成功发言时间（ms） */
    lastSpokeAt: number;
    /** 最近一小时内的发言时间（ms） */
    sentAt: number[];
    /** 连续被模型 __SKIP__ 的次数（用于退避） */
    skipStreak: number;
    /** 上次跳过的时间（ms）；太久没跳过就把退避清零，避免永久变安静 */
    lastSkipAt?: number;
    /** 上次"考虑"的时间（ms） */
    lastConsiderAt: number;
}
export interface Decision {
    send: boolean;
    reason: string;
}
/** 解析 "HH:MM-HH:MM,HH:MM-HH:MM" 为分钟区间（支持跨天段，如 23:00-07:00）。 */
export declare function parseQuietHours(raw: string): Array<[number, number]>;
/** 现在（本地分钟的当日偏移）是否落在静默时段内。 */
export declare function inQuietHours(minuteOfDay: number, ranges: ReadonlyArray<[number, number]>): boolean;
/**
 * 泊松命中概率：距上次"考虑"过了 elapsedMs，这段时间内至少命中一次的概率。
 * λ 用每小时期望次数换算成每毫秒，p = 1 - e^(-λt)。
 */
export declare function poissonHit(ratePerHour: number, elapsedMs: number): number;
/**
 * 连续 skip 后的退避：第 n 次连续跳过把 λ 减半，**下限 1/2**。
 * 旧实现退到 1/8，一次「闭嘴」就可能让机器人安静几个小时（2026-10-29 线上反馈）。
 */
export declare function skipBackoffFactor(skipStreak: number): number;
export declare function newChatState(): ChatProactiveState;
export declare function pruneSentAt(sentAt: number[], now: number): number[];
/**
 * 判定这次要不要主动说话。调用方负责在真正发言后 recordSpoke、被 SKIP 后 recordSkip。
 * @param recentOthers 观察窗口内的他人消息条数（调用方统计）
 */
export declare function decide(input: {
    now: number;
    minuteOfDay: number;
    options: ProactiveOptions;
    state: ChatProactiveState;
    recentOthers: number;
    /** 最后一条他人消息的时间（ms）：群里刚还在聊才考虑开口 */
    lastMessageAt?: number;
    random?: () => number;
    quietRanges?: ReadonlyArray<[number, number]>;
}): Decision;
