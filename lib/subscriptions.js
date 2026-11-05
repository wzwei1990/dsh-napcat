/**
 * 订阅（平台无关）：订阅表 + 轮询 + 投递队列，2026-11-05。
 *
 * 设计（与用户确认的 A 方案）：
 *   - 订阅属于"有收件人的插件"（渠道），所以由 dsh-napcat 拥有；
 *   - 数据来源是**可插拔 provider**（现在只有 B 站，将来可加抖音/微博…），
 *     订阅记录带 provider 字段，删掉某个 provider 不影响其他；
 *   - 没有可用 provider 时，工具报"没有可用的数据源"，不点名某个插件。
 */
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
function defaultDir() {
    const dshHome = process.env.DSH_HOME;
    const base = dshHome !== undefined && dshHome !== '' ? dshHome : join(homedir(), '.dsh');
    return join(base, 'dsh-napcat', 'subscriptions');
}
export class SubscriptionStore {
    options;
    subsFile;
    queueFile;
    loaded = false;
    subs = [];
    queue = [];
    constructor(options = {}) {
        this.options = options;
        const dir = options.dir ?? defaultDir();
        this.subsFile = join(dir, 'subscriptions.json');
        this.queueFile = join(dir, 'queue.jsonl');
    }
    log(level, message) {
        this.options.log?.(level, message);
    }
    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            const raw = await readFile(this.subsFile, 'utf8');
            const parsed = JSON.parse(raw);
            this.subs = Array.isArray(parsed.subscriptions) ? parsed.subscriptions.filter(Boolean) : [];
        }
        catch {
            this.subs = [];
        }
        try {
            const raw = await readFile(this.queueFile, 'utf8');
            this.queue = raw.split('\n').filter(line => line.trim() !== '').flatMap(line => {
                try {
                    return [JSON.parse(line)];
                }
                catch {
                    return [];
                }
            });
        }
        catch {
            this.queue = [];
        }
        this.log('debug', '订阅表：' + String(this.subs.length) + ' 个，队列 ' + String(this.queue.length) + ' 条');
    }
    async save() {
        await mkdir(dirname(this.subsFile), { recursive: true });
        const tmp = this.subsFile + '.tmp';
        await writeFile(tmp, JSON.stringify({ subscriptions: this.subs }, null, 2), 'utf8');
        await rename(tmp, this.subsFile);
    }
    list() {
        return this.subs.map(item => ({ ...item, groups: [...item.groups], types: [...item.types], recentIds: [...item.recentIds] }));
    }
    find(id) {
        return this.subs.find(item => item.id === id);
    }
    findByKey(provider, key) {
        return this.subs.find(item => item.provider === provider && item.key === key);
    }
    async upsert(input) {
        const now = input.now ?? Date.now();
        const existing = this.findByKey(input.provider, input.key);
        if (existing !== undefined) {
            for (const type of input.types ?? [])
                if (!existing.types.includes(type))
                    existing.types.push(type);
            for (const group of input.groups ?? [])
                if (!existing.groups.includes(group))
                    existing.groups.push(group);
            if (input.lastSeenPubdate !== undefined)
                existing.lastSeenPubdate = Math.max(existing.lastSeenPubdate, input.lastSeenPubdate);
            existing.enabled = true;
            existing.failures = 0;
            existing.nextCheckAt = now;
            await this.save();
            return { subscription: { ...existing }, created: false };
        }
        const subscription = {
            id: input.provider + ':' + input.key,
            provider: input.provider,
            key: input.key,
            name: input.name,
            types: input.types !== undefined && input.types.length > 0 ? [...new Set(input.types)] : ['video'],
            groups: [...new Set(input.groups ?? [])],
            lastSeenPubdate: input.lastSeenPubdate ?? 0,
            recentIds: [],
            failures: 0,
            nextCheckAt: now,
            enabled: true,
            createdAt: now,
        };
        this.subs.push(subscription);
        await this.save();
        return { subscription: { ...subscription }, created: true };
    }
    async remove(identifier) {
        if (identifier.group !== undefined && identifier.id !== undefined) {
            const target = this.find(identifier.id);
            if (target !== undefined) {
                target.groups = target.groups.filter(group => group !== identifier.group);
                await this.save();
                return 1;
            }
        }
        const before = this.subs.length;
        this.subs = this.subs.filter(item => {
            if (identifier.id !== undefined && item.id === identifier.id)
                return false;
            if (identifier.provider !== undefined && identifier.key !== undefined && item.provider === identifier.provider && item.key === identifier.key)
                return false;
            return true;
        });
        const removed = before - this.subs.length;
        if (removed > 0)
            await this.save();
        return removed;
    }
    async update(subscription) {
        const index = this.subs.findIndex(item => item.id === subscription.id);
        if (index < 0)
            return;
        this.subs[index] = subscription;
        await this.save();
    }
    due(now = Date.now(), limit = 1) {
        return this.subs
            .filter(item => item.enabled && item.nextCheckAt <= now)
            .sort((a, b) => a.nextCheckAt - b.nextCheckAt)
            .slice(0, limit);
    }
    pending(consumer, limit = 50, target) {
        let items = consumer === undefined ? this.queue : this.queue.filter(item => !item.deliveredTo.includes(consumer));
        if (target !== undefined)
            items = items.filter(item => item.groups.includes(target));
        return items.slice(-limit);
    }
    async ack(ids, consumer, keep = 200) {
        const set = new Set(ids);
        let changed = false;
        for (const item of this.queue) {
            if (!set.has(item.id))
                continue;
            if (!item.deliveredTo.includes(consumer)) {
                item.deliveredTo.push(consumer);
                changed = true;
            }
        }
        if (this.queue.length > keep) {
            this.queue = this.queue.slice(this.queue.length - keep);
            changed = true;
        }
        if (changed) {
            await mkdir(dirname(this.queueFile), { recursive: true });
            const body = this.queue.map(item => JSON.stringify(item)).join('\n') + (this.queue.length > 0 ? '\n' : '');
            await writeFile(this.queueFile, body, 'utf8');
        }
    }
    async push(items) {
        if (items.length === 0)
            return 0;
        await mkdir(dirname(this.queueFile), { recursive: true });
        const known = new Set(this.queue.map(item => item.id));
        const fresh = [];
        for (const item of items) {
            if (known.has(item.id)) {
                const existing = this.queue.find(entry => entry.id === item.id);
                if (existing !== undefined)
                    for (const group of item.groups)
                        if (!existing.groups.includes(group))
                            existing.groups.push(group);
                continue;
            }
            known.add(item.id);
            fresh.push({ ...item, addedAt: Date.now(), deliveredTo: [] });
        }
        if (fresh.length === 0)
            return 0;
        this.queue.push(...fresh);
        await appendFile(this.queueFile, fresh.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
        return fresh.length;
    }
}
/** 检查一个订阅：拉最新 → 与基线比较 → 写队列 */
export async function pollSubscription(subscription, options) {
    const now = Date.now();
    const current = { ...subscription, groups: [...subscription.groups], types: [...subscription.types], recentIds: [...subscription.recentIds] };
    try {
        const items = await options.provider.latest(current.key, current.types);
        const fresh = [];
        let newest = current.lastSeenPubdate;
        // 首次运行（还没基线、也没历史 id）：只记基线，不把过去的投稿当新内容
        if (current.lastSeenPubdate === 0 && current.recentIds.length === 0) {
            const baseline = items.reduce((max, item) => Math.max(max, item.pubdate), 0);
            current.lastSeenPubdate = baseline;
            current.failures = 0;
            current.nextCheckAt = now + options.intervalMinutes * 60_000;
            await options.store.update(current);
            options.log?.('info', '订阅基线已建立 ' + current.name + '（' + String(items.length) + ' 条历史内容不推送）');
            return { subscription: current, added: 0 };
        }
        for (const item of items) {
            if (item.pubdate > newest)
                newest = item.pubdate;
            if (item.pubdate <= current.lastSeenPubdate)
                continue;
            if (current.recentIds.includes(item.id))
                continue;
            fresh.push({
                id: options.provider.id + ':' + item.id,
                kind: item.kind,
                title: item.title,
                url: item.url,
                pubdate: item.pubdate,
                provider: options.provider.id,
                providerLabel: options.provider.label,
                subKey: current.key,
                subName: current.name,
                groups: [...current.groups],
                ...(item.extra === undefined ? {} : { extra: item.extra }),
            });
        }
        const added = await options.store.push(fresh);
        current.lastSeenPubdate = newest;
        current.recentIds = [...fresh.map(item => item.id.split(':').slice(1).join(':')), ...current.recentIds].slice(0, 40);
        current.failures = 0;
        // 加一点抖动，避免多个订阅同一分钟齐发
        current.nextCheckAt = now + options.intervalMinutes * 60_000 + Math.floor(Math.random() * 60_000);
        await options.store.update(current);
        if (added > 0)
            options.log?.('info', '订阅更新 ' + current.name + '：' + String(added) + ' 条');
        return { subscription: current, added };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const backoff = options.backoffMinutes ?? [5, 15, 60];
        const failures = current.failures + 1;
        let wait = backoff[Math.min(backoff.length - 1, failures - 1)] ?? 60;
        // 数据源报"风控"时，等它的冷却时间，别 5 分钟后又去撞（实测会一直 412）
        if (/412|风控|-352|-799|频繁/.test(message))
            wait = Math.max(wait, 15);
        current.failures = failures;
        current.nextCheckAt = now + wait * 60_000;
        await options.store.update(current);
        options.log?.('warn', '订阅检查失败 ' + current.name + '（' + String(failures) + ' 次，' + String(wait) + ' 分钟后重试）: ' + message);
        return { subscription: current, added: 0, error: message };
    }
}
