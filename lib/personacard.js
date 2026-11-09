/**
 * 人物卡文件读写（设置页下拉 / 保存按钮用）。
 * 只操作 persona 目录下的 *.json，名字做白名单校验。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const NAME_RE = /^[\w\u4e00-\u9fa5.-]{1,40}$/;
/** 名字是否合法（防目录穿越、防空名）。 */
export function validCardName(name) {
    const trimmed = name.trim();
    return NAME_RE.test(trimmed) && trimmed !== '.' && trimmed !== '..';
}
/** 列出目录里的卡名（不含 .json）。 */
export function listCardsInDir(dir) {
    try {
        return readdirSync(dir)
            .filter(file => file.endsWith('.json'))
            .map(file => file.slice(0, -'.json'.length))
            .filter(name => validCardName(name))
            .sort();
    }
    catch {
        return [];
    }
}
/** 读一张卡（不存在返回 undefined）。 */
export function readCardInDir(dir, name) {
    if (!validCardName(name))
        return undefined;
    try {
        const file = join(dir, name + '.json');
        if (!existsSync(file))
            return undefined;
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** 写一张卡（覆盖同名文件）。 */
export function writeCardInDir(dir, name, card) {
    if (!validCardName(name))
        return { ok: false, error: '名字只能包含字母/数字/下划线/横线/中文，1~40 字' };
    if (card === null || typeof card !== 'object')
        return { ok: false, error: '人物卡必须是一个 JSON 对象' };
    try {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, name + '.json');
        writeFileSync(file, JSON.stringify(card, null, 2) + '\n', 'utf8');
        return { ok: true, file };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
