/**
 * 主动发言（伪人模式）决策引擎。
 *
 * 设计参考（均为开源实现的做法）：
 * - revive-companion：不用固定间隔/纯随机，而用**泊松过程**决定"此刻要不要考虑说话"
 *   （p = 1 - e^(-λ·t)，λ = 每小时期望次数），间隔自然不均；带冷却与静默时段。
 * - koishi-plugin-imx：复读插话用 threshold + chance（0~1）双层控制。
 * - chat-learning：同一内容重复回复有冷却，且按群隔离。
 * - QQ 官方主动消息频控：每群 20 qpm、1000 条/群/天 → 我们保守得多。
 *
 * 配置只留 5 个（其余全部由这 5 个推导，避免互相打架）：
 *   开关 / 频率 λ / 最小间隔 / 静默时段 / 话题门槛
 *
 * 本文件只做**判定**，不发送任何消息；发送与 __SKIP__ 拦截在 bridge 里。
 */
const SMALL_TALK = [
    /^(早|早安|早上好|晚安|晚上好|午安|在吗|在不在|在么|有人吗|来了|签到|打卡)$/,
    /^(哈+|h+|呵+|嘿+|233+|6+|1+|0+|草+|笑死|xs|awsl|好家伙|确实|可以|行吧|收到|ok|okay)$/i,
    /^[。！？、，…~～\s]+$/,
    /^\[(表情|图片|动画表情|戳一戳|骰子|猜拳)\]$/,
];
/** 一条消息是不是"寒暄/刷屏"（0 分） */
export function isSmallTalk(text) {
    const clean = text.trim();
    if (clean === '')
        return true;
    if (clean.length === 1)
        return SMALL_TALK.some(pattern => pattern.test(clean));
    return SMALL_TALK.some(pattern => pattern.test(clean));
}
const QUESTION_HINT = /[?？]|怎么|为什么|为啥|在哪|哪个|多少|能不能|可以吗|有没有|求推荐|求助|有人知道/i;
/** 单条消息的信息量（0~4 分） */
export function messageScore(message, options = {}) {
    const text = message.text.replace(/\[图片:[^\]]*\]|\[文件:[^\]]*\]|\[视频:[^\]]*\]/g, '').trim();
    // 寒暄给 0.5 分而不是 0：纯寒暄也保留偶尔插一句的可能，只是热量涨得很慢
    if (isSmallTalk(text) && message.hasMedia !== true)
        return 0.3;
    let score = 1;
    if (text.length >= 5)
        score += 1;
    if (QUESTION_HINT.test(text))
        score += 1;
    const terms = options.terms;
    if (terms !== undefined && terms(text))
        score += 1;
    if (message.hasMedia === true)
        score += 1;
    return score;
}
/**
 * 窗口热量分。
 * - 分母 2.5：约 6 条认真讨论就能进"热聊"档，纯寒暄永远是 0
 * - cap 10：避免消息暴刷把概率推到 1
 */
