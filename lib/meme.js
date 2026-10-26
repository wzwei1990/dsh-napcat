/**
 * dsh-meme 表情包图库的只读访问层。
 *
 * 图库布局（dsh-meme 插件目录下，每个包一个库）：
 *   <plugin>/memes/<pack>/index.db      SQLite，表 memes(path, tag, file_name, caption, keywords, ...)
 *   <plugin>/memes/<pack>/<path>        图片本体（path 相对包目录）
 *
 * 用途：QQ 侧没有前端帮忙把 `[表情: 描述]` 渲染成图，所以这里按描述/关键词查库，
 * 找到文件后由 NapCat 以图片消息真的发出去。
 * node:sqlite 在 Node 22.5+ 可用（本插件要求 Node >=22）；不可用或库损坏时静默跳过。
 */
import { existsSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
/** 默认扫描位置（DSH_HOME 下的 profile 里装的 dsh-meme）。 */
export function defaultMemeDirs(dshHome) {
    const root = join(dshHome, 'profiles');
    const dirs = [];
    try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const dir = join(root, entry.name, 'node_modules', 'dsh-meme', 'memes');
            if (existsSync(dir))
                dirs.push(dir);
        }
    }
    catch {
        // 目录不存在就算了
    }
    return dirs;
}
export class MemeLibrary {
    dirs;
    log;
    loaded = new Map();
    missing = new Set();
    constructor(dirs, log = () => undefined) {
        this.dirs = dirs;
        this.log = log;
    }
    /** 读取一个图库根目录下所有包的 memes 行。 */
    async rowsOf(root) {
        const cached = this.loaded.get(root);
        if (cached !== undefined)
            return cached;
        if (this.missing.has(root))
            return [];
        if (!existsSync(root)) {
            this.missing.add(root);
            return [];
        }
        const rows = [];
        try {
            const packs = await readdir(root, { withFileTypes: true });
            const { DatabaseSync } = await import('node:sqlite');
            for (const pack of packs) {
                if (!pack.isDirectory())
                    continue;
                const packDir = join(root, pack.name);
                const dbPath = join(packDir, 'index.db');
                if (!existsSync(dbPath))
                    continue;
                try {
                    const db = new DatabaseSync(dbPath, { readOnly: true });
                    const list = db.prepare('SELECT path, tag, caption, keywords FROM memes').all();
                    for (const row of list) {
                        if (typeof row.path !== 'string' || row.path === '')
                            continue;
                        const file = resolve(packDir, row.path);
                        if (!file.startsWith(resolve(packDir) + sep) && file !== resolve(packDir))
                            continue;
                        if (!existsSync(file))
                            continue;
                        rows.push({ path: file, tag: String(row.tag ?? ''), caption: String(row.caption ?? ''), keywords: String(row.keywords ?? '') });
                    }
                    db.close();
                }
                catch (error) {
                    this.log('debug', '读取表情库失败 ' + dbPath + ': ' + (error instanceof Error ? error.message : String(error)));
                }
            }
        }
        catch (error) {
            this.log('debug', '扫描表情库失败 ' + root + ': ' + (error instanceof Error ? error.message : String(error)));
        }
        this.loaded.set(root, rows);
        if (rows.length > 0)
            this.log('debug', '表情库已加载 ' + rows.length + ' 张（' + root + '）');
        return rows;
    }
    async allRows() {
        const out = [];
        for (const dir of this.dirs)
            out.push(...await this.rowsOf(dir));
        return out;
    }
    /**
     * 按描述/关键词找图。
     * @param query `[表情: …]` 里的描述（通常就是候选 caption 原文）
     * @param avoid 最近发过的文件路径（用于避免连续重复同一张）
     */
    async search(query, avoid = new Set(), limit = 6) {
        const text = query.trim();
        if (text === '')
            return [];
        const rows = await this.allRows();
        if (rows.length === 0)
            return [];
        const scored = [];
        const needles = [text, ...text.split(/[\s,，、。;；:：]+/).filter(part => part.length >= 2)];
        for (const row of rows) {
            const haystack = row.caption + ' ' + row.keywords + ' ' + row.path;
            let score = 0;
            if (row.caption === text)
                score += 100;
            else if (row.caption.includes(text))
                score += 60;
            if (row.keywords.split(/\s+/).includes(text))
                score += 40;
            for (const needle of needles) {
                if (needle !== text && haystack.includes(needle))
                    score += 12;
            }
            if (score === 0)
                continue;
            if (avoid.has(row.path))
                score -= 30;
            scored.push({ hit: { file: row.path, caption: row.caption, tag: row.tag, pack: '' }, score });
        }
        scored.sort((left, right) => right.score - left.score);
        return scored.slice(0, limit).map(item => item.hit);
    }
    /** 同情绪里随机抽一张（描述匹配不上时的兜底），尽量避开最近发过的。 */
    async randomInTag(tag, avoid = new Set(), random = Math.random) {
        const rows = await this.allRows();
        const pool = rows.filter(row => row.tag === tag && !avoid.has(row.path));
        const fallback = rows.filter(row => row.tag === tag);
        const use = pool.length > 0 ? pool : fallback;
        if (use.length === 0)
            return undefined;
        const pick = use[Math.floor(random() * use.length) % use.length];
        if (pick === undefined)
            return undefined;
        return { file: pick.path, caption: pick.caption, tag: pick.tag, pack: '' };
    }
}
