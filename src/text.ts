/** 消息段 → 纯文本、@ 判定、长文分段。 */

import type { ObMessage, ObSegment } from './types.js'

const PLACEHOLDER: Record<string, string> = {
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  face: '[表情]',
  mface: '[表情]',
  reply: '',
  forward: '[合并转发]',
  json: '[卡片]',
  xml: '[卡片]',
  poke: '[戳一戳]',
  dice: '[骰子]',
  rps: '[猜拳]',
  music: '[音乐]',
  location: '[位置]',
  contact: '[名片]',
  markdown: '[卡片]',
  light_app: '[卡片]',
}

/** 解析 CQ 码字符串（NapCat 配成字符串上报时的兜底；数组更常见）。 */
export function parseCq(raw: string): ObSegment[] {
  const out: ObSegment[] = []
  const re = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g
  let last = 0
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    if (m.index > last) out.push({ type: 'text', data: { text: unescapeCq(raw.slice(last, m.index)) } })
    const data: Record<string, unknown> = {}
    const params = m[2] ?? ''
    for (const pair of params.split(',').slice(1)) {
      const eq = pair.indexOf('=')
      if (eq > 0) data[pair.slice(0, eq)] = unescapeCq(pair.slice(eq + 1))
    }
    out.push({ type: m[1] ?? 'text', data })
    last = m.index + m[0].length
  }
  if (last < raw.length) out.push({ type: 'text', data: { text: unescapeCq(raw.slice(last)) } })
  return out
}

function unescapeCq(value: string): string {
  return value
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&')
}

/** 归一化成消息段数组。 */
export function segmentsOf(message: ObMessage | undefined): ObSegment[] {
  if (message === undefined || message === null) return []
  if (Array.isArray(message)) return message
  return parseCq(String(message))
}

