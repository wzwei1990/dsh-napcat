/**
 * 订阅（平台无关）：订阅表 + 轮询 + 投递队列，2026-11-05。
 *
 * 设计（与用户确认的 A 方案）：
 *   - 订阅属于"有收件人的插件"（渠道），所以由 dsh-napcat 拥有；
 *   - 数据来源是**可插拔 provider**（现在只有 B 站，将来可加抖音/微博…），
 *     订阅记录带 provider 字段，删掉某个 provider 不影响其他；
 *   - 没有可用 provider 时，工具报"没有可用的数据源"，不点名某个插件。
 */
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type FeedType = 'video' | 'dynamic'

export interface FeedItem {
  /** 平台内唯一 id（bvid / 动态 id …） */
  id: string
  kind: FeedType
  title: string
  url: string
  pubdate: number
  extra?: string
}

/** 一个数据源（B 站、抖音…）要实现的东西 */
export interface FeedProvider {
  /** 稳定标识，写进订阅记录，比如 bili */
  id: string
  /** 展示名（日志/提示用） */
  label: string
  /** 这个输入是不是本平台能处理的（链接、mid、名字…） */
  canHandle(target: string): boolean
  /** 输入 → 稳定 key + 展示名（例如 mid + UP 名） */
  resolve(target: string): Promise<{ key: string; name: string; latestPubdate?: number }>
  /** 拉最近内容（按发布时间倒序） */
  latest(key: string, types: readonly FeedType[]): Promise<FeedItem[]>
}

export interface Subscription {
  id: string
  /** provider id（bili / douyin …） */
  provider: string
  /** provider 内部的稳定 key（B 站是 mid） */
  key: string
  name: string
  types: FeedType[]
  /** 推送目标（群），空数组 = 只进队列不主动推送 */
  groups: string[]
  lastSeenPubdate: number
  recentIds: string[]
  failures: number
  nextCheckAt: number
  enabled: boolean
  createdAt: number
}

export interface QueueItem extends FeedItem {
  provider: string
  providerLabel: string
  subKey: string
  subName: string
  groups: string[]
  addedAt: number
  deliveredTo: string[]
}

export interface SubscriptionStoreOptions {
  /** 数据目录，缺省 ~/.dsh/dsh-napcat/subscriptions */
  dir?: string
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void
}

function defaultDir(): string {
  const dshHome = process.env.DSH_HOME
  const base = dshHome !== undefined && dshHome !== '' ? dshHome : join(homedir(), '.dsh')
  return join(base, 'dsh-napcat', 'subscriptions')
}

export class SubscriptionStore {
  private readonly options: SubscriptionStoreOptions
  private readonly subsFile: string
  private readonly queueFile: string
  private loaded = false
  private subs: Subscription[] = []
  private queue: QueueItem[] = []

  constructor(options: SubscriptionStoreOptions = {}) {
    this.options = options
    const dir = options.dir ?? defaultDir()
    this.subsFile = join(dir, 'subscriptions.json')
    this.queueFile = join(dir, 'queue.jsonl')
  }

