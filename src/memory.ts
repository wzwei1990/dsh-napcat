/** 群/私聊记忆：一群一目录隔离 + 最近消息缓冲；长期记忆走 mnemon（失败则落本地 notes.md）。 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { LogLevel } from './onebot.js'

export interface MemoryOptions {
  ctx: unknown
  /** 记忆根目录（通常是 <workspacePath>/memory） */
  root: string
  /** mnemon 空间名前缀 */
  spacePrefix: string
  /** 长期记忆后端：mnemon（交给模型写）或 file（纯本地） */
  backend: 'mnemon' | 'file'
  /** 自动记忆：模型自己判断写入（关闭则只响应显式「记住」） */
  autoCapture?: boolean
  /** 配置里手填的空间 id（group:<号>=<id> 多行） */
  spaces?: string
  /** recent.jsonl 保留条数 */
  recentLimit: number
  /** 注入最近多少条对话 */
  injectRecent: number
  /** 注入总字符上限 */
  injectMaxChars: number
  log: (level: LogLevel, message: string) => void
}

export interface ChatLike {
  agent?: unknown
}

const RECENT_FILE = 'recent.jsonl'
const SPACE_FILE = 'space.json'
const NOTES_FILE = 'notes.md'

/** 从任意返回值里捞出文本（工具结果结构可能变，尽量宽松）。 */
function collectText(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => collectText(item, depth + 1)).filter(part => part !== '').join('\n')
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'content', 'value', 'result']) {
      if (record[key] !== undefined) {
        const text = collectText(record[key], depth + 1)
        if (text !== '') return text
      }
    }
  }
  return ''
}

/** 从工具返回值里递归找 memoryBodyId / id（先试 JSON，再退回正则）。 */
function findId(raw: string): string | undefined {
  const walk = (value: unknown, depth = 0): string | undefined => {
    if (depth > 6 || value === null || value === undefined) return undefined
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of ['memoryBodyId', 'memoryBody', 'id']) {
        const candidate = record[key]
        if (typeof candidate === 'string' && candidate !== '') return candidate
      }
      for (const nested of Object.values(record)) {
        const found = walk(nested, depth + 1)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  try {
    const found = walk(JSON.parse(raw))
    if (found !== undefined) return found
  } catch {
    // 不是 JSON，退回正则
  }
  const match = /"memoryBodyId"\s*:\s*"([^"]+)"/.exec(raw) ?? /"id"\s*:\s*"([^"]+)"/.exec(raw)
  return match?.[1]
}

/** 从空间目录文本里按名字找 id（JSON 优先，失败退回正则）。 */
function findIdByName(raw: string, name: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { items?: Array<{ id?: string; name?: string }> }
    const found = parsed.items?.find(item => item.name === name)
    if (found?.id !== undefined && found.id !== '') return found.id
  } catch {
    // 不是 JSON
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp('"id"\\s*:\\s*"([^"]+)"\\s*,\\s*"name"\\s*:\\s*"' + escaped + '"').exec(raw)
  return match?.[1]
}

/** 解析 group:<群号>=<id> 多行配置。 */
export function parseSpaceMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(group|private):(\d+)\s*=\s*(\S+)\s*$/.exec(line)
    if (match !== null) map[match[1] + ':' + match[2]] = match[3] as string
  }
  return map
}

export class MemoryStore {
  constructor(private readonly opts: MemoryOptions) {}

  /** 每个聊天一个目录：memory/group-<号> / memory/private-<QQ> */
  private dirFor(chatKey: string): string {
    return join(this.opts.root, chatKey.replace(':', '-'))
  }

