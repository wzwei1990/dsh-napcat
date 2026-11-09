/** 最近游戏上下文有效期 */
const RECENT_GAME_TTL_MS = 30 * 60_000;
/** 没有命中词表、但出现这些词时，按「最近聊过的游戏」补一条线索 */
const GAMEY_WORDS = /boss|关卡|副本|装备|武器|饰品|技能|存档|支线|主线|剧情|结局|弹反|数值|build|配装|打法|攻略|卡关|打不过|怎么打/i;
export class GameWiki {
    options;
    /** chatKey → 最近聊到的游戏 */
    recent = new Map();
    constructor(options) {
        this.options = options;
    }
    service() {
        try {
            const get = this.options.ctx.get;
            const svc = get?.('dshGame');
            if (svc === undefined || svc === null || typeof svc.detect !== 'function')
                return undefined;
            return svc;
        }
        catch {
            return undefined;
        }
    }
    /** 最近聊过的游戏（30 分钟内有效） */
    recentGameOf(chatKey, now = Date.now()) {
        const hit = this.recent.get(chatKey);
        if (hit === undefined)
            return undefined;
        if (now - hit.at > RECENT_GAME_TTL_MS) {
            this.recent.delete(chatKey);
            return undefined;
        }
        return hit.game;
    }
    /**
     * 返回要注入的"话题线索"块；没有命中 / 未启用 / 服务不在 → undefined。
     * 注意：这里**不查 wiki**，只告诉模型"可能是这个游戏、这些词、必须/可以这样查"。
     */
    async hintFor(text, chatKey = '') {
        if (!this.options.enabled)
            return undefined;
        const trimmed = text.trim();
        if (trimmed === '')
            return undefined;
        const svc = this.service();
        const detect = svc?.detect;
        if (detect === undefined)
            return undefined;
        try {
            const candidates = await detect(trimmed);
            if (candidates.length > 0) {
                const top = candidates.slice(0, 2);
                if (chatKey !== '')
                    this.recent.set(chatKey, { game: top[0]?.game ?? '', at: Date.now() });
                this.options.log('debug', '游戏词表命中：' + top.map(c => c.game + '[' + c.hits.join('/') + ']').join(' '));
                return buildHintBlock(top, { askedForHelp: looksLikeHelpRequest(trimmed) });
            }
            // 没命中关键词：如果本群最近聊过某个游戏，且这条也像在聊游戏，就给一条"背景"线索
            const recentGame = chatKey === '' ? undefined : this.recentGameOf(chatKey);
            if (recentGame !== undefined && recentGame !== '' && GAMEY_WORDS.test(trimmed)) {
                this.options.log('debug', '按最近游戏补线索：' + recentGame);
                return buildHintBlock([{ game: recentGame, hits: [] }], { askedForHelp: looksLikeHelpRequest(trimmed), fromRecent: true });
            }
            return undefined;
        }
        catch (error) {
            this.options.log('debug', '词表召回失败（静默跳过）: ' + (error instanceof Error ? error.message : String(error)));
            return undefined;
        }
    }
}
/** 粗略判断是不是在求解（决定"必须先查"还是"可以不查"） */
export function looksLikeHelpRequest(text) {
    return /怎么|怎样|如何|在哪|哪里|要不要|该不该|选哪|是不是|能不能|有没有|求|问下|问一下|打不过|卡关|卡住|过不去|找不到|缺|bug|吗？|吗\?|？|\?/i.test(text);
}
/** 注入块：线索 + 工具用法 + 按意图分档的要求 */
export function buildHintBlock(candidates, options = {}) {
    const lines = ['【话题线索·可能相关的游戏】'];
    for (const candidate of candidates) {
        const words = candidate.hits.slice(0, 4).join('、');
        lines.push('· ' + candidate.game + (words === '' ? '（本群最近在聊）' : '：命中「' + words + '」'));
        const first = candidate.hits[0];
        const keyword = first ?? candidate.game;
        lines.push('  可查：game_wiki_search(game="' + candidate.game + '", keyword="' + keyword + '")'
            + ' → game_wiki_read(game="' + candidate.game + '", title=命中标题)');
    }
    if (options.askedForHelp === true) {
        lines.push('【这条像在问攻略/卡关 → 回答要给到点子上】');
        lines.push('  1) 能查就先查：game_wiki_search（关键词用命中词，或换成你判断的 Boss/地点/物品；最多换两次词）。');
        lines.push('  2) 用自己的话给出**具体答案/下一步**：去哪、找谁、按什么顺序、注意什么（例如"先回营地找铁匠，再打门上那个机关"）。');
        lines.push('  3) 没查到就说没查到，别编步骤；也别用"多练练 / 看攻略 / 加油"这类空话糊过去。');
        lines.push('  4) 不要贴链接、不要列点、不要说"wiki 上写着"。');
    }
    else {
        lines.push('【这条更像随口讨论 → 可以不查】');
        lines.push('  查了只当背景，别列点、别给教程、别说"wiki 上写着"；没查就别装懂编步骤。');
    }
    return lines.join('\n');
}
