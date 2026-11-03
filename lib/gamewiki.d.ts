/**
 * 游戏 wiki 联动：判意图 → 查一次 → 按意图包装成注入块。
 *
 * 两种情况必须分开（用户明确要求）：
 *   ask     —— 真的在问攻略（"魔渊怎么打""弹反在哪学"）：查完给答案
 *   discuss —— 在聊某个道具/机制（"这武器感觉挺强""黑伤值不值"）：查到的只当**背景**，
 *              用来听懂大家在聊什么，不许复述、不给攻略、不贴来源
 *
 * 所有失败都静默（限流 / 没收录 / 服务不在），绝不把错误甩到群里。
 */
import type { Context } from '@deepseek-ai/cordis';
export interface GameQuery {
    game: string;
    keyword: string;
    mode: 'ask' | 'discuss';
}
/** dsh-game 暴露的服务形状（本插件只依赖这一小部分） */
export interface GameService {
    list?: () => Array<{
        name: string;
        aliases?: string[];
    }>;
    resolve?: (name: string) => unknown;
    search?: (game: string, keyword: string) => Promise<Array<{
        title: string;
        snippet?: string;
        url?: string;
    }>>;
    read?: (game: string, title: string, optionsOrMax?: number | {
        maxChars?: number;
        section?: number;
    }) => Promise<{
        title: string;
        text: string;
        url?: string;
    }>;
}
/** 去掉标点，保留中英文数字 */
export declare function normalizeText(text: string): string;
/**
 * 从一条群消息里判断"要不要查、查什么、怎么用"。
 * @param text 消息文本
 * @param games 已收录的游戏名/别名（来自 dsh-game 的 list()）
 */
export declare function detectGameIntent(text: string, games: readonly string[]): GameQuery | undefined;
/** 抽关键词：剥掉停用词后取最长一段中文/字母数字串（≤8 字），抽不到就用原文 */
export declare function extractKeyword(rest: string): string;
export interface GameWikiOptions {
    ctx: Context;
    enabled: boolean;
    /** 注入块最大字数（只为省上下文，不是限流） */
    maxChars: number;
    /** 同一问题的结果缓存时长：重复问同一件事直接复用文本，不再发请求 */
    cacheTtlMs: number;
    log: (level: 'debug' | 'info' | 'warn', message: string) => void;
}
export declare class GameWiki {
    private readonly options;
    /** 游戏名+关键词 → 已生成的注入块（TTL 内复用，避免重复请求；不是拒绝查询） */
    private readonly cache;
    /** 缓存游戏名列表（避免每条消息都问服务） */
    private cachedNames;
    constructor(options: GameWikiOptions);
    /** dsh-game 服务；没装/未启用就是 undefined（联动整体静默关闭） */
    private service;
    private gameNames;
    /** 命中缓存就直接复用（同一问题不重复发请求，但照样能回答） */
    private cacheGet;
    private cacheSet;
    /**
     * 主入口：解析这条消息要不要游戏资料。
     * 返回注入块文本；不需要 / 失败 / 超预算 一律 undefined（调用方原样继续）。
     */
    contextFor(chatKey: string, text: string): Promise<string | undefined>;
    /** 别名 → 标准名（注册表里的 name） */
    private displayNameFor;
}
export interface GameBlockInput {
    game: string;
    title: string;
    url: string;
    text: string;
    mode: 'ask' | 'discuss';
}
/** 两种注入形态：同一份数据，两套指令（ask 给答案 / discuss 只当背景） */
export declare function buildGameBlock(input: GameBlockInput): string;