  private async ensureDir(chatKey: string): Promise<string> {
    const dir = this.dirFor(chatKey)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** 用注册表直接调工具（插件掌握时机，不依赖模型）。 */
  private async callTool(name: string, args: Record<string, unknown>, agent: unknown): Promise<string> {
    const registry = (this.opts.ctx as { tools?: { execute?(input: unknown): Promise<unknown> } } | undefined)?.tools
    if (registry?.execute === undefined) throw new Error('宿主没有 tools.execute')
    const result = await registry.execute({
      callId: 'napcat-mem-' + Date.now().toString(36),
      name,
      arguments: args,
      agent,
      // 宿主 prepareExecution 会读 exec.signal.aborted，不传就抛 TypeError
      signal: new AbortController().signal,
    })
    return collectText(result)
  }

  /** 把工具原始返回写进 _debug.log（排查解析问题用）。 */
  private dumpRaw(label: string, raw: string): void {
    void mkdir(this.opts.root, { recursive: true })
      .then(() => appendFile(join(this.opts.root, '_debug.log'), new Date().toISOString() + ' [' + label + '] ' + raw.slice(0, 800).replace(/\s+/g, ' ') + '\n', 'utf8'))
      .catch(() => undefined)
  }

  /** 记忆相关失败：warn 到控制台 + 追加到 memory/_debug.log，便于事后定位。 */
  private reportFailure(what: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error)
    this.opts.log('warn', what + ': ' + reason)
    void mkdir(this.opts.root, { recursive: true })
      .then(() => appendFile(join(this.opts.root, '_debug.log'), new Date().toISOString() + ' ' + what + ': ' + reason + '\n', 'utf8'))
      .catch(() => undefined)
  }

  /** 拿到（或创建）本聊天的 mnemon 空间 id；失败返回 undefined（自动退化为文件记忆）。 */
  async ensureSpace(chatKey: string, agent: unknown): Promise<string | undefined> {
    if (this.opts.backend === 'file') return undefined
    // mnemon 的记忆操作要求"本轮 turn 的 View"，插件在轮次外调用会被拒 →
    // 空间 id 必须由用户在配置里给出（memorySpaces），插件不再自己创建/查询。
    const configured = parseSpaceMap(this.opts.spaces ?? '')[chatKey]
    if (configured !== undefined && configured !== '') return configured
    try {
      const cached = JSON.parse(await readFile(join(this.dirFor(chatKey), SPACE_FILE), 'utf8')) as { id?: string }
      if (typeof cached.id === 'string' && cached.id !== '') return cached.id
    } catch {
      // 无缓存
    }
    return undefined
    try {
      const dir = await this.ensureDir(chatKey)
      return undefined
    } catch (error) {
      this.reportFailure('记忆空间不可用，退化为本地笔记', error)
      return undefined
    }
  }

  /** 埋点：把 agent 的会话事件尾部写进 _debug.log，用于排查 mnemon 的 turn/View 绑定。 */
  async dumpTurnState(chatKey: string, agent: unknown): Promise<void> {
    try {
      const session = (agent as { session?: { id?: unknown; snapshotEvents?(): Array<{ type?: string; data?: { turn?: number } }> } } | undefined)?.session
      const events = session?.snapshotEvents?.() ?? []
      const tail = events.slice(-8).map(event => event.type + (typeof event.data?.turn === 'number' ? '(' + event.data.turn + ')' : ''))
      let open: number | undefined
      for (const event of events) {
        if (event.type === 'turn/start' && typeof event.data?.turn === 'number') open = event.data.turn
        else if (event.type === 'turn/end' && event.data?.turn === open) open = undefined
      }
      this.dumpRaw('turn-state', 'session=' + String(session?.id) + ' openTurn=' + String(open) + ' tail=' + tail.join(' | '))
    } catch (error) {
      this.dumpRaw('turn-state 失败', error instanceof Error ? error.message : String(error))
    }
  }

  /** 登记空间 id（供 napcat_memory_space 工具调用）。 */
  async saveSpace(chatKey: string, spaceId: string): Promise<void> {
    const dir = await this.ensureDir(chatKey)
    await writeFile(join(dir, SPACE_FILE), JSON.stringify({ id: spaceId }, null, 2), 'utf8')
  }

  /** 写一条长期记忆：优先 mnemon，失败落 notes.md。 */
  async remember(chatKey: string, content: string, agent: unknown, tags: readonly string[] = []): Promise<string> {
    const text = content.trim()
    if (text === '') throw new Error('记忆内容为空')
    const id = await this.ensureSpace(chatKey, agent)
    if (id !== undefined) {
      try {
        await this.callTool('mnemon_remember', {
          content: text,
          category: 'fact',
          importance: 3,
          memoryBodyId: id,
          tags: ['napcat', ...tags],
          source: 'user',
        }, agent)
        return '已写入本群长期记忆（mnemon）'
      } catch (error) {
        this.reportFailure('mnemon 写入失败，落本地笔记', error)
      }
    }
    const dir = await this.ensureDir(chatKey)
    await appendFile(join(dir, NOTES_FILE), '- [' + new Date().toISOString() + '] ' + text.replace(/\s+/g, ' ') + '\n', 'utf8')
    return '已写入本群笔记（本地文件）'
  }

