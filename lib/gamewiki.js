/** 攻略类提问的线索词 */
const ASK_WORDS = /怎么打|打法|攻略|弱点|材料|配装|掉落|怎么过|在哪|哪里|如何|怎么|打法|解锁|顺序|推荐等级|几级|抗性|机制|怎么获取/;
/** 讨论/评价类线索词 */
const DISCUSS_WORDS = /感觉|我觉得|是不是|好用|垃圾|值不值|值得|强|弱|厉害|难|丑|帅|无语|坑|香|爽|废|顶/;
/** 停用词（抽关键词时剥掉） */
const STOP_WORDS = /[的了吗呢啊吧呀嘛哈哦这那个我你他她它都就也还在有是把被给和与及或]/g;
/** 去掉标点，保留中英文数字 */
export function normalizeText(text) {
    return text.replace(/[\s，。！？、；：""''（）【】《》…—\-_.!?,;:()\[\]{}"'`~@#$%^&*+=|\\/]/g, '');
}
/**
 * 从一条群消息里判断"要不要查、查什么、怎么用"。
 * @param text 消息文本
 * @param games 已收录的游戏名/别名（来自 dsh-game 的 list()）
 */
export function detectGameIntent(text, games) {
    const normalized = normalizeText(text);
    if (normalized === '' || games.length === 0)
        return undefined;
    let matched = '';
    for (const name of games) {
        const key = normalizeText(name);
        if (key !== '' && normalized.includes(key) && key.length > matched.length)
            matched = key;
    }
    if (matched === '')
        return undefined;
    const rest = normalized.split(matched).join('');
    const ask = ASK_WORDS.test(rest) || /[?？]/.test(text);
    const discuss = DISCUSS_WORDS.test(rest);
    if (!ask && !discuss)
        return undefined;
    return {
        game: matched,
        keyword: extractKeyword(rest),
        mode: ask ? 'ask' : 'discuss',
    };
}
/** 放进关键词的噪声词（提问/评价/泛用动词）：整块剥掉，避免把"怎么打"当搜索词 */
const NOISE_WORDS = /怎么打|打法|攻略|弱点|材料|配装|掉落|怎么过|在哪|哪里|如何|怎么|解锁|顺序|推荐等级|几级|抗性|机制|怎么获取|感觉|我觉得|是不是|好用|垃圾|值不值|值得|厉害|无语|有点|挺|真的|这个|那个|一下|有没有|可以|能用/g;
/** 抽关键词：剥掉停用词/噪声词后取最长一段中文/字母数字串（≤8 字） */
export function extractKeyword(rest) {
    const cleaned = rest
        .replace(NOISE_WORDS, ' ')
        .replace(ASK_WORDS, ' ')
        .replace(DISCUSS_WORDS, ' ')
        .replace(STOP_WORDS, ' ');
    const runs = (cleaned.match(/[\u4e00-\u9fa5a-zA-Z0-9]{2,}/g) ?? [])
        .filter(run => !/^[的了是吗呢啊吧呀嘛哦哈]+$/.test(run));
    const best = runs.sort((a, b) => b.length - a.length)[0] ?? '';
    return best.slice(0, 8);
}
export class GameWiki {
    options;
    /** 游戏名+关键词 → 已生成的注入块（TTL 内复用，避免重复请求；不是拒绝查询） */
    cache = new Map();
    /** 缓存游戏名列表（避免每条消息都问服务） */
    cachedNames;
    constructor(options) {
        this.options = options;
    }
    /** dsh-game 服务；没装/未启用就是 undefined（联动整体静默关闭） */
    service() {
        try {
            const get = this.options.ctx.get;
            const svc = get?.('dshGame');
            return svc !== undefined && svc !== null && typeof svc.search === 'function' ? svc : undefined;
        }
        catch {
            return undefined;
        }
    }
    gameNames() {
        const now = Date.now();
        if (this.cachedNames !== undefined && now - this.cachedNames.at < 60_000)
            return this.cachedNames.names;
        const svc = this.service();
        const names = [];
        try {
            const entries = svc?.list?.() ?? [];
            for (const entry of entries) {
                if (typeof entry.name === 'string' && entry.name !== '')
                    names.push(entry.name);
                for (const alias of entry.aliases ?? [])
                    if (typeof alias === 'string' && alias !== '')
                        names.push(alias);
            }
        }
        catch {
            // 忽略：拿不到游戏表就当没收录
        }
        this.cachedNames = { at: now, names };
        return names;
    }
    /** 命中缓存就直接复用（同一问题不重复发请求，但照样能回答） */
    cacheGet(key) {
        const hit = this.cache.get(key);
        if (hit === undefined)
            return undefined;
        if (Date.now() - hit.at >= this.options.cacheTtlMs) {
            this.cache.delete(key);
            return undefined;
        }
        return hit.block;
    }
    cacheSet(key, block) {
        this.cache.set(key, { at: Date.now(), block });
    }
    /**
     * 主入口：解析这条消息要不要游戏资料。
     * 返回注入块文本；不需要 / 失败 / 超预算 一律 undefined（调用方原样继续）。
     */
    async contextFor(chatKey, text) {
        if (!this.options.enabled)
            return undefined;
        const query = detectGameIntent(text, this.gameNames());
        if (query === undefined)
            return undefined;
        const svc = this.service();
        if (svc === undefined || svc.search === undefined)
            return undefined;
        const gameName = this.displayNameFor(query.game);
        const cacheKey = gameName + '|' + query.keyword + '|' + query.mode;
        const cached = this.cacheGet(cacheKey);
        if (cached !== undefined) {
            this.options.log('debug', '游戏资料命中缓存：' + gameName + ' / ' + query.keyword);
            return cached;
        }
        try {
            const hits = await svc.search(gameName, query.keyword);
            const first = hits[0];
            if (first === undefined)
                return undefined;
            const page = svc.read === undefined
                ? { title: first.title, text: first.snippet ?? '', url: first.url }
                : await svc.read(gameName, first.title, { maxChars: this.options.maxChars });
            const body = cleanBody(page.text ?? '');
            if (body === '') {
                this.options.log('debug', '游戏资料太薄（占位/待补充），跳过注入');
                return undefined;
            }
            this.options.log('info', '游戏资料命中：' + gameName + ' / ' + first.title + '（' + query.mode + '）');
            const block = buildGameBlock({
                game: gameName,
                title: page.title ?? first.title,
                url: page.url ?? first.url ?? '',
                text: body.slice(0, this.options.maxChars),
                mode: query.mode,
            });
            this.cacheSet(cacheKey, block);
            return block;
        }
        catch (error) {
            this.options.log('debug', '游戏资料查询失败（静默跳过）: ' + (error instanceof Error ? error.message : String(error)));
            return undefined;
        }
    }
    /** 别名 → 标准名（注册表里的 name） */
    displayNameFor(alias) {
        const svc = this.service();
        try {
            const entries = svc?.list?.() ?? [];
            for (const entry of entries) {
                if (normalizeText(entry.name) === alias)
                    return entry.name;
                if ((entry.aliases ?? []).some(item => normalizeText(item) === alias))
                    return entry.name;
            }
        }
        catch {
            // 忽略
        }
        return alias;
    }
}
/** 两种注入形态：同一份数据，两套指令（ask 给答案 / discuss 只当背景） */
export function buildGameBlock(input) {
    // 两种形态都不带链接、不带"来源"字样：群聊里没人想看你贴 wiki
    const head = input.mode === 'ask'
        ? '【游戏资料 · ' + input.game + '】\n'
        : '【背景资料（不是要你复述的答案）· ' + input.game + '】\n';
    const body = input.text + '\n';
    const tail = input.mode === 'ask'
        ? '[用法] 有人真的在问攻略：用你自己理解后的口语说出来（先给结论，再补一两句），像老玩家随口讲；不要贴来源/链接、不要整段搬运、不要列成长清单；不确定就说不知道。'
        : '[用法] 这是让你听懂大家在聊什么，用来支撑你自己的看法：不要列点、不要给攻略步骤、不要说"wiki 上写着"、不要贴来源；最多自然地带一条事实。';
    return head + body + tail;
}
/** 正文清洗：去掉表格残渣/占位页；太薄的直接判空（宁可不说，也别把"待补充"塞给模型） */
export function cleanBody(text) {
    const lines = text
        .split('\n')
        .map(line => line.trim())
        .filter(line => !/^[-—–\s]*$/.test(line))
        .filter(line => !/^(占位|待补充|暂无|没有内容)[。！!]?$/.test(line));
    const body = lines.join('\n').trim();
    if (body.length < 40)
        return '';
    // 几乎全是"待补充"的页面
    const stubHits = (body.match(/待补充|占位|暂无/g) ?? []).length;
    if (stubHits >= 3 && stubHits * 6 > body.split('\n').length)
        return '';
    return body;
}
