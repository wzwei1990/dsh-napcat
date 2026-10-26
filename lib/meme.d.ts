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
    private allRows;
    /**
     * 按描述/关键词找图。
     * @param query `[表情: …]` 里的描述（通常就是候选 caption 原文）
     * @param avoid 最近发过的文件路径（用于避免连续重复同一张）
     */
    search(query: string, avoid?: Set<string>, limit?: number): Promise<MemeHit[]>;
    /** 同情绪里随机抽一张（描述匹配不上时的兜底），尽量避开最近发过的。 */
    randomInTag(tag: string, avoid?: Set<string>, random?: () => number): Promise<MemeHit | undefined>;
}