  private log(level: 'debug' | 'info' | 'warn', message: string): void {
    this.options.log?.(level, message)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.subsFile, 'utf8')
      const parsed = JSON.parse(raw) as { subscriptions?: Subscription[] }
      this.subs = Array.isArray(parsed.subscriptions) ? parsed.subscriptions.filter(Boolean) : []
    } catch {
      this.subs = []
    }
    try {
      const raw = await readFile(this.queueFile, 'utf8')
      this.queue = raw.split('\n').filter(line => line.trim() !== '').flatMap(line => {
        try {
          return [JSON.parse(line) as QueueItem]
        } catch {
          return []
        }
      })
    } catch {
      this.queue = []
    }
    this.log('debug', '订阅表：' + String(this.subs.length) + ' 个，队列 ' + String(this.queue.length) + ' 条')
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.subsFile), { recursive: true })
    const tmp = this.subsFile + '.tmp'
    await writeFile(tmp, JSON.stringify({ subscriptions: this.subs }, null, 2), 'utf8')
    await rename(tmp, this.subsFile)
  }

  list(): Subscription[] {
    return this.subs.map(item => ({ ...item, groups: [...item.groups], types: [...item.types], recentIds: [...item.recentIds] }))
  }

  find(id: string): Subscription | undefined {
    return this.subs.find(item => item.id === id)
  }

  findByKey(provider: string, key: string): Subscription | undefined {
    return this.subs.find(item => item.provider === provider && item.key === key)
  }

  async upsert(input: {
    provider: string
    key: string
    name: string
    types?: FeedType[]
    groups?: string[]
    lastSeenPubdate?: number
    now?: number
  }): Promise<{ subscription: Subscription; created: boolean }> {
    const now = input.now ?? Date.now()
    const existing = this.findByKey(input.provider, input.key)
    if (existing !== undefined) {
      for (const type of input.types ?? []) if (!existing.types.includes(type)) existing.types.push(type)
      for (const group of input.groups ?? []) if (!existing.groups.includes(group)) existing.groups.push(group)
      if (input.lastSeenPubdate !== undefined) existing.lastSeenPubdate = Math.max(existing.lastSeenPubdate, input.lastSeenPubdate)
      existing.enabled = true
      existing.failures = 0
      existing.nextCheckAt = now
      await this.save()
      return { subscription: { ...existing }, created: false }
    }
    const subscription: Subscription = {
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
    }
    this.subs.push(subscription)
    await this.save()
    return { subscription: { ...subscription }, created: true }
  }

  async remove(identifier: { id?: string; provider?: string; key?: string; group?: string }): Promise<number> {
    if (identifier.group !== undefined && identifier.id !== undefined) {
      const target = this.find(identifier.id)
      if (target !== undefined) {
        target.groups = target.groups.filter(group => group !== identifier.group)
        await this.save()
        return 1
      }
    }
    const before = this.subs.length
    this.subs = this.subs.filter(item => {
      if (identifier.id !== undefined && item.id === identifier.id) return false
      if (identifier.provider !== undefined && identifier.key !== undefined && item.provider === identifier.provider && item.key === identifier.key) return false
      return true
    })
    const removed = before - this.subs.length
    if (removed > 0) await this.save()
    return removed
  }

  async update(subscription: Subscription): Promise<void> {
    const index = this.subs.findIndex(item => item.id === subscription.id)
    if (index < 0) return
    this.subs[index] = subscription
    await this.save()
  }

  due(now = Date.now(), limit = 1): Subscription[] {
    return this.subs
      .filter(item => item.enabled && item.nextCheckAt <= now)
      .sort((a, b) => a.nextCheckAt - b.nextCheckAt)
      .slice(0, limit)
  }

  pending(consumer?: string, limit = 50, target?: string): QueueItem[] {
    let items = consumer === undefined ? this.queue : this.queue.filter(item => !item.deliveredTo.includes(consumer))
    if (target !== undefined) items = items.filter(item => item.groups.includes(target))
    return items.slice(-limit)
  }

  async ack(ids: readonly string[], consumer: string, keep = 200): Promise<void> {
    const set = new Set(ids)
    let changed = false
    for (const item of this.queue) {
      if (!set.has(item.id)) continue
      if (!item.deliveredTo.includes(consumer)) {
        item.deliveredTo.push(consumer)
        changed = true
      }
    }
    if (this.queue.length > keep) {
      this.queue = this.queue.slice(this.queue.length - keep)
      changed = true
    }
    if (changed) {
      await mkdir(dirname(this.queueFile), { recursive: true })
      const body = this.queue.map(item => JSON.stringify(item)).join('\n') + (this.queue.length > 0 ? '\n' : '')
      await writeFile(this.queueFile, body, 'utf8')
    }
  }

  async push(items: readonly Omit<QueueItem, 'addedAt' | 'deliveredTo'>[]): Promise<number> {
    if (items.length === 0) return 0
    await mkdir(dirname(this.queueFile), { recursive: true })
    const known = new Set(this.queue.map(item => item.id))
    const fresh: QueueItem[] = []
    for (const item of items) {
      if (known.has(item.id)) {
        const existing = this.queue.find(entry => entry.id === item.id)
        if (existing !== undefined) for (const group of item.groups) if (!existing.groups.includes(group)) existing.groups.push(group)
        continue
      }
      known.add(item.id)
      fresh.push({ ...item, addedAt: Date.now(), deliveredTo: [] })
    }
    if (fresh.length === 0) return 0
    this.queue.push(...fresh)
    await appendFile(this.queueFile, fresh.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8')
    return fresh.length
  }
}

export interface PollOptions {
  store: SubscriptionStore
  provider: FeedProvider
  intervalMinutes: number
  backoffMinutes?: number[]
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void
}

export interface PollResult {
  subscription: Subscription
  added: number
  error?: string
}

/** 检查一个订阅：拉最新 → 与基线比较 → 写队列 */
export async function pollSubscription(subscription: Subscription, options: PollOptions): Promise<PollResult> {
  const now = Date.now()
  const current: Subscription = { ...subscription, groups: [...subscription.groups], types: [...subscription.types], recentIds: [...subscription.recentIds] }
  try {
    const items = await options.provider.latest(current.key, current.types)
    const fresh: Array<Omit<QueueItem, 'addedAt' | 'deliveredTo'>> = []
    let newest = current.lastSeenPubdate
    // 首次运行（还没基线、也没历史 id）：只记基线，不把过去的投稿当新内容
    if (current.lastSeenPubdate === 0 && current.recentIds.length === 0) {
      const baseline = items.reduce((max, item) => Math.max(max, item.pubdate), 0)
      current.lastSeenPubdate = baseline
      current.failures = 0
      current.nextCheckAt = now + options.intervalMinutes * 60_000
      await options.store.update(current)
      options.log?.('info', '订阅基线已建立 ' + current.name + '（' + String(items.length) + ' 条历史内容不推送）')
      return { subscription: current, added: 0 }
    }
    for (const item of items) {
      if (item.pubdate > newest) newest = item.pubdate
      if (item.pubdate <= current.lastSeenPubdate) continue
      if (current.recentIds.includes(item.id)) continue
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
      })
    }
    const added = await options.store.push(fresh)
    current.lastSeenPubdate = newest
    current.recentIds = [...fresh.map(item => item.id.split(':').slice(1).join(':')), ...current.recentIds].slice(0, 40)
    current.failures = 0
    current.nextCheckAt = now + options.intervalMinutes * 60_000
    await options.store.update(current)
    if (added > 0) options.log?.('info', '订阅更新 ' + current.name + '：' + String(added) + ' 条')
    return { subscription: current, added }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const backoff = options.backoffMinutes ?? [5, 15, 60]
    const failures = current.failures + 1
    const wait = backoff[Math.min(backoff.length - 1, failures - 1)] ?? 60
    current.failures = failures
    current.nextCheckAt = now + wait * 60_000
    await options.store.update(current)
    options.log?.('warn', '订阅检查失败 ' + current.name + '（' + String(failures) + ' 次，' + String(wait) + ' 分钟后重试）: ' + message)
    return { subscription: current, added: 0, error: message }
  }
}
