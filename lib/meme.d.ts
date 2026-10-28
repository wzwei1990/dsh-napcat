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
/** dsh-meme 的设置文件内容（只读它关心的两项）。 */
export interface MemeSettings {
    /** 自定义图库根目录（设置页「图库目录」） */
    packsDir?: string;
    /** 显式勾选启用的包 id；用户没拨过开关时为空 */
    enabledPacks?: string[];
}
/** dsh-meme 的 home（它用 os.homedir()，可用 DSH_MEME_HOME 覆盖）。 */
export declare function memeHomeDir(): string;
/**
 * 读 dsh-meme 的设置（`<memeHome>/.dsh/dsh-expression.json`）。
 *
 * 图库根目录与「启用了哪几个包」都以这份设置为准，否则会和 Web 面板显示不一致
 * （线上曾出现面板 3 个包、插件只扫到内置 24 张的情况）。
 */
export declare function readMemeSettings(): MemeSettings;
/**
 * 默认扫描位置（全部一起搜，命中后按 caption+tag 去重）。
 *
 * 1. dsh-meme 的设置里指定的 `packsDir`，否则 `<memeHome>/.dsh/meme-packs`；
 * 2. `<DSH_HOME>/meme-packs`（有些部署 DSH_HOME 与 home 不同）；
 * 3. `profiles/<name>/node_modules/dsh-meme/memes` —— 插件包内自带的示例包（兜底）。
 *
 * 旧实现只扫第 3 种，所以用户后加的包永远读不到。
 */
export declare function defaultMemeDirs(dshHome: string): string[];
export declare class MemeLibrary {
    private readonly dirs;
    private readonly log;
    /** 缓存有效期（毫秒）：到期重扫图库，新加的包最多这么久后自动生效。 */
    private readonly ttlMs;
    /** 只读这些包（dsh-meme 设置里显式勾选的 enabledPacks；空/未给则全部读）。 */
    private readonly allowedPacks?;
    /** 每个根目录的缓存行 + 读取时间（TTL 到了重扫，新加的包不用重启）。 */
    private readonly loaded;
    private readonly missing;
    constructor(dirs: string[], log?: (level: string, message: string) => void, 
    /** 缓存有效期（毫秒）：到期重扫图库，新加的包最多这么久后自动生效。 */
    ttlMs?: number, 
    /** 只读这些包（dsh-meme 设置里显式勾选的 enabledPacks；空/未给则全部读）。 */
    allowedPacks?: readonly string[] | undefined);
    /** 读取一个图库根目录下所有包的 memes 行。 */
    private rowsOf;
    /**
     * 图库目录摘要：每个分类的张数 + 几条示例描述。
     * 给模型看"库里有什么"，避免它凭空编描述导致匹配不上。
     */
    catalog(samplesPerTag?: number): Promise<Array<{
        tag: string;
        count: number;
        samples: string[];
    }>>;
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