export function scoreHeat(messages, options = {}) {
    const lowMax = options.lowMax ?? 2;
    const hotMin = options.hotMin ?? 3;
    let sum = 0;
    let effective = 0;
    let question = false;
    let onlySmallTalk = messages.length > 0;
    const senders = new Set();
    for (const message of messages) {
        const score = messageScore(message, options);
        sum += score;
        // "有效"按"有信息量"算：寒暄 0.3 分不算有效（但也不禁止发言，只是低档）
        if (score >= 1) {
            effective += 1;
            if (QUESTION_HINT.test(message.text))
                question = true;
        }
        const text = message.text.replace(/\[(图片|文件|视频):[^\]]*\]/g, '').trim();
        if (message.hasMedia !== true && !isSmallTalk(text))
            onlySmallTalk = false;
        if (message.sender !== undefined && message.sender !== '')
            senders.add(message.sender);
    }
    const heat = Math.min(10, Math.round(sum / 2.5));
    const tier = heat >= hotMin ? 'hot' : heat < lowMax ? 'low' : 'normal';
    return {
        messages: messages.length,
        effective,
        heat,
        participants: senders.size,
        unansweredQuestion: question,
        allSmallTalk: onlySmallTalk,
        tier,
    };
}
export const TIERS = {
    low: { ratePerHour: 1, cooldownMinutes: 10, capPerHour: 1, label: '寒暄档' },
    normal: { ratePerHour: 3, cooldownMinutes: 4, capPerHour: 3, label: '闲聊档' },
    hot: { ratePerHour: 8, cooldownMinutes: 3, capPerHour: 6, label: '热聊档' },
};
export function tierParamsOf(tier) {
    return TIERS[tier];
}
/** 观察窗口 = max(5 分钟, 最小间隔)：间隔越长，看的窗口也越长（不再单独配）。 */
export function windowMsOf(options) {
    return Math.max(5, Math.max(1, options.cooldownMinutes)) * 60_000;
}
/** 每小时上限由最小间隔推导：间隔 10 分钟 → 6 条/小时（另加 1 次热点跳队）。 */
export function maxPerHourOf(options) {
    const cooldown = Math.max(1, options.cooldownMinutes);
    return Math.max(1, Math.floor(60 / cooldown) + 1);
}
/** 热点窗口固定 3 分钟；跳队阈值 = 门槛 × 1.5（不低于 6 条）。 */
export const HOT_WINDOW_MS = 3 * 60_000;
export function hotJumpThresholdOf(options) {
    return Math.max(6, Math.ceil(Math.max(0, options.hotMessages) * 1.5));
}
/** 冷场门固定 120 秒：最后一条消息超过它就说明群里已经安静了。 */
export const FRESH_SECONDS = 300;
/** 解析 "HH:MM-HH:MM,HH:MM-HH:MM" 为分钟区间（支持跨天段，如 23:00-07:00）。 */
export function parseQuietHours(raw) {
    const ranges = [];
    for (const part of raw.split(/[,，;；]/)) {
        const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
        if (match === null)
            continue;
        const start = Number(match[1]) * 60 + Number(match[2]);
        const end = Number(match[3]) * 60 + Number(match[4]);
        if (start === end)
            continue;
        ranges.push([start, end]);
    }
    return ranges;
}
/** 现在（本地分钟的当日偏移）是否落在静默时段内。 */
export function inQuietHours(minuteOfDay, ranges) {
    for (const [start, end] of ranges) {
        if (start < end) {
            if (minuteOfDay >= start && minuteOfDay < end)
                return true;
        }
        else {
            // 跨天：23:00-07:00
            if (minuteOfDay >= start || minuteOfDay < end)
                return true;
        }
    }
    return false;
}
/**
 * 泊松命中概率：距上次"考虑"过了 elapsedMs，这段时间内至少命中一次的概率。
 * λ 用每小时期望次数换算成每毫秒，p = 1 - e^(-λt)。
 */
export function poissonHit(ratePerHour, elapsedMs) {
    if (ratePerHour <= 0)
        return 0;
    const lambdaPerMs = ratePerHour / 3_600_000;
    const probability = 1 - Math.exp(-lambdaPerMs * Math.max(0, elapsedMs));
    return Math.min(1, Math.max(0, probability));
}
/**
 * 连续 skip 后的退避：第 n 次连续跳过把 λ 减半，**下限 1/2**。
 * 旧实现退到 1/8，一次「闭嘴」就可能让机器人安静几个小时（2026-10-29 线上反馈）。
 */
export function skipBackoffFactor(skipStreak) {
    if (skipStreak <= 0)
        return 1;
    return 1 / Math.min(2, 2 ** skipStreak);
}
export function newChatState() {
    return { lastSpokeAt: 0, sentAt: [], skipStreak: 0, lastConsiderAt: 0 };
}
export function pruneSentAt(sentAt, now) {
    return sentAt.filter(at => now - at < 3_600_000);
}
/**
 * 判定这次要不要主动说话。调用方负责在真正发言后 recordSpoke、被 SKIP 后 recordSkip。
 * @param recentOthers 观察窗口内的他人消息条数（调用方统计）
 */
