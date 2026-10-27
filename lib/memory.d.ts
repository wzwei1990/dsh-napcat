/** 群/私聊记忆：一群一目录隔离 + 最近消息缓冲；长期记忆走 mnemon（失败则落本地 notes.md）。 */
import { type MemoryItem, type MemoryKind } from './memscore.js';
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
    /** 读已登记的 mnemon 空间 id（没有就 undefined）。 */
    readSpaceId(chatKey: string): Promise<string | undefined>;
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
    /** 扫描磁盘上遗留的待归档批次（进程重启后恢复用）。 */
    listPendingArchives(): Promise<Array<{
        chatKey: string;
        path: string;
        count: number;
        from: number;
        to: number;
        preparedAt: number;
    }>>;
    /** 归档状态：已处理到哪条消息（时间戳）与上次归档时间。 */
    archiveState(chatKey: string): Promise<{
        archivedUpTo: number;
        lastAt: number;
    }>;
    saveArchiveState(chatKey: string, state: {
        archivedUpTo: number;
        lastAt: number;
    }): Promise<void>;
    /** 取出「还没归档」的消息（按时间正序，最多 limit 条）。 */
    pendingArchiveRows(chatKey: string, since: number, limit: number): Promise<Array<{
        t: number;
        nick: string;
        text: string;
    }>>;
    /** 把待归档批次落盘（模型用文件工具自己读，避免把几十条塞进注入）。 */
    writeArchiveBatch(chatKey: string, rows: Array<{
        t: number;
        nick: string;
        text: string;
    }>): Promise<string>;
    /** 读评分条目（items.json）；旧数据（people.json/facts.json）首次会迁移过来。 */
    readItems(chatKey: string): Promise<MemoryItem[]>;
    saveItems(chatKey: string, items: readonly MemoryItem[]): Promise<void>;
    /** 合并一批新观察到 items（同 key 累加 hits），再按评分淘汰。 */
    mergeItemsInto(chatKey: string, incoming: ReadonlyArray<{
        kind: MemoryKind;
        text: string;
        weight?: number;
        expiresAt?: number;
    }>, options?: {
        maxPerKind?: number;
        minScore?: number;
        forgetAfterMs?: number;
    }): Promise<{
        kept: number;
        dropped: number;
    }>;
    /** 注入用：取某类评分最高的若干条文本。 */
    topTexts(chatKey: string, kind: MemoryKind, limit: number): Promise<string[]>;
    /** 记一条安全审计（危险请求的拒绝/放行），落 audit.jsonl。 */
    appendAudit(chatKey: string, row: {
        at: number;
        userId: string;
        nick?: string;
        role: 'admin' | 'member';
        word: string;
        category: string;
        decision: 'rejected' | 'allowed';
    }): Promise<void>;
    /** 读最近 N 条审计（新的在前）。 */
    readAudit(chatKey: string, limit?: number): Promise<Array<Record<string, unknown>>>;
    /** 删除待归档批次文件（归档完成或放弃后调用，避免重启后重复处理）。 */
    clearArchiveBatch(chatKey: string): Promise<void>;
    /** 生成人类可读的记忆快照 memory.md（便于直接翻看，不参与注入）。 */
    writeDigest(chatKey: string): Promise<void>;
    /** 读当前滚动摘要（单一版本；旧版 summary.jsonl 兜底取最后一段）。 */
    readSummary(chatKey: string): Promise<{
        text: string;
        from: number;
        to: number;
        updatedAt: number;
    } | undefined>;
    /** 覆盖当前滚动摘要（模型每次输出"合并后的完整版"，旧内容被替换而不是追加）。 */
    saveSummary(chatKey: string, entry: {
        text: string;
        from: number;
        to: number;
    }): Promise<void>;
    /** 群级结构化事实（黑话/设定）：按内容更新，不无限堆叠。 */
    readFacts(chatKey: string): Promise<{
        glossary: string[];
        setting: string[];
    }>;
    /** 覆盖写入群级事实（模型输出的是合并后的完整列表）。 */
    saveFacts(chatKey: string, facts: {
        glossary: string[];
        setting: string[];
    }): Promise<void>;
    /** 追加一段归档摘要（旧版格式，保留兼容）。 */
    appendSummary(chatKey: string, entry: {
        from: number;
        to: number;
        text: string;
    }): Promise<void>;
    /** 读最近 N 段摘要（新的在后）。 */
    readSummaries(chatKey: string, limit?: number): Promise<string[]>;
    /** 人物群像快照（名字 → 一句话画像）。 */
    readPeople(chatKey: string): Promise<Record<string, {
        names?: string[];
        style?: string;
        topics?: string[];
        weight?: number;
    }>>;
    savePeople(chatKey: string, people: Record<string, {
        names?: string[];
        style?: string;
        topics?: string[];
        weight?: number;
    }>): Promise<void>;
    /** 组装注入文本（含 @ 优先级指令），超预算截断。 */
    buildInjection(parts: {
        chatKey: string;
        recent: readonly string[];
        recallText?: string;
        mention?: string;
        spaceId?: string;
        recentExpressions?: readonly string[];
        memeNudge?: number;
        summary?: string;
        facts?: {
            glossary: readonly string[];
            setting: readonly string[];
            preference?: readonly string[];
            style?: readonly string[];
            todo?: readonly string[];
            event?: readonly string[];
        };
        people?: ReadonlyArray<{
            name: string;
            style?: string;
            topics?: readonly string[];
        }>;
    }): string;
}
