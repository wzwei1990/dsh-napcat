/**
 * 小黑盒（xiaoheihe）分享链接解析。
 *
 * 背景：群里常有人发 `https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?...&link_id=<id>&...`
 * 这种链接，模型拿到后只能 blind 抓页面（多数情况是 JS 壳或风控页）。这里直接用官方
 * 接口 `/v3/bbs/app/link/tree?link_id=` 取标题 + 摘要 + 正文首段，拼成一段可注入的文字，
 * 让模型不必自己去猜链接里有什么。
 *
 * 接口契约来源（社区整理）：
 *   https://github.com/AaronZ345/xiaoheihe-cli/blob/main/docs/api-contract.md
 *   - GET /bbs/app/link/tree : 完整正文；`link.text` 是文本块序列化 JSON，`description` 是摘要
 * 抽取顺序参考：
 *   https://github.com/butlanys/xiaoheihe-telegraph-bot（正文 → 原图 → 热评）
 *
 * 设计约定（与 bililink.ts 一致）：
 *   - 纯解析，不做网络重试策略；失败返回 null，由调用方决定要不要退回"裸链接"
 *   - 只读接口，任何字段缺失都不抛异常
 */

const SHARE_HOST = /(^|\.)xiaoheihe\.cn$|(^|\.)heybox\.(cn|com)$/i

/** 从任意文本里抽第一个小黑盒链接与 link_id。 */
export interface HeyboxRef {
  url: string
  linkId: string
}

export function extractHeyboxLink(text: string): HeyboxRef | null {
  if (text === '') return null
  const urls = text.match(/https?:\/\/[^\s<>"')]+/g) ?? []
  for (const raw of urls) {
    const url = raw.replace(/[.,;:!?]+$/, '')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (!SHARE_HOST.test(parsed.hostname)) continue
    const linkId = (parsed.searchParams.get('link_id') ?? parsed.searchParams.get('linkId') ?? '').trim()
    if (linkId === '') continue
    return { url, linkId }
  }
  return null
}

export interface HeyboxPost {
  linkId: string
  title: string
  /** 作者昵称，取不到就是空串 */
  author: string
  /** 摘要：优先 description，其次正文首段 */
  summary: string
  /** 正文前几段（已去掉图片块等噪声），最多 3 段 */
  paragraphs: string[]
}

/** 把 `link.text` 那种"文本块序列化 JSON"降级成纯文本。 */
function textBlocksToPlain(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 不是 JSON：当成已经可读的纯文本
    return raw
      .split(/\n{2,}/)
      .map(part => part.trim())
      .filter(part => part !== '')
  }
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      const value = node.trim()
      if (value !== '') out.push(value)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node === 'object') {
      const record = node as Record<string, unknown>
      // 常见块类型：{ type: 'text', text: '...' } / { type: 'img', ... }
      const type = typeof record['type'] === 'string' ? (record['type'] as string) : ''
      if (type === 'img' || type === 'image' || type === 'video') return
      if (typeof record['text'] === 'string') {
        const value = (record['text'] as string).trim()
        if (value !== '') out.push(value)
        return
      }
      if (Array.isArray(record['content'])) {
        walk(record['content'])
        return
      }
    }
  }
  walk(parsed)
  return out
}

function pickString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * 拉取一条小黑盒帖子。失败（风控 / 结构变更 / 超时）返回 null，不抛。
 * `fetchImpl` 仅用于单测注入。
 */
export async function fetchHeyboxPost(
  linkId: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HeyboxPost | null> {
  const id = linkId.trim()
  if (id === '') return null
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const endpoint =
      'https://api.xiaoheihe.cn/v3/bbs/app/link/tree?link_id=' + encodeURIComponent(id) +
      '&h_camp=link&h_src=YXBwX3NoYXJl'
    const response = await fetchImpl(endpoint, {
      signal: controller.signal,
      headers: {
        // 该接口对 UA 有要求，移动端 UA 最稳；不带 Referer 反而不易被风控
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        accept: 'application/json',
      },
    })
    if (!response.ok) return null
    const body = (await response.json()) as Record<string, unknown>
    if (body['status'] !== undefined && String(body['status']) !== 'ok' && String(body['status']) !== '0') {
      // 部分版本用 status: 'ok' / 0 表示成功；其它值一律当失败，避免把错误页当正文注入
      return null
    }
    const result = (body['result'] ?? {}) as Record<string, unknown>
    const link = (result['link'] ?? result) as Record<string, unknown>
    const title = pickString(link, ['title', 'share_title'])
    const description = pickString(link, ['description', 'summary'])
    const paragraphs = textBlocksToPlain(link['text']).slice(0, 3)
    const user = (link['user'] ?? result['user'] ?? {}) as Record<string, unknown>
    const author = pickString(user, ['username', 'nickname', 'name'])
    if (title === '' && description === '' && paragraphs.length === 0) return null
    const summary = description !== '' ? description : (paragraphs[0] ?? '')
    return { linkId: id, title, author, summary, paragraphs }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 渲染成可注入上下文的一段文字（不含任何指令性语句，只陈述事实）。 */
export function renderHeyboxBlock(post: HeyboxPost): string {
  const lines: string[] = ['[小黑盒帖子' + (post.author === '' ? '' : ' · ' + post.author) + ']']
  if (post.title !== '') lines.push('标题：' + post.title)
  if (post.summary !== '' && post.summary !== post.title) lines.push('摘要：' + post.summary)
  const body = post.paragraphs.filter(part => part !== post.summary && part !== post.title)
  if (body.length > 0) lines.push('正文：' + body.join(' / ').slice(0, 400))
  lines.push('（原链接：https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=' + post.linkId + '）')
  return lines.join('\n')
}