export function decide(input) {
    const { now, options, state } = input;
    const random = input.random ?? Math.random;
    if (!options.enabled)
        return { send: false, reason: 'disabled' };
    const quietRanges = input.quietRanges ?? parseQuietHours(options.quietHours);
    if (inQuietHours(input.minuteOfDay, quietRanges))
        return { send: false, reason: 'quiet-hours' };
    // 档位：热量自适应开启且拿到热量分时用三档参数，否则沿用配置里的固定值
    const scaling = options.heatScaling !== false && input.heat !== undefined;
    const tier = scaling ? tierParamsOf(input.heat.tier) : undefined;
    const cooldownMinutes = tier?.cooldownMinutes ?? options.cooldownMinutes;
    const capPerHour = tier?.capPerHour ?? maxPerHourOf(options);
    // 冷却门：默认闭嘴（防刷屏）。但"突然爆话题"时允许提前插一次，
    // 否则最热的那几分钟永远被冷却锁着（2026-10-30 线上：11:04 那波 20 条全错过）。
    // 跳队限流：一小时最多一次，且仍要过下面的每小时上限。
    if (state.lastSpokeAt !== 0 && now - state.lastSpokeAt < cooldownMinutes * 60_000) {
        const recentHot = input.recentHot ?? 0;
        const lastJump = state.hotJumpAt ?? 0;
        const jumpable = recentHot >= hotJumpThresholdOf(options) && (lastJump === 0 || now - lastJump > 60 * 60_000);
        if (!jumpable)
            return { send: false, reason: 'cooldown' };
    }
    const sent = pruneSentAt(state.sentAt, now);
    if (sent.length >= capPerHour)
        return { send: false, reason: 'hourly-cap' };
    // 话题门槛：热量自适应下用热量分判断（寒暄刷屏 heat=0 直接不插话），
    // 否则沿用旧的"窗口内消息条数"门槛。
    if (scaling) {
        const heat = input.heat;
        if (input.recentOthers < 1) {
            return { send: false, reason: 'not-enough-chatter' };
        }
    }
    else if (options.hotMessages > 0 && input.recentOthers < options.hotMessages) {
        return { send: false, reason: 'not-enough-chatter' };
    }
    // 冷场门：最后一条消息太久以前 = 群里已经安静，别自言自语（阈值可配，默认 300 秒）
    const freshSeconds = options.freshSeconds ?? FRESH_SECONDS;
    if (freshSeconds > 0 && input.lastMessageAt !== undefined && input.lastMessageAt > 0) {
        if (now - input.lastMessageAt > freshSeconds * 1000)
            return { send: false, reason: 'stale-chat' };
    }
    // 概率：优先泊松（自然间隔），否则固定 chance。
    // elapsed 封顶 60 秒：空闲很久之后 elapsed 会把概率推到接近 1，表现为「憋一会儿然后连着说」；
    // 封顶后每轮评估概率恒定，配合 60 秒定时评估 = 稳定速率（不再集中爆发）。
    const elapsedRaw = state.lastConsiderAt === 0 ? 60_000 : now - state.lastConsiderAt;
    const elapsed = Math.min(60_000, Math.max(0, elapsedRaw));
    const baseRate = tier?.ratePerHour ?? options.ratePerHour;
    if (baseRate <= 0)
        return { send: false, reason: 'rate-zero' };
    // 没开热量自适应时保留旧的"聊得越热闹机会越多"（1~3 倍）
    const boost = scaling ? 1 : Math.min(3, Math.max(1, 1 + input.recentOthers / 8));
    const probability = poissonHit(baseRate * boost * skipBackoffFactor(state.skipStreak), elapsed);
    return random() < probability ? { send: true, reason: 'poisson' } : { send: false, reason: 'poisson-miss' };
}
