/** B 站 provider：数据来自 dshBili 服务 */
export class BiliFeedProvider {
    id = 'bili';
    label = 'B站';
    service;
    constructor(service) {
        this.service = service;
    }
    canHandle(target) {
        const text = target.trim();
        if (text === '')
            return false;
        return /^\d{1,15}$/.test(text) || /^(BV[0-9A-Za-z]{10}|av\d+)$/i.test(text) || /bilibili\.com|b23\.tv/i.test(text);
    }
    async resolve(target) {
        const resolveUp = this.service.resolveUp;
        if (resolveUp === undefined)
            throw new Error('B 站数据源不可用');
        const info = await resolveUp(target);
        const latest = await this.service.upVideos?.(info.mid, 1, 1).catch(() => []);
        return {
            key: String(info.mid),
            name: info.name,
            ...(latest?.[0]?.pubdate === undefined ? {} : { latestPubdate: latest[0].pubdate }),
        };
    }
    async latest(key, types) {
        const mid = Number(key);
        if (!Number.isFinite(mid) || mid <= 0)
            throw new Error('无效的 UP mid：' + key);
        const items = [];
        if (types.includes('video') && this.service.upVideos !== undefined) {
            const videos = await this.service.upVideos(mid, 1, 10);
            for (const video of videos) {
                items.push({
                    id: video.bvid,
                    kind: 'video',
                    title: video.title,
                    url: video.url,
                    pubdate: video.pubdate,
                    ...(video.durationSec > 0 ? { extra: Math.round(video.durationSec / 60) + ' 分钟' } : {}),
                });
            }
        }
        if (types.includes('dynamic') && this.service.upDynamics !== undefined) {
            const dynamics = await this.service.upDynamics(mid, 10);
            for (const dynamic of dynamics) {
                items.push({
                    id: dynamic.id,
                    kind: 'dynamic',
                    title: dynamic.text === '' ? (dynamic.imageCount > 0 ? '发了一张图' : '发了一条动态') : dynamic.text.slice(0, 80),
                    url: dynamic.url,
                    pubdate: dynamic.pubdate,
                    ...(dynamic.imageCount > 0 ? { extra: dynamic.imageCount + ' 张图' } : {}),
                });
            }
        }
        return items.sort((a, b) => b.pubdate - a.pubdate);
    }
}
export class ProviderRegistry {
    options;
    providers = new Map();
    constructor(options) {
        this.options = options;
    }
    service() {
        try {
            const get = this.options.ctx.get;
            const svc = get?.('dshBili');
            if (svc === undefined || svc === null)
                return undefined;
            if (typeof svc.resolveUp !== 'function')
                return undefined;
            return svc;
        }
        catch {
            return undefined;
        }
    }
    /** 按需发现 provider（每次调用都检查，装上数据源后无需重启注册流程） */
    available() {
        const svc = this.service();
        if (svc !== undefined && !this.providers.has('bili')) {
            this.providers.set('bili', new BiliFeedProvider(svc));
            this.options.log('info', '已接入数据源：B站');
        }
        return [...this.providers.values()];
    }
    /** 注册额外 provider（未来抖音等在这里加） */
    register(provider) {
        this.providers.set(provider.id, provider);
        this.options.log('info', '已注册数据源：' + provider.label);
    }
    /**
     * 按输入挑 provider：
     *   1) 显式指定 id
     *   2) 能处理该输入的 provider（多个时取第一个）
     * 找不到返回 undefined（调用方给出"没有可用数据源"的提示，不点名插件）
     */
    pick(target, preferred) {
        const list = this.available();
        if (preferred !== undefined && preferred !== '')
            return list.find(provider => provider.id === preferred);
        return list.find(provider => provider.canHandle(target));
    }
    get(id) {
        return this.available().find(provider => provider.id === id);
    }
    labels() {
        return this.available().map(provider => provider.label + '(' + provider.id + ')').join('、');
    }
}
