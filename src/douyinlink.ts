/**
 * 抖音链接 → 主动发言上下文（2026-11-26）。
 *
 * 与 bililink 同形态：不下载视频，只拿元数据（标题/作者/时长/点赞/简介）。
 * 数据来自 dshBili 的 douyinMeta（内部走 amagi 服务，本地签名、无头可用）。
 * 拿不到就静默跳过，不影响正常聊天。
 */
import type { Context } from '@deepseek-ai/cordis'

export interface DouyinMetaLike {
  title: string
  uploader?: string
  durationSec?: number
  description?: string
  url: string
  likes?: number
}

export interface DouyinStoryboardLike {
  imagePath: string
  timeline: Array<{ index: number; label: string }>
}

export interface DouyinAnalysisLike {
  meta: DouyinMetaLike
  storyboard?: DouyinStoryboardLike
  audioPath?: string
}

/** dshBili 暴露的服务（只依赖这一小部分） */
export interface DouyinServiceLike {
  douyinMeta?: (input: string) => Promise<DouyinMetaLike>
  douyinAnalyze?: (input: string) => Promise<DouyinAnalysisLike>
}

export interface DouyinLinkOptions {
  ctx: Context
  enabled: boolean
  log: (level: 'debug' | 'info' | 'warn', message: string) => void
}

/** 从一段文本里抽第一个抖音链接 */
export function extractDouyinLink(text: string): string | undefined {
  const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? []
  for (const match of matches) {
    const cleaned = match.replace(/[)，。！？、；：]+$/u, '')
    try {
      const host = new URL(cleaned).hostname
      if (host === 'douyin.com' || host.endsWith('.douyin.com') || host.endsWith('.iesdouyin.com')) return cleaned
    } catch {
      // 不是合法 URL，跳过
    }
  }
  return undefined
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}

function count(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return ''
  if (value >= 100_000_000) return (value / 100_000_000).toFixed(1).replace(/\.0$/, '') + '亿'
  if (value >= 10_000) return (value / 10_000).toFixed(1).replace(/\.0$/, '') + '万'
  return String(Math.round(value))
}

/** 注入给模型的上下文块（纯函数，方便单测） */
export function formatDouyinBlock(meta: DouyinMetaLike, storyboard?: DouyinStoryboardLike): string {
  const bits: string[] = []
  if (meta.uploader !== undefined && meta.uploader !== '') bits.push(meta.uploader)
  if (meta.durationSec !== undefined && meta.durationSec > 0) bits.push(clock(meta.durationSec))
  const likes = count(meta.likes)
  if (likes !== '') bits.push(likes + ' 赞')
  const intro = (meta.description ?? '').split('\n').slice(0, 2).join(' ').trim()
  const lines = [
    '【抖音视频】' + meta.title,
    bits.length > 0 ? bits.join(' · ') : '',
    intro === '' || intro === meta.title ? '' : '简介：' + intro.slice(0, 140),
    '链接：' + meta.url,
    storyboard === undefined
      ? '- 你已经在后台看过它的标题/简介；要聊具体画面或台词，可以调 douyin_parse 这个链接（会下载、抽音频、出 9 帧分镜），不要凭标题编。'
      : '画面分镜：[图片: ' + storyboard.imagePath + ']（' + storyboard.timeline.map(item => '#' + String(item.index) + ' ' + item.label).join('  ') + '）',
    storyboard === undefined
      ? ''
      : '- 分镜图已经给你了：能对着画面说具体内容；需要台词/声音再调 douyin_parse。',
  ]
  return lines.filter(line => line !== '').join('\n')
}

export class DouyinLink {
  private readonly options: DouyinLinkOptions
  /** 最近解析过的链接（按会话），让"没 @ 我"时也能接上刚才的视频 */
  private readonly recent = new Map<string, { title: string; url: string; link: string; at: number }>()
  private readonly cache = new Map<string, { meta: DouyinMetaLike; at: number }>()
  private readonly analysisCache = new Map<string, { analysis: DouyinAnalysisLike; at: number }>()

  constructor(options: DouyinLinkOptions) {
    this.options = options
  }

  private service(): DouyinServiceLike | undefined {
    try {
      const get = this.options.ctx.get as ((name: string) => unknown) | undefined
      const svc = get?.('dshBili') as DouyinServiceLike | undefined
      if (svc === undefined || svc === null || typeof svc.douyinMeta !== 'function') return undefined
      return svc
    } catch {
      return undefined
    }
  }

  private async meta(link: string): Promise<DouyinMetaLike | undefined> {
    const hit = this.cache.get(link)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < 10 * 60_000) return hit.meta
    const service = this.service()
    const fn = service?.douyinMeta
    if (fn === undefined) return undefined
    try {
      const meta = await fn(link)
      this.cache.set(link, { meta, at: now })
      return meta
    } catch (error) {
      this.options.log('debug', '抖音链接解析失败（静默）: ' + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }

  /** 抖音完整分析（带 15s 预算；失败退回元数据） */
  private async analyze(link: string): Promise<DouyinAnalysisLike | undefined> {
    const hit = this.analysisCache.get(link)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < 10 * 60_000) return hit.analysis
    const service = this.service()
    const fn = service?.douyinAnalyze
    if (fn === undefined) return undefined
    try {
      const analysis = await Promise.race([
        fn(link),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('抖音分析超时 15s')), 15_000)),
      ])
      this.analysisCache.set(link, { analysis, at: now })
      return analysis
    } catch (error) {
      this.options.log('debug', '抖音深度解析失败（退回元数据）: ' + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }

  /** 消息里有抖音链接就返回注入块（传 chatKey 时会记进"最近发过"） */
  async blockFor(text: string, chatKey?: string): Promise<string | undefined> {
    if (!this.options.enabled) return undefined
    const link = extractDouyinLink(text)
    if (link === undefined) return undefined
    const analysis = await this.analyze(link)
    const meta = analysis?.meta ?? await this.meta(link)
    if (meta === undefined) return undefined
    if (chatKey !== undefined) this.recent.set(chatKey, { title: meta.title, url: meta.url, link, at: Date.now() })
    this.cache.set(link, { meta, at: Date.now() })
    return formatDouyinBlock(meta, analysis?.storyboard)
  }

  /** 观察层：看到链接就后台解析一次（不阻塞回复） */
  async note(chatKey: string, text: string, meta?: DouyinMetaLike): Promise<void> {
    if (!this.options.enabled) return
    const link = extractDouyinLink(text)
    if (link === undefined) return
    const resolved = meta ?? await this.meta(link)
    if (resolved === undefined) return
    this.recent.set(chatKey, { title: resolved.title, url: resolved.url, link, at: Date.now() })
    this.options.log('info', '后台解析抖音链接：' + resolved.title.slice(0, 40))
  }

  /** 这个会话最近发过的抖音视频（10 分钟内） */
  recentOf(chatKey: string): { title: string; url: string; link: string } | undefined {
    const hit = this.recent.get(chatKey)
    if (hit === undefined || Date.now() - hit.at > 10 * 60_000) return undefined
    return { title: hit.title, url: hit.url, link: hit.link }
  }
}
