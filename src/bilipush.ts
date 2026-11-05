/**
 * B 站 UP 更新 → QQ 群推送（dsh-napcat 侧，2026-11-05）。
 *
 * 解耦设计：napcat 只是 outbox 的一个消费方，自己定时来取；
 *   - dsh-bili 没装 → 静默跳过（ctx.get('dshBili') 拿不到服务）
 *   - 取到后发消息，再 ack(id, 'napcat:<chatKey>')，避免重复推
 *   - 推送只发到订阅里指定的群（outbox 条目自带 groups）
 */
import type { Context } from '@deepseek-ai/cordis'

/** 队列条目（来自 subscriptions.ts 的 QueueItem，这里只取用得到的字段） */
export interface BiliOutboxItem {
  id: string
  kind: 'video' | 'dynamic'
  title: string
  url: string
  pubdate: number
  groups: string[]
  subName: string
  providerLabel: string
  extra?: string
}

/** dsh-bili 暴露的订阅服务（只依赖这一小部分） */
export interface BiliSubService {
  pending?: (consumer?: string, limit?: number, target?: string) => BiliOutboxItem[]
  ack?: (ids: string[], consumer: string) => Promise<void>
}

export interface BiliPushOptions {
  ctx: Context
  enabled: boolean
  /** 单次最多推几条 */
  maxPerPush: number
  /** 免打扰时段（"00:00-08:00"），复用 napcat 的解析 */
  quietRanges: ReadonlyArray<[number, number]>
  log: (level: 'debug' | 'info' | 'warn', message: string) => void
}

function clockOf(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}

/** 把若干条更新拼成一条群消息 */
export function formatPush(items: readonly BiliOutboxItem[]): string {
  const first = items[0]
  const label = first === undefined ? '' : first.providerLabel
  const lines: string[] = ['【' + label + '更新】']
  for (const item of items) {
    const meta = item.extra !== undefined && item.extra !== '' ? '（' + item.extra + '）' : ''
    const icon = item.kind === 'video' ? '🎬' : '📝'
    lines.push(icon + ' ' + item.subName + '：' + item.title + meta)
    if (item.url !== '') lines.push('   ' + item.url)
  }
  return lines.join('\n')
}

export class BiliPusher {
  private readonly options: BiliPushOptions

  constructor(options: BiliPushOptions) {
    this.options = options
  }

  private service(): BiliSubService | undefined {
    try {
      const get = this.options.ctx.get as ((name: string) => unknown) | undefined
      const svc = get?.('dshBili') as BiliSubService | undefined
      if (svc === undefined || svc === null || typeof svc.pending !== 'function') return undefined
      return svc
    } catch {
      return undefined
    }
  }

  /** 是否有可推送的内容（供 tick 判断，不发请求） */
  hasService(): boolean {
    return this.options.enabled && this.service() !== undefined
  }

  /**
   * 取某个会话的待推送内容（不发消息，交给调用方决定怎么发）。
   * @param chatKey 例如 group:660610917
   */
  take(chatKey: string): { items: BiliOutboxItem[]; consumer: string } | undefined {
    if (!this.options.enabled) return undefined
    const svc = this.service()
    const pending = svc?.pending
    if (pending === undefined) return undefined
    const consumer = 'napcat:' + chatKey
    try {
      const items = pending(consumer, this.options.maxPerPush, chatKey)
      if (items.length === 0) return undefined
      return { items, consumer }
    } catch (error) {
      this.options.log('debug', '读取 B 站待推送失败: ' + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }

  /** 发送成功后标记已投递 */
  async ack(consumer: string, items: readonly BiliOutboxItem[]): Promise<void> {
    const svc = this.service()
    const ack = svc?.ack
    if (ack === undefined || items.length === 0) return
    try {
      await ack(items.map(item => item.id), consumer)
    } catch (error) {
      this.options.log('debug', 'B 站推送 ack 失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  inQuietHours(minuteOfDay: number): boolean {
    for (const [start, end] of this.options.quietRanges) {
      if (start < end) {
        if (minuteOfDay >= start && minuteOfDay < end) return true
      } else if (minuteOfDay >= start || minuteOfDay < end) {
        return true
      }
    }
    return false
  }
}

export { clockOf }
