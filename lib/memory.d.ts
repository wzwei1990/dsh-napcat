/** 群/私聊记忆：一群一目录隔离 + 最近消息缓冲；长期记忆走 mnemon（失败则落本地 notes.md）。 */
import type { LogLevel } from './onebot.js';
export interface MemoryOptions {
    ctx: unknown;
    /** 记忆根目录（通常是 <workspacePath>/memory） */
    root: string;
    /** mnemon 空间名前缀 */
    spacePrefix: string;
    /** 长期记忆后端：mnemon（交给模型写）或 file（纯本地） */
    backend: 'mnemon' | 'file';
    /** 自动记忆：模型自己判断写入（关闭则只响应显式「记住」） */
    autoCapture?: boolean;
    /** 配置里手填的空间 id（group:<号>=<id> 多行） */
    spaces?: string;
    /** recent.jsonl 保留条数 */
    recentLimit: number;
    /** 注入最近多少条对话 */
    injectRecent: number;
    /** 注入总字符上限 */
    injectMaxChars: number;
    log: (level: LogLevel, message: string) => void;
}
export interface ChatLike {
    agent?: unknown;
}
/** 解析 group:<群号>=<id> 多行配置。 */
export declare function parseSpaceMap(raw: string): Record<string, string>;
export declare class MemoryStore {
    private readonly opts;
    constructor(opts: MemoryOptions);
    /** 每个聊天一个目录：memory/group-<号> / memory/private-<QQ> */
    private dirFor;
    private ensureDir;
    /** 用注册表直接调工具（插件掌握时机，不依赖模型）。 */
    private callTool;
    /** 把工具原始返回写进 _debug.log（排查解析问题用）。 */
    private dumpRaw;
    /** 记忆相关失败：warn 到控制台 + 追加到 memory/_debug.log，便于事后定位。 */
    private reportFailure;
    /** 拿到（或创建）本聊天的 mnemon 空间 id；失败返回 undefined（自动退化为文件记忆）。 */
    ensureSpace(chatKey: string, agent: unknown): Promise<string | undefined>;
    /** 埋点：把 agent 的会话事件尾部写进 _debug.log，用于排查 mnemon 的 turn/View 绑定。 */
    dumpTurnState(chatKey: string, agent: unknown): Promise<void>;
    /** 登记空间 id（供 napcat_memory_space 工具调用）。 */
    saveSpace(chatKey: string, spaceId: string): Promise<void>;
    /** 写一条长期记忆：优先 mnemon，失败落 notes.md。 */
    remember(chatKey: string, content: string, agent: unknown, tags?: readonly string[]): Promise<string>;
    /** 召回与本群相关的内容（query 用最近对话摘要）。 */
    recall(chatKey: string, query: string, agent: unknown): Promise<string>;
    /** 追加一条最近消息（滚动保留；与已有同一条消息（5 秒内同内容）会合并而不是重复追加）。 */
    appendRecent(chatKey: string, entry: {
        nick: string;
        text: string;
        at?: number;
    }): Promise<void>;
    /**
     * 把若干行合并进 recent.jsonl（append 与预热共用）。
     * 判重：同一「5 秒时间窗 + 归一化内容」视为同一条（历史接口秒级 / 实时毫秒级 / [图片] vs [图片:文件名]）。
     * 合并时保留更完整的那条（有昵称优先，其次文本更长）。
     */
    private mergeInto;
    /**
     * 预热：把历史消息**合并**进 recent（按 时间+内容 去重；旧记录里昵称为空而新数据有昵称时自动补全）。
     * 注意：绝不能覆盖——否则每次"缓冲过期"都会把之前攒的几十上百条历史顶掉。
     */
    seedRecent(chatKey: string, entries: Array<{
        nick: string;
        text: string;
        at?: number;
    }>): Promise<number>;
    /** 读最近 N 条的时间戳（启动后用它初始化"有人在聊"的滑动窗口）。 */
    recentTimestamps(chatKey: string, limit?: number): Promise<number[]>;
    /** 缓冲里最新一条的时间戳（毫秒；空=0）。用于判断缓冲是否"过期"。 */
    recentNewestAt(chatKey: string): Promise<number>;
    /** 当前缓冲条数（用于判断是否需要预热）。 */
    recentCount(chatKey: string): Promise<number>;
    /** 读最近 N 条，返回「昵称: 内容」行。 */
    readRecent(chatKey: string, limit?: number): Promise<string[]>;
    /** 组装注入文本（含 @ 优先级指令），超预算截断。 */
    buildInjection(parts: {
        chatKey: string;
        recent: readonly string[];
        recallText?: string;
        mention?: string;
        spaceId?: string;
        recentExpressions?: readonly string[];
    }): string;
}
