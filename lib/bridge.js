/**
 * QQ 会话 ↔ dsh agent 的桥。
 *
 * 入站：OneBot 消息事件 → 策略/门控 → 每个会话一个 agent → `agent.followup(用户消息)`
 * 出站：订阅会话事件（`session/event`）→ 回合结束时把助手文本按长度分段发回 QQ
 *
 * 会话 id 由 QQ 会话确定性地派生（`napcat-private-<QQ>` / `napcat-group-<群号>`），
 * 重启后 create 失败即回退 resume，于是同一 QQ 会话自动续上上下文。
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';
import { allowAccess, chatRefOf, isAdmin, sessionIdForChat } from './chat.js';
import { buildRefusalPrompt, cleanRefusal, detectDanger } from './danger.js';
import { findKeyword, mentions, parsePersonaOverrides, repliesToAny, segmentsOf, shortHash, stripKeyword, titleFrom, toText } from './text.js';
import { MemoryStore } from './memory.js';
import { ImageCache } from './imagecache.js';
import { buildArchivePrompt, parseArchivePayload } from './archive.js';
import { faceFor } from './faces.js';
import { defaultMemeDirs, MemeLibrary, readMemeSettings } from './meme.js';
import { localToBase64Url } from './media.js';
import { decide, FRESH_SECONDS, HOT_WINDOW_MS, inQuietHours, maxPerHourOf, newChatState, parseQuietHours, pruneSentAt, windowMsOf } from './proactive.js';
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_IMAGE_BYTES, base64UrlToBuffer, downloadToFile, ensureInbox, imageMediaType, nameFromRef } from './media.js';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
/** 投递后多久没收到 turn/start 就判定会话失效。 */
const WATCHDOG_MS = 10000;
export class Bridge {
    opts;
    /** 群/私聊记忆（一群一目录 + mnemon 长期记忆）。 */
    mem;
    /** 已尝试预热的聊天（每会话一次）。 */
    /** 上次预热尝试时间（避免频繁重试）。 */
    warmAttempts = new Map();
    chats = new Map();
    bySession = new Map();
    /** 归档/失效后换用新会话 id 的后缀（下次建会话时带上）。 */
    sessionSuffixes = new Map();
    /** sessionId → 该会话的人设文本（来自 personaOverrides）。 */
    personaBySession = new Map();
    /** 解析后的人设表（chat key → 文本）。 */
    personas = parsePersonaOverrides('');
    sessionEventOff;
    stopped = false;
    mentionWarned = false;
    constructor(opts) {
        this.opts = opts;
        this.mem = new MemoryStore({
            ctx: opts.ctx,
            root: normalizePath(join(normalizePath(opts.config.workspacePath) || process.cwd(), 'memory')),
            spacePrefix: opts.config.memorySpacePrefix,
            backend: opts.config.memoryBackend,
            autoCapture: opts.config.memoryAutoCapture,
            spaces: opts.config.memorySpaces,
            recentLimit: opts.config.recentLimit,
            injectRecent: opts.config.injectRecent,
            injectMaxChars: opts.config.injectMaxChars,
            log: opts.log,
        });
        this.refreshPersonas();
    }
    start() {
        this.stopped = false;
        this.sessionEventOff = this.opts.ctx.on('session/event', (session, event) => {
            this.onSessionEvent(session, event);
        });
        // 归档定时器：60 秒检查一次。不 unref（进程常驻，unref 只影响退出，别让定时器变成孤儿）
        this.archiveTimer = setInterval(() => { void this.archiveTick(); }, 60_000);
        // 主动发言：每 60 秒补一次评估（冷清群靠消息触发会很久才掷一次骰子）
        this.proactiveTimer = setInterval(() => { void this.proactiveTick(); }, 60_000);
        // 运行心跳：即使什么也没发生，也每 N 分钟打一条状态摘要
        this.stats.startedAt = Date.now();
        this.stats.lastHeartbeatAt = Date.now();
        this.heartbeatTimer = setInterval(() => { this.heartbeatTick(); }, 60_000);
        setTimeout(() => { void this.archiveTick(); }, 5_000);
        void this.restoreArchivePending();
        void this.logMemeLibrary();
        this.opts.log('info', '归档定时器已启动（每 60 秒检查；群空闲 ' + String(this.opts.config.archiveIdleMinutes) + ' 分钟后执行）');
        this.opts.log('info', '桥已就绪（每个 QQ 会话一个 agent）');
    }
    async stop() {
        this.stopped = true;
        if (this.archiveTimer !== undefined) {
            clearInterval(this.archiveTimer);
            this.archiveTimer = undefined;
        }
        if (this.proactiveTimer !== undefined) {
            clearInterval(this.proactiveTimer);
            this.proactiveTimer = undefined;
        }
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        this.sessionEventOff?.();
        this.sessionEventOff = undefined;
        // 归档会话与收集器一并释放（否则 stop 后还留着事件监听）
        for (const collector of this.archiveCollectors.values()) {
            clearTimeout(collector.timer);
            collector.resolve('');
        }
        this.archiveCollectors.clear();
        const archiveAgents = [...this.archiveAgents.values()];
        this.archiveAgents.clear();
        for (const handle of archiveAgents) {
            try {
                await handle.dispose();
            }
            catch {
                // 单个失败不影响其它
            }
        }
        const states = [...this.chats.values()];
        this.chats.clear();
        this.bySession.clear();
        for (const state of states) {
            try {
                await state.dispose();
            }
            catch {
                // 单个会话 dispose 失败不影响其它会话
            }
        }
    }
    /** 一条 OneBot 事件进站。 */
    async handleEvent(event) {
        try {
            await this.handleEventInner(event);
        }
        catch (error) {
            let cwd;
            try {
                const ref = chatRefOf(event);
                if (ref !== undefined)
                    cwd = join(normalizePath(this.opts.config.workspacePath) || process.cwd(), 'napcat', (ref.kind === 'group' ? 'group-' : 'private-') + ref.id);
            }
            catch {
                // 取不到就写默认位置
            }
            this.debugLog(cwd, '出站异常: ' + describe(error));
            throw error;
        }
    }
    // ── 群聊图片缓存 ──
    /** 每个 cwd 一个图片缓存（配额/清理按 cwd 独立）。 */
    imageCaches = new Map();
    /** 已经清理过过期目录的 cwd。 */
    imageCacheSwept = new Set();
    /** 危险请求拒绝提示的节流时间（每会话 10 分钟一次，避免刷屏）。 */
    dangerNoticeAt = new Map();
    imageCacheFor(cwd) {
        const existing = this.imageCaches.get(cwd);
        if (existing !== undefined)
            return existing;
        const cache = new ImageCache({
            cwd,
            maxBytes: this.opts.config.imageCacheMaxBytes,
            dailyCap: this.opts.config.imageCacheDailyCap,
            retentionDays: this.opts.config.imageCacheRetentionDays,
            log: this.opts.log,
        });
        this.imageCaches.set(cwd, cache);
        if (!this.imageCacheSwept.has(cwd)) {
            this.imageCacheSwept.add(cwd);
            void cache.sweep().then(removed => {
                if (removed > 0)
                    this.opts.log('info', '清理过期图片缓存目录 ' + removed + ' 个: ' + cwd);
            });
        }
        return cache;
    }
    /**
     * 观察层用：把消息里的图片落盘（imageCache=all 时），并把文件名写进聊天记录，
     * 这样之后能用 read_image 回头看群里的图/表情包。
     */
    async prepareRecentText(ref, msg, rawText, nick) {
        const segments = segmentsOf(msg.message);
        const images = segments.filter(seg => seg.type === 'image');
        const faces = segments.filter(seg => seg.type === 'face' || seg.type === 'mface');
        if (this.opts.config.imageCache === 'off') {
            return faces.length > 0 ? rawText.replace(/\[表情\]/g, '[表情]') : rawText;
        }
        if (images.length === 0 && faces.length === 0)
            return rawText;
        let cwd = normalizePath(this.opts.config.workspacePath);
        try {
            cwd = await this.cwdFor(ref);
        }
        catch {
            // 用工作区根目录兜底
        }
        const cache = this.imageCacheFor(cwd);
        for (const face of faces.slice(0, 3)) {
            const name = String(face.data.name ?? face.data.id ?? '');
            if (name !== '')
                void cache.noteFace(ref.key, nick, name);
        }
        const saved = [];
        for (const seg of images.slice(0, 3)) {
            const fileRef = String(seg.data.file ?? '');
            if (fileRef === '')
                continue;
            try {
                const info = await this.opts.conn.call('get_image', { file: fileRef });
                const url = info?.url;
                if (typeof url !== 'string' || url === '')
                    continue;
                const hit = await cache.save({ url, chatKey: ref.key, nick, name: nameFromRef(fileRef, 'image.png') });
                // 写成相对工作目录的路径，模型才能用 read_image 直接打开（只写文件名是打不开的）
                if (hit !== undefined)
                    saved.push(relative(cwd, hit.path).replace(/\\/g, '/'));
            }
            catch (error) {
                this.opts.log('debug', '图片缓存失败（已跳过）: ' + (error instanceof Error ? error.message : String(error)));
            }
        }
        if (saved.length === 0)
            return rawText;
        return rawText.replace(/\[图片\]/g, '') + ' [图片:' + saved.join(',') + ']';
    }
    // ── 主动发言（伪人模式）──
    /** 每聊天的主动发言状态。 */
    proactiveStates = new Map();
    /** 该聊天最近「他人消息」的时间戳（观察窗口内计数用）。 */
    chatter = new Map();
    /** 首次计数时用历史缓冲回填窗口的 promise：判定前要等它，否则重启后会误判「只有 1 条」。 */
    chatterReady = new Map();
    /** 已投递主动发言请求、等待回复拦截的聊天。 */
    pendingProactive = new Set();
    /** 每次主动发言的投递时间（用于超时清理，避免卡死后再也不插话） */
    proactiveStartedAt = new Map();
    /** 群禁言到什么时候（毫秒）：期间不发消息，也跳过主动发言。 */
    mutedUntil = new Map();
    /** 表情库（懒加载）。 */
    memeLibrary;
    /** 表情库目录摘要缓存（TTL 60 秒，图库变了能自动更上）。 */
    memeCatalogCache;
    /** 归档定时器与运行时状态（独立静默会话，输出不进 QQ）。 */
    archiveTimer;
    /** 主动发言的定时评估器（每 60 秒扫一遍有动静的群） */
    proactiveTimer;
    /** 运行心跳：每 N 分钟打一条状态摘要（用来区分"没人说话"和"出故障了"） */
    heartbeatTimer;
    stats = {
        startedAt: Date.now(),
        messages: 0,
        groupMessages: 0,
        privateMessages: 0,
        dispatched: 0,
        sent: 0,
        proactiveSent: 0,
        proactiveSkipped: 0,
        lastMessageAt: 0,
        lastHeartbeatAt: 0,
        quietWarnedAt: 0,
    };
    archiveAgents = new Map();
    archiveRunning = new Set();
    archiveLastActivity = new Map();
    archiveCollectors = new Map();
    /** 最近发过的原生表情 id（避免同一句描述永远同一个表情）。 */
    recentFaceIds = [];
    /** 最近用过的表情描述（注入给模型，提示它别连着用同一个）。 */
    recentMemeCaptions = [];
    /** 待处理的归档批次（素材路径/条数/时间范围），随下一轮回复一起产出归档 JSON。 */
    archivePending = new Map();
    /** 各聊天连续几条回复没带表情（到阈值就在注入里轻推一把）。 */
    repliesSinceMeme = new Map();
    /** 归档连续几轮没产出（到 3 就丢弃重建）。 */
    archiveMiss = new Map();
    /** 最近发过的表情文件（避免连续重复同一张）。 */
    recentMemeFiles = [];
    /** 机器人自己的 QQ（配置没填时用 get_login_info 取一次后缓存）。 */
    selfQqCache = '';
    /** 上次「被硬门挡住」的提示时间（防刷屏，每群 10 分钟一条）。 */
    proactiveNoticeAt = new Map();
    /** 评估计数（每群：窗口内评估次数 + 最后一次未中原因），用于 30 分钟一条诊断 */
    proactiveEval = new Map();
    /** 记录一条他人消息（供主动发言判断"有没有人在聊"）。 */
    noteChatter(ref) {
        const now = Date.now();
        const windowMs = windowMsOf({ cooldownMinutes: this.opts.config.proactiveCooldownMinutes });
        const cached = this.chatter.get(ref.key);
        const list = (cached ?? []).filter(at => now - at < windowMs);
        list.push(now);
        this.chatter.set(ref.key, list);
        // 重启后第一次计数：用缓冲里的历史时间戳补齐（否则"近 10 分钟"永远从 0 开始，刚重启就被拦）
        if (cached === undefined && this.opts.config.proactiveEnabled) {
            const seeding = this.mem.recentTimestamps(ref.key, 200).then(stamps => {
                const merged = [...stamps, ...(this.chatter.get(ref.key) ?? [])].filter(at => Date.now() - at < windowMs);
                merged.sort((left, right) => left - right);
                this.chatter.set(ref.key, merged);
            });
            this.chatterReady.set(ref.key, seeding.then(() => undefined, () => undefined));
        }
    }
    /**
     * 运行心跳（每 60 秒检查一次，按配置间隔打一条 info）：
     * 回答"现在到底什么情况"——连没连上、收了多少消息、回复了几轮、主动发言开没开。
     */
    heartbeatTick() {
        const minutes = Math.floor(this.opts.config.heartbeatMinutes);
        if (minutes <= 0)
            return;
        const now = Date.now();
        if (now - this.stats.lastHeartbeatAt < minutes * 60_000)
            return;
        this.stats.lastHeartbeatAt = now;
        const upMin = Math.round((now - this.stats.startedAt) / 60_000);
        const connected = this.opts.conn.connected;
        const idleSec = this.stats.lastMessageAt === 0
            ? Math.round((now - this.stats.startedAt) / 1000)
            : Math.round((now - this.stats.lastMessageAt) / 1000);
        const cfg = this.opts.config;
        const proactive = cfg.proactiveEnabled
            ? '开(λ=' + cfg.proactiveRatePerHour + '，已发 ' + this.stats.proactiveSent + '，跳过 ' + this.stats.proactiveSkipped + ')'
            : '关';
        this.opts.log('info', '[心跳] 运行 ' + upMin + ' 分钟 · NapCat ' + (connected ? '已连接' : '未连接')
            + ' · 收消息 ' + this.stats.messages + '（群 ' + this.stats.groupMessages + ' / 私聊 ' + this.stats.privateMessages + '）'
            + ' · 已回复 ' + this.stats.sent + ' 轮 · 主动发言 ' + proactive
            + ' · 距上条消息 ' + idleSec + ' 秒 · 会话 ' + this.chats.size + ' 个');
        // 连着却长时间没消息：最常见的故障（NapCat 没把群消息上报过来）。
        // 三段门避免夜里/静默时段误报：
        //   ① 静默时段（proactiveQuietHours，默认 00:00-08:00）不告警
        //   ② 从没收到过任何消息不告警（刚启动/刚装，那是配置问题不是故障）
        //   ③ 距上次告警至少 30 分钟
        const nowLocal = new Date(now);
        const quietNow = inQuietHours(nowLocal.getHours() * 60 + nowLocal.getMinutes(), parseQuietHours(cfg.proactiveQuietHours));
        if (connected
            && !quietNow
            && this.stats.messages > 0
            && idleSec > Math.max(1800, minutes * 120)
            && now - this.stats.quietWarnedAt > 30 * 60_000) {
            this.stats.quietWarnedAt = now;
            this.opts.log('warn', '连接正常但已经 ' + Math.round(idleSec / 60) + ' 分钟没收到任何消息：'
                + '检查 NapCat 是否把群消息上报给了这个插件（允许的群 / 上报事件类型）');
        }
    }
    /**
     * 定时评估：冷清群不能只靠"来一条消息掷一次骰子"，否则十几分钟才评估一次。
     * 每 60 秒扫一遍最近还有动静的群，交给同一套决策（内部有 20 秒节流与各类硬门）。
     */
    async proactiveTick() {
        const cfg = this.opts.config;
        if (!cfg.proactiveEnabled || this.stopped)
            return;
        const now = Date.now();
        const windowMs = windowMsOf({ cooldownMinutes: cfg.proactiveCooldownMinutes });
        // 遍历"有消息的群"而不是"已建会话的群"：
        // 会话只在被 @/命中关键字时才建，之前从 chatter 反推，导致没被叫过的群永远不评估
        // （2026-10-30 线上：收消息 13 条、会话 0 个 → 主动发言一次都没跑）。
        const keys = new Set([...this.chats.keys(), ...this.chatter.keys()]);
        for (const key of keys) {
            const ref = this.chats.get(key)?.ref ?? this.chatRefFromKey(key);
            if (ref === undefined || ref.kind !== 'group')
                continue;
            const recent = (this.chatter.get(key) ?? []).filter(at => now - at < windowMs);
            if (recent.length === 0)
                continue;
            try {
                await this.maybeInterject(ref, true);
            }
            catch (error) {
                this.opts.log('debug', '定时主动评估失败: ' + key + ' — ' + describe(error));
            }
        }
    }
    /**
     * 判断并（可能）主动插话。只在群里、且用户没叫它的时候调用。
     * 判定不通过就什么都不做；通过则投递一条 [主动发言] 请求，由模型决定说还是回 __SKIP__。
     */
    async maybeInterject(ref, fromTick = false) {
        const cfg = this.opts.config;
        if (!cfg.proactiveEnabled || ref.kind !== 'group')
            return;
        // 禁言期间不插话（发了也会被 QQ 拒）
        if ((this.mutedUntil.get(ref.key) ?? 0) > Date.now())
            return;
        const state = this.proactiveStates.get(ref.key) ?? newChatState();
        const now = Date.now();
        // 同群 20 秒内不重复评估：定时评估与消息触发会同时进来，避免重复掷骰子
        if (state.lastConsiderAt !== 0 && now - state.lastConsiderAt < 20_000)
            return;
        const windowMs = windowMsOf({ cooldownMinutes: cfg.proactiveCooldownMinutes });
        // 重启后的第一轮：等历史回填完成再判定，否则会拿"只有 1 条"去跟门槛比。
        // 一个群重启后还没人说话（chatter 里没有该 key）也主动补一次，别让计数一直空着。
        if (!this.chatter.has(ref.key) && !this.chatterReady.has(ref.key)) {
            const windowMs0 = windowMs;
            const seeding = this.mem.recentTimestamps(ref.key, 200).then(stamps => {
                const merged = stamps.filter(at => Date.now() - at < windowMs0);
                merged.sort((left, right) => left - right);
                this.chatter.set(ref.key, merged);
                this.opts.log('debug', '主动发言计数已按历史补齐 ' + ref.key + '：' + merged.length + ' 条');
            });
            this.chatterReady.set(ref.key, seeding.then(() => undefined, () => undefined));
        }
        const pendingSeed = this.chatterReady.get(ref.key);
        if (pendingSeed !== undefined) {
            await pendingSeed.catch(() => undefined);
        }
        const recentOthers = (this.chatter.get(ref.key) ?? []).filter(at => now - at < windowMs).length;
        // 只有定时 tick 掷骰子：消息触发时也掷的话，等于把 3 次/小时的速率放大成 8~10 次/小时
        if (!fromTick) {
            state.lastConsiderAt = now;
            this.proactiveStates.set(ref.key, state);
            return;
        }
        // 上一轮主动发言如果超过 3 分钟还没结束（模型卡住/事件丢失），把标记清掉，否则会永远不再评估
        const startedAt = this.proactiveStartedAt.get(ref.key);
        if (startedAt !== undefined && startedAt !== 0 && now - startedAt > 3 * 60_000) {
            this.pendingProactive.delete(ref.key);
            this.proactiveStartedAt.delete(ref.key);
            this.opts.log('warn', '上一轮主动发言超时未结束，已清理标记: ' + ref.key);
        }
        // 退避衰减：30 分钟没再跳过就清零（否则一次"闭嘴"会让它长期安静）
        if (state.skipStreak > 0 && state.lastSkipAt !== undefined && now - state.lastSkipAt > 30 * 60_000) {
            state.skipStreak = 0;
            this.proactiveStates.set(ref.key, state);
            this.opts.log('debug', '主动发言退避已清零（30 分钟没跳过）: ' + ref.key);
        }
        const local = new Date(now);
        // 只传 5 个字段：窗口 / 每小时上限 / 冷场门 / 跳队阈值全部由它们推导
        const options = {
            enabled: cfg.proactiveEnabled,
            ratePerHour: cfg.proactiveRatePerHour,
            cooldownMinutes: cfg.proactiveCooldownMinutes,
            quietHours: cfg.proactiveQuietHours,
            hotMessages: cfg.proactiveHotMessages,
        };
        const lastMessageAt = (this.chatter.get(ref.key) ?? []).at(-1) ?? 0;
        const decision = decide({
            now,
            minuteOfDay: local.getHours() * 60 + local.getMinutes(),
            options,
            state,
            recentOthers,
            lastMessageAt,
            recentHot: (this.chatter.get(ref.key) ?? []).filter(at => now - at < HOT_WINDOW_MS).length,
            quietRanges: parseQuietHours(cfg.proactiveQuietHours),
        });
        state.lastConsiderAt = now;
        if (decision.send && state.lastSpokeAt !== 0 && now - state.lastSpokeAt < cfg.proactiveCooldownMinutes * 60_000) {
            // 冷却期内还能发，说明走的是热点跳队：记时间，一小时只允许一次
            state.hotJumpAt = now;
            this.opts.log('info', '热点跳队：冷却期内破例一次: ' + ref.key);
        }
        this.proactiveStates.set(ref.key, state);
        if (!decision.send) {
            this.opts.log('debug', '主动发言不触发(' + decision.reason + '): ' + ref.key);
            // 统计：每群每 30 分钟最多一条 info，说明"评估了多少次、最后为什么没中"
            // 首次（at=0）不打印：刚重启时窗口内计数本来就少，打出来会误报"评估 1 次"
            const stat = this.proactiveEval.get(ref.key) ?? { count: 0, lastReason: '', at: now };
            stat.count += 1;
            stat.lastReason = decision.reason;
            if (now - stat.at > 30 * 60_000) {
                this.opts.log('info', '主动发言评估 ' + String(stat.count) + ' 次未触发（最后原因 ' + decision.reason
                    + '，近 ' + Math.round(windowMs / 60_000) + ' 分钟他人消息 ' + recentOthers + ' 条，λ=' + cfg.proactiveRatePerHour
                    + '，skipStreak=' + state.skipStreak + '）: ' + ref.key);
                stat.count = 0;
                stat.at = now;
            }
            this.proactiveEval.set(ref.key, stat);
            // 被"硬门"挡住时用 info 说明一次（每群 30 分钟最多一条），带上实际计数便于判断是配置还是逻辑问题
            if (decision.reason !== 'poisson-miss' && decision.reason !== 'disabled') {
                const lastNotice = this.proactiveNoticeAt.get(ref.key) ?? 0;
                if (now - lastNotice > 30 * 60_000) {
                    this.proactiveNoticeAt.set(ref.key, now);
                    const hint = {
                        'quiet-hours': '当前在静默时段',
                        cooldown: '距上次发言不足 ' + cfg.proactiveCooldownMinutes + ' 分钟',
                        'hourly-cap': '本小时已达 ' + maxPerHourOf({ cooldownMinutes: cfg.proactiveCooldownMinutes }) + ' 条上限',
                        'not-enough-chatter': '近 ' + Math.round(windowMs / 60_000) + ' 分钟只有 ' + recentOthers + ' 条他人消息（门槛 ' + cfg.proactiveHotMessages + '）',
                        'stale-chat': '最后一条群消息已是 ' + Math.round((now - lastMessageAt) / 1000) + ' 秒前（冷场门 ' + FRESH_SECONDS + ' 秒）',
                        'rate-zero': 'λ=0（不主动发言）',
                    };
                    this.opts.log('info', '主动发言暂不触发（' + (hint[decision.reason] ?? decision.reason) + '）: ' + ref.key);
                }
            }
            return;
        }
        try {
            const chat = await this.ensureChat(ref);
            const recent = await this.mem.readRecent(ref.key, this.opts.config.injectRecent);
            // 主动发言也要带完整记忆块（空间 id / 固定层召回指令 / 自动记忆规则），与 @ 触发时一致
            let memoryBlock = '';
            let proactiveSpaceId;
            if (this.opts.config.memoryEnabled) {
                try {
                    proactiveSpaceId = await this.mem.ensureSpace(ref.key, chat.agent);
                    const recalled = this.opts.config.memoryBackend === 'file'
                        ? await this.mem.recall(ref.key, recent.slice(-5).join(' '), chat.agent)
                        : '';
                    memoryBlock = this.mem.buildInjection({ chatKey: ref.key, recent, recallText: recalled, spaceId: proactiveSpaceId, recentExpressions: this.recentMemeCaptions, summary: (await this.mem.readSummary(ref.key))?.text, facts: { glossary: await this.mem.topTexts(ref.key, 'glossary', 8), setting: await this.mem.topTexts(ref.key, 'setting', 8), preference: await this.mem.topTexts(ref.key, 'preference', 6), style: await this.mem.topTexts(ref.key, 'style', 2), todo: await this.mem.topTexts(ref.key, 'todo', 5), event: await this.mem.topTexts(ref.key, 'event', 5) }, people: await this.peopleFor(ref.key), memeNudge: this.memeNudgeFor(ref.key), memeCatalog: await this.memeCatalogText(), memeAllowed: this.memeAllowedFor(ref.key), memeSinceLast: this.repliesSinceMeme.get(ref.key) ?? 0 });
                }
                catch (error) {
                    this.opts.log('debug', '主动发言记忆注入失败: ' + (error instanceof Error ? error.message : String(error)));
                }
            }
            // 主动发言轮的记忆任务：没有空间就建好并先记一条；有空间就顺手记新信息（各限 1 条，别啰嗦）
            if (this.opts.config.memoryEnabled && this.opts.config.memoryBackend === 'mnemon') {
                const spaceName = this.opts.config.memorySpacePrefix + ref.key;
                const registerCall = ref.kind === 'group'
                    ? 'napcat_memory_space({ group_id: "' + ref.id + '", space_id: <同一个 id> })'
                    : 'napcat_memory_space({ user_id: "' + ref.id + '", space_id: <同一个 id> })';
                memoryBlock += proactiveSpaceId === undefined
                    ? '\n\n【本轮额外要求·先做这个再说话】本群还没有记忆空间。请依次执行：'
                        + '① mnemon_memory_body_create({ name: "' + spaceName + '", description: "QQ ' + ref.key + ' 的长期记忆" })'
                        + '② mnemon_memory_body_update({ memoryBodyId: <返回的 id>, active: true })'
                        + '③ ' + registerCall
                        + '④ 从上面的近期群聊里提炼 1~3 条值得长期记住的内容（群定位/成员称呼/黑话梗/重要约定），用 mnemon_remember 写进这个空间。'
                        + '全部做完后再照常插话（没有想说的仍然回 __SKIP__）。这一步只做一次，之后本群就有记忆空间了。'
                    : '\n\n【本轮小提醒】如果上面的近期群聊里出现了值得长期记住的新信息（新人设/称呼/黑话/重要约定），可以顺手调用 mnemon_remember 记 1 条（最多 1 条，没实质内容就不记）；这只是附带动作，不要因此改变插话的语气。';
            }
            this.pendingProactive.add(ref.key);
            this.proactiveStartedAt.set(ref.key, Date.now());
            // 优先参考最近几条，但不是"只准接最后一句"：允许结合更早的上下文与长期记忆来回
            const lastThree = recent.slice(-3);
            const latestSpeaker = lastThree.length === 0 ? '' : lastThree[lastThree.length - 1] ?? '';
            const anchorBlock = lastThree.length === 0
                ? ''
                : '【最近的对话（优先从这里切入）】\n' + lastThree.join('\n') + '\n\n';
            // 最新消息是图片时，直接把那张图作为附件附上（不再指望模型主动 read_image）
            const latestImage = await this.latestImageOf(recent, chat.cwd);
            const imageNote = latestImage === undefined
                ? ''
                : '【当前话题就是这张图：已经随本轮消息附上，直接对着图里的内容说，别接更早的文字话题】\n';
            await this.dispatch(chat, (memoryBlock === '' ? '' : memoryBlock + '\n\n')
                + this.linkHintOf(recent)
                + imageNote
                + anchorBlock
                + '[主动发言] 现在是主动插话窗口。\n'
                + '怎么想：先看上面的群设定、长期记忆和完整聊天记录，判断大家在聊什么、聊到哪一步，再决定你要说什么；'
                + '切入点**优先取最近这几条**（' + (latestSpeaker === '' ? '最新消息' : '最近一句来自「' + latestSpeaker.slice(0, 40) + '」') + '），'
                + '但不必死盯最后一句——如果前面几轮里有个更值得回应/补充/吐槽的点，也可以接着那个说。\n'
                + '## 先看清楚再开口\n'
                + '最近这几条里如果有 [图片: <相对路径>]，而且当前话题的重点就是那张图/表情包/截图（不是纯文字在聊别的事），'
                + '**先用 read_image 传那个相对路径看一眼**，对着图里的内容说；有 [文件: <路径>] 且大家在聊文件内容时，也先读一下文件。\n'
                + '不要图挂着不看、转头去接更早的文字话题；只跟当前话题无关的旧图可以跳过。\n'
                + '如果最新一条是链接（http/https），当前话题就是那个链接：先用 web_fetch 打开看标题再聊，打不开就说打不开。\n'
                + (recent.slice(-12).some(line => /闭嘴|别说了|安静点|少说点/.test(line))
                    ? '最近有人说过「闭嘴/别说了」：这条先别插话，回 __SKIP__ 也行；但别长期缩着，隔几条明显值得接的话照常参与。\n'
                    : '')
                + '怎么说：① 不超过 2 句、口语化，像群成员随口插话，不要像播报或客服；② 附和、补充、吐槽、接梗、追问都行；\n'
                + '③ 不要重复别人刚说过的内容，不要总结、不要列点、不要点名；④ 不要抛与本群历史和当前话题无关的新话题；\n'
                + '⑤ 拿不准或觉得这轮插话多余，就只回复 __SKIP__（三个下划线 + SKIP），我会丢弃这条。', latestImage?.blocks ?? [], latestImage?.parts ?? []);
            this.opts.log('info', '主动发言已触发: ' + ref.key + '（' + decision.reason + '）');
        }
        catch (error) {
            this.pendingProactive.delete(ref.key);
            this.opts.log('debug', '主动发言投递失败: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    /** 供 napcat_memory_space 工具登记空间 id。 */
    /** 供 napcat_memory_space 工具登记空间 id。 */
    async saveMemorySpace(chatKey, spaceId) {
        await this.mem.saveSpace(chatKey, spaceId);
        this.opts.log('info', '已登记记忆空间: ' + chatKey + ' → ' + spaceId);
    }
    /**
     * 最近几条里如果有链接（http/https），就提示模型"话题是这条链接"，
     * 并明确要求先抓取内容再聊——否则模型读不懂链接，只能抓更早的话题硬接。
     */
    linkHintOf(lines) {
        const tail = lines.slice(-3);
        for (let index = tail.length - 1; index >= 0; index -= 1) {
            const line = tail[index] ?? '';
            const match = /https?:\/\/[^\s"'）)】]+/.exec(line);
            if (match === null)
                continue;
            const url = match[0].slice(0, 200);
            const who = line.split('：')[0]?.trim() ?? '';
            return '【最新话题是一条链接' + (who === '' ? '' : '（' + who.slice(0, 20) + ' 发的）') + '】' + url + '\n'
                + '- 链接内容你看不到，除非去取：**先用 web_fetch（或 read_page）打开它**，看标题/摘要/关键信息，再围绕它说。\n'
                + '- 取不到（超时、要登录、被墙）就直说「这个链接我打不开」，**不要拿更早的话题硬接**；可以先问一句"这是啥？"再聊。\n';
        }
        return '';
    }
    /** 本轮能不能发表情：距上次带图已隔够 `memeMinGap` 条文字回复才算可以。 */
    memeAllowedFor(key) {
        const gap = Math.max(0, Math.floor(this.opts.config.memeMinGap));
        if (gap <= 1)
            return true;
        return (this.repliesSinceMeme.get(key) ?? gap) >= gap;
    }
    /** 记一轮"带没带表情"：带了清零，没带 +1（供下轮注入做频率提示）。 */
    noteReplyMemeState(key, hadMeme) {
        if (hadMeme) {
            this.repliesSinceMeme.set(key, 0);
            return;
        }
        this.repliesSinceMeme.set(key, (this.repliesSinceMeme.get(key) ?? 0) + 1);
    }
    /** 连续几条回复没带表情（到阈值才提示，0=关闭）。 */
    memeNudgeFor(key) {
        const threshold = this.opts.config.memeNudgeAfter;
        if (threshold <= 0)
            return 0;
        const missed = this.repliesSinceMeme.get(key) ?? 0;
        return missed >= threshold ? missed : 0;
    }
    /** 人物群像 → 注入用数组（按评分取前 6，名字+画像）。 */
    async peopleFor(chatKey) {
        try {
            const limit = Math.max(0, Math.floor(this.opts.config.peopleLimit));
            const texts = await this.mem.topTexts(chatKey, 'person', limit > 0 ? limit : 200);
            return texts.map(text => {
                const [name, ...rest] = text.split('：');
                return { name: (name ?? text).trim(), style: rest.join('：').trim() };
            });
        }
        catch {
            return [];
        }
    }
    /** 从磁盘恢复遗留的待归档批次（进程重启/升级后不会丢）。 */
    async restoreArchivePending() {
        try {
            const rows = await this.mem.listPendingArchives();
            let restored = 0;
            for (const row of rows) {
                if (this.archivePending.has(row.chatKey))
                    continue;
                this.archivePending.set(row.chatKey, {
                    path: row.path,
                    count: row.count,
                    from: row.from,
                    to: row.to,
                    preparedAt: row.preparedAt,
                });
                restored += 1;
            }
            if (restored > 0)
                this.opts.log('info', '恢复待归档批次 ' + String(restored) + ' 个（重启前遗留）');
        }
        catch (error) {
            this.opts.log('debug', '恢复归档批次失败: ' + describe(error));
        }
    }
    /** 从会话 key（group:123 / private:456）还原 ChatRef，用于重启后还没人说话时也能归档。 */
    chatRefFromKey(key) {
        const index = key.indexOf(':');
        if (index <= 0)
            return undefined;
        const kind = key.slice(0, index);
        const id = key.slice(index + 1);
        if ((kind !== 'group' && kind !== 'private') || id === '')
            return undefined;
        return { kind, id, key };
    }
    /** 按 sessionId 查宿主里活着的 agent（用于避开"已被写句柄占用"的冲突）。 */
    liveAgentFor(sessionId) {
        try {
            const agents = this.opts.ctx.agents;
            const live = agents?.get?.(String(sessionId));
            return live === undefined || live === null ? undefined : live;
        }
        catch {
            return undefined;
        }
    }
    /** 定时器：待归档批次 + 群空闲够了 → 起一轮独立归档（模型专门做这件事）。 */
    async archiveTick() {
        if (!this.opts.config.memoryEnabled || this.opts.config.archiveEvery === 0)
            return;
        const idleMs = Math.max(0, this.opts.config.archiveIdleMinutes) * 60_000;
        if (this.archivePending.size === 0)
            return;
        this.opts.log('debug', '归档轮检查：待处理 ' + String(this.archivePending.size) + ' 个');
        for (const [key, pending] of [...this.archivePending]) {
            if (this.archiveRunning.has(key))
                continue;
            // 重启后群里没人说话时 chats 里还没有这个会话——用 key 还原一个 ref 就够
            const ref = this.chats.get(key)?.ref ?? this.chatRefFromKey(key);
            if (ref === undefined) {
                this.opts.log('warn', '归档轮跳过 ' + key + '：取不到会话标识');
                continue;
            }
            // 空闲基准：实时活动时间；没有就退回批次生成时间（重启场景）
            const last = this.archiveLastActivity.get(key) ?? pending.preparedAt;
            const idleFor = Date.now() - last;
            if (idleFor < idleMs) {
                this.opts.log('debug', '归档轮等待空闲 ' + key + '：还需 ' + Math.ceil((idleMs - idleFor) / 1000) + ' 秒');
                continue;
            }
            this.archiveRunning.add(key);
            this.opts.log('info', '归档轮开始 ' + key + '：' + pending.count + ' 条（已空闲 ' + Math.round(idleFor / 1000) + ' 秒）');
            try {
                // 整体兜底超时：卡住也不会永远占着 running 标记
                await Promise.race([
                    this.runArchiveTurn(key, pending),
                    new Promise((_resolve, reject) => {
                        setTimeout(() => reject(new Error('归档轮超时（240s）')), 240_000);
                    }),
                ]);
            }
            catch (error) {
                this.opts.log('warn', '归档轮失败: ' + key + ' — ' + describe(error));
            }
            finally {
                this.archiveRunning.delete(key);
            }
        }
    }
    /** 攒够 archiveEvery 条就准备批次（真正执行由 archiveTick 起独立轮）。 */
    async maybePrepareArchive(ref) {
        try {
            const existing = this.archivePending.get(ref.key);
            if (existing !== undefined) {
                if (Date.now() - existing.preparedAt < 30 * 60_000)
                    return;
                this.archivePending.delete(ref.key);
            }
            const state = await this.mem.archiveState(ref.key);
            const limit = Math.max(this.opts.config.archiveEvery, 1);
            const rows = await this.mem.pendingArchiveRows(ref.key, state.archivedUpTo, limit * 2);
            if (rows.length < limit)
                return;
            const batch = rows.slice(0, limit);
            const path = await this.mem.writeArchiveBatch(ref.key, batch);
            const from = batch[0]?.t ?? 0;
            const to = batch[batch.length - 1]?.t ?? 0;
            this.archivePending.set(ref.key, { path, count: batch.length, from, to, preparedAt: Date.now() });
            this.opts.log('info', '归档批次已准备 ' + ref.key + '：' + batch.length + ' 条（空闲 ' + String(this.opts.config.archiveIdleMinutes) + ' 分钟后起独立归档轮）');
        }
        catch (error) {
            this.opts.log('debug', '归档准备失败: ' + describe(error));
        }
    }
    /** 开一个独立会话专门做归档：不进 bySession，输出不会发到 QQ。 */
    async openArchiveAgent(cwd, sessionKey, prefix = 'napcat-archive-') {
        const agents = this.opts.ctx.agents;
        let sessionId = makeSessionId(prefix + sessionKey);
        this.opts.log('debug', '归档会话: ' + String(sessionId) + '（cwd=' + cwd + '）');
        const live = agents.get?.(String(sessionId));
        if (live !== undefined)
            return { agent: live, dispose: async () => undefined };
        const defaultModel = this.opts.ctx.agentDefaultModel;
        const selection = defaultModel?.currentSelection?.();
        const agentOptions = {};
        if (selection !== undefined) {
            agentOptions.provider = selection.provider;
            agentOptions.model = selection.model;
        }
        if (this.opts.config.provider !== '')
            agentOptions.provider = this.opts.config.provider;
        if (this.opts.config.model !== '')
            agentOptions.model = this.opts.config.model;
        if (agentOptions.provider === undefined || agentOptions.model === undefined) {
            this.opts.log('warn', '归档轮没有可用模型，跳过（先配 DSH 默认模型或填 provider/model）');
            return undefined;
        }
        const presetId = this.opts.config.agentPreset.trim() === '' ? undefined : this.opts.config.agentPreset.trim();
        const presets = this.opts.ctx.agentPresets;
        const selectionRef = {
            current: {
                provider: agentOptions.provider,
                model: agentOptions.model,
                ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
            },
            assembled: undefined,
        };
        const setup = async (agentCtx) => {
            if (presets?.mount !== undefined) {
                try {
                    await presets.mount(agentCtx, presetId);
                }
                catch (error) {
                    this.opts.log('debug', '归档 agent 挂预设失败: ' + describe(error));
                }
            }
            installModelSelection(agentCtx, selectionRef);
        };
        const meta = { cwd };
        if (presetId !== undefined)
            meta.agentPreset = presetId;
        let handle;
        const persistence = this.opts.ctx.sessionPersistence;
        let exists = false;
        if (persistence?.stat !== undefined) {
            try {
                exists = (await persistence.stat(sessionId)) !== undefined;
            }
            catch {
                exists = false;
            }
        }
        const ownedByOther = (error) => /already owned by an active write handle/i.test(describe(error));
        for (let attempt = 1; handle === undefined && attempt <= 3; attempt += 1) {
            const live = this.liveAgentFor(String(sessionId));
            if (live !== undefined) {
                handle = { agent: live, dispose: async () => undefined };
                break;
            }
            try {
                if (exists) {
                    handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
                }
                else {
                    this.opts.log('debug', '归档会话 create: ' + String(sessionId));
                    handle = await agents.create({ sessionId, meta, agentOptions, setup });
                }
            }
            catch (error) {
                if (ownedByOther(error)) {
                    await new Promise(resolve => setTimeout(resolve, 400));
                    const late = this.liveAgentFor(String(sessionId));
                    if (late !== undefined) {
                        handle = { agent: late, dispose: async () => undefined };
                        break;
                    }
                    // 换一个带时间戳的归档会话，绝不和旧写句柄死磕
                    sessionId = makeSessionId(prefix + sessionKey + '-t' + Date.now().toString(36));
                    exists = false;
                    this.opts.log('warn', '归档会话被占用，改用新会话: ' + String(sessionId));
                    continue;
                }
                if (exists) {
                    exists = false;
                    continue;
                }
                this.opts.log('warn', '归档会话创建失败: ' + describe(error));
                return undefined;
            }
        }
        if (handle === undefined) {
            this.opts.log('warn', '归档会话多次创建失败，跳过本轮');
            return undefined;
        }
        try {
            await handle.agent.whenIdle();
        }
        catch {
            // 忽略：投递失败会另有日志
        }
        const approval = this.opts.ctx.approval;
        approval?.setPolicy?.(handle.agent, 'never');
        return handle;
    }
    /** 跑一轮归档：模型只读素材、只输出 JSON（顺带把长期条目写进 mnemon）。 */
    async runArchiveTurn(key, pending) {
        const chat = this.chats.get(key);
        const ref = chat?.ref ?? this.chatRefFromKey(key);
        if (ref === undefined) {
            this.opts.log('warn', '归档轮跳过 ' + key + '：取不到会话标识');
            return;
        }
        let cwd = chat?.cwd;
        if (cwd === undefined) {
            try {
                cwd = await this.cwdFor(ref);
            }
            catch {
                cwd = process.cwd();
            }
        }
        const handle = await this.openArchiveAgent(cwd, key);
        if (handle === undefined)
            return;
        this.archiveAgents.set(key, handle);
        const sessionId = String(handle.agent.session.id);
        // 给归档会话起个能认的名字（Web 会话列表里可点进去看完整归档过程）
        try {
            const titles = this.opts.ctx.sessionTitle;
            titles?.rename?.(handle.agent.session, '归档·' + key.replace(':', ' '));
        }
        catch {
            // 标题只是可读性，失败不影响归档
        }
        // 带上现有记忆，让模型输出"合并后的完整版"（更新而不是叠加）
        const existingSummary = await this.mem.readSummary(key);
        const existingItems = await this.mem.readItems(key);
        const peopleLimit = Math.max(0, Math.floor(this.opts.config.peopleLimit));
        const existingPeople = existingItems.filter(item => item.kind === 'person');
        const existing = {
            summary: existingSummary?.text,
            people: (peopleLimit > 0 ? existingPeople.slice(0, peopleLimit) : existingPeople).map(item => {
                const [name, ...rest] = item.text.split('：');
                return { name: (name ?? item.text).trim(), style: rest.join('：').trim() !== '' ? rest.join('：').trim() : undefined };
            }),
            glossary: existingItems.filter(item => item.kind === 'glossary').slice(0, 15).map(item => item.text),
            setting: existingItems.filter(item => item.kind === 'setting').slice(0, 15).map(item => item.text),
        };
        const spaceId = await this.mem.readSpaceId(key);
        const text = await this.collectArchiveOutput(sessionId, async () => {
            await handle.agent.followup(createUserMessage({
                content: [{ type: 'text', text: buildArchivePrompt({ path: pending.path, count: pending.count, chatKey: key, existing, spaceId, peopleLimit }) }],
                source: { kind: 'plugin:dsh-napcat' },
            }));
        }, 180_000);
        const payload = text.trim() === '' ? undefined : parseArchivePayload(text, peopleLimit);
        if (payload === undefined) {
            const misses = this.bumpArchiveMiss(key);
            this.opts.log('warn', '归档轮没产出合法 JSON（连续第 ' + misses + ' 次），片段: ' + text.slice(0, 160).replace(/\s+/g, ' '));
            if (misses >= 3) {
                this.archivePending.delete(key);
                this.archiveMiss.delete(key);
                await this.mem.clearArchiveBatch(key);
                this.opts.log('warn', '归档连续 3 次失败，丢弃该批次（下次重新准备）: ' + key);
            }
            return;
        }
        this.archiveMiss.delete(key);
        this.archivePending.delete(key);
        await this.applyArchivePayload(key, pending, payload);
        await this.mem.clearArchiveBatch(key);
    }
    /** 收集归档轮的输出（只对归档会话生效，不投递给 QQ）。 */
    async collectArchiveOutput(sessionId, send, timeoutMs) {
        const promise = new Promise(resolve => {
            const timer = setTimeout(() => {
                this.archiveCollectors.delete(sessionId);
                resolve('');
            }, timeoutMs);
            this.archiveCollectors.set(sessionId, { buffer: [], resolve, timer });
        });
        try {
            await send();
        }
        catch (error) {
            const collector = this.archiveCollectors.get(sessionId);
            if (collector !== undefined) {
                clearTimeout(collector.timer);
                this.archiveCollectors.delete(sessionId);
                collector.resolve('');
            }
            throw error;
        }
        return promise;
    }
    /** 归档落盘：条目走评分合并（同 key 累加 hits），再按评分淘汰边缘条目。 */
    async applyArchivePayload(key, pending, payload) {
        const incoming = [];
        if (payload.summary !== undefined)
            incoming.push({ kind: 'summary', text: payload.summary, weight: 5 });
        for (const person of payload.people ?? []) {
            const detail = [person.style, person.topics !== undefined && person.topics.length > 0 ? '常聊 ' + person.topics.join('/') : '']
                .filter(part => part !== undefined && part !== '')
                .join('；');
            incoming.push({ kind: 'person', text: person.name + (detail !== '' ? '：' + detail : ''), weight: person.weight });
        }
        for (const item of payload.glossary ?? [])
            incoming.push({ kind: 'glossary', text: item.text, weight: item.weight });
        for (const item of payload.setting ?? [])
            incoming.push({ kind: 'setting', text: item.text, weight: item.weight });
        for (const item of payload.preference ?? [])
            incoming.push({ kind: 'preference', text: item.text, weight: item.weight });
        for (const item of payload.style ?? [])
            incoming.push({ kind: 'style', text: item.text, weight: item.weight });
        // todo：有 when 就到次日失效；没 when 给 14 天兜底
        for (const item of payload.todo ?? []) {
            const due = item.when !== undefined ? Date.parse(item.when + 'T23:59:59') : Number.NaN;
            const expiresAt = Number.isFinite(due) ? due + 86_400_000 : Date.now() + 14 * 86_400_000;
            incoming.push({ kind: 'todo', text: item.when !== undefined ? item.text + '（' + item.when + '）' : item.text, weight: item.weight ?? 4, expiresAt });
        }
        // event：有 when 就保留 archiveEventDays 天，没有就按今天算
        for (const item of payload.event ?? []) {
            const base = item.when !== undefined ? Date.parse(item.when + 'T12:00:00') : Date.now();
            const expiresAt = (Number.isFinite(base) ? base : Date.now()) + this.opts.config.archiveEventDays * 86_400_000;
            incoming.push({ kind: 'event', text: item.when !== undefined ? item.text + '（' + item.when + '）' : item.text, weight: item.weight ?? 2, expiresAt });
        }
        const result = await this.mem.mergeItemsInto(key, incoming, { maxPerKind: 30 });
        if (payload.summary !== undefined) {
            const prev = await this.mem.readSummary(key);
            await this.mem.saveSummary(key, { text: payload.summary, from: prev?.from ?? pending.from, to: pending.to });
        }
        await this.mem.saveArchiveState(key, { archivedUpTo: pending.to, lastAt: Date.now() });
        await this.mem.writeDigest(key).catch(() => undefined);
        this.opts.log('info', '归档完成 ' + key + '：' + pending.count + ' 条 → 摘要'
            + (payload.summary !== undefined ? '有' : '无') + '，人物 ' + String(payload.people?.length ?? 0) + ' 位'
            + (payload.glossary !== undefined ? '，黑话 ' + String(payload.glossary.length) : '')
            + (payload.setting !== undefined ? '，设定 ' + String(payload.setting.length) : '')
            + (payload.preference !== undefined ? '，偏好 ' + String(payload.preference.length) : '')
            + (payload.style !== undefined ? '，氛围 ' + String(payload.style.length) : '')
            + (payload.todo !== undefined ? '，待办 ' + String(payload.todo.length) : '')
            + (payload.event !== undefined ? '，事件 ' + String(payload.event.length) : '')
            + '（条目 ' + String(result.kept) + '，淘汰 ' + String(result.dropped) + '）');
    }
    bumpArchiveMiss(key) {
        const next = (this.archiveMiss.get(key) ?? 0) + 1;
        this.archiveMiss.set(key, next);
        return next;
    }
    /** 仅把旧格式的 <归档> 块从回复里剥掉（不再依赖它归档，纯安全网）。 */
    stripArchiveBlock(text) {
        return text
            .replace(/<\s*(?:归档|archive)\s*>[\s\S]*?<\s*\/\s*(?:归档|archive)\s*>/gi, '')
            .replace(/【\s*归档\s*】[\s\S]*$/m, '')
            .trim();
    }
    /** 缓冲不足时才预热；同一聊天 5 分钟内最多尝试一次。 */
    async maybeWarmup(ref) {
        try {
            const last = this.warmAttempts.get(ref.key) ?? 0;
            if (Date.now() - last < 5 * 60_000)
                return;
            const have = await this.mem.recentCount(ref.key);
            const newest = await this.mem.recentNewestAt(ref.key);
            const staleMs = this.opts.config.warmupStaleMinutes * 60_000;
            const enough = have >= this.opts.config.recentLimit;
            const fresh = newest > 0 && Date.now() - newest <= staleMs;
            if (enough && fresh)
                return;
            this.warmAttempts.set(ref.key, Date.now());
            this.opts.log('info', '预热触发 ' + ref.key + '：已有 ' + have + ' 条，目标 ' + this.opts.config.recentLimit);
            await this.warmup(ref);
        }
        catch (error) {
            this.opts.log('warn', '预热判断失败: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    /** 用 NapCat 的历史消息接口预热 recent 缓冲（群 get_group_msg_history / 私聊 get_friend_msg_history）。 */
    async warmup(ref) {
        try {
            // 单次最多拉 300 条：recentLimit 再大也分多次补，别让 NapCat 一次要太多
            const wanted = this.opts.config.recentLimit;
            const count = Math.min(wanted, 300);
            if (wanted > count) {
                this.opts.log('info', '预热单次上限 300 条（recentLimit=' + wanted + '），会分多次补齐');
            }
            const isGroup = ref.kind === 'group';
            const action = isGroup ? 'get_group_msg_history' : 'get_friend_msg_history';
            const params = isGroup
                ? { group_id: ref.id, count, reverse_order: false }
                : { user_id: ref.id, count, reverseOrder: false };
            const data = await this.opts.conn.call(action, params);
            const list = Array.isArray(data?.messages) ? data.messages : [];
            // 历史图片：消息里存的 url 会过期，但 file id 还能用 get_image 重新解析 → 能解析就缓存
            let cache;
            let cacheCwd = '';
            let imageBudget = this.opts.config.warmupImages ? this.opts.config.warmupImageLimit : 0;
            if (imageBudget > 0) {
                try {
                    cacheCwd = await this.cwdFor(ref);
                    cache = this.imageCacheFor(cacheCwd);
                }
                catch {
                    cache = undefined;
                }
            }
            const entries = [];
            // 先把所有消息整理成条目，同时记下带图片的条目（下载留到第二轮，按"最新优先"消耗预算）
            const imageTasks = [];
            for (const item of list) {
                // 与实时路径一致的兜底：群名片 → 昵称 → QQ 号（历史接口里 card 常为空串，不能用 ?? ）
                const card = typeof item.sender?.card === 'string' ? item.sender.card.trim() : '';
                const nick = typeof item.sender?.nickname === 'string' ? item.sender.nickname.trim() : '';
                const uid = typeof item.sender?.user_id === 'number' ? String(item.sender.user_id) : '';
                const speaker = card !== '' ? card : nick !== '' ? nick : uid !== '' ? uid : '?';
                const text = toText(item.message) || String(item.raw_message ?? '');
                if (text === '')
                    continue;
                const at = typeof item.time === 'number' ? item.time * 1000 : Date.now();
                if (cache !== undefined && imageBudget > 0) {
                    const files = segmentsOf(item.message)
                        .filter(seg => seg.type === 'image')
                        .map(seg => String(seg.data.file ?? ''))
                        .filter(file => file !== '')
                        .slice(0, 3);
                    if (files.length > 0)
                        imageTasks.push({ index: entries.length, at, speaker, files });
                }
                entries.push({ nick: speaker, text, at });
            }
            // 第二轮：**最新的图片优先**消耗预算（而不是从头开始把预算喂给最旧的消息）
            imageTasks.sort((left, right) => right.at - left.at);
            for (const task of imageTasks) {
                if (imageBudget <= 0)
                    break;
                const entry = entries[task.index];
                if (entry === undefined)
                    continue;
                const names = [];
                let expired = 0;
                for (const fileRef of task.files) {
                    if (imageBudget <= 0)
                        break;
                    imageBudget -= 1;
                    try {
                        const info = await this.opts.conn.call('get_image', { file: fileRef });
                        const url = info?.url;
                        if (typeof url !== 'string' || url === '') {
                            expired += 1;
                            continue;
                        }
                        const hit = await cache?.save({ url, chatKey: ref.key, nick: task.speaker, name: nameFromRef(fileRef, 'image.png') });
                        if (hit !== undefined)
                            names.push(relative(cacheCwd, hit.path).replace(/\\/g, '/'));
                        else
                            expired += 1;
                    }
                    catch {
                        expired += 1;
                    }
                }
                if (names.length > 0) {
                    entry.text = entry.text.replace(/\[图片\]/g, '').trimStart() + ' [图片:' + names.join(',') + ']';
                }
                else if (expired > 0) {
                    entry.text = entry.text.replace(/\[图片\]/g, '[图片(已过期)]');
                }
            }
            {
                const seeded = await this.mem.seedRecent(ref.key, entries);
                this.opts.log('info', '预热历史 ' + ref.key + '：' + seeded + ' 条' + (this.opts.config.warmupImages ? '（图片预算已用 ' + (this.opts.config.warmupImageLimit - Math.max(0, imageBudget)) + ' 张，最新优先）' : ''));
            }
        }
        catch (error) {
            this.opts.log('warn', '预热历史失败: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    async handleEventInner(event) {
        if (this.stopped)
            return;
        if (event.post_type !== 'message')
            return;
        const msg = event;
        const ref = chatRefOf(msg);
        if (ref === undefined)
            return;
        const userId = String(msg.user_id ?? '');
        const selfId = this.opts.conn.selfId;
        if (this.opts.config.ignoreSelf && selfId !== '' && userId === selfId) {
            this.opts.log('debug', '忽略机器人自己的消息');
            return;
        }
        if (!allowAccess(this.opts.config, ref, userId)) {
            this.opts.log('debug', '策略拒绝: ' + ref.key + ' user=' + userId);
            return;
        }
        const rawText = toText(msg.message, selfId);
        const keyword = findKeyword(rawText, this.opts.config.triggerKeywords);
        // ── 观察层：在 @门控之前，所有消息（不管有没有叫到机器人）都记进缓冲 ──
        // 昵称三级兜底：群名片(card) → 昵称(nickname) → QQ 号（QQ 群成员经常只有名片，nickname 为空）
        const senderInfo = msg.sender;
        const card = typeof senderInfo?.card === 'string' ? senderInfo.card.trim() : '';
        const nick = typeof senderInfo?.nickname === 'string' ? senderInfo.nickname.trim() : '';
        const senderNick = card !== '' ? card : nick !== '' ? nick : userId;
        // 用消息本身的时间（秒级 time × 1000），不要用"处理时刻"——否则和预热拉回的历史差几秒，去重对不上
        const messageAt = typeof msg.time === 'number' && msg.time > 0 ? msg.time * 1000 : undefined;
        if (this.opts.config.memoryEnabled) {
            if (this.opts.config.imageCache === 'all') {
                // 图片要落盘并写进记录（异步，不阻塞本条消息处理）
                void (async () => {
                    const text = await this.prepareRecentText(ref, msg, rawText, senderNick);
                    await this.mem.appendRecent(ref.key, { nick: senderNick, text, at: messageAt });
                })();
            }
            else {
                void this.mem.appendRecent(ref.key, { nick: senderNick, text: rawText, at: messageAt });
            }
            if (this.opts.config.recentLimit > 0) {
                void this.maybeWarmup(ref);
            }
            // 记群活动时间：归档轮要等群里闲下来才跑，避免和聊天抢
            this.archiveLastActivity.set(ref.key, Date.now());
            if (this.opts.config.archiveEvery > 0) {
                void this.maybePrepareArchive(ref);
            }
        }
        // 主动发言：记录"有人在聊"，判定推迟到门控之后（被 @ 时不插话）
        this.stats.messages += 1;
        this.stats.lastMessageAt = Date.now();
        if (ref.kind === 'group')
            this.stats.groupMessages += 1;
        else
            this.stats.privateMessages += 1;
        this.noteChatter(ref);
        if (ref.kind === 'group' && this.opts.config.requireMention) {
            if (selfId === '') {
                if (!this.mentionWarned) {
                    this.mentionWarned = true;
                    this.opts.log('warn', '还不知道机器人自己的 QQ（botQQ 留空且事件里没带 self_id），暂不启用 @ 门控');
                }
            }
            else {
                const recent = this.chats.get(ref.key)?.recentReplyIds ?? [];
                const hit = mentions(msg.message, selfId) || repliesToAny(msg.message, recent) || keyword !== undefined;
                if (!hit) {
                    this.opts.log('debug', '群消息未 @ 机器人且没命中关键字（已记入缓冲）: ' + ref.key);
                    // 没叫它 → 看看要不要主动插一句（判定在 proactive 里）
                    if (this.opts.config.proactiveEnabled)
                        void this.maybeInterject(ref);
                    return;
                }
            }
        }
        // ── 危险操作门禁：普通群友发这类请求直接拒，不投给模型 ──
        if (this.opts.config.dangerPolicy !== 'off') {
            const danger = detectDanger(rawText, this.opts.config.dangerWords);
            if (danger !== undefined) {
                const admin = isAdmin(this.opts.config, userId);
                const allowAnyone = this.opts.config.dangerPolicy === 'allow';
                if (!admin && !allowAnyone) {
                    void this.mem.appendAudit(ref.key, {
                        at: Date.now(), userId, nick: senderNick, role: 'member',
                        word: danger.word, category: danger.category, decision: 'rejected',
                    });
                    this.opts.log('warn', '拦截危险请求 ' + ref.key + ' user=' + userId + ' 命中=' + danger.word);
                    await this.replyDanger(ref, danger);
                    return;
                }
                void this.mem.appendAudit(ref.key, {
                    at: Date.now(), userId, nick: senderNick, role: admin ? 'admin' : 'member',
                    word: danger.word, category: danger.category, decision: 'allowed',
                });
                this.opts.log('info', '危险请求放行 ' + ref.key + ' user=' + userId + ' 命中=' + danger.word + ' role=' + (admin ? 'admin' : 'member'));
            }
        }
        const chat = await this.ensureChat(ref);
        if (this.opts.config.memoryEnabled)
            void this.mem.dumpTurnState(ref.key, chat.agent);
        // 记忆命令（插件直写，不经过模型）
        if (this.opts.config.memoryEnabled) {
            // 命令前先去掉 @段 与触发词，否则「小灯记忆」匹配不上
            let commandText = rawText.replace(/\[CQ:[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
            for (const word of this.opts.config.triggerKeywords) {
                if (word !== '')
                    commandText = stripKeyword(commandText, word);
            }
            commandText = commandText.trim();
            const rememberMatch = /^记住(设定|黑话|人物|事实)?[:：]?\s*([\s\S]+)$/.exec(commandText);
            if (rememberMatch !== null && rememberMatch[2] !== undefined && rememberMatch[2].trim() !== '') {
                const kind = rememberMatch[1] ?? '事实';
                const extraTag = kind === '设定' ? 'setting' : kind === '黑话' ? 'glossary' : kind === '人物' ? 'person' : '';
                const rawContent = rememberMatch[2].trim();
                const content = '【' + kind + '】' + rawContent;
                if (this.opts.config.memoryBackend === 'mnemon') {
                    // mnemon 的记忆操作要求"本轮 turn 的 View"：插件在轮次外调会被拒，
                    // 所以把请求投给模型，让它在**本轮内**创建空间/写入（注入块里也给了规范）。
                    const spaceId = await this.mem.ensureSpace(ref.key, chat.agent);
                    const spaceName = this.opts.config.memorySpacePrefix + ref.key;
                    const tags = '["napcat","' + ref.key + '"' + (extraTag === '' ? '' : ',"' + extraTag + '"') + ']';
                    const steps = spaceId !== undefined
                        ? '直接调用 mnemon_remember({ memoryBodyId: "' + spaceId + '", content: <下面内容>, tags: ' + tags + ' })'
                        : '本群还没有记忆空间，按顺序执行：\n'
                            + '1) mnemon_memory_body_create({ name: "' + spaceName + '", description: "QQ ' + ref.key + ' 的长期记忆" })\n'
                            + '2) mnemon_memory_body_update({ memoryBodyId: <上一步的 id>, active: true })\n'
                            + '3) napcat_memory_space({ group_id: "' + ref.id + '", space_id: <同一个 id> })   ← 让插件记住这个 id\n'
                            + '4) mnemon_remember({ memoryBodyId: <同一个 id>, content: <下面内容>, tags: ' + tags + ' })';
                    await this.dispatch(chat, '[记忆请求]（类别：' + kind + '）把下面这条信息写入本群长期记忆。\n' + steps + '\n\n内容（含【' + kind + '】前缀，请原样写入）：' + content + '\n\n完成后只回一句「已记住」即可。', [], []);
                    return;
                }
                const ok = await this.mem.remember(ref.key, content, chat.agent, ['group:' + ref.id]);
                await this.sendText(chat, '✅ ' + ok);
                return;
            }
            if (/^记忆\s*$/.test(commandText)) {
                if (this.opts.config.memoryBackend === 'mnemon') {
                    // mnemon 的读取需要本轮 View，插件在轮次外调用必失败 → 交给模型在轮内显式回忆
                    const spaceId = await this.mem.ensureSpace(ref.key, chat.agent);
                    const recentForQuery = await this.mem.readRecent(ref.key, 5);
                    await this.dispatch(chat, '[记忆查询] 请用 mnemon_recall 检索本群长期记忆并直接回答用户。\n'
                        + '空间 id：' + (spaceId ?? '（未配置，见上文说明）') + '\n'
                        + '查询词（可用最近群聊推断）：' + (recentForQuery.join(' ') || '本群记忆')
                        + '\n如果检索不到，就直说「本群还没有相关记忆」；不要把工具报错原文发给用户。', [], []);
                    return;
                }
                const recentForQuery = await this.mem.readRecent(ref.key, 10);
                const recalled = await this.mem.recall(ref.key, recentForQuery.join(' '), chat.agent);
                await this.sendText(chat, recalled === '' ? '本群还没有长期记忆' : '本群记忆（相关片段）：\n' + recalled);
                return;
            }
        }
        const media = await this.resolveInboundMedia(msg, chat);
        const textWithoutImageMarkers = rawText.replace(/\[图片\]/g, '').replace(/\n{2,}/g, '\n').trim();
        let memoryBlock = '';
        if (this.opts.config.memoryEnabled) {
            try {
                const recent = await this.mem.readRecent(ref.key);
                const history = recent.slice(0, Math.max(0, recent.length - 1));
                const query = history.slice(-5).join(' ');
                const recalled = query === '' ? '' : await this.mem.recall(ref.key, query, chat.agent);
                const spaceId = await this.mem.ensureSpace(ref.key, chat.agent);
                memoryBlock = this.mem.buildInjection({ chatKey: ref.key, recent: history, recallText: recalled, spaceId, recentExpressions: this.recentMemeCaptions, summary: (await this.mem.readSummary(ref.key))?.text, facts: { glossary: await this.mem.topTexts(ref.key, 'glossary', 8), setting: await this.mem.topTexts(ref.key, 'setting', 8), preference: await this.mem.topTexts(ref.key, 'preference', 6), style: await this.mem.topTexts(ref.key, 'style', 2), todo: await this.mem.topTexts(ref.key, 'todo', 5), event: await this.mem.topTexts(ref.key, 'event', 5) }, people: await this.peopleFor(ref.key), memeNudge: this.memeNudgeFor(ref.key), memeCatalog: await this.memeCatalogText(), memeAllowed: this.memeAllowedFor(ref.key), memeSinceLast: this.repliesSinceMeme.get(ref.key) ?? 0 });
            }
            catch (error) {
                this.opts.log('debug', '记忆注入失败: ' + (error instanceof Error ? error.message : String(error)));
            }
        }
        // 这一轮本身就是图片/文件消息时，明确要求先看再回（否则模型容易只接文字）
        const visualHint = media.notes.some(note => note.startsWith('[图片')) || media.notes.some(note => note.startsWith('[文件'))
            ? '[本轮消息主要是图片/文件] 先按上面的说明用 read_image 或读文件确认内容，再针对它回应；不要凭文字猜测画面。'
            : '';
        const linkHint = this.linkHintOf([...(await this.mem.readRecent(ref.key, 4)), rawText]);
        const text = [memoryBlock, visualHint, linkHint, textWithoutImageMarkers, ...media.notes].filter(part => part !== '').join('\n\n');
        if (text.trim() === '') {
            this.opts.log('debug', '空消息（无文本也没有可下载的媒体），跳过: ' + ref.key);
            return;
        }
        const sentId = String(msg.message_id ?? '');
        chat.lastReplyId = sentId;
        if (sentId !== '') {
            chat.recentReplyIds = [...(chat.recentReplyIds ?? []), sentId].slice(-30);
        }
        this.dispatch(chat, text, media.blocks, media.parts);
    }
    /** 写一行诊断到 <会话cwd>/napcat-inbox/_image-debug.log（出问题时能自查，用户随时可删）。 */
    debugLog(cwd, note) {
        try {
            const dir = cwd ?? join(normalizePath(this.opts.config.workspacePath) || process.cwd(), 'napcat');
            void appendFile(join(dir, 'napcat-inbox', '_image-debug.log'), new Date().toISOString() + ' v0.3.7 ' + note + '\n').catch(() => undefined);
        }
        catch {
            // 诊断日志写不了就算了
        }
    }
    /** 宿主会话 id → QQ 会话 key（工具省略 chat_id 时用来定位当前会话）。 */
    keyForSession(sessionId) {
        return this.bySession.get(sessionId);
    }
    /**
     * 最近几条里最新的一张已缓存图片 → 附件块。
     * 主动发言没有"当前消息"，只有记录里的路径；把图直接附上，模型就一定会看到。
     */
    async latestImageOf(recent, cwd) {
        const base = cwd ?? process.cwd();
        for (let index = recent.length - 1; index >= Math.max(0, recent.length - 5); index -= 1) {
            const line = recent[index] ?? '';
            const match = /\[图片: ?([^\]（]+)/.exec(line);
            if (match === null)
                continue;
            const raw = (match[1] ?? '').trim();
            if (raw === '' || raw.includes('已过期'))
                continue;
            const file = isAbsolute(raw) ? raw : join(base, raw);
            if (!existsSync(file))
                continue;
            const admitted = await this.admitImage(base, file, basename(file));
            if (admitted.blocks.length === 0)
                return undefined;
            return { blocks: admitted.blocks, parts: admitted.part === undefined ? [] : [admitted.part] };
        }
        return undefined;
    }
    /**
     * 把本地图片交给宿主附件准入，产出 image content block。
     * 供两处复用：入站图片消息、主动发言时把"最新那张图"直接附上（省得模型不肯主动 read_image）。
     */
    async admitImage(cwd, path, name) {
        const out = { blocks: [] };
        try {
            const buffer = await readFile(path);
            const mediaType = imageMediaType(buffer);
            this.debugLog(cwd, '图片已读取 bytes=' + buffer.byteLength + ' type=' + String(mediaType));
            if (mediaType === undefined) {
                this.opts.log('warn', '图片类型无法识别（不是 png/jpeg/gif/webp），只给路径');
                return out;
            }
            const ctxAny = this.opts.ctx;
            const attachments = (ctxAny.get?.('attachments') ?? ctxAny.attachments);
            if (attachments?.admitPromptContent === undefined) {
                this.debugLog(cwd, '宿主没有 admitPromptContent');
                return out;
            }
            const admitted = await attachments.admitPromptContent([
                { type: 'image', mediaType, data: buffer.toString('base64'), name },
            ]);
            for (const part of admitted) {
                if (part.type === 'image')
                    out.blocks.push(part);
            }
            if (out.blocks.length > 0)
                out.part = { type: 'image', mediaType, data: buffer.toString('base64'), name };
            this.debugLog(cwd, 'admit ok admitted=' + admitted.length + ' blocks=' + out.blocks.length);
        }
        catch (error) {
            this.debugLog(cwd, 'admit 失败: ' + describe(error));
            this.opts.log('warn', 'admitPromptContent 失败: ' + describe(error));
        }
        return out;
    }
    /** 把消息里的图片/文件下载到会话收件箱，返回给模型的文本注释（[图片: path]）。 */
    async resolveInboundMedia(msg, chat) {
        const media = segmentsOf(msg.message).filter(seg => seg.type === 'image' || seg.type === 'file');
        // 引用回复：被引用的那条消息里的图/文件不在当前 segments 里，用 get_msg 取回来
        const replySeg = segmentsOf(msg.message).find(seg => seg.type === 'reply');
        const replyId = replySeg === undefined ? '' : String(replySeg.data?.id ?? '');
        if (replyId !== '') {
            try {
                const quoted = await this.opts.conn.call('get_msg', { message_id: replyId });
                const quotedMedia = segmentsOf(quoted?.message).filter(seg => seg.type === 'image' || seg.type === 'file');
                if (quotedMedia.length > 0) {
                    media.push(...quotedMedia);
                    this.debugLog(undefined, '引用消息带媒体 n=' + quotedMedia.length);
                }
            }
            catch (error) {
                this.debugLog(undefined, 'get_msg 失败: ' + describe(error));
            }
        }
        const blocks = [];
        const parts = [];
        if (media.length === 0)
            return { notes: [], blocks, parts };
        let cwd = chat.cwd;
        if (cwd === undefined) {
            cwd = await this.cwdFor(chat.ref);
            chat.cwd = cwd;
        }
        const inbox = await ensureInbox(cwd);
        this.debugLog(cwd, '收到媒体 segments=' + media.length);
        const notes = [];
        for (const seg of media) {
            const data = (seg.data ?? {});
            const fileRef = String(data.file ?? '');
            try {
                if (seg.type === 'image') {
                    const info = await this.opts.conn.call('get_image', { file: fileRef });
                    const url = info?.url;
                    if (url === undefined || url === '')
                        throw new Error('get_image 没有返回 url');
                    const saved = await downloadToFile(url, inbox, nameFromRef(fileRef, 'image.png'), DEFAULT_MAX_IMAGE_BYTES);
                    this.opts.log('info', '收到图片 → ' + saved.path + ' (' + Math.round(saved.bytes / 1024) + 'KB)');
                    // 走 DSH 原生附件：图片作为 image block 进模型请求；纯文本模型由宿主降级为占位文本
                    const admitted = await this.admitImage(cwd, saved.path, nameFromRef(fileRef, 'image'));
                    for (const block of admitted.blocks)
                        blocks.push(block);
                    if (admitted.part !== undefined)
                        parts.push(admitted.part);
                    const attached = admitted.blocks.length > 0;
                    // 路径注释永远保留：无视觉模型只会拿到宿主的占位文本，路径是它们唯一的抓手；
                    // 视觉模型另外还能直接拿到 image block。
                    notes.push('[图片: ' + saved.path + ']' + (attached ? '' : '（未登记为附件，仅路径）'));
                }
                else {
                    // NapCat 在远端（常见于 Docker）：get_file 的 url 可能是它**本机路径**，不能 fetch。
                    // 顺序照 dsh-onebot：①私聊 get_private_file_url 的 CDN 链接 ②get_file 的 base64 ③http url
                    const isHttp = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
                    const fileName = nameFromRef(fileRef, 'file');
                    let savedPath;
                    const failures = [];
                    if (chat.ref.kind === 'private') {
                        try {
                            const direct = await this.opts.conn.call('get_private_file_url', {
                                user_id: chat.ref.id,
                                file_id: fileRef,
                            });
                            if (isHttp(direct?.url)) {
                                const saved = await downloadToFile(direct.url, inbox, fileName, DEFAULT_MAX_FILE_BYTES);
                                savedPath = saved.path;
                                this.debugLog(cwd, '文件走 get_private_file_url');
                            }
                        }
                        catch (error) {
                            failures.push('get_private_file_url: ' + describe(error));
                        }
                    }
                    if (savedPath === undefined) {
                        const info = await this.opts.conn.call('get_file', { file: fileRef });
                        if (typeof info?.base64 === 'string' && info.base64 !== '') {
                            const buffer = base64UrlToBuffer(info.base64);
                            if (buffer.byteLength > DEFAULT_MAX_FILE_BYTES)
                                throw new Error('文件超过上限');
                            savedPath = join(inbox, Date.now().toString(36) + '-' + fileName);
                            await writeFile(savedPath, buffer);
                            this.debugLog(cwd, '文件走 get_file base64');
                        }
                        else if (isHttp(info?.url)) {
                            const saved = await downloadToFile(info.url, inbox, fileName, DEFAULT_MAX_FILE_BYTES);
                            savedPath = saved.path;
                            this.debugLog(cwd, '文件走 get_file url');
                        }
                        else if (typeof info?.url === 'string' && info.url !== '') {
                            // 远端 NapCat 的本地路径：拿不到字节，给出明确原因让模型能向用户解释
                            throw new Error('NapCat 只给了它本机的路径（' + info.url + '），跨机器取不到；可在 NapCat 里开启文件直链或改用图片发送');
                        }
                    }
                    if (savedPath === undefined) {
                        throw new Error('get_file 既没有 base64 也没有可下载的 url' + (failures.length > 0 ? '（' + failures.join('；') + '）' : ''));
                    }
                    this.opts.log('info', '收到文件 → ' + savedPath);
                    notes.push('[文件: ' + savedPath + ']');
                }
            }
            catch (error) {
                const reason = describe(error);
                this.opts.log('warn', '收媒体失败（' + seg.type + '）: ' + reason);
                notes.push('[' + (seg.type === 'image' ? '图片' : '文件') + ': 下载失败（' + reason + '）]');
            }
        }
        return { notes, blocks, parts };
    }
    // ── 会话装配 ───────────────────────────────────────────────────────────────
    /** 同一聊天并发进来时只装配一次（并发 create 会撞 write handle）。 */
    pendingChats = new Map();
    ensureChat(ref) {
        const existing = this.chats.get(ref.key);
        if (existing !== undefined)
            return Promise.resolve(existing);
        const inflight = this.pendingChats.get(ref.key);
        if (inflight !== undefined)
            return inflight;
        const job = this.createChat(ref).finally(() => { this.pendingChats.delete(ref.key); });
        this.pendingChats.set(ref.key, job);
        return job;
    }
    async createChat(ref) {
        const existing = this.chats.get(ref.key);
        if (existing !== undefined)
            return existing;
        const agents = this.opts.ctx.agents;
        const cwd = await this.cwdFor(ref);
        const suffix = this.sessionSuffixes.get(ref.key);
        // 把 cwd 编进会话 id：改过 workspacePath/开关后自然换新会话，不会 resume 到旧 cwd 的半死会话
        const cwdTag = this.opts.config.perChatWorkspace && this.opts.config.workspacePath.trim() !== ''
            ? '-w' + shortHash(cwd)
            : '';
        let sessionId = makeSessionId(sessionIdForChat(ref.key) + cwdTag + (suffix === undefined ? '' : '-' + suffix));
        // 用户归档过这个会话 → 不解除归档（尊重你的意图），改用**确定性**后缀的新会话：
        // -r1、-r2… 逐个试，取第一个没被归档的。这样重启后还是同一个，不会每次换新。
        if (this.isArchived(String(sessionId))) {
            const base = sessionIdForChat(ref.key) + cwdTag;
            for (let n = 1; n <= 99; n += 1) {
                const candidate = makeSessionId(base + '-r' + n);
                if (this.isArchived(String(candidate)))
                    continue;
                sessionId = candidate;
                this.sessionSuffixes.set(ref.key, 'r' + n);
                this.opts.log('info', '会话已被归档，改用未归档的会话: ' + String(sessionId));
                break;
            }
        }
        // 宿主注册表里已有活着的 agent（上一轮装配失败/并发场景）→ 直接复用，
        // 否则 resume/create 会撞 "already owned by an active write handle" / "already exists"
        let handle;
        const liveAgent = agents.get?.(String(sessionId));
        if (liveAgent !== undefined) {
            this.opts.log('info', '复用已存在的 agent: ' + String(sessionId));
            handle = { agent: liveAgent, dispose: async () => undefined };
        }
        const meta = { cwd };
        if (this.opts.config.agentPreset !== '')
            meta.agentPreset = this.opts.config.agentPreset;
        const agentOptions = {};
        // 照 dsh-onebot：优先用宿主默认模型服务；插件配置里的 provider/model 覆盖它
        const defaultModel = this.opts.ctx.agentDefaultModel;
        let selection = defaultModel?.currentSelection?.();
        if (selection !== undefined) {
            agentOptions.provider = selection.provider;
            agentOptions.model = selection.model;
        }
        if (this.opts.config.provider !== '')
            agentOptions.provider = this.opts.config.provider;
        if (this.opts.config.model !== '')
            agentOptions.model = this.opts.config.model;
        if (agentOptions.provider !== undefined && agentOptions.model !== undefined) {
            selection = { provider: agentOptions.provider, model: agentOptions.model, ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) };
        }
        const selectionRef = selection === undefined ? undefined : { current: selection, assembled: undefined };
        // setup：把预设挂进 agent 的 ctx，并安装模型选择（dsh-onebot 同款）
        const presetId = this.opts.config.agentPreset.trim() === '' ? undefined : this.opts.config.agentPreset.trim();
        const presets = this.opts.ctx.agentPresets;
        if (presets?.mount === undefined)
            this.opts.log('warn', '宿主没有 agentPresets 服务（agent 可能没有工具/loop）');
        const setup = async (agentCtx) => {
            if (presets?.mount !== undefined) {
                try {
                    const mounted = await presets.mount(agentCtx, presetId);
                    this.opts.log('debug', 'agent 已挂预设: ' + String(mounted?.id ?? presetId ?? 'default'));
                }
                catch (error) {
                    this.opts.log('warn', '挂预设失败: ' + describe(error));
                }
            }
            if (selectionRef === undefined) {
                this.opts.log('warn', '没有可用模型（agentDefaultModel 缺失或未选择），这一轮可能空跑');
            }
            else {
                installModelSelection(agentCtx, selectionRef);
                this.opts.log('debug', 'agent 模型: ' + selectionRef.current.provider + '/' + selectionRef.current.model);
            }
        };
        if (agentOptions.model === undefined) {
            this.opts.log('warn', '没有可用的模型：在「设置 → NapCat」里填 provider/model，或先给 DSH 配一个默认模型');
        }
        let created = true;
        if (handle === undefined) {
            // 照 dsh-onebot：先用 sessionPersistence.stat 探测是否已有持久化日志，避免 create 抛错
            let exists = false;
            const persistence = this.opts.ctx.sessionPersistence;
            if (persistence?.stat !== undefined) {
                try {
                    exists = (await persistence.stat(sessionId)) !== undefined;
                }
                catch {
                    exists = false;
                }
            }
            // 冲突（同一 session 已被别的活跃写句柄占用）时：先尝试复用活着的 agent，再换确定性新后缀
            const ownedByOther = (error) => /already owned by an active write handle/i.test(describe(error));
            for (let attempt = 1; handle === undefined && attempt <= 3; attempt += 1) {
                const live = this.liveAgentFor(String(sessionId));
                if (live !== undefined) {
                    handle = { agent: live, dispose: async () => undefined };
                    created = false;
                    this.opts.log('info', '复用已存在的 agent: ' + String(sessionId));
                    break;
                }
                try {
                    if (exists) {
                        created = false;
                        handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
                    }
                    else {
                        created = true;
                        handle = await agents.create({ sessionId, meta, agentOptions, setup });
                    }
                }
                catch (error) {
                    if (ownedByOther(error)) {
                        // 写持有者存在但拿不到 agent（可能刚被别的路径建好）：等一下再看一次
                        await new Promise(resolve => setTimeout(resolve, 400));
                        const late = this.liveAgentFor(String(sessionId));
                        if (late !== undefined) {
                            handle = { agent: late, dispose: async () => undefined };
                            created = false;
                            break;
                        }
                        // 仍是别人的：换一个确定性新会话，别死磕
                        const base = sessionIdForChat(ref.key) + cwdTag;
                        const next = attempt + (Number(this.sessionSuffixes.get(ref.key)?.replace(/^x/, '') ?? 0) || 0);
                        this.sessionSuffixes.set(ref.key, 'x' + next);
                        sessionId = makeSessionId(base + '-x' + next);
                        exists = false;
                        this.opts.log('warn', '会话被活跃写句柄占用，改用新会话: ' + String(sessionId));
                        continue;
                    }
                    if (exists) {
                        // 有日志但 resume 失败（格式/版本问题）→ 改 create
                        this.opts.log('warn', '预检到日志但 resume 失败，改 create: ' + describe(error));
                        exists = false;
                        continue;
                    }
                    throw error;
                }
            }
            if (handle === undefined)
                throw new Error('会话获取失败（多次重试）');
        }
        // 照 dsh-onebot：create/resume 后必须等 agent 就绪（whenIdle）再投递消息，
        // 否则 followup 落不到正在初始化的 agent 上，表现为"消息进去了但这一轮不跑"
        try {
            await handle.agent.whenIdle();
        }
        catch (error) {
            try {
                await handle.dispose();
            }
            catch {
                // 以 whenIdle 的错误为准
            }
            throw error;
        }
        // QQ 渠道没人能点"同意"：审批策略设为 never（否则每轮 turn 会被 blocked）
        try {
            const approval = this.opts.ctx.approval;
            if (approval?.setPolicy !== undefined) {
                approval.setPolicy(handle.agent, 'never');
                this.opts.log('debug', '审批策略已设为 never（QQ 会话无法交互审批）');
            }
            else {
                this.opts.log('warn', '宿主没有 approval.setPolicy（可能仍会被审批挡住）');
            }
        }
        catch (error) {
            this.opts.log('warn', '设置审批策略失败: ' + describe(error));
        }
        const state = {
            ref,
            cwd,
            agent: handle.agent,
            dispose: () => handle.dispose(),
            buffer: [],
            lastReplyId: '',
            recentReplyIds: [],
            fresh: created,
            turnStarted: false,
            retried: false,
        };
        this.chats.set(ref.key, state);
        this.bySession.set(String(handle.agent.session.id), ref.key);
        // 新会话也要立刻套用群/人设（否则只有"保存设置"时才会补上）
        {
            const persona = this.personas.get(ref.key);
            if (persona !== undefined && persona !== '')
                this.personaBySession.set(String(handle.agent.session.id), persona);
            else
                this.personaBySession.delete(String(handle.agent.session.id));
        }
        // 侧边栏工作区需要显式挂载会话（否则显示未分组）
        await this.attachToWorkspace(cwd, workspaceTitle(ref), handle.agent.session.id);
        this.opts.log('info', '会话就绪: ' + ref.key + ' → ' + String(handle.agent.session.id) + ' (cwd=' + cwd + ')');
        return state;
    }
    /**
     * 把会话挂进工作区：宿主要求 **工作区路径必须等于会话 cwd**，所以每个聊天目录本身就是
     * 一个工作区（一群一格 / 一人一格）。照 dsh-onebot：resolveByPath → create(path,title) → attachSession。
     */
    /** 该会话是否已被归档（归档门禁会把每一轮判成 blocked，所以要换新会话）。 */
    isArchived(sessionId) {
        try {
            const registry = this.opts.ctx.workspaceRegistry;
            const ids = registry?.archivedSessionIds ?? [];
            return ids.some(id => String(id) === sessionId);
        }
        catch {
            return false;
        }
    }
    /** 重新解析 personaOverrides（配置热更新时调用）。 */
    refreshPersonas() {
        this.personas = parsePersonaOverrides(this.opts.config.personaOverrides);
        for (const [sessionId, chatKey] of this.bySession) {
            const text = this.personas.get(chatKey);
            if (text === undefined || text === '')
                this.personaBySession.delete(sessionId);
            else
                this.personaBySession.set(sessionId, text);
        }
    }
    /** systemPrompt.context 的取值函数：按 assembly 里的 sessionId 找该会话的人设。 */
    personaText(assembly) {
        const id = assembly?.agent?.session?.id;
        if (id === undefined)
            return '';
        const persona = this.personaBySession.get(String(id)) ?? '';
        if (persona === '')
            return '';
        // 人设只控制语气/称呼/风格：不许复述设定本身，也不许拿它当自我介绍
        return '（角色设定：只用于把握语气、称呼与说话风格。不要在回复里复述、引用或解释这份设定，不要自称"我是…团宠/助手"之类；用户问"你是谁"时用一两句自然的话回答即可。）\n'
            + persona;
    }
    async attachToWorkspace(cwd, title, sessionId) {
        try {
            const registry = this.opts.ctx.workspaceRegistry;
            if (registry === undefined) {
                this.opts.log('warn', '宿主没有 workspaceRegistry 服务（无法挂工作区）');
                return;
            }
            let workspace = await registry.resolveByPath?.(cwd);
            if (workspace === undefined && registry.create !== undefined) {
                workspace = await registry.create(cwd, title);
                this.opts.log('info', '已创建分组（工作区）: ' + title + ' → ' + cwd);
            }
            if (workspace?.attachSession === undefined) {
                this.opts.log('warn', '工作区对象不可挂载: ' + cwd);
                return;
            }
            await workspace.attachSession(String(sessionId));
            this.opts.log('info', '会话已挂到分组: ' + String(workspace.path ?? cwd));
        }
        catch (error) {
            this.opts.log('warn', '挂工作区失败: ' + describe(error));
        }
    }
    /** 会话工作目录：开了 perChatWorkspace 时每个 QQ 会话一个子目录（侧边栏按工作区归拢）。 */
    async cwdFor(ref) {
        const base = this.opts.config.workspacePath.trim();
        if (base === '')
            return process.cwd();
        if (!this.opts.config.perChatWorkspace)
            return base;
        const safe = ref.key.replace(/[^A-Za-z0-9._-]+/g, '-');
        const dir = join(base, 'napcat', safe);
        try {
            await mkdir(dir, { recursive: true });
        }
        catch (error) {
            this.opts.log('warn', '创建会话目录失败，退回工作区根目录: ' + describe(error));
            return base;
        }
        return dir;
    }
    dispatch(chat, text, blocks = [], parts = []) {
        this.debugLog(chat.cwd, 'dispatch 进入 ref=' + chat.ref.key + ' text=' + text.length + '字 blocks=' + blocks.length + ' parts=' + parts.length);
        chat.buffer = [];
        chat.lastText = text;
        // 每次投递前重新断言「免审批」：用户在 GUI 换过权限档位也能继续工作
        try {
            const approval = this.opts.ctx.approval;
            approval?.setPolicy?.(chat.agent, 'never');
        }
        catch {
            // 尽力而为；失败时后续仍会按原策略走
        }
        if (chat.titleSet !== true) {
            chat.titleSet = true;
            try {
                const titles = this.opts.ctx.sessionTitle;
                const named = titles?.rename?.(chat.agent.session, titleFrom(text));
                this.opts.log('debug', '会话标题: ' + String(named?.title ?? titleFrom(text)));
            }
            catch (error) {
                this.opts.log('debug', '设置会话标题失败: ' + describe(error));
            }
        }
        if (parts.length > 0)
            this.debugLog(chat.cwd, '图片消息 blocks=' + blocks.length + ' parts=' + parts.length);
        let pending;
        try {
            pending = chat.agent.followup(createUserMessage({
                // 图片块放在文本之前（与 dsh-qqbot 一致；text 在前时日志里只剩 text）
                content: [...blocks, { type: 'text', text }],
                source: { kind: 'plugin:dsh-napcat' },
            }));
            this.stats.dispatched += 1;
            this.opts.log('info', '已投递到模型: ' + chat.ref.key + ' (' + text.length + ' 字)');
        }
        catch (error) {
            this.opts.log('warn', '投递失败: ' + describe(error));
            void this.recoverChat(chat, error);
            return;
        }
        // followup 可能是异步的（会话被归档/删除、agent 已释放时会 reject）——必须接住，否则消息静默丢失
        if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
            void pending.catch((error) => {
                this.opts.log('warn', '投递被拒: ' + describe(error));
                void this.recoverChat(chat, error);
            });
        }
        chat.dispatchedAt = Date.now();
        // 新建的会话一般不会失效；只有 resume 回来的旧会话（可能已归档）才需要看门狗
        if (chat.fresh !== true)
            this.armWatchdog(chat, text);
    }
    /** 10s 内没等到 turn/start 就认为会话已失效（典型：会话被归档），换新会话重投一次。 */
    armWatchdog(chat, text) {
        if (chat.startTimer !== undefined)
            clearTimeout(chat.startTimer);
        chat.turnStarted = false;
        chat.startTimer = setTimeout(() => {
            chat.startTimer = undefined;
            if (this.stopped)
                return;
            const alive = chat.turnStarted === true || (chat.lastEventAt ?? 0) > (chat.dispatchedAt ?? 0);
            if (alive)
                return;
            this.opts.log('warn', '会话没有开始执行（可能已归档或失效），换新会话重投: ' + chat.ref.key);
            void this.recoverAndRetry(chat, text);
        }, WATCHDOG_MS);
    }
    /** 会话失效后：重建会话并把这条消息再投一次（每条消息只重试一次）。 */
    async recoverAndRetry(chat, text) {
        const ref = chat.ref;
        if (chat.retried === true) {
            await this.sendText(chat, '⚠️ 会话没有响应，已换新会话仍失败，请稍后再试');
            return;
        }
        await this.recoverChat(chat, new Error('会话没有开始执行'));
        try {
            const fresh = await this.ensureChat(ref);
            fresh.retried = true;
            this.dispatch(fresh, text);
        }
        catch (error) {
            this.opts.log('warn', '重建会话失败: ' + describe(error));
        }
    }
    /** 投递失败（归档/删除/agent 释放）：丢掉旧会话状态，下次消息重新建会话，并告知用户。 */
    async recoverChat(chat, error, notify = true) {
        if (chat.startTimer !== undefined) {
            clearTimeout(chat.startTimer);
            chat.startTimer = undefined;
        }
        // 换一个会话 id：否则 create 会撞上归档/失效的旧 id，又 resume 回那个死会话
        this.sessionSuffixes.set(chat.ref.key, Date.now().toString(36));
        this.chats.delete(chat.ref.key);
        for (const [sid, key] of [...this.bySession]) {
            if (key === chat.ref.key)
                this.bySession.delete(sid);
        }
        try {
            await chat.dispose();
        }
        catch {
            // agent 可能已被宿主释放，忽略
        }
        if (notify)
            await this.sendText(chat, '⚠️ 消息没送进模型：' + describe(error) + '\n（会话状态已重置，再发一条会重新建会话）');
    }
    // ── 出站 ───────────────────────────────────────────────────────────────────
    onSessionEvent(session, event) {
        // 归档会话的输出：只收集，不投递给 QQ
        const collector = this.archiveCollectors.get(String(session.id));
        if (collector !== undefined) {
            if (event.type === 'assistant/message') {
                const collected = messageText(event.data.message);
                if (collected.trim() !== '')
                    collector.buffer.push(collected.trim());
                return;
            }
            if (event.type === 'turn/end') {
                const text = collector.buffer.join('\n').trim();
                clearTimeout(collector.timer);
                this.archiveCollectors.delete(String(session.id));
                collector.resolve(text);
                return;
            }
            return;
        }
        if (this.stopped)
            return;
        const key = this.bySession.get(String(session.id));
        if (key === undefined) {
            if (String(session.id).includes('napcat'))
                this.opts.log('debug', '事件找不到会话映射: ' + String(session.id) + ' type=' + String(event.type));
            return;
        }
        this.opts.log('debug', '出站事件: ' + String(event.type) + ' ← ' + key);
        const chat = this.chats.get(key);
        if (chat === undefined)
            return;
        // 任何事件都说明这一轮在跑（turn/start 未必总能收到）
        chat.lastEventAt = Date.now();
        if (event.type === 'turn/start') {
            chat.buffer = [];
            return;
        }
        if (event.type === 'assistant/message') {
            const text = messageText(event.data.message);
            this.opts.log('debug', '助手文本长度: ' + text.length);
            if (text.trim() !== '')
                chat.buffer.push(text.trim());
            return;
        }
        if (event.type === 'assistant/attempt') {
            const stream = event.data.stream;
            this.opts.log('warn', '一次模型尝试未提交（无正式回复）: ' + JSON.stringify(stream ?? {}).slice(0, 400));
            return;
        }
        if (event.type === 'turn/end') {
            this.opts.log('debug', 'turn/end 原因: ' + JSON.stringify(event.data.reason ?? {}).slice(0, 400));
            const reason = event.data.reason;
            let text = chat.buffer.join('\n').trim();
            chat.buffer = [];
            // 主动发言：拦截 __SKIP__，并记录发言/跳过
            if (this.pendingProactive.delete(key)) {
                const state = this.proactiveStates.get(key) ?? newChatState();
                const now = Date.now();
                this.proactiveStartedAt.delete(key);
                if (text === '' || /__SKIP__/i.test(text)) {
                    state.skipStreak += 1;
                    state.lastSkipAt = now;
                    state.lastConsiderAt = now;
                    this.proactiveStates.set(key, state);
                    this.stats.proactiveSkipped += 1;
                    this.opts.log('info', '主动发言跳过（模型认为没必要）: ' + key + ' skipStreak=' + state.skipStreak);
                    if (text === '' && reason.kind === 'error') {
                        this.opts.log('debug', '主动发言轮次出错（忽略）: ' + reason.error.message);
                    }
                    return;
                }
                state.skipStreak = 0;
                state.lastSkipAt = undefined;
                state.lastSpokeAt = now;
                state.sentAt = pruneSentAt([...state.sentAt, now], now);
                state.lastConsiderAt = now;
                this.proactiveStates.set(key, state);
                this.stats.proactiveSent += 1;
                this.opts.log('info', '主动发言已发出: ' + key + '（本小时第 ' + state.sentAt.length + ' 条）');
            }
            if (text !== '') {
                // 旧格式 <归档> 块兜底剥离（真正的归档已改独立轮，这里只是防止漏给群友）
                const cleaned = this.stripArchiveBlock(text);
                if (cleaned !== '')
                    void this.sendText(chat, cleaned);
            }
            else if (reason.kind === 'error') {
                void this.sendText(chat, '⚠️ 本轮出错：' + reason.error.message);
                // 会话存储文件被外部删掉时会 ENOENT：丢状态 + 换新 id，下一条消息自然新建日志
                if (/ENOENT|no such file/i.test(reason.error.message)) {
                    this.opts.log('warn', '会话存储文件丢失，丢弃会话状态并用新会话重投: ' + chat.ref.key);
                    const text = chat.lastText;
                    if (text !== undefined && text !== '')
                        void this.recoverAndRetry(chat, text);
                    else
                        void this.recoverChat(chat, reason.error, false);
                }
            }
            return;
        }
    }
    /**
     * 探测本群机器人是否被禁言（群聊）。
     * 来源：get_group_member_info 的 shut_up_timestamp（秒）+ get_group_info 的 group_all_shut（全员禁言）。
     * 返回解禁时间戳（毫秒）：未禁言 = 0；查不到 = undefined（此时不做任何暂停）。
     */
    async probeMute(ref) {
        if (ref.kind !== 'group')
            return undefined;
        const selfId = await this.selfQq();
        if (selfId === '')
            return undefined;
        try {
            const member = await this.opts.conn.call('get_group_member_info', {
                group_id: ref.id,
                user_id: selfId,
                no_cache: true,
            });
            const until = Number(member?.shut_up_timestamp ?? 0);
            if (Number.isFinite(until) && until * 1000 > Date.now())
                return until * 1000;
        }
        catch {
            // 查不到成员信息就继续看全员禁言
        }
        try {
            const info = await this.opts.conn.call('get_group_info', { group_id: ref.id, no_cache: true });
            if (Number(info?.group_all_shut ?? 0) > 0)
                return Date.now() + 15 * 60_000;
        }
        catch {
            // 忽略
        }
        return 0;
    }
    /** 机器人自己的 QQ：配置优先，未配置时用 get_login_info 取一次并缓存。 */
    async selfQq() {
        const configured = this.opts.config.botQQ.trim();
        if (configured !== '')
            return configured;
        if (this.selfQqCache !== '')
            return this.selfQqCache;
        try {
            const info = await this.opts.conn.call('get_login_info');
            const id = String(info?.user_id ?? '').trim();
            if (id !== '')
                this.selfQqCache = id;
            return id;
        }
        catch {
            return '';
        }
    }
    /** 出站发送：小黄脸嵌在文字里（同一条消息），图片/表情包单独发。 */
    /** 让模型说一句幽默的拒绝（一次性会话，只让它说话、不执行）。 */
    async humorousRefusal(ref, hit) {
        try {
            const cwd = await this.cwdFor(ref);
            const handle = await this.openArchiveAgent(cwd, ref.key, 'napcat-refuse-');
            if (handle === undefined)
                return '';
            const sessionId = String(handle.agent.session.id);
            const prompt = buildRefusalPrompt(hit, this.opts.config.dangerReplyPrompt);
            const text = await this.collectArchiveOutput(sessionId, async () => {
                await handle.agent.followup(createUserMessage({
                    content: [{ type: 'text', text: prompt }],
                    source: { kind: 'plugin:dsh-napcat' },
                }));
            }, 20_000);
            return cleanRefusal(text, 60);
        }
        catch (error) {
            this.opts.log('debug', '生成幽默拒绝失败: ' + describe(error));
            return '';
        }
    }
    /** 拒绝危险请求时回一句（每会话 10 分钟最多一次，避免刷屏）。 */
    async replyDanger(ref, hit) {
        const now = Date.now();
        const last = this.dangerNoticeAt.get(ref.key) ?? 0;
        if (now - last < 10 * 60_000)
            return;
        this.dangerNoticeAt.set(ref.key, now);
        // 只说模型给的那句；拿不到就静默（不留固定文案）
        const text = await this.humorousRefusal(ref, hit);
        if (text.trim() === '') {
            this.opts.log('debug', '没能生成拒绝文案，本条静默: ' + ref.key);
            return;
        }
        try {
            const params = ref.kind === 'group' ? { group_id: ref.id, message: text } : { user_id: ref.id, message: text };
            await this.opts.conn.call('send_msg', params);
        }
        catch (error) {
            this.opts.log('debug', '发送拒绝提示失败: ' + describe(error));
        }
    }
    async sendText(chat, text) {
        // 群禁言期间直接不发（QQ 会拒，还白烧一轮模型）
        const mutedUntil = this.mutedUntil.get(chat.ref.key) ?? 0;
        if (mutedUntil > Date.now()) {
            this.opts.log('info', '本群禁言中，暂停发送: ' + chat.ref.key + '（解禁 ' + new Date(mutedUntil).toLocaleTimeString('zh-CN') + '）');
            return;
        }
        const plan = await this.planOutbound(chat, text);
        const groups = splitSegments(plan.segments, this.opts.config.splitMaxChars);
        const interval = this.opts.config.sendIntervalMs;
        for (let index = 0; index < groups.length; index += 1) {
            const parts = groups[index] ?? [];
            const message = [];
            if (index === 0 && this.opts.config.replyAsQuote && chat.lastReplyId !== '') {
                message.push({ type: 'reply', data: { id: chat.lastReplyId } });
            }
            for (const part of parts) {
                message.push(part.kind === 'text' ? { type: 'text', data: { text: part.text } } : { type: 'face', data: { id: part.id } });
            }
            if (message.length === 0)
                continue;
            const ok = await this.sendSegments(chat, message);
            if (!ok)
                return;
            this.stats.sent += 1;
            this.opts.log('info', '已发送到 QQ: ' + chat.ref.key + '（' + parts.length + ' 段）');
            if (interval > 0 && index < groups.length - 1) {
                await new Promise(resolve => setTimeout(resolve, interval));
            }
        }
        // 图片/表情包单独发（每张一条），图自己会说话
        for (const file of plan.images) {
            await this.sendImagePath(chat, file);
        }
        // 记录这轮带没带表情（供下轮注入做频率提示）
        this.noteReplyMemeState(chat.ref.key, plan.images.length > 0 || plan.segments.some(part => part.kind === 'face'));
    }
    /**
     * 出站预处理：把回复里的标记解析成「文字段 + 原生表情段」和「待发图片」。
     *   [图片:<路径>] / ![alt](<路径>)  → 收集为图片，解析后单独发
     *   [表情:<描述>]                   → 图库有图就当图片发；没图就换成 QQ 原生表情，**就地嵌进文字流**
     */
    async planOutbound(chat, text) {
        const images = [];
        const pushFile = (rawPath) => {
            const cleaned = rawPath.trim().replace(/^<|>$/g, '');
            if (cleaned === '')
                return;
            const baseDir = chat.cwd ?? normalizePath(this.opts.config.workspacePath) ?? process.cwd();
            const absolute = /^([A-Za-z]:[\\/]|\/)/.test(cleaned) ? cleaned : join(baseDir, cleaned);
            if (!existsSync(absolute)) {
                this.opts.log('warn', '要发送的图片不存在，已跳过: ' + cleaned);
                return;
            }
            if (!images.includes(absolute))
                images.push(absolute);
        };
        // 1) 先把图片标记摘掉（它们不进文字流）
        let body = text
            .replace(/\[图片:([^\]]+)\]/g, (_match, raw) => {
            for (const part of raw.split(/[,，]/))
                pushFile(part);
            return '';
        })
            .replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_match, raw) => {
            pushFile(raw);
            return '';
        });
        // 2) 再按 [表情:…] 切分文字流，小黄脸就地插进去
        const segments = [];
        const pattern = /\[表情:\s*([^\]]*)\]/g;
        let last = 0;
        let match;
        while ((match = pattern.exec(body)) !== null) {
            const before = body.slice(last, match.index);
            if (before !== '')
                segments.push({ kind: 'text', text: before });
            last = match.index + match[0].length;
            const query = (match[1] ?? '').trim();
            let resolved = false;
            if (this.opts.config.memeEnabled && query !== '') {
                const hit = await this.resolveMeme(query);
                if (hit !== undefined) {
                    pushFile(hit);
                    resolved = true;
                }
            }
            if (!resolved && this.opts.config.faceFallback) {
                const faceId = faceFor(query, this.recentFaceIds);
                if (faceId !== undefined) {
                    segments.push({ kind: 'face', id: faceId });
                    this.noteFaceSent(faceId);
                    resolved = true;
                }
            }
            if (!resolved && this.opts.config.faceFallback && query !== '') {
                // 连关键词都对不上：给一个轮换的"通用"表情，别让用户的 [表情:…] 白写
                const generic = faceFor('开心', this.recentFaceIds) ?? '14';
                segments.push({ kind: 'face', id: generic });
                this.noteFaceSent(generic);
                resolved = true;
                this.opts.log('info', '表情描述匹配不到，改用通用表情 face ' + generic + ': ' + query);
            }
            if (!resolved && query !== '')
                this.opts.log('info', '表情已丢弃（图库/表情都不可用）: ' + query);
        }
        const tail = body.slice(last);
        if (tail !== '')
            segments.push({ kind: 'text', text: tail });
        // 3) 规整文字段（去多余空行；纯空白段丢掉）
        const cleaned = [];
        for (const part of segments) {
            if (part.kind === 'face') {
                cleaned.push(part);
                continue;
            }
            const value = part.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
            if (value.trim() !== '')
                cleaned.push({ kind: 'text', text: value });
        }
        return { segments: trimParts(cleaned), images };
    }
    /**
     * 计算"避重集合"：默认按图库大小自适应（约一半），图库变大窗口自动变宽，
     * 不用手动调；`memeRecentLimit` 设正数则固定，设 0 则不避重。
     */
    async memeAvoidSet() {
        const configured = Math.floor(this.opts.config.memeRecentLimit);
        if (configured === 0)
            return new Set();
        let window = configured;
        if (configured < 0) {
            const total = await this.memeLib().size();
            // 一半左右最舒服：太少会重复，太多会导致可选图变少反而更差
            window = Math.min(50, Math.max(1, Math.floor(total / 2)));
        }
        return new Set(this.recentMemeFiles.slice(0, Math.max(0, window)));
    }
    /**
     * 在候选里挑一张"分数够、但不总是第一名"的图：取前 5 张随机挑一张。
     * 以前永远返回第一名 → 图库 146 张，实际只有几张在轮换。
     */
    pickDiverse(hits) {
        const top = hits[0];
        if (top === undefined)
            throw new Error('表情候选为空');
        const candidates = hits.slice(0, 5);
        const picked = candidates[Math.floor(Math.random() * candidates.length)];
        return picked ?? top;
    }
    /** 按描述从 dsh-meme 图库找图；同一张最近发过就换一张同情绪的，避免来回重复。 */
    async resolveMeme(query) {
        this.noteExpressionUsed(query);
        const library = this.memeLib();
        // 描述恰好是某张图的 caption 原文 → 锁定这张，不参与避重换图
        // （网页端按同一段描述显示的就是这张，换成别的会出现"两边不一致"；
        //   想要多样性靠注入「最近发过的表情」让模型换描述，而不是插件偷换图）
        const exact = await library.exact(query);
        if (exact !== undefined) {
            this.noteMemeSent(exact.file);
            return exact.file;
        }
        const avoid = await this.memeAvoidSet();
        const hits = await library.search(query, avoid, 12);
        // 在"分数接近的前几名"里随机挑：否则永远命中同一张，146 张只用到几张
        const fresh = hits.filter(hit => !avoid.has(hit.file));
        if (fresh.length > 0) {
            const picked = this.pickDiverse(fresh);
            this.noteMemeSent(picked.file);
            return picked.file;
        }
        // 描述匹配不上：退回"按情绪挑"（只认明确提到的情绪词，不再默认 daily）
        const guess = query.match(/开心|笑|好耶|满意|可爱|喜欢|卖萌|赞|棒/) ? 'happy'
            : query.match(/生气|怒|气死|讨厌|烦/) ? 'angry'
                : query.match(/难过|伤心|哭|委屈|求饶|唉/) ? 'sad'
                    : query.match(/无语|汗|尴尬|无奈/) ? 'sigh'
                        : query.match(/害羞|脸红|不好意思|羞/) ? 'shy'
                            : query.match(/困惑|疑问|惊讶|震惊|懵/) ? 'confused'
                                : query.match(/睡|困|晚安|累/) ? 'sleep'
                                    : undefined;
        if (guess !== undefined) {
            const fallback = await library.randomInTag(guess, avoid);
            if (fallback !== undefined) {
                this.noteMemeSent(fallback.file);
                return fallback.file;
            }
        }
        // 情绪也匹配不上（或该情绪用光）：默认**不发不贴题的图**，交给上层退化成小黄脸/纯文字。
        // 想要"没匹配也随便发一张"就把 memeLooseFallback 打开。
        if (this.opts.config.memeLooseFallback) {
            const anywhere = await library.randomAny(avoid);
            if (anywhere !== undefined) {
                this.noteMemeSent(anywhere.file);
                return anywhere.file;
            }
        }
        return undefined;
    }
    /** 记录用过的表情描述（注入给模型，提示别连着用同一个），最多 8 条。 */
    noteExpressionUsed(query) {
        const text = query.trim();
        if (text === '')
            return;
        if (this.recentMemeCaptions[0] === text)
            return;
        this.recentMemeCaptions.unshift(text);
        while (this.recentMemeCaptions.length > 8)
            this.recentMemeCaptions.pop();
    }
    /** 记录刚发过的原生表情（用于轮换，最多 8 个）。 */
    noteFaceSent(faceId) {
        this.recentFaceIds.unshift(faceId);
        while (this.recentFaceIds.length > 8)
            this.recentFaceIds.pop();
    }
    noteMemeSent(file) {
        // 只负责记录（最多存 50 条），实际用多少由 memeAvoidSet() 按图库大小自动决定
        this.recentMemeFiles.unshift(file);
        while (this.recentMemeFiles.length > 50)
            this.recentMemeFiles.pop();
    }
    /** 启动时把图库解析结果打到 info，方便一眼确认"扫的哪个目录、有多少张"。 */
    async logMemeLibrary() {
        if (!this.opts.config.memeEnabled) {
            this.opts.log('info', '表情功能已关闭（memeEnabled=false）');
            return;
        }
        const configured = this.opts.config.memeDirs.split(/[\n;,]/).map(part => normalizePath(part)).filter(part => part !== '');
        const dshHome = (process.env.DSH_HOME ?? '').trim() !== '' ? normalizePath(process.env.DSH_HOME ?? '') : join(homedir(), '.dsh');
        const dirs = configured.length > 0 ? configured : defaultMemeDirs(dshHome);
        if (dirs.length === 0) {
            this.opts.log('warn', '表情库为空：没找到任何图库目录（DSH_HOME=' + dshHome + '，找 <DSH_HOME>/meme-packs 或 profiles/*/node_modules/dsh-meme/memes）');
            return;
        }
        try {
            const size = await this.memeLib().size();
            this.opts.log('info', '表情库: ' + String(size) + ' 张 · 目录 ' + dirs.join(' , '));
            if (size === 0)
                this.opts.log('warn', '表情库扫到 0 张（目录存在但没有 index.db 或图片缺失）');
        }
        catch (error) {
            this.opts.log('warn', '表情库加载失败: ' + describe(error));
        }
    }
    /** 供 napcat_meme_search 工具：按描述查表情（返回 caption/tag 便于模型精确引用）。 */
    async searchMemeForTool(query, limit) {
        try {
            const hits = await this.memeLib().search(query, new Set(), Math.max(1, limit));
            return hits.map(hit => ({ caption: hit.caption, tag: hit.tag }));
        }
        catch (error) {
            this.opts.log('debug', '表情检索失败: ' + describe(error));
            return [];
        }
    }
    /** 供 napcat_meme_catalog 工具：分类 + 张数 + 示例。 */
    async memeCatalogForTool() {
        try {
            return await this.memeLib().catalog(3);
        }
        catch (error) {
            this.opts.log('debug', '表情目录失败: ' + describe(error));
            return [];
        }
    }
    /** 表情库目录摘要（缓存 60 秒；新加的表情包到期自动出现在目录里）。 */
    async memeCatalogText() {
        const cached = this.memeCatalogCache;
        if (cached !== undefined && Date.now() - cached.at < 60_000)
            return cached.text;
        if (!this.opts.config.memeEnabled) {
            this.memeCatalogCache = { text: '', at: Date.now() };
            return '';
        }
        try {
            const catalog = await this.memeLib().catalog(2);
            if (catalog.length === 0) {
                this.memeCatalogCache = { text: '', at: Date.now() };
                return '';
            }
            const total = catalog.reduce((sum, entry) => sum + entry.count, 0);
            const lines = catalog.slice(0, 14).map(entry => entry.tag + '(' + entry.count + ')' + (entry.samples.length > 0 ? '：' + entry.samples.join(' / ') : ''));
            const text = '【可用表情包（共 ' + total + ' 张，按分类）】' + lines.join('；')
                + '\n想发时在回复里写 [表情: 描述]（贴近上面某分类的示例或某一类的意思）；拿不准就不发。'
                + '\n这是图库里的**表情包图片**（不是用户发的图，两者无关）：只是调味，别每条都配；情绪到位、接梗、卖萌时才用。'
                + '也可以先用 napcat_meme_search 查一下再写。';
            this.memeCatalogCache = { text, at: Date.now() };
            return text;
        }
        catch (error) {
            this.opts.log('debug', '表情库目录生成失败: ' + describe(error));
            this.memeCatalogCache = { text: '', at: Date.now() };
            return '';
        }
    }
    /** 懒加载表情库（优先配置目录，否则扫 DSH_HOME 下各 profile 里的 dsh-meme）。 */
    memeLib() {
        if (this.memeLibrary !== undefined)
            return this.memeLibrary;
        const configured = this.opts.config.memeDirs
            .split(/[\n;,]/)
            .map(part => normalizePath(part))
            .filter(part => part !== '');
        const dshHome = (process.env.DSH_HOME ?? '').trim() !== '' ? normalizePath(process.env.DSH_HOME ?? '') : join(homedir(), '.dsh');
        const settings = readMemeSettings(); // dsh-meme 的图库根目录 / 启用的包以它为准
        const dirs = configured.length > 0 ? configured : defaultMemeDirs(dshHome);
        this.memeLibrary = new MemeLibrary(dirs, (level, message) => this.opts.log(level, message), 60_000, settings.enabledPacks);
        return this.memeLibrary;
    }
    /** 把本地图片文件作为图片消息发出去（带重试/禁言处理；dryRun 时只记日志）。 */
    async sendImagePath(chat, file) {
        if (this.opts.config.dryRun) {
            this.opts.log('info', '[dryRun] 本应发送图片: ' + chat.ref.key + ' ← ' + file);
            return;
        }
        let url = '';
        let name = '';
        try {
            const packed = await localToBase64Url(file, this.opts.config.outboundImageMaxBytes);
            url = packed.url;
            name = packed.name;
        }
        catch (error) {
            this.opts.log('warn', '读取待发送图片失败: ' + describe(error));
            return;
        }
        const message = [{ type: 'image', data: { file: url } }];
        const sent = await this.sendSegments(chat, message);
        if (sent)
            this.opts.log('info', '已发送图片到 QQ: ' + chat.ref.key + ' (' + name + ')');
    }
    /** 统一的发送入口：重试 + 禁言探测；dryRun 时只记日志并返回成功。 */
    async sendSegments(chat, message) {
        if (!this.opts.config.enabled) {
            this.opts.log('debug', '插件已禁用（enabled=false），跳过发送');
            return false;
        }
        if (this.opts.config.dryRun) {
            this.opts.log('info', '[dryRun] 本应发送到 ' + chat.ref.key + ': ' + JSON.stringify(message.slice(0, 2)).slice(0, 200));
            return true;
        }
        const attempts = 3;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                await this.opts.conn.call('send_msg', {
                    message_type: chat.ref.kind,
                    ...(chat.ref.kind === 'group' ? { group_id: chat.ref.id } : { user_id: chat.ref.id }),
                    message,
                });
                return true;
            }
            catch (error) {
                const reason = describe(error);
                const transient = /EventChecker|result":\s*120|timeout|ECONN|socket/i.test(reason);
                if (attempt < attempts - 1 && transient) {
                    const wait = 700 * (attempt + 1);
                    this.opts.log('warn', '发送被 QQ 拒绝（第 ' + (attempt + 1) + ' 次），' + wait + 'ms 后重试: ' + chat.ref.key);
                    await new Promise(resolve => setTimeout(resolve, wait));
                    continue;
                }
                const until = await this.probeMute(chat.ref);
                if (until !== undefined && until > Date.now()) {
                    this.mutedUntil.set(chat.ref.key, until);
                    this.opts.log('warn', '检测到机器人被禁言，暂停发送: ' + chat.ref.key + '（解禁 ' + new Date(until).toLocaleTimeString('zh-CN') + '）');
                    return false;
                }
                this.opts.log('warn', '发送失败: ' + chat.ref.key + ' — ' + reason);
                return false;
            }
        }
        return false;
    }
}
/** 从助手消息里抽纯文本（工具调用等非文本段忽略）。 */
function messageText(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const part of content) {
        const item = part;
        if (item.type === 'text' && typeof item.text === 'string')
            parts.push(item.text);
    }
    return parts.join('');
}
function describe(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
/** 路径归一化：**按当前平台**统一分隔符、去尾斜杠；Windows 额外小写（盘符/路径不区分大小写）。 */
function normalizePath(input) {
    const trimmed = input.trim();
    if (process.platform === 'win32') {
        let value = trimmed.replace(/\//g, '\\');
        while (value.length > 1 && value.endsWith('\\'))
            value = value.slice(0, -1);
        return value.toLowerCase();
    }
    // Linux / macOS：一律正斜杠（否则会生成 \workspace\memory 这种非法路径）
    let value = trimmed.replace(/\\/g, '/');
    while (value.length > 1 && value.endsWith('/'))
        value = value.slice(0, -1);
    return value;
}
/** 工作区/分组标题：群 → 群 <号>；私聊 → 私聊 <QQ>。 */
function workspaceTitle(ref) {
    const id = ref.key.replace(/^[a-z]+[:：]/, '');
    return ref.kind === 'group' ? '群 ' + id : '私聊 ' + id;
}
/** 去掉首尾纯空白文字段（表情段保留）。 */
export function trimParts(parts) {
    const out = [...parts];
    while (out.length > 0) {
        const first = out[0];
        if (first === undefined || first.kind !== 'text')
            break;
        const trimmed = first.text.replace(/^\s+/, '');
        if (trimmed === '') {
            out.shift();
            continue;
        }
        out[0] = { kind: 'text', text: trimmed };
        break;
    }
    while (out.length > 0) {
        const lastPart = out[out.length - 1];
        if (lastPart === undefined || lastPart.kind !== 'text')
            break;
        const trimmed = lastPart.text.replace(/\s+$/, '');
        if (trimmed === '') {
            out.pop();
            continue;
        }
        out[out.length - 1] = { kind: 'text', text: trimmed };
        break;
    }
    return out;
}
/**
 * 把混排片段按字数上限切成多条消息（表情不占字数、跟着当前条走）。
 * maxChars <= 0 表示不分段。
 */
export function splitSegments(parts, maxChars) {
    const groups = [];
    let current = [];
    let length = 0;
    const flush = () => {
        if (current.length > 0) {
            groups.push(current);
            current = [];
            length = 0;
        }
    };
    for (const part of parts) {
        if (part.kind === 'face') {
            current.push(part);
            continue;
        }
        let rest = part.text;
        if (maxChars <= 0) {
            current.push({ kind: 'text', text: rest });
            length += rest.length;
            continue;
        }
        while (rest !== '') {
            const room = Math.max(1, maxChars - length);
            const piece = rest.slice(0, room);
            rest = rest.slice(piece.length);
            current.push({ kind: 'text', text: piece });
            length += piece.length;
            if (length >= maxChars)
                flush();
        }
    }
    flush();
    return groups;
}
