export class GameWiki {
    options;
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
    /**
     * 返回要注入的"话题线索"块；没有命中 / 未启用 / 服务不在 → undefined。
     * 注意：这里**不查 wiki**，只告诉模型"可能是这个游戏、这些词、可以这样查"。
     */
    async hintFor(text) {
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
            if (candidates.length === 0)
                return undefined;
            const top = candidates.slice(0, 2);
            this.options.log('debug', '游戏词表命中：' + top.map(c => c.game + '[' + c.hits.join('/') + ']').join(' '));
            return buildHintBlock(top);
        }
        catch (error) {
            this.options.log('debug', '词表召回失败（静默跳过）: ' + (error instanceof Error ? error.message : String(error)));
            return undefined;
        }
    }
}
/** 注入块：线索 + 工具用法 + 两种意图的不同要求 */
export function buildHintBlock(candidates) {
    const lines = ['【话题线索·可能相关的游戏】'];
    for (const candidate of candidates) {
        const words = candidate.hits.slice(0, 4).join('、');
        lines.push('· ' + candidate.game + '：命中「' + words + '」');
        const first = candidate.hits[0];
        if (first !== undefined) {
            lines.push('  可查：game_wiki_search(game="' + candidate.game + '", keyword="' + first + '")'
                + ' → game_wiki_read(game="' + candidate.game + '", title=命中标题)');
        }
    }
    lines.push('[怎么用] 这条消息真在问攻略 → 查完用你自己的话讲（别贴链接/来源、别整段搬）；');
    lines.push('         只是随口讨论/评价 → 可以不查；查了也只当背景，不要列点、不要给攻略步骤、不要说"wiki 上写着"。');
    return lines.join('\n');
}
