export interface MemeHit {
    /** 图片绝对路径 */
    file: string;
    /** 描述（候选里显示的那句） */
    caption: string;
    /** 情绪分类 */
    tag: string;
    /** 所属包目录 */
    pack: string;
}
/** 默认扫描位置（DSH_HOME 下的 profile 里装的 dsh-meme）。 */
export declare function defaultMemeDirs(dshHome: string): string[];
export declare class MemeLibrary {
    private readonly dirs;
    private readonly log;
    private readonly loaded;
    private readonly missing;
    constructor(dirs: string[], log?: (level: string, message: string) => void);
    /** 读取一个图库根目录下所有包的 memes 行。 */
    private rowsOf;
    /** 图库总张数（自适应避重窗口用）。 */
    size(): Promise<number>;
    private allRows;
    /**
     * 按描述/关键词找图。
     * @param query `[表情: …]` 里的描述（通常就是候选 caption 原文）
     * @param avoid 最近发过的文件路径（用于避免连续重复同一张）
     */
    search(query: string, avoid?: Set<string>, limit?: number): Promise<MemeHit[]>;
    /** 同情绪里随机抽一张（描述匹配不上时的兜底），只从没发过的里面挑；该情绪用光就返回 undefined。 */
    randomInTag(tag: string, avoid?: Set<string>, random?: () => number): Promise<MemeHit | undefined>;
    /**
     * 精确命中：描述**完全等于**某张图的 caption（模型抄的是候选原文）。
     * 这种情况必须返回那一张，不能再参与"避重换图"——否则 Web 端按同一段描述
     * 显示的是这张、QQ 端却换成另一张，同一个回复两边不一致。
     */
    exact(caption: string): Promise<MemeHit | undefined>;
    /**
     * 全场随机（不限情绪），只避开最近发过的 —— 同情绪图用光时扩池，
     * 让轮换范围从「3 张开心」扩到「整个图库」。
     */
    randomAny(avoid?: Set<string>, random?: () => number): Promise<MemeHit | undefined>;
}
/** 中文 2-gram（去重、只保留含中文/字母的组），用于粗粒度相关度打分。 */
/** 中文说法 → 图库标签的同义词表（标签多是英文，靠这张表把口语对上）。 */
export declare const TAG_SYNONYMS: Record<string, string[]>;
export declare function bigrams(text: string): string[];
