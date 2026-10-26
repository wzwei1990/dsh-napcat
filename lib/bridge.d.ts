/**
 * QQ 会话 ↔ dsh agent 的桥。
 *
 * 入站：OneBot 消息事件 → 策略/门控 → 每个会话一个 agent → `agent.followup(用户消息)`
 * 出站：订阅会话事件（`session/event`）→ 回合结束时把助手文本按长度分段发回 QQ
 *
 * 会话 id 由 QQ 会话确定性地派生（`napcat-private-<QQ>` / `napcat-group-<群号>`），
 * 重启后 create 失败即回退 resume，于是同一 QQ 会话自动续上上下文。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import type { LogLevel, OneBotConnection } from './onebot.js';
import type { ObEvent } from './types.js';
export interface BridgeOptions {
    ctx: Context;
    config: Config;
    conn: OneBotConnection;
    log(level: LogLevel, message: string): void;
}
export declare class Bridge {
    private readonly opts;
    /** 群/私聊记忆（一群一目录 + mnemon 长期记忆）。 */
    private readonly mem;
    /** 已尝试预热的聊天（每会话一次）。 */
    /** 上次预热尝试时间（避免频繁重试）。 */
    private readonly warmAttempts;
    private readonly chats;
    private readonly bySession;
    /** 归档/失效后换用新会话 id 的后缀（下次建会话时带上）。 */
    private readonly sessionSuffixes;
    /** sessionId → 该会话的人设文本（来自 personaOverrides）。 */
    private readonly personaBySession;
    /** 解析后的人设表（chat key → 文本）。 */
    private personas;
    private sessionEventOff;
    private stopped;
    private mentionWarned;
    constructor(opts: BridgeOptions);
    start(): void;
    stop(): Promise<void>;
    /** 一条 OneBot 事件进站。 */
    handleEvent(event: ObEvent): Promise<void>;
    /** 每个 cwd 一个图片缓存（配额/清理按 cwd 独立）。 */
    private readonly imageCaches;
    /** 已经清理过过期目录的 cwd。 */
    private readonly imageCacheSwept;
    private imageCacheFor;
    /**
     * 观察层用：把消息里的图片落盘（imageCache=all 时），并把文件名写进聊天记录，
     * 这样之后能用 read_image 回头看群里的图/表情包。
     */
    private prepareRecentText;
    /** 每聊天的主动发言状态。 */
    private readonly proactiveStates;
    /** 该聊天最近「他人消息」的时间戳（观察窗口内计数用）。 */
    private readonly chatter;
    /** 首次计数时用历史缓冲回填窗口的 promise：判定前要等它，否则重启后会误判「只有 1 条」。 */
    private readonly chatterReady;
    /** 已投递主动发言请求、等待回复拦截的聊天。 */
    private readonly pendingProactive;
    /** 群禁言到什么时候（毫秒）：期间不发消息，也跳过主动发言。 */
    private readonly mutedUntil;
    /** 表情库（懒加载）。 */
    private memeLibrary;
    /** 最近发过的原生表情 id（避免同一句描述永远同一个表情）。 */
    private readonly recentFaceIds;
    /** 最近发过的表情文件（避免连续重复同一张）。 */
    private readonly recentMemeFiles;
    /** 机器人自己的 QQ（配置没填时用 get_login_info 取一次后缓存）。 */
    private selfQqCache;
    /** 上次「被硬门挡住」的提示时间（防刷屏，每群 10 分钟一条）。 */
    private readonly proactiveNoticeAt;
    /** 记录一条他人消息（供主动发言判断"有没有人在聊"）。 */
    private noteChatter;
    /**
     * 判断并（可能）主动插话。只在群里、且用户没叫它的时候调用。
     * 判定不通过就什么都不做；通过则投递一条 [主动发言] 请求，由模型决定说还是回 __SKIP__。
     */
    private maybeInterject;
    /** 供 napcat_memory_space 工具登记空间 id。 */
    /** 供 napcat_memory_space 工具登记空间 id。 */
    saveMemorySpace(chatKey: string, spaceId: string): Promise<void>;
    /** 缓冲不足时才预热；同一聊天 5 分钟内最多尝试一次。 */
    private maybeWarmup;
    /** 用 NapCat 的历史消息接口预热 recent 缓冲（群 get_group_msg_history / 私聊 get_friend_msg_history）。 */
    private warmup;
    private handleEventInner;
    /** 写一行诊断到 <会话cwd>/napcat-inbox/_image-debug.log（出问题时能自查，用户随时可删）。 */
    private debugLog;
    /** 宿主会话 id → QQ 会话 key（工具省略 chat_id 时用来定位当前会话）。 */
    keyForSession(sessionId: string): string | undefined;
    /** 把消息里的图片/文件下载到会话收件箱，返回给模型的文本注释（[图片: path]）。 */
    private resolveInboundMedia;
    /** 同一聊天并发进来时只装配一次（并发 create 会撞 write handle）。 */
    private readonly pendingChats;
    private ensureChat;
    private createChat;
    /**
     * 把会话挂进工作区：宿主要求 **工作区路径必须等于会话 cwd**，所以每个聊天目录本身就是
     * 一个工作区（一群一格 / 一人一格）。照 dsh-onebot：resolveByPath → create(path,title) → attachSession。
     */
    /** 该会话是否已被归档（归档门禁会把每一轮判成 blocked，所以要换新会话）。 */
    private isArchived;
    /** 重新解析 personaOverrides（配置热更新时调用）。 */
    refreshPersonas(): void;
    /** systemPrompt.context 的取值函数：按 assembly 里的 sessionId 找该会话的人设。 */
    personaText(assembly: {
        agent?: {
            session?: {
                id?: unknown;
            };
        };
    } | undefined): string;
    private attachToWorkspace;
    /** 会话工作目录：开了 perChatWorkspace 时每个 QQ 会话一个子目录（侧边栏按工作区归拢）。 */
    private cwdFor;
    private dispatch;
    /** 10s 内没等到 turn/start 就认为会话已失效（典型：会话被归档），换新会话重投一次。 */
    private armWatchdog;
    /** 会话失效后：重建会话并把这条消息再投一次（每条消息只重试一次）。 */
    private recoverAndRetry;
    /** 投递失败（归档/删除/agent 释放）：丢掉旧会话状态，下次消息重新建会话，并告知用户。 */
    private recoverChat;
    private onSessionEvent;
    /**
     * 探测本群机器人是否被禁言（群聊）。
     * 来源：get_group_member_info 的 shut_up_timestamp（秒）+ get_group_info 的 group_all_shut（全员禁言）。
     * 返回解禁时间戳（毫秒）：未禁言 = 0；查不到 = undefined（此时不做任何暂停）。
     */
    private probeMute;
    /** 机器人自己的 QQ：配置优先，未配置时用 get_login_info 取一次并缓存。 */
    private selfQq;
    /** 出站发送：小黄脸嵌在文字里（同一条消息），图片/表情包单独发。 */
    private sendText;
    /**
     * 出站预处理：把回复里的标记解析成「文字段 + 原生表情段」和「待发图片」。
     *   [图片:<路径>] / ![alt](<路径>)  → 收集为图片，解析后单独发
     *   [表情:<描述>]                   → 图库有图就当图片发；没图就换成 QQ 原生表情，**就地嵌进文字流**
     */
    private planOutbound;
    /**
     * 计算"避重集合"：默认按图库大小自适应（约一半），图库变大窗口自动变宽，
     * 不用手动调；`memeRecentLimit` 设正数则固定，设 0 则不避重。
     */
    private memeAvoidSet;
    /** 按描述从 dsh-meme 图库找图；同一张最近发过就换一张同情绪的，避免来回重复。 */
    private resolveMeme;
    private noteMemeSent;
    /** 懒加载表情库（优先配置目录，否则扫 DSH_HOME 下各 profile 里的 dsh-meme）。 */
    private memeLib;
    /** 把本地图片文件作为图片消息发出去（带重试/禁言处理；dryRun 时只记日志）。 */
    private sendImagePath;
    /** 统一的发送入口：重试 + 禁言探测；dryRun 时只记日志并返回成功。 */
    private sendSegments;
}
/** 出站消息片段：文字或 QQ 原生表情（就地混排）。 */
export type OutPart = {
    kind: 'text';
    text: string;
} | {
    kind: 'face';
    id: string;
};
/** 去掉首尾纯空白文字段（表情段保留）。 */
export declare function trimParts(parts: OutPart[]): OutPart[];
/**
 * 把混排片段按字数上限切成多条消息（表情不占字数、跟着当前条走）。
 * maxChars <= 0 表示不分段。
 */
export declare function splitSegments(parts: OutPart[], maxChars: number): OutPart[][];