/** 从一段原始文本里挖出 http(s) 链接（卡片 JSON/XML 里链接常被转义成 \/ 或 &amp;）。 */
export function urlsInText(raw: string): string[] {
  if (raw === '') return []
  const out: string[] = []
  const seen = new Set<string>()
  const normalized = raw
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/g, '=')
  for (const match of normalized.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
    const url = match[0].replace(/[),.;]+$/, '')
    if (url.length < 12 || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/**
 * 从卡片/富媒体段里挖链接与标题。
 * QQ 群里分享 B 站视频多数不是纯文本，而是：
 *   - json 段（com.tencent.structmsg / 小程序卡片），链接在 meta.news.jumpUrl / meta.detail_1.qqdocurl
 *   - xml 段，链接在 url="..." / brief="..." / qqdocurl 里
 * 只把段转成「[卡片]」会把链接丢掉 → 下游的 B 站联动永远不会触发。
 */
export function linksInSegment(seg: ObSegment): string[] {
  const data = seg.data ?? {}
  const raw: string[] = []
  for (const key of ['data', 'content', 'url', 'file', 'summary', 'title', 'json_payload', 'payload', 'json', 'prompt']) {
    const value = (data as Record<string, unknown>)[key]
    if (typeof value === 'string' && value !== '') raw.push(value)
  }
  const urls = urlsInText(raw.join('\n'))
  // 卡片里常先出现跳转中转（qqurl），把 B 站直链排前面
  return urls.sort((a, b) => Number(isBiliLink(b)) - Number(isBiliLink(a)))
}

function isBiliLink(url: string): boolean {
  return /(?:bilibili\.com|b23\.tv)/i.test(url)
}

/** 卡片的标题/摘要（给模型一点上下文，别让链接裸奔） */
export function cardTitleOf(seg: ObSegment): string {
  const data = (seg.data ?? {}) as Record<string, unknown>
  // xml 卡片：标题在 <title> 里
  const rawXml = typeof data.data === 'string' ? data.data : ''
  if (rawXml.trim().startsWith('<')) {
    const matched = /<title>([^<]{1,80})<\/title>/i.exec(rawXml)
    if (matched !== null && matched[1] !== undefined) return matched[1].trim()
  }
  for (const key of ['title', 'summary', 'desc', 'content', 'data', 'json_payload', 'payload']) {
    const value = data[key]
    if (typeof value !== 'string') continue
    const json = value.trim().startsWith('{') ? safeJson(value) : undefined
    if (json !== undefined) {
      const meta = (json as { meta?: Record<string, { title?: string; desc?: string }> }).meta
      if (meta !== undefined) {
        for (const value of Object.values(meta)) {
          const title = value?.title ?? value?.desc
          if (typeof title === 'string' && title.trim() !== '') return title.trim().slice(0, 60)
        }
      }
      continue
    }
    if (key !== 'data' && value.trim() !== '' && !/^https?:/i.test(value)) return value.trim().slice(0, 60)
  }
  return ''
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 把消息段拼成给模型看的纯文本（图片/语音等转成占位符；卡片会带上里面的链接）。 */
export function toText(message: ObMessage | undefined, selfId = '', selfName = '你'): string {
  const parts: string[] = []
  for (const seg of segmentsOf(message)) {
    const data = seg.data ?? {}
    if (seg.type === 'text') {
      parts.push(String(data.text ?? ''))
      continue
    }
    if (seg.type === 'at') {
      const qq = String(data.qq ?? '')
      if (qq === 'all') parts.push('@全体成员')
      else if (selfId !== '' && qq === selfId) parts.push('@' + selfName)
      else parts.push('@' + String(data.name ?? qq))
      continue
    }
    if (seg.type === 'json' || seg.type === 'xml' || seg.type === 'markdown' || seg.type === 'light_app') {
      const holder = PLACEHOLDER[seg.type] ?? '[卡片]'
      const links = linksInSegment(seg)
      const title = cardTitleOf(seg)
      const suffix = [title, ...links].filter(part => part !== '').join(' ')
      parts.push(holder + (suffix === '' ? '' : ' ' + suffix))
      continue
    }
    const holder = PLACEHOLDER[seg.type]
    if (holder !== undefined) parts.push(holder)
    else if (seg.type !== 'text') parts.push('[' + seg.type + ']')
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').trim()
}

/** 是否 @ 了指定 QQ（群聊门控用）。 */
export function mentions(message: ObMessage | undefined, selfId: string): boolean {
  if (selfId === '') return false
  return segmentsOf(message).some(seg => seg.type === 'at' && String(seg.data?.qq ?? '') === selfId)
}

/** 是否引用了指定消息（回复机器人的消息也算"提及"，由调用方决定是否启用）。 */
export function repliesTo(message: ObMessage | undefined, messageId: string): boolean {
  if (messageId === '') return false
  return segmentsOf(message).some(seg => seg.type === 'reply' && String(seg.data?.id ?? '') === messageId)
}

/**
 * 长文分段：优先按空行切，其次按句号/换行，最后硬切。
 * 返回的每段都不超过 maxChars（maxChars <= 0 时原样返回一段）。
 */
export function splitText(text: string, maxChars: number): string[] {
  const trimmed = text.trim()
  if (trimmed === '' || maxChars <= 0 || trimmed.length <= maxChars) return trimmed === '' ? [] : [trimmed]

  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let cut = -1
    for (const sep of ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? ', ' ']) {
      const at = window.lastIndexOf(sep)
      if (at > maxChars * 0.4) {
        cut = at + sep.length
        break
      }
    }
    if (cut <= 0) cut = maxChars
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== '') chunks.push(rest)
  return chunks.filter(chunk => chunk !== '')
}
/** 在文本里找第一个命中的触发关键字（大小写不敏感，空词忽略）。 */
export function findKeyword(text: string, words: readonly string[]): string | undefined {
  if (words.length === 0) return undefined
  const lowered = text.toLowerCase()
  for (const word of words) {
    const needle = String(word ?? '').trim()
    if (needle === '') continue
    if (lowered.includes(needle.toLowerCase())) return needle
  }
  return undefined
}

/** 去掉命中的触发关键字（大小写不敏感，只去掉第一个）。 */
export function stripKeyword(text: string, keyword: string): string {
  const index = text.toLowerCase().indexOf(keyword.toLowerCase())
  if (index < 0) return text
  return (text.slice(0, index) + text.slice(index + keyword.length)).trim()
}
/** 消息是否引用了这批消息 id 中的任意一条。 */
export function repliesToAny(message: ObMessage | undefined, ids: readonly string[]): boolean {
  if (ids.length === 0) return false
  const wanted = new Set(ids)
  return segmentsOf(message).some(seg => seg.type === 'reply' && wanted.has(String(seg.data?.id ?? '')))
}
/** 稳定的短哈希（djb2 → base36），用于把 cwd 编进会话 id。 */
export function shortHash(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}
/**
 * 解析「群/人性格」配置：每行 `<group:群号|private:QQ>=<人设文本>`，
 * 支持 `#` 注释与空行。返回 key → 文本（key 形如 `group:123`）。
 */
export function parsePersonaOverrides(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const text = trimmed.slice(at + 1).trim()
    if (!/^(group|private)[:：].+/.test(key) || text === '') continue
    map.set(key.replace('：', ':'), text)
  }
  return map
}
/** 会话标题：`MM-DD HH:mm`（本地时间；内容容易乱，所以只标时间）。 */
export function titleFrom(text: string, now: Date = new Date()): string {
  void text
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = pad(now.getMonth() + 1) + '-' + pad(now.getDate())
  const time = pad(now.getHours()) + ':' + pad(now.getMinutes())
  return date + ' ' + time
}
/** 文件名模糊匹配打分（0 = 不匹配）。用户常只记得一部分名字。 */
export function scoreFileName(name: string, query: string): number {
  const norm = (s: string): string => s.toLowerCase().replace(/[\s_\-—–]+/g, '')
  const a = norm(name)
  const q = norm(query)
  if (q === '') return 0
  if (a === q) return 100
  const stem = a.replace(/\.[a-z0-9]{1,8}$/, '')
  const qStem = q.replace(/\.[a-z0-9]{1,8}$/, '')
  if (stem === qStem) return 90
  if (a.startsWith(q) || stem.startsWith(qStem)) return 80
  if (a.includes(q) || stem.includes(qStem)) return 60
  const tokens = query.toLowerCase().split(/[\s_\-—–]+/).filter(part => part !== '')
  if (tokens.length > 1 && tokens.every(part => a.includes(norm(part)))) return 40
  return 0
}

/** 按模糊打分排序候选（只返回 score>0）。 */
export function rankByFileName<T>(items: readonly T[], query: string, nameOf: (item: T) => string): Array<{ item: T; score: number }> {
  return items
    .map(item => ({ item, score: scoreFileName(nameOf(item), query) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score)
}