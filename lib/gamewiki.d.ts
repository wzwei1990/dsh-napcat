/**
 * 游戏 wiki 联动（模型自决版）。
 *
 * 设计（2026-11-09 修订）：
 *   ① 词表召回（零成本、代码）：dsh-game 用 wiki 全站标题建词表，识别群聊里的地名/道具名；
 *   ② 把命中结果 + 可用工具写进注入。**按意图分档要求**：
 *        · 在问攻略/卡关（怎么打、打不过、在哪、要不要做、选哪个、是不是 bug）→ 必须先查，
 *          然后用一两句给出**具体的下一步**（去哪/找谁/什么顺序/注意什么）；
 *        · 只是随口评价/吐槽 → 可以不查，但别装懂编步骤。
 *   ③ 最近聊过的游戏按会话记 30 分钟：没命中关键词、但消息像在聊游戏（boss/关卡/装备…）时，
 *       也能提示「本群最近在聊 X」。
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
export interface Candidate {
    game: string;
    hits: string[];
    pages?: string[];
}
export declare class GameWiki {
    private readonly options;
    /** chatKey → 最近聊到的游戏 */
    private readonly recent;
    constructor(options: GameHintOptions);
    private service;
    /** 最近聊过的游戏（30 分钟内有效） */
    private recentGameOf;
    /**
     * 返回要注入的"话题线索"块；没有命中 / 未启用 / 服务不在 → undefined。
     * 注意：这里**不查 wiki**，只告诉模型"可能是这个游戏、这些词、必须/可以这样查"。
     */
    hintFor(text: string, chatKey?: string): Promise<string | undefined>;
}
/** 粗略判断是不是在求解（决定"必须先查"还是"可以不查"） */
export declare function looksLikeHelpRequest(text: string): boolean;
/** 注入块：线索 + 工具用法 + 按意图分档的要求 */
export declare function buildHintBlock(candidates: readonly Candidate[], options?: {
    askedForHelp?: boolean;
    fromRecent?: boolean;
}): string;
