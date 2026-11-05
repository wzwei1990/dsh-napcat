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
import { SubscriptionStore } from './subscriptions.js';
import { ProviderRegistry } from './providers.js';
import type { ObEvent } from './types.js';
export interface BridgeOptions {
    ctx: Context;
    config: Config;
    conn: OneBotConnection;
    log(level: LogLevel, message: string): void;
    /** 订阅表 / 数据源（与工具共用同一实例；缺省自建） */
    subscriptions?: {
        store: SubscriptionStore;
        registry: ProviderRegistry;
    };
}
export declare class Bridge {
    private readonly opts;
    /** 群/私聊记忆（一群一目录 + mnemon 长期记忆）。 */
    private readonly mem;
    /** 游戏 wiki 联动（查一次，按意图包装；失败静默） */
    private readonly gameWiki;
    /** B 站链接 → 「看过」上下文（弹幕高光 + 字幕节选） */
    private readonly biliLink;
    /** B 站 UP 更新 → 群推送（读 outbox，ack 后不重复） */
    private readonly biliPusher;
    /** 订阅表（B 站/以后其它平台共用） */
    /** 由 index 传入，保证工具与轮询共用同一个 store */
    private readonly subStore;
    /** 数据源注册表 */
    private readonly providers;
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
    /** 危险请求拒绝提示的节流时间（每会话 10 分钟一次，避免刷屏）。 */
    private readonly dangerNoticeAt;
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
    /** 最近的群消息正文（热量分用：看内容而不是只数条数） */
    private readonly recentMsgs;
    /** 首次计数时用历史缓冲回填窗口的 promise：判定前要等它，否则重启后会误判「只有 1 条」。 */
    private readonly chatterReady;
    /** 已投递主动发言请求、等待回复拦截的聊天。 */
    private readonly pendingProactive;
    /** 每次主动发言的投递时间（用于超时清理，避免卡死后再也不插话） */
    private readonly proactiveStartedAt;
    /** 群禁言到什么时候（毫秒）：期间不发消息，也跳过主动发言。 */
    private readonly mutedUntil;
    /** 表情库（懒加载）。 */
    private memeLibrary;
    /** 表情库目录摘要缓存（TTL 60 秒，图库变了能自动更上）。 */
    private memeCatalogCache;
    /** 归档定时器与运行时状态（独立静默会话，输出不进 QQ）。 */
    private archiveTimer;
    /** 主动发言的定时评估器（每 60 秒扫一遍有动静的群） */
    private proactiveTimer;
    /** 运行心跳：每 N 分钟打一条状态摘要（用来区分"没人说话"和"出故障了"） */
    private heartbeatTimer;
    private biliPushTimer;
    /** 上次推送检查时间（节流用） */
    private biliPushLastAt;
    /** 上次订阅轮询时间（节流用） */
    private subTickAt;
    private readonly stats;
    private readonly archiveAgents;
    private readonly archiveRunning;
    private readonly archiveLastActivity;
    private readonly archiveCollectors;
    /** 最近发过的原生表情 id（避免同一句描述永远同一个表情）。 */
    private readonly recentFaceIds;
    /** 最近用过的表情描述（注入给模型，提示它别连着用同一个）。 */
    private readonly recentMemeCaptions;
    /** 待处理的归档批次（素材路径/条数/时间范围），随下一轮回复一起产出归档 JSON。 */
    private readonly archivePending;
    /** 各聊天连续几条回复没带表情（到阈值就在注入里轻推一把）。 */
    private readonly repliesSinceMeme;
    /** 归档连续几轮没产出（到 3 就丢弃重建）。 */
    private readonly archiveMiss;
    /** 最近发过的表情文件（避免连续重复同一张）。 */
    private readonly recentMemeFiles;
    /** 机器人自己的 QQ（配置没填时用 get_login_info 取一次后缓存）。 */
    private selfQqCache;
    /** 上次「被硬门挡住」的提示时间（防刷屏，每群 10 分钟一条）。 */
    private readonly proactiveNoticeAt;
    /** 评估计数（每群：窗口内评估次数 + 最后一次未中原因），用于 30 分钟一条诊断 */
    private readonly proactiveEval;
    /** 记录一条他人消息（供主动发言判断"有没有人在聊"）。 */
    /** 记一条消息正文（热量分用），只留最近 40 条 */
    private noteRecentMessage;
    private noteChatter;
    /**
     * 运行心跳（每 60 秒检查一次，按配置间隔打一条 info）：
     * 回答"现在到底什么情况"——连没连上、收了多少消息、回复了几轮、主动发言开没开。
     */
    /**
     * B 站 UP 更新推送：读 dsh-bili 的 outbox（按群过滤），发到群里再 ack。
     * 完全解耦：没装 dsh-bili 时 hasService() 为 false，静默跳过。
     */
    /**
     * 订阅轮询 + 推送：
     *   ① 取一个到期订阅 → 用对应 provider 拉最新 → 写队列
     *   ② 把队列里属于本群的条目发出去 → ack
     * 没有任何 provider 时静默跳过（不提示装某个插件）。
     */
    private subscriptionTick;
    private heartbeatTick;
    /**
     * 定时评估：冷清群不能只靠"来一条消息掷一次骰子"，否则十几分钟才评估一次。
     * 每 60 秒扫一遍最近还有动静的群，交给同一套决策（内部有 20 秒节流与各类硬门）。
     */
    private proactiveTick;
    /**
     * 判断并（可能）主动插话。只在群里、且用户没叫它的时候调用。
     * 判定不通过就什么都不做；通过则投递一条 [主动发言] 请求，由模型决定说还是回 __SKIP__。
     */
    private maybeInterject;
    /** 供 napcat_memory_space 工具登记空间 id。 */
    /** 供 napcat_memory_space 工具登记空间 id。 */
    saveMemorySpace(chatKey: string, spaceId: string): Promise<void>;
    /**
     * 最近几条里如果有链接（http/https），就提示模型"话题是这条链接"，
     * 并明确要求先抓取内容再聊——否则模型读不懂链接，只能抓更早的话题硬接。
     */
    private linkHintOf;
    /** 本轮能不能发表情：距上次带图已隔够 `memeMinGap` 条文字回复才算可以。 */
    private memeAllowedFor;
    /** 记一轮"带没带表情"：带了清零，没带 +1（供下轮注入做频率提示）。 */
    private noteReplyMemeState;
    /** 连续几条回复没带表情（到阈值才提示，0=关闭）。 */
    private memeNudgeFor;
    /** 人物群像 → 注入用数组（按评分取前 6，名字+画像）。 */
    private peopleFor;
    /** 从磁盘恢复遗留的待归档批次（进程重启/升级后不会丢）。 */
    private restoreArchivePending;
    /** 从会话 key（group:123 / private:456）还原 ChatRef，用于重启后还没人说话时也能归档。 */
    private chatRefFromKey;
    /** 按 sessionId 查宿主里活着的 agent（用于避开"已被写句柄占用"的冲突）。 */
    private liveAgentFor;
    /** 定时器：待归档批次 + 群空闲够了 → 起一轮独立归档（模型专门做这件事）。 */
    private archiveTick;
    /** 攒够 archiveEvery 条就准备批次（真正执行由 archiveTick 起独立轮）。 */
    private maybePrepareArchive;
    /** 开一个独立会话专门做归档：不进 bySession，输出不会发到 QQ。 */
    private openArchiveAgent;
    /** 跑一轮归档：模型只读素材、只输出 JSON（顺带把长期条目写进 mnemon）。 */
    private runArchiveTurn;
    /** 收集归档轮的输出（只对归档会话生效，不投递给 QQ）。 */
    private collectArchiveOutput;
    /** 归档落盘：条目走评分合并（同 key 累加 hits），再按评分淘汰边缘条目。 */
    private applyArchivePayload;
    private bumpArchiveMiss;
    /** 仅把旧格式的 <归档> 块从回复里剥掉（不再依赖它归档，纯安全网）。 */
    private stripArchiveBlock;
    /** 缓冲不足时才预热；同一聊天 5 分钟内最多尝试一次。 */
    private maybeWarmup;
    /** 用 NapCat 的历史消息接口预热 recent 缓冲（群 get_group_msg_history / 私聊 get_friend_msg_history）。 */
    private warmup;
    private handleEventInner;
    /** 写一行诊断到 <会话cwd>/napcat-inbox/_image-debug.log（出问题时能自查，用户随时可删）。 */
    private debugLog;
    /** 宿主会话 id → QQ 会话 key（工具省略 chat_id 时用来定位当前会话）。 */
    keyForSession(sessionId: string): string | undefined;
    /**
     * 最近几条里最新的一张已缓存图片 → 附件块。
     * 主动发言没有"当前消息"，只有记录里的路径；把图直接附上，模型就一定会看到。
     */
    private latestImageOf;
    /**
     * 把本地图片交给宿主附件准入，产出 image content block。
     * 供两处复用：入站图片消息、主动发言时把"最新那张图"直接附上（省得模型不肯主动 read_image）。
     */
    private admitImage;
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
    /**
     * 会话工作目录（决定侧边栏归到哪个工作区）。
     *
     * 修复 2026-11-05：原来 `workspacePath` 留空时直接返回 process.cwd()，
     * 导致"每个会话用独立子目录"这个开关被跳过 → 所有群共用一个目录，
     * workspaceRegistry 按目录匹配时把不同群的会话全塞进第一个群的工作区格子。
     *
     * 现在的规则：
     *   - 群聊：**永远**一个群一个子目录（共用目录是错的，工作区没法按群分开）
     *   - 私聊：按 perChatWorkspace 决定
     *   - workspacePath 留空时，以宿主 cwd 为基准目录
     */
    private cwdFor;
    private dispatch;
    /**
     * 投递后等 turn/start。**两轮**才判定会话失效：
     *   第 1 轮超时 → 只记日志、再等一轮（云端模型排队/慢启动很常见，10s 就判死会误杀活会话）；
     *   第 2 轮仍没动静 → 才认为会话已归档/失效，换新会话重投。
     */
    private armWatchdog;
    private armWatchdogRound;
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
    /** 让模型说一句幽默的拒绝（一次性会话，只让它说话、不执行）。 */
    private humorousRefusal;
    /** 拒绝危险请求时回一句（每会话 10 分钟最多一次，避免刷屏）。 */
    private replyDanger;
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
    /**
     * 在候选里挑一张"分数够、但不总是第一名"的图：取前 5 张随机挑一张。
     * 以前永远返回第一名 → 图库 146 张，实际只有几张在轮换。
     */
    private pickDiverse;
    /** 按描述从 dsh-meme 图库找图；同一张最近发过就换一张同情绪的，避免来回重复。 */
    private resolveMeme;
    /** 记录用过的表情描述（注入给模型，提示别连着用同一个），最多 8 条。 */
    private noteExpressionUsed;
    /** 记录刚发过的原生表情（用于轮换，最多 8 个）。 */
    private noteFaceSent;
    private noteMemeSent;
    /** 启动时把图库解析结果打到 info，方便一眼确认"扫的哪个目录、有多少张"。 */
    private logMemeLibrary;
    /** 供 napcat_meme_search 工具：按描述查表情（返回 caption/tag 便于模型精确引用）。 */
    searchMemeForTool(query: string, limit: number): Promise<Array<{
        caption: string;
        tag: string;
    }>>;
    /** 供 napcat_meme_catalog 工具：分类 + 张数 + 示例。 */
    memeCatalogForTool(): Promise<Array<{
        tag: string;
        count: number;
        samples: string[];
    }>>;
    /** 表情库目录摘要（缓存 60 秒；新加的表情包到期自动出现在目录里）。 */
    private memeCatalogText;
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
