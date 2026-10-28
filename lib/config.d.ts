/** 插件配置（schemastery 校验，全部带默认值，Web UI 设置页可直接改）。 */
import type Z from '@deepseek-ai/schemastery';
export interface Config {
    /** 总开关：关掉后不连接 NapCat、也不处理任何消息。 */
    enabled: boolean;
    /** forward = 本插件主动连 NapCat 的 ws；reverse = 本插件监听、NapCat 拨进来。 */
    mode: 'forward' | 'reverse';
    /** forward 模式：NapCat 的 WebSocket 地址（如 ws://<napcat-host>:3001）。 */
    url: string;
    /** OneBot access_token：forward 时作为 Authorization 发出，reverse 时校验来者。 */
    accessToken: string;
    /** reverse 模式监听地址；NapCat 在别的机器上时必须是 0.0.0.0。 */
    host: string;
    /** reverse 模式监听端口。 */
    port: number;
    /** 机器人自己的 QQ；留空则从 meta 事件自动学习。 */
    botQQ: string;
    /** 管理员 QQ（私聊、工具发送默认只对管理员开放）。 */
    adminUsers: string[];
    /** 危险操作策略：admin-only=仅管理员可发起；allow=谁都能发；off=不做词表拦截。 */
    dangerPolicy: 'admin-only' | 'allow' | 'off';
    /** 额外危险词（包含即命中）。 */
    dangerWords: string[];
    /** 让模型说拒绝时的开场句模板，支持 {category}；留空用内置。 */
    dangerReplyPrompt: string;
    /** 人物表上限（0=不限制；>0 时按 weight 保留前 N 个）。 */
    peopleLimit: number;
    /** 连续多少条文字回复后才允许再发表情（0=不限制）。 */
    memeMinGap: number;
    /** 私聊策略：admin=仅管理员；open=任何人；disabled=关闭。 */
    dmPolicy: 'admin' | 'open' | 'disabled';
    /** dmPolicy=open 时的额外白名单（留空=不限）。 */
    allowFrom: string[];
    /** 群聊策略：open=任何群；allowlist=只允许 groupAllowFrom 里的群；disabled=关闭。 */
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    /** 允许的群号。 */
    groupAllowFrom: string[];
    /** 群聊是否必须 @机器人才响应。 */
    requireMention: boolean;
    /** 群聊里没 @ 但消息包含这些关键字也响应（空=只认 @ 与回复）。 */
    triggerKeywords: string[];
    /** 忽略机器人自己发出的消息（防自循环）。 */
    ignoreSelf: boolean;
    /** 回复时引用原消息（QQ 里表现为"回复"气泡）。 */
    replyAsQuote: boolean;
    /** 单条 QQ 消息的最大字数，超出按段落/句子分段发送；0=不分段。 */
    splitMaxChars: number;
    sendIntervalMs: number;
    dryRun: boolean;
    memeEnabled: boolean;
    faceFallback: boolean;
    memeDirs: string;
    memeRecentLimit: number;
    memeLooseFallback: boolean;
    memeNudgeAfter: number;
    outboundImageMaxBytes: number;
    /** forward 模式连续失败多少次后放弃重连（0=无限）。 */
    reconnectMaxAttempts: number;
    /** QQ 会话挂载的工作区；留空=宿主进程 cwd。 */
    workspacePath: string;
    /** 每个 QQ 会话是否用 workspacePath 下的独立子目录。 */
    perChatWorkspace: boolean;
    /** 群/人性格：每行 group:<群号>=<人设> 或 private:<QQ>=<人设>。 */
    personaOverrides: string;
    /** 会话挂载的 agent preset（留空=宿主默认）。 */
    agentPreset: string;
    /** 覆盖模型 provider（留空=宿主默认）。 */
    provider: string;
    /** 覆盖模型 id（留空=宿主默认）。 */
    model: string;
    /** 日志级别。 */
    logLevel: 'debug' | 'info' | 'warn';
    memoryEnabled: boolean;
    memoryBackend: 'mnemon' | 'file';
    memoryAutoCapture: boolean;
    imageCache: 'off' | 'all';
    imageCacheMaxBytes: number;
    imageCacheDailyCap: number;
    imageCacheRetentionDays: number;
    proactiveEnabled: boolean;
    proactiveRatePerHour: number;
    proactiveChance: number;
    proactiveCooldownMinutes: number;
    proactiveMaxPerHour: number;
    proactiveQuietHours: string;
    proactiveMinMessages: number;
    proactiveWindowMinutes: number;
    memorySpacePrefix: string;
    memorySpaces: string;
    recentLimit: number;
    injectRecent: number;
    injectMaxChars: number;
    warmupStaleMinutes: number;
    archiveEvery: number;
    archiveIdleMinutes: number;
    archiveEventDays: number;
    warmupImages: boolean;
    warmupImageLimit: number;
}
export declare const Config: Z<Config>;
/** 各字段的内置默认值（与 schema 的 default 保持一致，供 volatile 字段兜底）。 */
export declare const DEFAULTS: Config;
/** volatile 字段在运行时是 `{ get(): T }` 的稳定引用（cosmokit 的 Volatile）。 */
interface VolatileRef<T> {
    get(): T;
}
/** 取活值：volatile 引用调 get()，普通值原样返回。 */
export declare function readVolatile<T>(value: T | VolatileRef<T> | undefined): T | undefined;
/** 用内置默认值补齐调用方配置（volatile 字段读出来是引用，需要 get()）。 */
export declare function resolveConfig(input: Partial<Config> | undefined): Config;
export {};
