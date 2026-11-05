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
        let info;
        try {
            if (resolveUp === undefined)
                throw new Error('B 站数据源不可用');
            info = await resolveUp(target);
        }
        catch (error) {
            // 空间接口对未登录/机房 IP 很容易 -352 风控；退回"按名字搜用户"（这个接口宽松得多）
            const searchUser = this.service.searchUser;
            if (searchUser === undefined)
                throw error;
            const users = await searchUser(target);
            const picked = users[0];
            if (picked === undefined)
                throw error;
            info = { mid: picked.mid, name: picked.name };
        }
        let latestPubdate;
        if (this.service.upVideos !== undefined) {
            try {
                const latest = await this.service.upVideos(info.mid, 1, 1);
                latestPubdate = latest[0]?.pubdate;
            }
            catch {
                // 拿不到就留空，由轮询的"首次运行"兜底
            }
        }
        return {
            key: String(info.mid),
            name: info.name,
            ...(latestPubdate === undefined ? {} : { latestPubdate }),
        };
    }
    /** 最近一次失败原因（供上层日志） */
    lastError = '';
    async latest(key, types) {
        const mid = Number(key);
        if (!Number.isFinite(mid) || mid <= 0)
            throw new Error('无效的 UP mid：' + key);
        const items = [];
        let videoFetchFailed = false;
        if (types.includes('video') && this.service.upVideos !== undefined) {
            try {
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
            catch (error) {
                // 投稿接口被风控时不要整轮失败：动态里的"视频动态"也能发现新投稿
                videoFetchFailed = true;
                this.lastError = error instanceof Error ? error.message : String(error);
            }
        }
        if ((types.includes('dynamic') || videoFetchFailed) && this.service.upDynamics !== undefined) {
            const dynamics = await this.service.upDynamics(mid, 10);
            for (const dynamic of dynamics) {
                // 视频动态（DYNAMIC_TYPE_AV）当作"新视频"兜底：标题在 text 里，id 用动态 id
                if (videoFetchFailed && dynamic.type === 'DYNAMIC_TYPE_AV' && dynamic.text !== '') {
                    items.push({
                        id: 'av-' + dynamic.id,
                        kind: 'video',
                        title: dynamic.text.slice(0, 80),
                        url: dynamic.url,
                        pubdate: dynamic.pubdate,
                        extra: '来自动态',
                    });
                    continue;
                }
                if (!types.includes('dynamic'))
                    continue;
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
        if (items.length === 0 && videoFetchFailed && this.lastError !== '') {
            throw new Error(this.lastError);
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
     *   2) canHandle 认得的（链接 / id 这类强特征）
     *   3) 都不认得时（例如中文名字）：**逐个尝试 resolve**，谁认得算谁的
     * 这样"订阅半佛仙人"也能落到 B 站，而不是报"没有可用的数据源"。
     */
    async resolveTarget(target, preferred) {
        const list = this.available();
        if (preferred !== undefined && preferred !== '') {
            const only = list.find(provider => provider.id === preferred);
            if (only === undefined)
                throw new Error('没有这个数据源：' + preferred);
            return { provider: only, resolved: await only.resolve(target) };
        }
        const strong = list.filter(provider => provider.canHandle(target));
        const candidates = strong.length > 0 ? strong : list;
        const errors = [];
        for (const provider of candidates) {
            try {
                const resolved = await provider.resolve(target);
                return { provider, resolved };
            }
            catch (error) {
                errors.push(provider.label + '：' + (error instanceof Error ? error.message : String(error)));
            }
        }
        if (list.length === 0)
            return undefined;
        throw new Error('没有数据源能识别「' + target + '」' + (errors.length > 0 ? '（' + errors.join('；') + '）' : ''));
    }
    /** 同步挑选（只按强特征，给不需要解析的场景用） */
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
