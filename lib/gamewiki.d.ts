/**
 * 游戏 wiki 联动（模型自决版）。
 *
 * 设计（2026-11-04 与用户确认）：
 *   ① 词表召回（零成本、代码）：dsh-game 用 wiki 全站标题建词表，识别群聊里的地名/道具名；
 *   ② 把命中结果 + 可用工具写进注入，交给**模型自己判断**：
 *        真在问攻略 → 调 game_wiki_search / game_wiki_read，用自己的话答（不贴来源）
 *        只是讨论     → 可以不查；查了也只当背景，不列点、不给教程、不说"wiki 上写着"
 *   ③ 插件不做阈值判定、不做预算限流：工具自身已有缓存与 6s 串行。
 *
 * 所有失败静默（没装 dsh-game / 词表没建 / 出错），绝不把错误甩到群里。
 */
import type { Context } from '@deepseek-ai/cordis';
/** dsh-game 暴露的服务（只依赖这一小部分） */
export interface GameService {
    list?: () => Array<{
        name: string;
        aliases?: string[];
    }>;
    /** 词表召回：返回命中的游戏与命中词（只召回，不判断） */
    detect?: (text: string) => Promise<Array<{
        game: string;
        hits: string[];
        pages?: string[];
    }>>;
}
export interface GameHintOptions {
    ctx: Context;
    enabled: boolean;
    log: (level: 'debug' | 'info' | 'warn', message: string) => void;
}
export declare class GameWiki {
    private readonly options;
    constructor(options: GameHintOptions);
    private service;
    /**
     * 返回要注入的"话题线索"块；没有命中 / 未启用 / 服务不在 → undefined。
     * 注意：这里**不查 wiki**，只告诉模型"可能是这个游戏、这些词、可以这样查"。
     */
    hintFor(text: string): Promise<string | undefined>;
}
export interface Candidate {
    game: string;
    hits: string[];
    pages?: string[];
}
/** 注入块：线索 + 工具用法 + 两种意图的不同要求 */
export declare function buildHintBlock(candidates: readonly Candidate[]): string;
