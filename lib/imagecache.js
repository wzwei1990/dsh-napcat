/**
 * 群聊图片缓存：把群里的图片（含表情包）落到会话目录，供之后 read_image / 视觉模型回看。
 *
 * 约束（防止把磁盘吃满）：
 * - 每条消息最多存 3 张
 * - 单张 ≤ maxBytes（默认 2MB）
 * - 每个聊天每天 ≤ dailyCap 张（默认 100）
 * - 超过 retentionDays 的目录在启动/写入时清理
 * - 按 URL 取 hash 去重（同一张图重复发只存一份）
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadToFile, pruneInbox } from './media.js';
/** 每天目录名：YYYYMMDD（本地时区）。 */
export function dayKey(now) {
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}
/** 用图片 URL 生成稳定短 hash（同一张图重复发只存一份）。 */
export function urlHash(url) {
    return createHash('sha1').update(url).digest('hex').slice(0, 10);
}
export class ImageCache {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    get root() {
        return join(this.opts.cwd, 'napcat-inbox', 'imgs');
    }
    /** 清理超过保留天数的日期目录 + 收件箱根目录里的旧媒体。 */
    async sweep(now = Date.now()) {
        let removed = 0;
        try {
            const dirs = await readdir(this.root, { withFileTypes: true });
            const cutoff = now - this.opts.retentionDays * 86_400_000;
            for (const entry of dirs) {
                if (!entry.isDirectory() || !/^\d{8}$/.test(entry.name))
                    continue;
                const dayPath = join(this.root, entry.name);
                try {
                    const info = await stat(dayPath);
                    if (info.mtimeMs < cutoff) {
                        await rm(dayPath, { recursive: true, force: true });
                        removed += 1;
                    }
                }
                catch {
                    // 忽略单项失败
                }
            }
        }
        catch {
            // 目录还不存在
        }
        // 收件箱根目录：原图/表情包/视频/文件也按同一保留天数清理
        // （之前只清 imgs/ 日期目录，inbox 根目录的文件会一直堆着）
        try {
            removed += await pruneInbox(join(this.opts.cwd, 'napcat-inbox'), this.opts.retentionDays, now);
        }
        catch {
            // 清理失败不影响主流程
        }
        return removed;
    }
    /** 当天已存张数。 */
    async countToday(now = Date.now()) {
        try {
            const entries = await readdir(join(this.root, dayKey(now)));
            return entries.length;
        }
        catch {
            return 0;
        }
    }
    /** 存一张图；超限/去重命中时返回 undefined 或已有路径。 */
    async save(input) {
        const now = input.now ?? Date.now();
        const day = dayKey(now);
        const dir = join(this.root, day);
        const hash = urlHash(input.url);
        const safe = input.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 40);
        const fileName = hash + '-' + safe;
        const target = join(dir, fileName);
        // 去重：同一天里已有同 hash 的任意文件（downloadToFile 会自己改名字，所以按前缀找）
        try {
            const entries = await readdir(dir);
            const hit = entries.find(entry => entry.startsWith(hash + '-'));
            if (hit !== undefined) {
                const info = await stat(join(dir, hit));
                if (info.size > 0)
                    return { path: join(dir, hit), name: hit, bytes: info.size };
            }
        }
        catch {
            // 目录不存在
        }
        if ((await this.countToday(now)) >= this.opts.dailyCap) {
            this.opts.log('debug', '图片缓存达到每日上限，跳过: ' + input.chatKey);
            return undefined;
        }
        try {
            await mkdir(dir, { recursive: true });
            const saved = await downloadToFile(input.url, dir, fileName, this.opts.maxBytes);
            // 统一改名为 hash-原名（便于去重与阅读；重名说明并发下已有人存了）
            let finalPath = saved.path;
            let finalName = saved.path.split(/[\\/]/).pop() ?? fileName;
            try {
                await rename(saved.path, target);
                finalPath = target;
                finalName = fileName;
            }
            catch {
                // 目标已存在 → 删掉刚下载的重复文件
                try {
                    await rm(saved.path, { force: true });
                    const info = await stat(target);
                    return { path: target, name: fileName, bytes: info.size };
                }
                catch {
                    // 保留原文件名
                }
            }
            try {
                await appendFile(join(this.root, 'index.jsonl'), JSON.stringify({ t: now, chat: input.chatKey, nick: input.nick.slice(0, 24), file: day + '/' + finalName, bytes: saved.bytes }) + '\n', 'utf8');
            }
            catch {
                // 索引失败不影响图片
            }
            return { path: finalPath, name: finalName, bytes: saved.bytes };
        }
        catch (error) {
            this.opts.log('debug', '图片缓存失败: ' + (error instanceof Error ? error.message : String(error)));
            return undefined;
        }
    }
    /** 把纯文本证据写一份（表情包名称之类），便于以后统计常用表情。 */
    async noteFace(chatKey, nick, face, now = Date.now()) {
        try {
            await mkdir(this.root, { recursive: true });
            await appendFile(join(this.root, 'faces.jsonl'), JSON.stringify({ t: now, chat: chatKey, nick: nick.slice(0, 24), face: face.slice(0, 40) }) + '\n', 'utf8');
        }
        catch {
            // 忽略
        }
    }
    /** 写一小段统计（可选调用）。 */
    async writeSummary(text) {
        try {
            await mkdir(this.root, { recursive: true });
            await writeFile(join(this.root, 'summary.txt'), text, 'utf8');
        }
        catch {
            // 忽略
        }
    }
}