  /** 召回与本群相关的内容（query 用最近对话摘要）。 */
  async recall(chatKey: string, query: string, agent: unknown): Promise<string> {
    if (query.trim() === '') return ''
    // mnemon 的读取要求本轮 View，插件在轮次外调用必失败（会返回 Error 文本）→ 交给模型轮内显式回忆
    if (this.opts.backend === 'mnemon') return ''
    const id = await this.ensureSpace(chatKey, agent)
    if (id !== undefined) {
      try {
        const text = await this.callTool('mnemon_recall', { query, memoryBodyIds: [id], limit: 3 }, agent)
        if (text.trim() !== '') return text.trim()
      } catch (error) {
        this.opts.log('debug', 'mnemon 召回失败: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    // 落本地笔记兜底：取最近 20 行里与 query 关键词有交集的
    try {
      const notes = await readFile(join(this.dirFor(chatKey), NOTES_FILE), 'utf8')
      const lines = notes.split('\n').filter(line => line.startsWith('- '))
      const matched = lines.filter(line => query.split(/\s+/).some(word => word.length > 1 && line.includes(word)))
      return matched.slice(-3).join('\n')
    } catch {
      return ''
    }
  }

  /** 追加一条最近消息（滚动保留；与已有同一条消息（5 秒内同内容）会合并而不是重复追加）。 */
  async appendRecent(chatKey: string, entry: { nick: string; text: string; at?: number }): Promise<void> {
    try {
      await this.mergeInto(chatKey, [{
        t: entry.at ?? Date.now(),
        nick: entry.nick.slice(0, 24),
        text: entry.text.slice(0, 500),
      }])
    } catch (error) {
      this.opts.log('debug', '记录群消息失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * 把若干行合并进 recent.jsonl（append 与预热共用）。
   * 判重：同一「5 秒时间窗 + 归一化内容」视为同一条（历史接口秒级 / 实时毫秒级 / [图片] vs [图片:文件名]）。
   * 合并时保留更完整的那条（有昵称优先，其次文本更长）。
   */
  private async mergeInto(chatKey: string, incoming: Array<{ t: number; nick: string; text: string }>): Promise<number> {
    if (incoming.length === 0) return 0
    const dir = await this.ensureDir(chatKey)
    const path = join(dir, RECENT_FILE)
    type Row = { t: number; nick: string; text: string }
    const normText = (text: string): string => text.replace(/\[图片:[^\]]*\]/g, '[图片]').trim()
    /**
     * 合并同一条消息的两份记录：**逐字段取优**（不是整行二选一）。
     * - 时间取更早的（更接近消息本身的时间）
     * - 昵称取非空的那个（避免被空昵称顶掉）
     * - 文本取更长的那个（避免把 [图片:<文件名>] 降级成 [图片]，丢掉缓存引用）
     */
    const better = (left: Row, right: Row): Row => {
      const rich = (nick: string): boolean => nick !== '' && nick !== '?'
      return {
        t: Math.min(left.t, right.t),
        nick: rich(left.nick) && !rich(right.nick) ? left.nick : rich(right.nick) && !rich(left.nick) ? right.nick : left.nick,
        text: right.text.length > left.text.length ? right.text : left.text,
      }
    }
    const rows: Row[] = []
    try {
      const existing = await readFile(path, 'utf8')
      for (const line of existing.split('\n')) {
        if (line.trim() === '') continue
        try {
          const row = JSON.parse(line) as Row
          if (typeof row.t === 'number') rows.push(row)
        } catch {
          // 坏行跳过
        }
      }
    } catch {
      // 文件还不存在
    }
    const before = rows.length
    let added = 0
    for (const row of incoming) {
      // 同内容 + 5 秒内 → 合并
      const index = rows.findIndex(existing => normText(existing.text) === normText(row.text) && Math.abs(existing.t - row.t) <= 5000)
      if (index >= 0) rows[index] = better(rows[index] as Row, row)
      else {
        rows.push(row)
        added += 1
      }
    }
    rows.sort((left, right) => left.t - right.t)
    // 自检压缩：把历史遗留的"同内容 + 5 秒内"重复行也合并掉（清洗旧数据用）
    const compacted: Row[] = []
    for (const row of rows) {
      const last = compacted[compacted.length - 1]
      if (last !== undefined && normText(last.text) === normText(row.text) && Math.abs(row.t - last.t) <= 5000) {
        compacted[compacted.length - 1] = better(last, row)
      } else {
        compacted.push(row)
      }
    }
    const kept = compacted.slice(-this.opts.recentLimit)
    const payload = kept.map(row => JSON.stringify(row)).join('\n') + '\n'
    const tmp = path + '.tmp'
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, path)
    // 返回"真正新增的条数"（原来用 kept.length - before，缓冲满了永远是 0，日志误导）
    return added
  }

  /**
   * 预热：把历史消息**合并**进 recent（按 时间+内容 去重；旧记录里昵称为空而新数据有昵称时自动补全）。
   * 注意：绝不能覆盖——否则每次"缓冲过期"都会把之前攒的几十上百条历史顶掉。
   */
  async seedRecent(chatKey: string, entries: Array<{ nick: string; text: string; at?: number }>): Promise<number> {
    if (entries.length === 0) return 0
    return this.mergeInto(chatKey, entries.map(entry => ({
      t: entry.at ?? Date.now(),
      nick: entry.nick.slice(0, 24),
      text: entry.text.slice(0, 500),
    })))
  }
  /** 读最近 N 条的时间戳（启动后用它初始化"有人在聊"的滑动窗口）。 */
  async recentTimestamps(chatKey: string, limit = 200): Promise<number[]> {
    try {
      const content = await readFile(join(this.dirFor(chatKey), RECENT_FILE), 'utf8')
      const result: number[] = []
      for (const line of content.split('\n')) {
        if (line.trim() === '') continue
        try {
          const row = JSON.parse(line) as { t?: number }
          if (typeof row.t === 'number') result.push(row.t)
        } catch {
          // 坏行跳过
        }
      }
      return result.slice(-limit)
    } catch {
      return []
    }
  }

  /** 缓冲里最新一条的时间戳（毫秒；空=0）。用于判断缓冲是否"过期"。 */
  async recentNewestAt(chatKey: string): Promise<number> {
    try {
      const content = await readFile(join(this.dirFor(chatKey), RECENT_FILE), 'utf8')
      const lines = content.split('\n').filter(part => part.trim() !== '')
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index] as string) as { t?: number }
          if (typeof parsed.t === 'number') return parsed.t
        } catch {
          // 坏行跳过
        }
      }
      return 0
    } catch {
      return 0
    }
  }

