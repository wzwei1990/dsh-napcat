/**
 * B 站链接 → "看过了"的上下文块。
 *
 * 目标（2026-11-04 与用户确认）：群友发链接时，机器人要能**接话/评价**，
 * 而不是回一张卡片或者复述简介。所以注入只给三类事实：
 *   ① 视频是谁发的、多长、多热
 *   ② 弹幕说明的"高光时段"（哪里被刷屏）
 *   ③ 被反复刷的弹幕（梗）
 * 然后明确要求：像看过一样随口聊，不要播报、不要贴链接。
 */
import type { Context } from '@deepseek-ai/cordis'

/** dshBili 暴露的服务（只依赖这一小部分） */
export interface BiliService {
  danmaku?: (input: string, options?: { cid?: number }) => Promise<{
    info: {
      title: string
      up: string
      durationSec: number
      pageUrl: string
      stats?: { view?: number }
    }
    summary: { total: number; density: number; peaks: Array<{ startSec: number; endSec: number; count: number; samples: string[] }>; samples: string[] }
  }>
  subtitle?: (input: string, options?: { maxChars?: number }) => Promise<{ text: string; bvid?: string }>
  /** 分镜图（返回绝对路径与时间轴） */
  storyboard?: (input: string) => Promise<{
    imagePath: string
    title: string
    durationSec: number
    timeline: Array<{ index: number; atSec: number; label: string }>
  }>
}

export interface BiliBlockOptions {
  ctx: Context
  enabled: boolean
  log: (level: 'debug' | 'info' | 'warn', message: string) => void
}

/** 从一段文本里抽第一个 B 站链接（BV / av / b23.tv / 带参数的完整 URL） */
export function extractBiliLink(text: string): string | undefined {
  const full = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/[A-Za-z0-9?=&%._-]+/i.exec(text)
  if (full !== null) return full[0]
  const short = /https?:\/\/b23\.tv\/[A-Za-z0-9]+/i.exec(text)
  if (short !== null) return short[0]
  const bv = /BV[0-9A-Za-z]{10}/.exec(text)
  if (bv !== null) return 'https://www.bilibili.com/video/' + bv[0]
  const av = /(?:^|[^0-9])av(\d{1,12})/i.exec(text)
  if (av !== null) return 'https://www.bilibili.com/video/av' + (av[1] ?? '')
  return undefined
}

function clockOf(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}

function viewsText(view: number | undefined): string {
  if (view === undefined || !Number.isFinite(view)) return ''
  if (view >= 1e8) return (view / 1e8).toFixed(1) + ' 亿播放'
  if (view >= 1e4) return (view / 1e4).toFixed(1) + ' 万播放'
  return String(view) + ' 播放'
}

export interface BiliData {
  info: { title: string; up: string; durationSec: number; pageUrl: string; stats?: { view?: number } }
  summary: { total: number; density: number; peaks: Array<{ startSec: number; endSec: number; count: number; samples: string[] }>; samples: string[] }
  subtitleText?: string
  /** 分镜图路径（给模型"看画面"，也方便通道直接发图） */
  storyboardPath?: string
  storyboardTimeline?: Array<{ index: number; label: string }>
}

