function clockOf(seconds) {
    const total = Math.max(0, Math.round(seconds));
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}
/** 把若干条更新拼成一条群消息 */
export function formatPush(items) {
    const first = items[0];
    const label = first === undefined ? '' : first.providerLabel;
    const lines = ['【' + label + '更新】'];
    for (const item of items) {
        const meta = item.extra !== undefined && item.extra !== '' ? '（' + item.extra + '）' : '';
        const icon = item.kind === 'video' ? '🎬' : '📝';
        lines.push(icon + ' ' + item.subName + '：' + item.title + meta);
        if (item.url !== '')
            lines.push('   ' + item.url);
    }
    return lines.join('\n');
}
export class BiliPusher {
    options;
    constructor(options) {
        this.options = options;
    }
    service() {
        try {
            const get = this.options.ctx.get;
            const svc = get?.('dshBili');
            if (svc === undefined || svc === null || typeof svc.pending !== 'function')
                return undefined;
            return svc;
        }
        catch {
            return undefined;
        }
    }
    /** 是否有可推送的内容（供 tick 判断，不发请求） */
    hasService() {
        return this.options.enabled && this.service() !== undefined;
    }
    /**
     * 取某个会话的待推送内容（不发消息，交给调用方决定怎么发）。
     * @param chatKey 例如 group:660610917
     */
    take(chatKey) {
        if (!this.options.enabled)
            return undefined;
        const svc = this.service();
        const pending = svc?.pending;
        if (pending === undefined)
            return undefined;
        const consumer = 'napcat:' + chatKey;
        try {
            const items = pending(consumer, this.options.maxPerPush, chatKey);
            if (items.length === 0)
                return undefined;
            return { items, consumer };
        }
        catch (error) {
            this.options.log('debug', '读取 B 站待推送失败: ' + (error instanceof Error ? error.message : String(error)));
            return undefined;
        }
    }
    /** 发送成功后标记已投递 */
    async ack(consumer, items) {
        const svc = this.service();
        const ack = svc?.ack;
        if (ack === undefined || items.length === 0)
            return;
        try {
            await ack(items.map(item => item.id), consumer);
        }
        catch (error) {
            this.options.log('debug', 'B 站推送 ack 失败: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    inQuietHours(minuteOfDay) {
        for (const [start, end] of this.options.quietRanges) {
            if (start < end) {
                if (minuteOfDay >= start && minuteOfDay < end)
                    return true;
            }
            else if (minuteOfDay >= start || minuteOfDay < end) {
                return true;
            }
        }
        return false;
    }
}
export { clockOf };
