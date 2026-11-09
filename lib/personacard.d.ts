/**
 * 人物卡文件读写（设置页下拉 / 保存按钮用）。
 * 只操作 persona 目录下的 *.json，名字做白名单校验。
 */
/** 名字是否合法（防目录穿越、防空名）。 */
export declare function validCardName(name: string): boolean;
/** 列出目录里的卡名（不含 .json）。 */
export declare function listCardsInDir(dir: string): string[];
/** 读一张卡（不存在返回 undefined）。 */
export declare function readCardInDir(dir: string, name: string): unknown;
/** 写一张卡（覆盖同名文件）。 */
export declare function writeCardInDir(dir: string, name: string, card: unknown): {
    ok: true;
    file: string;
} | {
    ok: false;
    error: string;
};