/** 注入块：像看过一样聊天，而不是播报 */
export function buildBiliBlock(data: BiliData): string {
  const lines: string[] = []
  const meta = [data.info.up, clockOf(data.info.durationSec), viewsText(data.info.stats?.view)].filter(part => part !== '')
  lines.push('【群友发了个 B 站视频（你刚看过）】')
  lines.push('标题：' + data.info.title + (meta.length > 0 ? '（' + meta.join(' · ') + '）' : ''))
  if (data.summary.total > 0) {
    lines.push('弹幕 ' + String(data.summary.total) + ' 条，平均每秒 ' + String(data.summary.density) + ' 条')
    if (data.summary.peaks.length > 0) {
      const peaks = data.summary.peaks
        .slice(0, 3)
        .map(peak => clockOf(peak.startSec) + '–' + clockOf(peak.endSec) + '（' + String(peak.count) + ' 条）' + (peak.samples.length > 0 ? '：' + peak.samples.slice(0, 3).join(' / ') : ''))
      lines.push('弹幕最密集：' + peaks.join('；'))
    }
    if (data.summary.samples.length > 0) lines.push('被反复刷的弹幕：' + data.summary.samples.slice(0, 8).join(' / '))
  }
  if (data.subtitleText !== undefined && data.subtitleText.trim() !== '') {
    lines.push('字幕节选：' + data.subtitleText.trim().slice(0, 400))
  }
  if (data.storyboardPath !== undefined) {
    const labels = (data.storyboardTimeline ?? []).map(item => '#' + String(item.index) + ' ' + item.label).join('  ')
    lines.push('画面分镜：[图片: ' + data.storyboardPath + ']（' + (labels === '' ? '9 格' : labels) + '）')
  }
  lines.push('[硬要求] 你这一条必须提到视频里的具体信息（标题里的东西 / 画面内容 / 某个弹幕梗），')
  lines.push('         不许只评论他发了张卡片或发了个链接这种空话——那等于没看。')
  lines.push('[怎么用] 像真的看过一样随口接话：可以评价、吐槽、接梗、追问，1~2 句就够；')
  lines.push('         不要说什么"弹幕里提到/字幕里写着"这种话，也不要贴链接、不要列点；')
  lines.push('         只有对方真的在问视频内容时，才认真讲它讲了什么。')
  return lines.join('\n')
}

export interface BiliContextOptions {
  ctx: Context
  enabled: boolean
  /** 字幕最多取多少字（有字幕时补充） */
  subtitleChars: number
  /** 是否抽分镜（需要 dsh-bili 的 storyboard 能力 + ffmpeg） */
  storyboard: boolean
  log: (level: 'debug' | 'info' | 'warn', message: string) => void
}

export class BiliLink {
  private readonly options: BiliContextOptions
  private lastWarnAt = 0

  constructor(options: BiliContextOptions) {
    this.options = options
  }

  private service(): BiliService | undefined {
    try {
      const get = this.options.ctx.get as ((name: string) => unknown) | undefined
      const svc = get?.('dshBili') as BiliService | undefined
      if (svc === undefined || svc === null || typeof svc.danmaku !== 'function') return undefined
      return svc
    } catch {
      return undefined
    }
  }

  /** 消息里有 B 站链接就返回注入块；失败/无服务静默返回 undefined */
  async blockFor(text: string): Promise<string | undefined> {
    if (!this.options.enabled) return undefined
    const link = extractBiliLink(text)
    if (link === undefined) return undefined
    const svc = this.service()
    const danmaku = svc?.danmaku
    if (danmaku === undefined) return undefined
    try {
      const { info, summary } = await danmaku(link)
      let subtitleText: string | undefined
      let storyboardPath: string | undefined
      let storyboardTimeline: Array<{ index: number; label: string }> | undefined
      if (this.options.storyboard && typeof svc?.storyboard === 'function') {
        try {
          const shot = await svc.storyboard(link)
          storyboardPath = shot.imagePath
          storyboardTimeline = shot.timeline.map(item => ({ index: item.index, label: item.label }))
        } catch (error) {
          this.options.log('debug', '分镜生成失败（继续用弹幕/字幕）: ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      // 字幕是可选的：没有 SESSDATA 时大概率拿不到，失败就当没有
      if (this.options.subtitleChars > 0 && typeof svc?.subtitle === 'function') {
        try {
          const subtitle = await svc.subtitle(link, { maxChars: this.options.subtitleChars })
          if (subtitle.text.trim() !== '') subtitleText = subtitle.text
        } catch {
          // 忽略：无字幕很常见
        }
      }
      this.options.log('info', 'B 站视频已解析：' + info.title + '（弹幕 ' + String(summary.total) + ' 条）')
      return buildBiliBlock({ info, summary, subtitleText, storyboardPath, storyboardTimeline })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 失败默认静默（不该在群里喊），但要能在日志里看到：同一小时只报一次
      const now = Date.now()
      if (now - this.lastWarnAt > 60 * 60_000) {
        this.lastWarnAt = now
        this.options.log('warn', 'B 站解析失败（本条消息不带视频上下文）: ' + message)
      } else {
        this.options.log('debug', 'B 站解析失败: ' + message)
      }
      return undefined
    }
  }
}
