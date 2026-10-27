/** 插件配置（schemastery 校验，全部带默认值，Web UI 设置页可直接改）。 */
import z from '@deepseek-ai/schemastery';
export const Config = z.object({
    enabled: z.boolean().default(true)
        .description('总开关：关掉后不连接 NapCat、也不处理任何消息（插件仍加载，随时可开）').volatile(),
    mode: z.union([z.const('forward'), z.const('reverse')]).default('forward')
        .description('连接方式：forward=本插件连 NapCat（NapCat 在别的机器上时用这个）；reverse=本插件监听、NapCat 拨进来').volatile(),
    url: z.string().default('')
        .description('forward 模式：NapCat 的 WebSocket 地址（如 ws://<napcat-host>:3001）；留空=不连接（去设置页填）').volatile(),
    accessToken: z.string().role('secret').default('')
        .description('OneBot access_token；forward 作为 Bearer 发出，reverse 校验来者（reverse 下留空=不校验，不推荐）').volatile(),
    host: z.string().default('127.0.0.1')
        .description('reverse 模式监听地址；NapCat 在别的机器上时必须改为 0.0.0.0').volatile(),
    port: z.number().default(8643)
        .description('reverse 模式监听端口').volatile(),
    botQQ: z.string().default('')
        .description('机器人自己的 QQ；留空则从事件里自动学习（影响 @ 门控与自消息过滤）').volatile(),
    adminUsers: z.array(z.string()).default([])
        .description('管理员 QQ 列表（私聊 + 主动发送工具默认只对管理员开放）').volatile(),
    dmPolicy: z.union([z.const('admin'), z.const('open'), z.const('disabled')]).default('admin')
        .description('私聊策略：admin=仅管理员；open=任何人；disabled=关闭').volatile(),
    allowFrom: z.array(z.string()).default([])
        .description('dmPolicy=open 时的额外允许 QQ（留空=不限）').volatile(),
    groupPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('allowlist')
        .description('群聊策略：open=任何群；allowlist=只允许下面的群；disabled=关闭').volatile(),
    groupAllowFrom: z.array(z.string()).default([])
        .description('允许的群号列表').volatile(),
    triggerKeywords: z.array(z.string()).default([])
        .description('群聊关键字触发：消息里出现任一词就响应（不要求 @；留空=只认 @）').volatile(),
    requireMention: z.boolean().default(true)
        .description('群聊必须 @机器人 才响应（关掉=任何群消息都进模型，容易刷屏）').volatile(),
    ignoreSelf: z.boolean().default(true)
        .description('忽略机器人自己发出的消息（防止自循环）').volatile(),
    replyAsQuote: z.boolean().default(false)
        .description('回复时引用原消息（QQ 里显示为"回复"）').volatile(),
    splitMaxChars: z.number().default(1200)
        .description('单条 QQ 消息最大字数，超出自动分段；0=不分段').volatile(),
    dryRun: z.boolean().default(false).description('只读模式：不向 QQ 发送任何消息（本地测试用，避免和线上实例重复发言）').volatile(),
    faceFallback: z.boolean().default(true).description('图库没有对应图时，把 [表情:描述] 换成 QQ 原生小黄脸').volatile(),
    memeEnabled: z.boolean().default(true).description('允许把 [表情:描述] 解析成 dsh-meme 图库里的图并发送').volatile(),
    memeNudgeAfter: z.natural().default(2).description('连续这么多条回复没带表情时，注入里提醒一次（0=不提醒）').volatile(),
    memeLooseFallback: z.boolean().default(false).description('描述和情绪都匹配不上时，是否仍随机发一张图（默认关：宁可不发也不发不贴题的）').volatile(),
    memeRecentLimit: z.number().default(-1).description('表情避重窗口：-1=按图库大小自动（约一半），0=不避重，正数=固定张数').volatile(),
    memeDirs: z.string().default('').description('表情库目录（分号/逗号分隔）；留空=自动扫描 DSH_HOME 下 dsh-meme 的 memes 目录').volatile(),
    outboundImageMaxBytes: z.natural().default(8388608).description('单张待发送图片的大小上限（字节，默认 8MB）').volatile(),
    sendIntervalMs: z.number().default(500)
        .description('分段消息之间的间隔（毫秒），避免 QQ 风控连发；0=不限').volatile(),
    reconnectMaxAttempts: z.number().default(0)
        .description('forward 模式连续失败多少次后放弃重连（0=无限重试，退避封顶 60s；日志会限流）').volatile(),
    personaOverrides: z.string().default('')
        .description('群/人性格：每行 group:<群号>=<人设> 或 private:<QQ>=<人设>（空=不额外注入）').volatile(),
    perChatWorkspace: z.boolean().default(true)
        .description('每个 QQ 会话用 workspacePath/napcat/<群号或QQ> 作为独立工作目录（便于按工作区归拢、文件隔离）').volatile(),
    workspacePath: z.string().default('')
        .description('QQ 会话挂载的工作区路径；留空=宿主进程 cwd').volatile(),
    agentPreset: z.string().default('')
        .description('QQ 会话挂载的 agent preset；留空=宿主默认').volatile(),
    provider: z.string().default('')
        .description('覆盖模型 provider；留空=宿主默认').volatile(),
    model: z.string().default('')
        .description('覆盖模型 id；留空=宿主默认').volatile(),
    logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn')]).default('info')
        .description('日志级别').volatile(),
    memoryEnabled: z.boolean().default(true).description('开启群记忆（最近对话缓冲 + 长期记忆）').volatile(),
    memoryAutoCapture: z.boolean().default(true).description('自动记忆：模型自己判断并写入群设定/黑话/人物关系，无需用户说「记住」').volatile(),
    imageCache: z.union([z.const('off'), z.const('all')]).default('off').description('群聊图片缓存：all=把群里的图片/表情包也存下来（默认 off，只有叫到机器人时才存）').volatile(),
    imageCacheMaxBytes: z.natural().default(2 * 1024 * 1024).description('单张图片缓存上限（字节）').volatile(),
    imageCacheDailyCap: z.natural().default(100).description('每个聊天每天最多缓存多少张图').volatile(),
    imageCacheRetentionDays: z.natural().default(7).description('图片缓存保留天数（超期自动清理）').volatile(),
    proactiveEnabled: z.boolean().default(false).description('主动发言（伪人模式）：群里有话题时自己插话（默认关闭）').volatile(),
    proactiveRatePerHour: z.number().default(3).description('泊松 λ：每小时期望主动发言次数（0=改用固定概率）').volatile(),
    proactiveChance: z.number().default(0.02).description('固定概率模式：每条群消息的插话概率（proactiveRatePerHour>0 时不生效）').volatile(),
    proactiveCooldownMinutes: z.number().default(15).description('两次主动发言的最小间隔（分钟）').volatile(),
    proactiveMaxPerHour: z.number().default(4).description('每小时最多主动发言次数').volatile(),
    proactiveQuietHours: z.string().default('00:00-08:00').description('静默时段，如 00:00-08:00,12:00-13:00').volatile(),
    proactiveMinMessages: z.number().default(2).description('观察窗口内至少多少条他人消息才考虑插话').volatile(),
    proactiveWindowMinutes: z.number().default(5).description('观察窗口（分钟）').volatile(),
    memoryBackend: z.union([z.const('mnemon'), z.const('file')]).default('mnemon').description('长期记忆后端：file=本地文件（推荐，插件自管）；mnemon=交给模型用 mnemon 工具写（需在本群配置 memorySpaces）').volatile(),
    memorySpaces: z.string().default('').description('mnemon 后端用：每行 group:<群号>=<记忆空间id>（在 mnemon 面板建好空间后填 id）').volatile(),
    memorySpacePrefix: z.string().default('napcat-').description('每群一个 mnemon 记忆空间，空间名前缀').volatile(),
    recentLimit: z.natural().default(200).description('每群保留最近多少条消息').volatile(),
    injectRecent: z.natural().default(20).description('触发时注入最近多少条对话').volatile(),
    injectMaxChars: z.natural().default(4000).description('记忆注入总字符上限').volatile(),
    archiveEventDays: z.natural().default(45).description('事件类记忆保留多少天（到期自动淡出）').volatile(),
    archiveIdleMinutes: z.natural().default(2).description('空闲这么久后起一轮独立归档（分钟）').volatile(),
    archiveEvery: z.natural().default(50).description('归档节奏：攒够这么多条消息就让模型蒸馏一次摘要/人物卡（0=关闭）').volatile(),
    warmupStaleMinutes: z.natural().default(10).description('预热新鲜度：缓冲最新一条超过这么多分钟也算过期，会重新拉历史').volatile(),
    warmupImages: z.boolean().default(true).description('预热时把历史消息里的图片也缓存（用 file id 重新解析，解析不了=已过期）').volatile(),
    warmupImageLimit: z.natural().default(30).description('单次预热最多下载几张历史图片（每日配额之外的保护）').volatile(),
});
/** 各字段的内置默认值（与 schema 的 default 保持一致，供 volatile 字段兜底）。 */
export const DEFAULTS = {
    enabled: true,
    mode: 'forward',
    url: '',
    accessToken: '',
    host: '127.0.0.1',
    port: 8643,
    botQQ: '',
    adminUsers: [],
    dmPolicy: 'admin',
    allowFrom: [],
    groupPolicy: 'allowlist',
    groupAllowFrom: [],
    requireMention: true,
    triggerKeywords: [],
    ignoreSelf: true,
    replyAsQuote: false,
    splitMaxChars: 1200,
    sendIntervalMs: 500,
    dryRun: false,
    memeEnabled: true,
    faceFallback: true,
    memeDirs: '',
    memeRecentLimit: -1,
    memeLooseFallback: false,
    memeNudgeAfter: 2,
    outboundImageMaxBytes: 8388608,
    reconnectMaxAttempts: 0,
    workspacePath: '',
    perChatWorkspace: true,
    personaOverrides: '',
    agentPreset: '',
    provider: '',
    model: '',
    logLevel: 'info',
    memoryEnabled: true,
    memoryAutoCapture: true,
    imageCache: 'off',
    imageCacheMaxBytes: 2 * 1024 * 1024,
    imageCacheDailyCap: 100,
    imageCacheRetentionDays: 7,
    proactiveEnabled: false,
    proactiveRatePerHour: 3,
    proactiveChance: 0.02,
    proactiveCooldownMinutes: 15,
    proactiveMaxPerHour: 4,
    proactiveQuietHours: '00:00-08:00',
    proactiveMinMessages: 2,
    proactiveWindowMinutes: 5,
    memoryBackend: 'mnemon',
    memorySpaces: '',
    memorySpacePrefix: 'napcat-',
    recentLimit: 200,
    injectRecent: 20,
    injectMaxChars: 4000,
    warmupStaleMinutes: 10,
    archiveEvery: 50,
    archiveIdleMinutes: 2,
    archiveEventDays: 45,
    warmupImages: true,
    warmupImageLimit: 30,
};
/** 取活值：volatile 引用调 get()，普通值原样返回。 */
export function readVolatile(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
/** 用内置默认值补齐调用方配置（volatile 字段读出来是引用，需要 get()）。 */
export function resolveConfig(input) {
    const merged = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
        const value = readVolatile(input?.[key]);
        if (value !== undefined)
            merged[key] = value;
    }
    return merged;
}