  /** 当前缓冲条数（用于判断是否需要预热）。 */
  async recentCount(chatKey: string): Promise<number> {
    try {
      const content = await readFile(join(this.dirFor(chatKey), RECENT_FILE), 'utf8')
      return content.split('\n').filter(part => part.trim() !== '').length
    } catch {
      return 0
    }
  }

  /** 读最近 N 条，返回「昵称: 内容」行。 */
  async readRecent(chatKey: string, limit?: number): Promise<string[]> {
    try {
      const content = await readFile(join(this.dirFor(chatKey), RECENT_FILE), 'utf8')
      const lines = content.split('\n').filter(part => part.trim() !== '').slice(-(limit ?? this.opts.injectRecent))
      const result: string[] = []
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { t?: number; nick?: string; text?: string }
          const clock = parsed.t === undefined ? '' : new Date(parsed.t).toTimeString().slice(0, 5) + ' '
          result.push(clock + (parsed.nick ?? '?') + ': ' + (parsed.text ?? ''))
        } catch {
          // 坏行跳过
        }
      }
      return result
    } catch {
      return []
    }
  }

  /** 组装注入文本（含 @ 优先级指令），超预算截断。 */
  buildInjection(parts: { chatKey: string; recent: readonly string[]; recallText?: string; mention?: string; spaceId?: string; recentExpressions?: readonly string[] }): string {
    const blocks: string[] = []
    blocks.push('这个会话来自 QQ（NapCat 渠道），聊天对象是 ' + parts.chatKey + '。')
    if (parts.mention !== undefined && parts.mention !== '') {
      blocks.push('【当前 @你 的人（优先级最高，先回答他的问题）】' + parts.mention)
    }
    if (parts.recent.length > 0) {
      blocks.push('【最近群聊（背景，用于理解话题，不要逐条回应）】\n' + parts.recent.join('\n'))
      // 只有 @ 那一轮图片是真正随消息送进来的；其余轮次图片只有记录，想看必须自己读文件
      if (parts.recent.some(line => line.includes('[图片'))) {
        blocks.push('【记录里的图片怎么看】形如 [图片:napcat-inbox/imgs/<日期>/<文件>] 的是本机已缓存的图（相对当前工作目录），'
          + '要用 read_image 传这个相对路径才能真正看到画面；只写 [图片] 或 [图片(已过期)] 的表示当时没缓存下来，看不到内容。'
          + '正常情况下不必每张都看，只有话题确实需要（在聊图/表情包/截图里的内容）时才读，避免拖慢回复。')
      }
    }

    if (this.opts.backend === 'mnemon') {
      if (parts.spaceId !== undefined && parts.spaceId !== '') {
        blocks.push('【本群长期记忆（mnemon）】空间 id = ' + parts.spaceId + '\n' +
          '写入：mnemon_remember({ memoryBodyId: "' + parts.spaceId + '", content: "…", tags: ["napcat","' + parts.chatKey + '"] })\n' +
          '回忆：必须显式调用 mnemon_recall({ memoryBodyIds: ["' + parts.spaceId + '"], query: "…" }) —— 不要依赖 mnemon 的自动回忆。\n' +
          '分层约定（写入时 content 加前缀 + tags 区分）：\n' +
          '  【设定】群规矩 / 称呼 / 习惯 → tags 加 "setting"\n' +
          '  【黑话】群内术语 / 缩写 → tags 加 "glossary"\n' +
          '  【人物】成员关系 / 身份 / 别名 → tags 加 "person"\n' +
          '  【事实】其他结论 / 约定 → 不加额外标签\n' +
          '回答本群问题前先做固定层召回：mnemon_recall({ memoryBodyIds: ["' + parts.spaceId + '"], query: "设定 称呼 黑话 人物" })，' +
          '再按当前话题做一次按需召回。\n' +
          (this.opts.autoCapture === false ? '' : '【自动记忆】不需要用户说「记住」：只要本轮对话里出现了下面任一**新信息**，你就自己调用 mnemon_remember 写入（不必告知用户，也不必询问）：\n' +
          '  · 群规矩 / 称呼习惯 / 禁忌 → content 前缀【设定】, tags 加 "setting"\n' +
          '  · 群内术语 / 缩写 / 梗 → 前缀【黑话】, tags 加 "glossary"\n' +
          '  · 成员身份 / 关系 / 别名 → 前缀【人物】, tags 加 "person"\n' +
          '  · 明确的结论 / 约定 / 待办 → 前缀【事实】\n' +
          '写入规则：①先做一次固定层召回，已存在的不重复写；②每条尽量 ≤ 60 字，写清楚「谁/什么/怎么叫」；③一次最多写 2 条，不确定就不写；④不要把闲聊、玩笑、临时情绪写进去。\n' +
          '【更新规则】记忆不是只增不改，信息变化时必须改：\n' +
          '  ① 先固定层召回，按「同一主体」找旧条目（同一个人的称呼 / 同一条规矩 / 同一个黑话）；\n' +
          '  ② 若旧条目已被**修正/替换**（改名、换人、规则变更、含义变化）→ 先 mnemon_forget({ id: <旧条目 id> }) 软删，再 mnemon_remember 写入新版本；\n' +
          '  ③ 新版本 content 末尾加（更新于 MM-DD），例如【人物】张哥=老张（更新于 10-23）；\n' +
          '  ④ 若只是**补充细节**（旧内容仍正确）→ 直接写一条带【补充】的新条目，不要删旧的；\n' +
          '  ⑤ 用户说「忘掉 X」或明确指出某条已不成立 → 召回后 mnemon_forget 掉对应条目，并简短确认。\n' +
          '【静默规则】记忆的增/改/删**全部静默执行**，不要向用户汇报过程：\n' +
          '  · 不要提「软删除 / 空间 / 条目 / mnemon / 向量 / 召回」等内部词；\n' +
          '  · 不要罗列你做了什么操作（"我会删掉旧的再写新的"这种一律不要说）；\n' +
          '  · 只有用户明确问「你记得什么 / 记住没」时，才用一两句说出**内容本身**；\n' +
          '  · 用户让你记住时，确认语尽量短（≤ 15 字，口语化），例如「好，以后叫帅哥」；\n' +
          '  · 群聊里保持自然聊天语气，不要像系统日志。'))
      } else {
        blocks.push('【本群长期记忆（mnemon）尚未配置空间 id】\n' +
          '本群还没有记忆空间。需要长期记住信息前：先 mnemon_memory_body_create({ name: "' + this.opts.spacePrefix + parts.chatKey + '", description: "QQ ' + parts.chatKey + ' 的长期记忆" })，' +
          '再 mnemon_memory_body_update({ memoryBodyId: <id>, active: true })，然后调用 napcat_memory_space({ group_id: "' + parts.chatKey.split(':')[1] + '", space_id: <id> }) 让插件记住这个 id。')
      }
    }
    if (parts.recallText !== undefined && parts.recallText !== '') {
      blocks.push('【本群长期记忆（相关片段）】\n' + parts.recallText)
    }
    // 最近用过的表情描述：明确告诉它别连着用同一个，换候选/换情绪
    if (parts.recentExpressions !== undefined && parts.recentExpressions.length > 0) {
      blocks.push('【最近发过的表情】' + parts.recentExpressions.slice(0, 6).join('、')
        + '\n→ 别连着用同一个描述/同一张：换一张候选，或换个情绪词。表情包是调味，不是每句都要配。')
    }
    // 出站可发送的媒体：生成/找到的图要主动带上，否则用户要再催一次
    blocks.push('【发图/发表情】**优先发表情包图片**（图库有就发图，比小黄脸更有味道）：\n'
      + '  ① 想发图库表情包 → 用**只读的**表情清单工具（meme_list）按关键词找候选，把候选描述**一字不改地**写进 [表情:描述]（命中率最高；网页端和 QQ 才会显示同一张）；\n'
      + '     **不要用 send_meme**——那会把图发到网页会话，QQ 里发图只认 [表情:…] 和 [图片:…]；\n'
      + '  ② 不想多搜一次 → 写**有画面感的具体词**（如 [表情:捧着碗干饭]、[表情:得意好耶]、[表情:抓狂崩溃]），插件按关键词去图库找；\n'
      + '  ③ 图库确实没有合适的 → 写简单情绪词（[表情:无语]），会退到同情绪图库，再退到会轮换的小黄脸。\n'
      + '匹配不到会自动降级，**不会白写也不会发错图**，所以拿不准时放心写。别直接用 emoji 字符（😊😌 这种每次同一个、也不进图库）。\n'
      + '**节制用表情**：不是每条回复都配图，大概三四条里带一次就够；同一个描述/同一张别连着用，换候选或换情绪。\n'
      + '这轮如果用工具生成了图片，请把文件路径用 [图片:绝对路径] 写进回复正文（一张一行），QQ 侧会作为真实图片消息发出去；'
      + '不要只说「图已生成」或只给文件名——没带 [图片:路径] 就等于没发出去。')
    // 群聊礼仪放最后：预算紧张时优先牺牲它，别挤掉 @ 段和长期记忆
    if (parts.chatKey.startsWith('group:')) {
      blocks.push('【这是群聊，不是一对一】群里有多个人：认人，必要时用昵称点名（不必每句）；谁问的就回谁；'
        + '定时提醒/到点通知必须带发起人昵称和事由；语气像群里一员，别像客服。')
    }
    let text = blocks.join('\n\n')
    if (text.length > this.opts.injectMaxChars) {
      text = text.slice(0, this.opts.injectMaxChars) + '\n…（记忆超预算已截断，需要时请把要点压缩）'
    }
    return text
  }
}
