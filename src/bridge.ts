/**
 * QQ 会话 ↔ dsh agent 的桥。
 *
 * 入站：OneBot 消息事件 → 策略/门控 → 每个会话一个 agent → `agent.followup(用户消息)`
 * 出站：订阅会话事件（`session/event`）→ 回合结束时把助手文本按长度分段发回 QQ
 *
 * 会话 id 由 QQ 会话确定性地派生（`napcat-private-<QQ>` / `napcat-group-<群号>`），
 * 重启后 create 失败即回退 resume，于是同一 QQ 会话自动续上上下文。
 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
/** 宿主 AgentRegistry.create 接受的模型选项（避免自己猜 ReasoningEffortId 的品牌类型）。 */
type AgentOptions = NonNullable<NonNullable<Parameters<AgentRegistry['create']>[0]>['agentOptions']>
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import type { Config } from './config.js'
import { allowAccess, chatRefOf, sessionIdForChat, type ChatRef } from './chat.js'
import type { LogLevel, OneBotConnection } from './onebot.js'
import { findKeyword, mentions, parsePersonaOverrides, repliesTo, repliesToAny, segmentsOf, shortHash, splitText, stripKeyword, titleFrom, toText } from './text.js'
import { MemoryStore } from './memory.js'
import { ImageCache } from './imagecache.js'
import { faceFor } from './faces.js'
import { defaultMemeDirs, MemeLibrary } from './meme.js'
import { localToBase64Url } from './media.js'
import { decide, newChatState, parseQuietHours, pruneSentAt, type ChatProactiveState } from './proactive.js'
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_IMAGE_BYTES, base64UrlToBuffer, downloadToFile, ensureInbox, imageMediaType, nameFromRef } from './media.js'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import type { ObEvent, ObMessageEvent, ObSegment } from './types.js'

/** 宿主注入的服务（inject 保证就绪）。 */
type HostContext = Context & { agents: AgentRegistry }

/** 投递后多久没收到 turn/start 就判定会话失效。 */
const WATCHDOG_MS = 10000

interface ChatState {
  ref: ChatRef
  agent: Agent
  dispose: () => Promise<void>
  /** 本轮已产生的助手文本（turn/end 时一次性发出）。 */
  buffer: string[]
  /** 最近一条触发了回复的消息 id（replyAsQuote 与"回复机器人也算提及"用）。 */
  lastReplyId: string
  /** 机器人最近发出的消息 id（用于判定「回复机器人」，最多 30 条） */
  recentReplyIds?: string[]
  /** 本轮是否已经收到 turn/start（看门狗判定用）。 */
  turnStarted?: boolean
  /** 投递后的看门狗定时器。 */
  startTimer?: ReturnType<typeof setTimeout>
  /** true=本次是新建的会话；false=resume 的旧会话（可能已归档，需要看门狗）。 */
  fresh?: boolean
  /** 本条消息投递时刻（看门狗判定存活用）。 */
  dispatchedAt?: number
  /** 这个会话最近一次收到任何事件的时刻。 */
  lastEventAt?: number
  /** 该会话的工作目录（收件箱放在它下面）。 */
  cwd?: string
  /** 是否已按首条消息设置过标题。 */
  titleSet?: boolean
  /** 最近一次投递给模型的文本（ENOENT 自愈时重投用）。 */
  lastText?: string
  /** 这条消息是否已经重试过一次。 */
  retried?: boolean
}

export interface BridgeOptions {
  ctx: Context
  config: Config
  conn: OneBotConnection
  log(level: LogLevel, message: string): void
}

export class Bridge {
  /** 群/私聊记忆（一群一目录 + mnemon 长期记忆）。 */
  private readonly mem: MemoryStore
  /** 已尝试预热的聊天（每会话一次）。 */
  /** 上次预热尝试时间（避免频繁重试）。 */
  private readonly warmAttempts = new Map<string, number>()
  private readonly chats = new Map<string, ChatState>()
  private readonly bySession = new Map<string, string>()
  /** 归档/失效后换用新会话 id 的后缀（下次建会话时带上）。 */
  private readonly sessionSuffixes = new Map<string, string>()
  /** sessionId → 该会话的人设文本（来自 personaOverrides）。 */
  private readonly personaBySession = new Map<string, string>()
  /** 解析后的人设表（chat key → 文本）。 */
  private personas = parsePersonaOverrides('')
  private sessionEventOff: (() => void) | undefined
  private stopped = false
  private mentionWarned = false

  constructor(private readonly opts: BridgeOptions) {
    this.mem = new MemoryStore({
      ctx: opts.ctx,
      root: normalizePath(join(normalizePath(opts.config.workspacePath) || process.cwd(), 'memory')),
      spacePrefix: opts.config.memorySpacePrefix,
      backend: opts.config.memoryBackend,
      autoCapture: opts.config.memoryAutoCapture,
      spaces: opts.config.memorySpaces,
      recentLimit: opts.config.recentLimit,
      injectRecent: opts.config.injectRecent,
      injectMaxChars: opts.config.injectMaxChars,
      log: opts.log,
    })

    this.refreshPersonas()}

  start(): void {
    this.stopped = false
    this.sessionEventOff = this.opts.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    })
    this.opts.log('info', '桥已就绪（每个 QQ 会话一个 agent）')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.sessionEventOff?.()
    this.sessionEventOff = undefined
    const states = [...this.chats.values()]
    this.chats.clear()
    this.bySession.clear()
    for (const state of states) {
      try {
        await state.dispose()
      } catch {
        // 单个会话 dispose 失败不影响其它会话
      }
    }
  }

  /** 一条 OneBot 事件进站。 */
  async handleEvent(event: ObEvent): Promise<void> {
    try {
      await this.handleEventInner(event)
    } catch (error) {
      let cwd: string | undefined
      try {
        const ref = chatRefOf(event as ObMessageEvent)
        if (ref !== undefined) cwd = join(normalizePath(this.opts.config.workspacePath) || process.cwd(), 'napcat', (ref.kind === 'group' ? 'group-' : 'private-') + ref.id)
      } catch {
        // 取不到就写默认位置
      }
      this.debugLog(cwd, '出站异常: ' + describe(error))
      throw error
    }
  }

  // ── 群聊图片缓存 ──
  /** 每个 cwd 一个图片缓存（配额/清理按 cwd 独立）。 */
  private readonly imageCaches = new Map<string, ImageCache>()
  /** 已经清理过过期目录的 cwd。 */
  private readonly imageCacheSwept = new Set<string>()

  private imageCacheFor(cwd: string): ImageCache {
    const existing = this.imageCaches.get(cwd)
    if (existing !== undefined) return existing
    const cache = new ImageCache({
      cwd,
      maxBytes: this.opts.config.imageCacheMaxBytes,
      dailyCap: this.opts.config.imageCacheDailyCap,
      retentionDays: this.opts.config.imageCacheRetentionDays,
      log: this.opts.log,
    })
    this.imageCaches.set(cwd, cache)
    if (!this.imageCacheSwept.has(cwd)) {
      this.imageCacheSwept.add(cwd)
      void cache.sweep().then(removed => {
        if (removed > 0) this.opts.log('info', '清理过期图片缓存目录 ' + removed + ' 个: ' + cwd)
      })
    }
    return cache
  }

  /**
   * 观察层用：把消息里的图片落盘（imageCache=all 时），并把文件名写进聊天记录，
   * 这样之后能用 read_image 回头看群里的图/表情包。
   */
  private async prepareRecentText(ref: ChatRef, msg: ObMessageEvent, rawText: string, nick: string): Promise<string> {
    const segments = segmentsOf(msg.message)
    const images = segments.filter(seg => seg.type === 'image')
    const faces = segments.filter(seg => seg.type === 'face' || seg.type === 'mface')
    if (this.opts.config.imageCache === 'off') {
      return faces.length > 0 ? rawText.replace(/\[表情\]/g, '[表情]') : rawText
    }
    if (images.length === 0 && faces.length === 0) return rawText
    let cwd = normalizePath(this.opts.config.workspacePath)
    try {
      cwd = await this.cwdFor(ref)
    } catch {
      // 用工作区根目录兜底
    }
    const cache = this.imageCacheFor(cwd)
    for (const face of faces.slice(0, 3)) {
      const name = String((face.data as { id?: unknown; name?: unknown }).name ?? (face.data as { id?: unknown }).id ?? '')
      if (name !== '') void cache.noteFace(ref.key, nick, name)
    }
    const saved: string[] = []
    for (const seg of images.slice(0, 3)) {
      const fileRef = String((seg.data as { file?: unknown }).file ?? '')
      if (fileRef === '') continue
      try {
        const info = await this.opts.conn.call<{ url?: string }>('get_image', { file: fileRef })
        const url = info?.url
        if (typeof url !== 'string' || url === '') continue
        const hit = await cache.save({ url, chatKey: ref.key, nick, name: nameFromRef(fileRef, 'image.png') })
        // 写成相对工作目录的路径，模型才能用 read_image 直接打开（只写文件名是打不开的）
        if (hit !== undefined) saved.push(relative(cwd, hit.path).replace(/\\/g, '/'))
      } catch (error) {
        this.opts.log('debug', '图片缓存失败（已跳过）: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    if (saved.length === 0) return rawText
    return rawText.replace(/\[图片\]/g, '') + ' [图片:' + saved.join(',') + ']'
  }

  // ── 主动发言（伪人模式）──
  /** 每聊天的主动发言状态。 */
  private readonly proactiveStates = new Map<string, ChatProactiveState>()
  /** 该聊天最近「他人消息」的时间戳（观察窗口内计数用）。 */
  private readonly chatter = new Map<string, number[]>()
  /** 首次计数时用历史缓冲回填窗口的 promise：判定前要等它，否则重启后会误判「只有 1 条」。 */
  private readonly chatterReady = new Map<string, Promise<void>>()
  /** 已投递主动发言请求、等待回复拦截的聊天。 */
  private readonly pendingProactive = new Set<string>()
  /** 群禁言到什么时候（毫秒）：期间不发消息，也跳过主动发言。 */
  private readonly mutedUntil = new Map<string, number>()
  /** 表情库（懒加载）。 */
  private memeLibrary: MemeLibrary | undefined
  /** 最近发过的原生表情 id（避免同一句描述永远同一个表情）。 */
  private readonly recentFaceIds: string[] = []
  /** 最近发过的表情文件（避免连续重复同一张）。 */
  private readonly recentMemeFiles: string[] = []
  /** 机器人自己的 QQ（配置没填时用 get_login_info 取一次后缓存）。 */
  private selfQqCache = ''
  /** 上次「被硬门挡住」的提示时间（防刷屏，每群 10 分钟一条）。 */
  private readonly proactiveNoticeAt = new Map<string, number>()

  /** 记录一条他人消息（供主动发言判断"有没有人在聊"）。 */
  private noteChatter(ref: ChatRef): void {
    const now = Date.now()
    const windowMs = this.opts.config.proactiveWindowMinutes * 60_000
    const cached = this.chatter.get(ref.key)
    const list = (cached ?? []).filter(at => now - at < windowMs)
    list.push(now)
    this.chatter.set(ref.key, list)
    // 重启后第一次计数：用缓冲里的历史时间戳补齐（否则"近 10 分钟"永远从 0 开始，刚重启就被拦）
    if (cached === undefined && this.opts.config.proactiveEnabled) {
      const seeding = this.mem.recentTimestamps(ref.key, 200).then(stamps => {
        const merged = [...stamps, ...(this.chatter.get(ref.key) ?? [])].filter(at => Date.now() - at < windowMs)
        merged.sort((left, right) => left - right)
        this.chatter.set(ref.key, merged)
      })
      this.chatterReady.set(ref.key, seeding.then(() => undefined, () => undefined))
    }
  }

  /**
   * 判断并（可能）主动插话。只在群里、且用户没叫它的时候调用。
   * 判定不通过就什么都不做；通过则投递一条 [主动发言] 请求，由模型决定说还是回 __SKIP__。
   */
  private async maybeInterject(ref: ChatRef): Promise<void> {
    const cfg = this.opts.config
    if (!cfg.proactiveEnabled || ref.kind !== 'group') return
    // 禁言期间不插话（发了也会被 QQ 拒）
    if ((this.mutedUntil.get(ref.key) ?? 0) > Date.now()) return
    const state = this.proactiveStates.get(ref.key) ?? newChatState()
    const now = Date.now()
    const windowMs = cfg.proactiveWindowMinutes * 60_000
    // 重启后的第一轮：等历史回填完成再判定，否则会拿"只有 1 条"去跟门槛比
    const pendingSeed = this.chatterReady.get(ref.key)
    if (pendingSeed !== undefined) {
      await pendingSeed.catch(() => undefined)
    }
    const recentOthers = (this.chatter.get(ref.key) ?? []).filter(at => now - at < windowMs).length
    const local = new Date(now)
    const decision = decide({
      now,
      minuteOfDay: local.getHours() * 60 + local.getMinutes(),
      options: {
        enabled: cfg.proactiveEnabled,
        ratePerHour: cfg.proactiveRatePerHour,
        chance: cfg.proactiveChance,
        cooldownMinutes: cfg.proactiveCooldownMinutes,
        maxPerHour: cfg.proactiveMaxPerHour,
        quietHours: cfg.proactiveQuietHours,
        minMessages: cfg.proactiveMinMessages,
        windowMinutes: cfg.proactiveWindowMinutes,
      },
      state,
      recentOthers,
      quietRanges: parseQuietHours(cfg.proactiveQuietHours),
    })
    state.lastConsiderAt = now
    this.proactiveStates.set(ref.key, state)
    if (!decision.send) {
      this.opts.log('debug', '主动发言不触发(' + decision.reason + '): ' + ref.key)
      // 被"硬门"挡住时用 info 说明一次（每群 3 分钟最多一条），带上**实际计数**便于判断是配置还是逻辑问题
      if (decision.reason !== 'poisson-miss' && decision.reason !== 'chance-miss' && decision.reason !== 'disabled') {
        const lastNotice = this.proactiveNoticeAt.get(ref.key) ?? 0
        if (now - lastNotice > 3 * 60_000) {
          this.proactiveNoticeAt.set(ref.key, now)
          const hint: Record<string, string> = {
            'quiet-hours': '当前在静默时段',
            cooldown: '距上次发言不足 ' + cfg.proactiveCooldownMinutes + ' 分钟',
            'hourly-cap': '本小时已达 ' + cfg.proactiveMaxPerHour + ' 条上限',
            'not-enough-chatter': '近 ' + cfg.proactiveWindowMinutes + ' 分钟只有 ' + recentOthers + ' 条他人消息（门槛 ' + cfg.proactiveMinMessages + '）',
            'chance-zero': 'proactiveChance=0 且未设 λ',
          }
          this.opts.log('info', '主动发言暂不触发（' + (hint[decision.reason] ?? decision.reason) + '）: ' + ref.key)
        }
      }
      return
    }
    try {
      const chat = await this.ensureChat(ref)
      const recent = await this.mem.readRecent(ref.key, this.opts.config.injectRecent)
      // 主动发言也要带完整记忆块（空间 id / 固定层召回指令 / 自动记忆规则），与 @ 触发时一致
      let memoryBlock = ''
      let proactiveSpaceId: string | undefined
      if (this.opts.config.memoryEnabled) {
        try {
          proactiveSpaceId = await this.mem.ensureSpace(ref.key, chat.agent)
          const recalled = this.opts.config.memoryBackend === 'file'
            ? await this.mem.recall(ref.key, recent.slice(-5).join(' '), chat.agent)
            : ''
          memoryBlock = this.mem.buildInjection({ chatKey: ref.key, recent, recallText: recalled, spaceId: proactiveSpaceId })
        } catch (error) {
          this.opts.log('debug', '主动发言记忆注入失败: ' + (error instanceof Error ? error.message : String(error)))
        }
      }
      // 主动发言轮的记忆任务：没有空间就建好并先记一条；有空间就顺手记新信息（各限 1 条，别啰嗦）
      if (this.opts.config.memoryEnabled && this.opts.config.memoryBackend === 'mnemon') {
        const spaceName = this.opts.config.memorySpacePrefix + ref.key
        const registerCall = ref.kind === 'group'
          ? 'napcat_memory_space({ group_id: "' + ref.id + '", space_id: <同一个 id> })'
          : 'napcat_memory_space({ user_id: "' + ref.id + '", space_id: <同一个 id> })'
        memoryBlock += proactiveSpaceId === undefined
          ? '\n\n【本轮额外要求·先做这个再说话】本群还没有记忆空间。请依次执行：'
            + '① mnemon_memory_body_create({ name: "' + spaceName + '", description: "QQ ' + ref.key + ' 的长期记忆" })'
            + '② mnemon_memory_body_update({ memoryBodyId: <返回的 id>, active: true })'
            + '③ ' + registerCall
            + '④ 从上面的近期群聊里提炼 1~3 条值得长期记住的内容（群定位/成员称呼/黑话梗/重要约定），用 mnemon_remember 写进这个空间。'
            + '全部做完后再照常插话（没有想说的仍然回 __SKIP__）。这一步只做一次，之后本群就有记忆空间了。'
          : '\n\n【本轮小提醒】如果上面的近期群聊里出现了值得长期记住的新信息（新人设/称呼/黑话/重要约定），可以顺手调用 mnemon_remember 记 1 条（最多 1 条，没实质内容就不记）；这只是附带动作，不要因此改变插话的语气。'
      }
      this.pendingProactive.add(ref.key)
      // 优先参考最近几条，但不是"只准接最后一句"：允许结合更早的上下文与长期记忆来回
      const lastThree = recent.slice(-3)
      const latestSpeaker = lastThree.length === 0 ? '' : lastThree[lastThree.length - 1] ?? ''
      const anchorBlock = lastThree.length === 0
        ? ''
        : '【最近的对话（优先从这里切入）】\n' + lastThree.join('\n') + '\n\n'
      await this.dispatch(chat,
        (memoryBlock === '' ? '' : memoryBlock + '\n\n')
        + anchorBlock
        + '[主动发言] 现在是主动插话窗口。\n'
        + '怎么想：先看上面的群设定、长期记忆和完整聊天记录，判断大家在聊什么、聊到哪一步，再决定你要说什么；'
        + '切入点**优先取最近这几条**（' + (latestSpeaker === '' ? '最新消息' : '最近一句来自「' + latestSpeaker.slice(0, 40) + '」') + '），'
        + '但不必死盯最后一句——如果前面几轮里有个更值得回应/补充/吐槽的点，也可以接着那个说。\n'
        + '怎么说：① 不超过 2 句、口语化，像群成员随口插话，不要像播报或客服；② 附和、补充、吐槽、接梗、追问都行；\n'
        + '③ 不要重复别人刚说过的内容，不要总结、不要列点、不要点名；④ 不要抛与本群历史和当前话题无关的新话题；\n'
        + '⑤ 拿不准或觉得这轮插话多余，就只回复 __SKIP__（三个下划线 + SKIP），我会丢弃这条。',
        [], [])
      this.opts.log('info', '主动发言已触发: ' + ref.key + '（' + decision.reason + '）')
    } catch (error) {
      this.pendingProactive.delete(ref.key)
      this.opts.log('debug', '主动发言投递失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /** 供 napcat_memory_space 工具登记空间 id。 */

  /** 供 napcat_memory_space 工具登记空间 id。 */
  async saveMemorySpace(chatKey: string, spaceId: string): Promise<void> {
    await this.mem.saveSpace(chatKey, spaceId)
    this.opts.log('info', '已登记记忆空间: ' + chatKey + ' → ' + spaceId)
  }

  /** 缓冲不足时才预热；同一聊天 5 分钟内最多尝试一次。 */
  private async maybeWarmup(ref: ChatRef): Promise<void> {
    try {
      const last = this.warmAttempts.get(ref.key) ?? 0
      if (Date.now() - last < 5 * 60_000) return
      const have = await this.mem.recentCount(ref.key)
      const newest = await this.mem.recentNewestAt(ref.key)
      const staleMs = this.opts.config.warmupStaleMinutes * 60_000
      const enough = have >= this.opts.config.warmupHistory
      const fresh = newest > 0 && Date.now() - newest <= staleMs
      if (enough && fresh) return
      this.warmAttempts.set(ref.key, Date.now())
      this.opts.log('info', '预热触发 ' + ref.key + '：已有 ' + have + ' 条，目标 ' + this.opts.config.warmupHistory)
      await this.warmup(ref)
    } catch (error) {
      this.opts.log('warn', '预热判断失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /** 用 NapCat 的历史消息接口预热 recent 缓冲（群 get_group_msg_history / 私聊 get_friend_msg_history）。 */
  private async warmup(ref: ChatRef): Promise<void> {
    try {
      const count = this.opts.config.warmupHistory
      const isGroup = ref.kind === 'group'
      const action = isGroup ? 'get_group_msg_history' : 'get_friend_msg_history'
      const params = isGroup
        ? { group_id: ref.id, count, reverse_order: false }
        : { user_id: ref.id, count, reverseOrder: false }
      const data = await this.opts.conn.call<{ messages?: Array<{ sender?: { nickname?: unknown; card?: unknown; user_id?: unknown }; message?: unknown; raw_message?: unknown; time?: number }> }>(action, params)
      const list = Array.isArray(data?.messages) ? data.messages : []
      // 历史图片：消息里存的 url 会过期，但 file id 还能用 get_image 重新解析 → 能解析就缓存
      let cache: ImageCache | undefined
      let cacheCwd = ''
      let imageBudget = this.opts.config.warmupImages ? this.opts.config.warmupImageLimit : 0
      if (imageBudget > 0) {
        try {
          cacheCwd = await this.cwdFor(ref)
          cache = this.imageCacheFor(cacheCwd)
        } catch {
          cache = undefined
        }
      }
      const entries: Array<{ nick: string; text: string; at?: number }> = []
      // 先把所有消息整理成条目，同时记下带图片的条目（下载留到第二轮，按"最新优先"消耗预算）
      const imageTasks: Array<{ index: number; at: number; speaker: string; files: string[] }> = []
      for (const item of list) {
        // 与实时路径一致的兜底：群名片 → 昵称 → QQ 号（历史接口里 card 常为空串，不能用 ?? ）
        const card = typeof item.sender?.card === 'string' ? item.sender.card.trim() : ''
        const nick = typeof item.sender?.nickname === 'string' ? item.sender.nickname.trim() : ''
        const uid = typeof item.sender?.user_id === 'number' ? String(item.sender.user_id) : ''
        const speaker = card !== '' ? card : nick !== '' ? nick : uid !== '' ? uid : '?'
        const text = toText(item.message as never) || String(item.raw_message ?? '')
        if (text === '') continue
        const at = typeof item.time === 'number' ? item.time * 1000 : Date.now()
        if (cache !== undefined && imageBudget > 0) {
          const files = segmentsOf(item.message as never)
            .filter(seg => seg.type === 'image')
            .map(seg => String((seg.data as { file?: unknown }).file ?? ''))
            .filter(file => file !== '')
            .slice(0, 3)
          if (files.length > 0) imageTasks.push({ index: entries.length, at, speaker, files })
        }
        entries.push({ nick: speaker, text, at })
      }
      // 第二轮：**最新的图片优先**消耗预算（而不是从头开始把预算喂给最旧的消息）
      imageTasks.sort((left, right) => right.at - left.at)
      for (const task of imageTasks) {
        if (imageBudget <= 0) break
        const entry = entries[task.index]
        if (entry === undefined) continue
        const names: string[] = []
        let expired = 0
        for (const fileRef of task.files) {
          if (imageBudget <= 0) break
          imageBudget -= 1
          try {
            const info = await this.opts.conn.call<{ url?: string }>('get_image', { file: fileRef })
            const url = info?.url
            if (typeof url !== 'string' || url === '') {
              expired += 1
              continue
            }
            const hit = await cache?.save({ url, chatKey: ref.key, nick: task.speaker, name: nameFromRef(fileRef, 'image.png') })
            if (hit !== undefined) names.push(relative(cacheCwd, hit.path).replace(/\\/g, '/'))
            else expired += 1
          } catch {
            expired += 1
          }
        }
        if (names.length > 0) {
          entry.text = entry.text.replace(/\[图片\]/g, '').trimStart() + ' [图片:' + names.join(',') + ']'
        } else if (expired > 0) {
          entry.text = entry.text.replace(/\[图片\]/g, '[图片(已过期)]')
        }
      }
      {
        const seeded = await this.mem.seedRecent(ref.key, entries)
        this.opts.log('info', '预热历史 ' + ref.key + '：' + seeded + ' 条' + (this.opts.config.warmupImages ? '（图片预算已用 ' + (this.opts.config.warmupImageLimit - Math.max(0, imageBudget)) + ' 张，最新优先）' : ''))
      }
    } catch (error) {
      this.opts.log('warn', '预热历史失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private async handleEventInner(event: ObEvent): Promise<void> {
    if (this.stopped) return
    if (event.post_type !== 'message') return
    const msg = event as ObMessageEvent
    const ref = chatRefOf(msg)
    if (ref === undefined) return
    const userId = String(msg.user_id ?? '')
    const selfId = this.opts.conn.selfId

    if (this.opts.config.ignoreSelf && selfId !== '' && userId === selfId) {
      this.opts.log('debug', '忽略机器人自己的消息')
      return
    }
    if (!allowAccess(this.opts.config, ref, userId)) {
      this.opts.log('debug', '策略拒绝: ' + ref.key + ' user=' + userId)
      return
    }

    const rawText = toText(msg.message, selfId)
    const keyword = findKeyword(rawText, this.opts.config.triggerKeywords)

    // ── 观察层：在 @门控之前，所有消息（不管有没有叫到机器人）都记进缓冲 ──
    // 昵称三级兜底：群名片(card) → 昵称(nickname) → QQ 号（QQ 群成员经常只有名片，nickname 为空）
    const senderInfo = msg.sender as { nickname?: unknown; card?: unknown } | undefined
    const card = typeof senderInfo?.card === 'string' ? senderInfo.card.trim() : ''
    const nick = typeof senderInfo?.nickname === 'string' ? senderInfo.nickname.trim() : ''
    const senderNick = card !== '' ? card : nick !== '' ? nick : userId
    // 用消息本身的时间（秒级 time × 1000），不要用"处理时刻"——否则和预热拉回的历史差几秒，去重对不上
    const messageAt = typeof msg.time === 'number' && msg.time > 0 ? msg.time * 1000 : undefined
    if (this.opts.config.memoryEnabled) {
      if (this.opts.config.imageCache === 'all') {
        // 图片要落盘并写进记录（异步，不阻塞本条消息处理）
        void (async () => {
          const text = await this.prepareRecentText(ref, msg, rawText, senderNick)
          await this.mem.appendRecent(ref.key, { nick: senderNick, text, at: messageAt })
        })()
      } else {
        void this.mem.appendRecent(ref.key, { nick: senderNick, text: rawText, at: messageAt })
      }
      if (this.opts.config.warmupHistory > 0) {
        void this.maybeWarmup(ref)
      }
    }
    // 主动发言：记录"有人在聊"，判定推迟到门控之后（被 @ 时不插话）
    this.noteChatter(ref)

    if (ref.kind === 'group' && this.opts.config.requireMention) {
      if (selfId === '') {
        if (!this.mentionWarned) {
          this.mentionWarned = true
          this.opts.log('warn', '还不知道机器人自己的 QQ（botQQ 留空且事件里没带 self_id），暂不启用 @ 门控')
        }
      } else {
        const recent = this.chats.get(ref.key)?.recentReplyIds ?? []
        const hit = mentions(msg.message, selfId) || repliesToAny(msg.message, recent) || keyword !== undefined
        if (!hit) {
          this.opts.log('debug', '群消息未 @ 机器人且没命中关键字（已记入缓冲）: ' + ref.key)
          // 没叫它 → 看看要不要主动插一句（判定在 proactive 里）
          if (this.opts.config.proactiveEnabled) void this.maybeInterject(ref)
          return
        }
      }
    }

    const chat = await this.ensureChat(ref)
    if (this.opts.config.memoryEnabled) void this.mem.dumpTurnState(ref.key, chat.agent)

    // 记忆命令（插件直写，不经过模型）
    if (this.opts.config.memoryEnabled) {
      // 命令前先去掉 @段 与触发词，否则「小灯记忆」匹配不上
      let commandText = rawText.replace(/\[CQ:[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
      for (const word of this.opts.config.triggerKeywords) {
        if (word !== '') commandText = stripKeyword(commandText, word)
      }
      commandText = commandText.trim()
      const rememberMatch = /^记住(设定|黑话|人物|事实)?[:：]?\s*([\s\S]+)$/.exec(commandText)
      if (rememberMatch !== null && rememberMatch[2] !== undefined && rememberMatch[2].trim() !== '') {
        const kind = rememberMatch[1] ?? '事实'
        const extraTag = kind === '设定' ? 'setting' : kind === '黑话' ? 'glossary' : kind === '人物' ? 'person' : ''
        const rawContent = rememberMatch[2].trim()
        const content = '【' + kind + '】' + rawContent
        if (this.opts.config.memoryBackend === 'mnemon') {
          // mnemon 的记忆操作要求"本轮 turn 的 View"：插件在轮次外调会被拒，
          // 所以把请求投给模型，让它在**本轮内**创建空间/写入（注入块里也给了规范）。
          const spaceId = await this.mem.ensureSpace(ref.key, chat.agent)
          const spaceName = this.opts.config.memorySpacePrefix + ref.key
          const tags = '["napcat","' + ref.key + '"' + (extraTag === '' ? '' : ',"' + extraTag + '"') + ']'
          const steps = spaceId !== undefined
            ? '直接调用 mnemon_remember({ memoryBodyId: "' + spaceId + '", content: <下面内容>, tags: ' + tags + ' })'
            : '本群还没有记忆空间，按顺序执行：\n'
              + '1) mnemon_memory_body_create({ name: "' + spaceName + '", description: "QQ ' + ref.key + ' 的长期记忆" })\n'
              + '2) mnemon_memory_body_update({ memoryBodyId: <上一步的 id>, active: true })\n'
              + '3) napcat_memory_space({ group_id: "' + ref.id + '", space_id: <同一个 id> })   ← 让插件记住这个 id\n'
              + '4) mnemon_remember({ memoryBodyId: <同一个 id>, content: <下面内容>, tags: ' + tags + ' })'
          await this.dispatch(chat, '[记忆请求]（类别：' + kind + '）把下面这条信息写入本群长期记忆。\n' + steps + '\n\n内容（含【' + kind + '】前缀，请原样写入）：' + content + '\n\n完成后只回一句「已记住」即可。', [], [])
          return
        }
        const ok = await this.mem.remember(ref.key, content, chat.agent, ['group:' + ref.id])
        await this.sendText(chat, '✅ ' + ok)
        return
      }
      if (/^记忆\s*$/.test(commandText)) {
        if (this.opts.config.memoryBackend === 'mnemon') {
          // mnemon 的读取需要本轮 View，插件在轮次外调用必失败 → 交给模型在轮内显式回忆
          const spaceId = await this.mem.ensureSpace(ref.key, chat.agent)
          const recentForQuery = await this.mem.readRecent(ref.key, 5)
          await this.dispatch(chat,
            '[记忆查询] 请用 mnemon_recall 检索本群长期记忆并直接回答用户。\n'
            + '空间 id：' + (spaceId ?? '（未配置，见上文说明）') + '\n'
            + '查询词（可用最近群聊推断）：' + (recentForQuery.join(' ') || '本群记忆')
            + '\n如果检索不到，就直说「本群还没有相关记忆」；不要把工具报错原文发给用户。',
            [], [])
          return
        }
        const recentForQuery = await this.mem.readRecent(ref.key, 10)
        const recalled = await this.mem.recall(ref.key, recentForQuery.join(' '), chat.agent)
        await this.sendText(chat, recalled === '' ? '本群还没有长期记忆' : '本群记忆（相关片段）：\n' + recalled)
        return
      }
    }

    const media = await this.resolveInboundMedia(msg, chat)
    const textWithoutImageMarkers = rawText.replace(/\[图片\]/g, '').replace(/\n{2,}/g, '\n').trim()
    let memoryBlock = ''
    if (this.opts.config.memoryEnabled) {
      try {
        const recent = await this.mem.readRecent(ref.key)
        const history = recent.slice(0, Math.max(0, recent.length - 1))
        const query = history.slice(-5).join(' ')
        const recalled = query === '' ? '' : await this.mem.recall(ref.key, query, chat.agent)
        const spaceId = await this.mem.ensureSpace(ref.key, chat.agent)
        memoryBlock = this.mem.buildInjection({ chatKey: ref.key, recent: history, recallText: recalled, spaceId })
      } catch (error) {
        this.opts.log('debug', '记忆注入失败: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    const text = [memoryBlock, textWithoutImageMarkers, ...media.notes].filter(part => part !== '').join('\n\n')
    if (text.trim() === '') {
      this.opts.log('debug', '空消息（无文本也没有可下载的媒体），跳过: ' + ref.key)
      return
    }
    const sentId = String(msg.message_id ?? '')
    chat.lastReplyId = sentId
    if (sentId !== '') {
      chat.recentReplyIds = [...(chat.recentReplyIds ?? []), sentId].slice(-30)
    }
    this.dispatch(chat, text, media.blocks, media.parts)
  }

  /** 写一行诊断到 <会话cwd>/napcat-inbox/_image-debug.log（出问题时能自查，用户随时可删）。 */
  private debugLog(cwd: string | undefined, note: string): void {
    try {
      const dir = cwd ?? join(normalizePath(this.opts.config.workspacePath) || process.cwd(), 'napcat')
      void appendFile(join(dir, 'napcat-inbox', '_image-debug.log'),
        new Date().toISOString() + ' v0.3.7 ' + note + '\n').catch(() => undefined)
    } catch {
      // 诊断日志写不了就算了
    }
  }
  /** 宿主会话 id → QQ 会话 key（工具省略 chat_id 时用来定位当前会话）。 */
  keyForSession(sessionId: string): string | undefined {
    return this.bySession.get(sessionId)
  }
  /** 把消息里的图片/文件下载到会话收件箱，返回给模型的文本注释（[图片: path]）。 */
  private async resolveInboundMedia(msg: ObMessageEvent, chat: ChatState): Promise<{ notes: string[]; blocks: ContentBlock[]; parts: Array<Record<string, unknown>> }> {
    const media = segmentsOf(msg.message).filter(seg => seg.type === 'image' || seg.type === 'file')
    // 引用回复：被引用的那条消息里的图/文件不在当前 segments 里，用 get_msg 取回来
    const replySeg = segmentsOf(msg.message).find(seg => seg.type === 'reply')
    const replyId = replySeg === undefined ? '' : String((replySeg.data as { id?: unknown } | undefined)?.id ?? '')
    if (replyId !== '') {
      try {
        const quoted = await this.opts.conn.call<{ message?: unknown }>('get_msg', { message_id: replyId })
        const quotedMedia = segmentsOf(quoted?.message as never).filter(seg => seg.type === 'image' || seg.type === 'file')
        if (quotedMedia.length > 0) {
          media.push(...quotedMedia)
          this.debugLog(undefined, '引用消息带媒体 n=' + quotedMedia.length)
        }
      } catch (error) {
        this.debugLog(undefined, 'get_msg 失败: ' + describe(error))
      }
    }
    const blocks: ContentBlock[] = []
    const parts: Array<Record<string, unknown>> = []
    if (media.length === 0) return { notes: [], blocks, parts }
    let cwd = chat.cwd
    if (cwd === undefined) {
      cwd = await this.cwdFor(chat.ref)
      chat.cwd = cwd
    }
    const inbox = await ensureInbox(cwd)
    this.debugLog(cwd, '收到媒体 segments=' + media.length)
    const notes: string[] = []
    for (const seg of media) {
      const data = (seg.data ?? {}) as { file?: unknown }
      const fileRef = String(data.file ?? '')
      try {
        if (seg.type === 'image') {
          const info = await this.opts.conn.call<{ url?: string; file?: string }>('get_image', { file: fileRef })
          const url = info?.url
          if (url === undefined || url === '') throw new Error('get_image 没有返回 url')
          const saved = await downloadToFile(url, inbox, nameFromRef(fileRef, 'image.png'), DEFAULT_MAX_IMAGE_BYTES)
          this.opts.log('info', '收到图片 → ' + saved.path + ' (' + Math.round(saved.bytes / 1024) + 'KB)')
          // 走 DSH 原生附件：图片作为 image block 进模型请求；纯文本模型由宿主降级为占位文本
          const buffer = await readFile(saved.path)
          const mediaType = imageMediaType(buffer)
          this.debugLog(cwd, '图片已下载 bytes=' + buffer.byteLength + ' type=' + String(mediaType))
          // 走宿主官方 prompt 附件准入（GUI 上传图片的同一入口）
          const ctxAny = this.opts.ctx as unknown as { get?(name: string): unknown; attachments?: unknown }
          const attachments = (ctxAny.get?.('attachments') ?? ctxAny.attachments) as {
            admitPromptContent?(parts: Array<{ type: 'image'; mediaType: string; data: string; name?: string }>): Promise<unknown[]>
          } | undefined
          let attached = false
          if (mediaType !== undefined && attachments?.admitPromptContent !== undefined) {
            try {
              const admitted = await attachments.admitPromptContent([
                { type: 'image', mediaType, data: buffer.toString('base64'), name: nameFromRef(fileRef, 'image') },
              ])
              for (const part of admitted) {
                if ((part as { type?: string }).type === 'image') blocks.push(part as ContentBlock)
              }
              attached = blocks.length > 0
              this.debugLog(cwd, 'admit ok admitted=' + admitted.length + ' blocks=' + blocks.length)
              if (attached) parts.push({ type: 'image', mediaType, data: buffer.toString('base64'), name: nameFromRef(fileRef, 'image') })
              this.opts.log('debug', '图片已走 admitPromptContent，产出 ' + admitted.length + ' 段')
            } catch (error) {
              this.debugLog(cwd, 'admit 失败: ' + describe(error))
              this.opts.log('warn', 'admitPromptContent 失败: ' + describe(error))
            }
          } else if (mediaType === undefined) {
            this.opts.log('warn', '图片类型无法识别（不是 png/jpeg/gif/webp），只给路径')
          } else {
            this.debugLog(cwd, '宿主没有 admitPromptContent')
            this.opts.log('warn', '宿主没有 attachments.admitPromptContent，只给路径')
          }
          // 路径注释永远保留：无视觉模型只会拿到宿主的占位文本，路径是它们唯一的抓手；
          // 视觉模型另外还能直接拿到 image block。
          notes.push('[图片: ' + saved.path + ']' + (attached ? '' : '（未登记为附件，仅路径）'))
        } else {
          // NapCat 在远端（常见于 Docker）：get_file 的 url 可能是它**本机路径**，不能 fetch。
          // 顺序照 dsh-onebot：①私聊 get_private_file_url 的 CDN 链接 ②get_file 的 base64 ③http url
          const isHttp = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//i.test(v)
          const fileName = nameFromRef(fileRef, 'file')
          let savedPath: string | undefined
          const failures: string[] = []
          if (chat.ref.kind === 'private') {
            try {
              const direct = await this.opts.conn.call<{ url?: string }>('get_private_file_url', {
                user_id: chat.ref.id,
                file_id: fileRef,
              })
              if (isHttp(direct?.url)) {
                const saved = await downloadToFile(direct.url, inbox, fileName, DEFAULT_MAX_FILE_BYTES)
                savedPath = saved.path
                this.debugLog(cwd, '文件走 get_private_file_url')
              }
            } catch (error) {
              failures.push('get_private_file_url: ' + describe(error))
            }
          }
          if (savedPath === undefined) {
            const info = await this.opts.conn.call<{ base64?: string; url?: string; file?: string }>('get_file', { file: fileRef })
            if (typeof info?.base64 === 'string' && info.base64 !== '') {
              const buffer = base64UrlToBuffer(info.base64)
              if (buffer.byteLength > DEFAULT_MAX_FILE_BYTES) throw new Error('文件超过上限')
              savedPath = join(inbox, Date.now().toString(36) + '-' + fileName)
              await writeFile(savedPath, buffer)
              this.debugLog(cwd, '文件走 get_file base64')
            } else if (isHttp(info?.url)) {
              const saved = await downloadToFile(info.url, inbox, fileName, DEFAULT_MAX_FILE_BYTES)
              savedPath = saved.path
              this.debugLog(cwd, '文件走 get_file url')
            } else if (typeof info?.url === 'string' && info.url !== '') {
              // 远端 NapCat 的本地路径：拿不到字节，给出明确原因让模型能向用户解释
              throw new Error('NapCat 只给了它本机的路径（' + info.url + '），跨机器取不到；可在 NapCat 里开启文件直链或改用图片发送')
            }
          }
          if (savedPath === undefined) {
            throw new Error('get_file 既没有 base64 也没有可下载的 url' + (failures.length > 0 ? '（' + failures.join('；') + '）' : ''))
          }
          this.opts.log('info', '收到文件 → ' + savedPath)
          notes.push('[文件: ' + savedPath + ']')
        }
      } catch (error) {
        const reason = describe(error)
        this.opts.log('warn', '收媒体失败（' + seg.type + '）: ' + reason)
        notes.push('[' + (seg.type === 'image' ? '图片' : '文件') + ': 下载失败（' + reason + '）]')
      }
    }
    return { notes, blocks, parts }
  }
  // ── 会话装配 ───────────────────────────────────────────────────────────────

  /** 同一聊天并发进来时只装配一次（并发 create 会撞 write handle）。 */
  private readonly pendingChats = new Map<string, Promise<ChatState>>()

  private ensureChat(ref: ChatRef): Promise<ChatState> {
    const existing = this.chats.get(ref.key)
    if (existing !== undefined) return Promise.resolve(existing)
    const inflight = this.pendingChats.get(ref.key)
    if (inflight !== undefined) return inflight
    const job = this.createChat(ref).finally(() => { this.pendingChats.delete(ref.key) })
    this.pendingChats.set(ref.key, job)
    return job
  }

  private async createChat(ref: ChatRef): Promise<ChatState> {
    const existing = this.chats.get(ref.key)
    if (existing !== undefined) return existing

    const agents = (this.opts.ctx as HostContext).agents
    const cwd = await this.cwdFor(ref)
    const suffix = this.sessionSuffixes.get(ref.key)
    // 把 cwd 编进会话 id：改过 workspacePath/开关后自然换新会话，不会 resume 到旧 cwd 的半死会话
    const cwdTag = this.opts.config.perChatWorkspace && this.opts.config.workspacePath.trim() !== ''
      ? '-w' + shortHash(cwd)
      : ''
    let sessionId = makeSessionId(
      sessionIdForChat(ref.key) + cwdTag + (suffix === undefined ? '' : '-' + suffix),
    )
    // 用户归档过这个会话 → 不解除归档（尊重你的意图），改用**确定性**后缀的新会话：
    // -r1、-r2… 逐个试，取第一个没被归档的。这样重启后还是同一个，不会每次换新。
    if (this.isArchived(String(sessionId))) {
      const base = sessionIdForChat(ref.key) + cwdTag
      for (let n = 1; n <= 99; n += 1) {
        const candidate = makeSessionId(base + '-r' + n)
        if (this.isArchived(String(candidate))) continue
        sessionId = candidate
        this.sessionSuffixes.set(ref.key, 'r' + n)
        this.opts.log('info', '会话已被归档，改用未归档的会话: ' + String(sessionId))
        break
      }
    }
    // 宿主注册表里已有活着的 agent（上一轮装配失败/并发场景）→ 直接复用，
    // 否则 resume/create 会撞 "already owned by an active write handle" / "already exists"
    let handle: { agent: Agent; dispose(): Promise<void> } | undefined
    const liveAgent = (agents as unknown as { get?(id: never): unknown }).get?.(String(sessionId) as never) as Agent | undefined
    if (liveAgent !== undefined) {
      this.opts.log('info', '复用已存在的 agent: ' + String(sessionId))
      handle = { agent: liveAgent, dispose: async () => undefined }
    }
    const meta: { cwd: string; agentPreset?: string } = { cwd }
    if (this.opts.config.agentPreset !== '') meta.agentPreset = this.opts.config.agentPreset
    const agentOptions: AgentOptions = {}
    // 照 dsh-onebot：优先用宿主默认模型服务；插件配置里的 provider/model 覆盖它
    const defaultModel = (this.opts.ctx as unknown as {
      agentDefaultModel?: { currentSelection?(): { provider?: string; model?: string; reasoningEffort?: string } | undefined }
    }).agentDefaultModel
    let selection = defaultModel?.currentSelection?.()
    if (selection !== undefined) {
      agentOptions.provider = selection.provider
      agentOptions.model = selection.model
    }
    if (this.opts.config.provider !== '') agentOptions.provider = this.opts.config.provider
    if (this.opts.config.model !== '') agentOptions.model = this.opts.config.model
    if (agentOptions.provider !== undefined && agentOptions.model !== undefined) {
      selection = { provider: agentOptions.provider, model: agentOptions.model, ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
    }
    const selectionRef = selection === undefined ? undefined : { current: selection, assembled: undefined }
    // setup：把预设挂进 agent 的 ctx，并安装模型选择（dsh-onebot 同款）
    const presetId = this.opts.config.agentPreset.trim() === '' ? undefined : this.opts.config.agentPreset.trim()
    const presets = (this.opts.ctx as unknown as { agentPresets?: { mount?(target: unknown, id?: string): Promise<{ id?: string }> } }).agentPresets
    if (presets?.mount === undefined) this.opts.log('warn', '宿主没有 agentPresets 服务（agent 可能没有工具/loop）')
    const setup = async (agentCtx: unknown): Promise<void> => {
      if (presets?.mount !== undefined) {
        try {
          const mounted = await presets.mount(agentCtx, presetId)
          this.opts.log('debug', 'agent 已挂预设: ' + String(mounted?.id ?? presetId ?? 'default'))
        } catch (error) {
          this.opts.log('warn', '挂预设失败: ' + describe(error))
        }
      }
      if (selectionRef === undefined) {
        this.opts.log('warn', '没有可用模型（agentDefaultModel 缺失或未选择），这一轮可能空跑')
      } else {
        installModelSelection(agentCtx as never, selectionRef as never)
        this.opts.log('debug', 'agent 模型: ' + selectionRef.current.provider + '/' + selectionRef.current.model)
      }
    }
    if (agentOptions.model === undefined) {
      this.opts.log('warn', '没有可用的模型：在「设置 → NapCat」里填 provider/model，或先给 DSH 配一个默认模型')
    }

    let created = true
    if (handle === undefined) {
    // 照 dsh-onebot：先用 sessionPersistence.stat 探测是否已有持久化日志，避免 create 抛错
    let exists = false
    const persistence = (this.opts.ctx as unknown as {
      sessionPersistence?: { stat?(id: unknown): Promise<object | undefined> }
    }).sessionPersistence
    if (persistence?.stat !== undefined) {
      try {
        exists = (await persistence.stat(sessionId)) !== undefined
      } catch {
        exists = false
      }
    }
    if (exists) {
      try {
        created = false
        handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      } catch (error) {
        this.opts.log('warn', '预检到日志但 resume 失败，改 create: ' + describe(error))
        created = true
        exists = false
        handle = await agents.create({ sessionId, meta, agentOptions, setup })
      }
    } else try {
      handle = await agents.create({ sessionId, meta, agentOptions, setup })
    } catch (error) {
      this.opts.log('warn', '创建会话失败（多半是同 id 已有持久化日志），改用 resume: ' + describe(error))
      created = false
      handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    }
    }

    // 照 dsh-onebot：create/resume 后必须等 agent 就绪（whenIdle）再投递消息，
    // 否则 followup 落不到正在初始化的 agent 上，表现为"消息进去了但这一轮不跑"
    try {
      await handle.agent.whenIdle()
    } catch (error) {
      try {
        await handle.dispose()
      } catch {
        // 以 whenIdle 的错误为准
      }
      throw error
    }

    // QQ 渠道没人能点"同意"：审批策略设为 never（否则每轮 turn 会被 blocked）
    try {
      const approval = (this.opts.ctx as unknown as {
        approval?: { setPolicy?(agent: unknown, policy: 'ask' | 'never'): void }
      }).approval
      if (approval?.setPolicy !== undefined) {
        approval.setPolicy(handle.agent, 'never')
        this.opts.log('debug', '审批策略已设为 never（QQ 会话无法交互审批）')
      } else {
        this.opts.log('warn', '宿主没有 approval.setPolicy（可能仍会被审批挡住）')
      }
    } catch (error) {
      this.opts.log('warn', '设置审批策略失败: ' + describe(error))
    }

    const state: ChatState = {
      ref,
      cwd,
      agent: handle.agent,
      dispose: () => handle.dispose(),
      buffer: [],
      lastReplyId: '',
      recentReplyIds: [],
      fresh: created,
      turnStarted: false,
      retried: false,
    }

    this.chats.set(ref.key, state)
    this.bySession.set(String(handle.agent.session.id), ref.key)
    // 新会话也要立刻套用群/人设（否则只有"保存设置"时才会补上）
    {
      const persona = this.personas.get(ref.key)
      if (persona !== undefined && persona !== '') this.personaBySession.set(String(handle.agent.session.id), persona)
      else this.personaBySession.delete(String(handle.agent.session.id))
    }
    // 侧边栏工作区需要显式挂载会话（否则显示未分组）
    await this.attachToWorkspace(cwd, workspaceTitle(ref), handle.agent.session.id)
    this.opts.log('info', '会话就绪: ' + ref.key + ' → ' + String(handle.agent.session.id) + ' (cwd=' + cwd + ')')
    return state
  }

  /**
   * 把会话挂进工作区：宿主要求 **工作区路径必须等于会话 cwd**，所以每个聊天目录本身就是
   * 一个工作区（一群一格 / 一人一格）。照 dsh-onebot：resolveByPath → create(path,title) → attachSession。
   */
  /** 该会话是否已被归档（归档门禁会把每一轮判成 blocked，所以要换新会话）。 */
  private isArchived(sessionId: string): boolean {
    try {
      const registry = (this.opts.ctx as unknown as {
        workspaceRegistry?: { archivedSessionIds?: readonly unknown[] }
      }).workspaceRegistry
      const ids = registry?.archivedSessionIds ?? []
      return ids.some(id => String(id) === sessionId)
    } catch {
      return false
    }
  }
  /** 重新解析 personaOverrides（配置热更新时调用）。 */
  refreshPersonas(): void {
    this.personas = parsePersonaOverrides(this.opts.config.personaOverrides)
    for (const [sessionId, chatKey] of this.bySession) {
      const text = this.personas.get(chatKey)
      if (text === undefined || text === '') this.personaBySession.delete(sessionId)
      else this.personaBySession.set(sessionId, text)
    }
  }

  /** systemPrompt.context 的取值函数：按 assembly 里的 sessionId 找该会话的人设。 */
  personaText(assembly: { agent?: { session?: { id?: unknown } } } | undefined): string {
    const id = assembly?.agent?.session?.id
    if (id === undefined) return ''
    const persona = this.personaBySession.get(String(id)) ?? ''
    if (persona === '') return ''
    // 人设只控制语气/称呼/风格：不许复述设定本身，也不许拿它当自我介绍
    return '（角色设定：只用于把握语气、称呼与说话风格。不要在回复里复述、引用或解释这份设定，不要自称"我是…团宠/助手"之类；用户问"你是谁"时用一两句自然的话回答即可。）\n'
      + persona
  }
  private async attachToWorkspace(cwd: string, title: string, sessionId: unknown): Promise<void> {
    try {
      const registry = (this.opts.ctx as unknown as {
        workspaceRegistry?: {
          resolveByPath?(path: string): Promise<{ path?: string; attachSession?(id: string): Promise<void> } | undefined>
          create?(path: string, title?: string): Promise<{ path?: string; attachSession?(id: string): Promise<void> }>
        }
      }).workspaceRegistry
      if (registry === undefined) {
        this.opts.log('warn', '宿主没有 workspaceRegistry 服务（无法挂工作区）')
        return
      }
      let workspace = await registry.resolveByPath?.(cwd)
      if (workspace === undefined && registry.create !== undefined) {
        workspace = await registry.create(cwd, title)
        this.opts.log('info', '已创建分组（工作区）: ' + title + ' → ' + cwd)
      }
      if (workspace?.attachSession === undefined) {
        this.opts.log('warn', '工作区对象不可挂载: ' + cwd)
        return
      }
      await workspace.attachSession(String(sessionId))
      this.opts.log('info', '会话已挂到分组: ' + String(workspace.path ?? cwd))
    } catch (error) {
      this.opts.log('warn', '挂工作区失败: ' + describe(error))
    }
  }
  /** 会话工作目录：开了 perChatWorkspace 时每个 QQ 会话一个子目录（侧边栏按工作区归拢）。 */
  private async cwdFor(ref: ChatRef): Promise<string> {
    const base = this.opts.config.workspacePath.trim()
    if (base === '') return process.cwd()
    if (!this.opts.config.perChatWorkspace) return base
    const safe = ref.key.replace(/[^A-Za-z0-9._-]+/g, '-')
    const dir = join(base, 'napcat', safe)
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      this.opts.log('warn', '创建会话目录失败，退回工作区根目录: ' + describe(error))
      return base
    }
    return dir
  }

  private dispatch(chat: ChatState, text: string, blocks: ContentBlock[] = [], parts: Array<Record<string, unknown>> = []): void {
    this.debugLog(chat.cwd, 'dispatch 进入 ref=' + chat.ref.key + ' text=' + text.length + '字 blocks=' + blocks.length + ' parts=' + parts.length)
    chat.buffer = []
    chat.lastText = text
    // 每次投递前重新断言「免审批」：用户在 GUI 换过权限档位也能继续工作
    try {
      const approval = (this.opts.ctx as unknown as {
        approval?: { setPolicy?(agent: unknown, policy: 'ask' | 'never'): void }
      }).approval
      approval?.setPolicy?.(chat.agent, 'never')
    } catch {
      // 尽力而为；失败时后续仍会按原策略走
    }
    if (chat.titleSet !== true) {
      chat.titleSet = true
      try {
        const titles = (this.opts.ctx as unknown as {
          sessionTitle?: { rename?(session: unknown, title: string): { title?: string } }
        }).sessionTitle
        const named = titles?.rename?.(chat.agent.session, titleFrom(text))
        this.opts.log('debug', '会话标题: ' + String(named?.title ?? titleFrom(text)))
      } catch (error) {
        this.opts.log('debug', '设置会话标题失败: ' + describe(error))
      }
    }
    if (parts.length > 0) this.debugLog(chat.cwd, '图片消息 blocks=' + blocks.length + ' parts=' + parts.length)
    let pending: unknown
    try {
      pending = chat.agent.followup(createUserMessage({
        // 图片块放在文本之前（与 dsh-qqbot 一致；text 在前时日志里只剩 text）
        content: [...blocks, { type: 'text', text }],
        source: { kind: 'plugin:dsh-napcat' },
      }))
      this.opts.log('info', '已投递到模型: ' + chat.ref.key + ' (' + text.length + ' 字)')
    } catch (error) {
      this.opts.log('warn', '投递失败: ' + describe(error))
      void this.recoverChat(chat, error)
      return
    }
    // followup 可能是异步的（会话被归档/删除、agent 已释放时会 reject）——必须接住，否则消息静默丢失
    if (pending !== null && typeof pending === 'object' && typeof (pending as { then?: unknown }).then === 'function') {
      void (pending as Promise<unknown>).catch((error: unknown) => {
        this.opts.log('warn', '投递被拒: ' + describe(error))
        void this.recoverChat(chat, error)
      })
    }
    chat.dispatchedAt = Date.now()
    // 新建的会话一般不会失效；只有 resume 回来的旧会话（可能已归档）才需要看门狗
    if (chat.fresh !== true) this.armWatchdog(chat, text)
  }

  /** 10s 内没等到 turn/start 就认为会话已失效（典型：会话被归档），换新会话重投一次。 */
  private armWatchdog(chat: ChatState, text: string): void {
    if (chat.startTimer !== undefined) clearTimeout(chat.startTimer)
    chat.turnStarted = false
    chat.startTimer = setTimeout(() => {
      chat.startTimer = undefined
      if (this.stopped) return
      const alive = chat.turnStarted === true || (chat.lastEventAt ?? 0) > (chat.dispatchedAt ?? 0)
      if (alive) return
      this.opts.log('warn', '会话没有开始执行（可能已归档或失效），换新会话重投: ' + chat.ref.key)
      void this.recoverAndRetry(chat, text)
    }, WATCHDOG_MS)
  }

  /** 会话失效后：重建会话并把这条消息再投一次（每条消息只重试一次）。 */
  private async recoverAndRetry(chat: ChatState, text: string): Promise<void> {
    const ref = chat.ref
    if (chat.retried === true) {
      await this.sendText(chat, '⚠️ 会话没有响应，已换新会话仍失败，请稍后再试')
      return
    }
    await this.recoverChat(chat, new Error('会话没有开始执行'))
    try {
      const fresh = await this.ensureChat(ref)
      fresh.retried = true
      this.dispatch(fresh, text)
    } catch (error) {
      this.opts.log('warn', '重建会话失败: ' + describe(error))
    }
  }

  /** 投递失败（归档/删除/agent 释放）：丢掉旧会话状态，下次消息重新建会话，并告知用户。 */
  private async recoverChat(chat: ChatState, error: unknown, notify = true): Promise<void> {
    if (chat.startTimer !== undefined) {
      clearTimeout(chat.startTimer)
      chat.startTimer = undefined
    }
    // 换一个会话 id：否则 create 会撞上归档/失效的旧 id，又 resume 回那个死会话
    this.sessionSuffixes.set(chat.ref.key, Date.now().toString(36))
    this.chats.delete(chat.ref.key)
    for (const [sid, key] of [...this.bySession]) {
      if (key === chat.ref.key) this.bySession.delete(sid)
    }
    try {
      await chat.dispose()
    } catch {
      // agent 可能已被宿主释放，忽略
    }
    if (notify) await this.sendText(chat, '⚠️ 消息没送进模型：' + describe(error) + '\n（会话状态已重置，再发一条会重新建会话）')
  }
  // ── 出站 ───────────────────────────────────────────────────────────────────

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.stopped) return
    const key = this.bySession.get(String(session.id))
    if (key === undefined) {
      if (String(session.id).includes('napcat')) this.opts.log('debug', '事件找不到会话映射: ' + String(session.id) + ' type=' + String(event.type))
      return
    }
    this.opts.log('debug', '出站事件: ' + String(event.type) + ' ← ' + key)
    const chat = this.chats.get(key)
    if (chat === undefined) return
    // 任何事件都说明这一轮在跑（turn/start 未必总能收到）
    chat.lastEventAt = Date.now()

    if (event.type === 'turn/start') {
      chat.buffer = []
      return
    }
    if (event.type === 'assistant/message') {
      const text = messageText(event.data.message)
      this.opts.log('debug', '助手文本长度: ' + text.length)
      if (text.trim() !== '') chat.buffer.push(text.trim())
      return
    }
    if (event.type === 'assistant/attempt') {
      const stream = (event.data as { stream?: unknown }).stream
      this.opts.log('warn', '一次模型尝试未提交（无正式回复）: ' + JSON.stringify(stream ?? {}).slice(0, 400))
      return
    }

    if (event.type === 'turn/end') {
      this.opts.log('debug', 'turn/end 原因: ' + JSON.stringify((event.data as { reason?: unknown }).reason ?? {}).slice(0, 400))
      const reason = event.data.reason
      let text = chat.buffer.join('\n').trim()
      chat.buffer = []
      // 主动发言：拦截 __SKIP__，并记录发言/跳过
      if (this.pendingProactive.delete(key)) {
        const state = this.proactiveStates.get(key) ?? newChatState()
        const now = Date.now()
        if (text === '' || /__SKIP__/i.test(text)) {
          state.skipStreak += 1
          state.lastConsiderAt = now
          this.proactiveStates.set(key, state)
          this.opts.log('info', '主动发言跳过（模型认为没必要）: ' + key + ' skipStreak=' + state.skipStreak)
          if (text === '' && reason.kind === 'error') {
            this.opts.log('debug', '主动发言轮次出错（忽略）: ' + reason.error.message)
          }
          return
        }
        state.skipStreak = 0
        state.lastSpokeAt = now
        state.sentAt = pruneSentAt([...state.sentAt, now], now)
        state.lastConsiderAt = now
        this.proactiveStates.set(key, state)
        this.opts.log('info', '主动发言已发出: ' + key + '（本小时第 ' + state.sentAt.length + ' 条）')
      }
      if (text !== '') {
        void this.sendText(chat, text)
      } else if (reason.kind === 'error') {
        void this.sendText(chat, '⚠️ 本轮出错：' + reason.error.message)
          // 会话存储文件被外部删掉时会 ENOENT：丢状态 + 换新 id，下一条消息自然新建日志
          if (/ENOENT|no such file/i.test(reason.error.message)) {
            this.opts.log('warn', '会话存储文件丢失，丢弃会话状态并用新会话重投: ' + chat.ref.key)
            const text = chat.lastText
            if (text !== undefined && text !== '') void this.recoverAndRetry(chat, text)
            else void this.recoverChat(chat, reason.error, false)
          }
      }
      return
    }
  }

  /**
   * 探测本群机器人是否被禁言（群聊）。
   * 来源：get_group_member_info 的 shut_up_timestamp（秒）+ get_group_info 的 group_all_shut（全员禁言）。
   * 返回解禁时间戳（毫秒）：未禁言 = 0；查不到 = undefined（此时不做任何暂停）。
   */
  private async probeMute(ref: ChatRef): Promise<number | undefined> {
    if (ref.kind !== 'group') return undefined
    const selfId = await this.selfQq()
    if (selfId === '') return undefined
    try {
      const member = await this.opts.conn.call<{ shut_up_timestamp?: number }>('get_group_member_info', {
        group_id: ref.id,
        user_id: selfId,
        no_cache: true,
      })
      const until = Number(member?.shut_up_timestamp ?? 0)
      if (Number.isFinite(until) && until * 1000 > Date.now()) return until * 1000
    } catch {
      // 查不到成员信息就继续看全员禁言
    }
    try {
      const info = await this.opts.conn.call<{ group_all_shut?: number }>('get_group_info', { group_id: ref.id, no_cache: true })
      if (Number(info?.group_all_shut ?? 0) > 0) return Date.now() + 15 * 60_000
    } catch {
      // 忽略
    }
    return 0
  }

  /** 机器人自己的 QQ：配置优先，未配置时用 get_login_info 取一次并缓存。 */
  private async selfQq(): Promise<string> {
    const configured = this.opts.config.botQQ.trim()
    if (configured !== '') return configured
    if (this.selfQqCache !== '') return this.selfQqCache
    try {
      const info = await this.opts.conn.call<{ user_id?: number | string }>('get_login_info')
      const id = String(info?.user_id ?? '').trim()
      if (id !== '') this.selfQqCache = id
      return id
    } catch {
      return ''
    }
  }

  /** 出站发送：小黄脸嵌在文字里（同一条消息），图片/表情包单独发。 */
  private async sendText(chat: ChatState, text: string): Promise<void> {
    // 群禁言期间直接不发（QQ 会拒，还白烧一轮模型）
    const mutedUntil = this.mutedUntil.get(chat.ref.key) ?? 0
    if (mutedUntil > Date.now()) {
      this.opts.log('info', '本群禁言中，暂停发送: ' + chat.ref.key + '（解禁 ' + new Date(mutedUntil).toLocaleTimeString('zh-CN') + '）')
      return
    }
    const plan = await this.planOutbound(chat, text)
    const groups = splitSegments(plan.segments, this.opts.config.splitMaxChars)
    const interval = this.opts.config.sendIntervalMs
    for (let index = 0; index < groups.length; index += 1) {
      const parts = groups[index] ?? []
      const message: ObSegment[] = []
      if (index === 0 && this.opts.config.replyAsQuote && chat.lastReplyId !== '') {
        message.push({ type: 'reply', data: { id: chat.lastReplyId } })
      }
      for (const part of parts) {
        message.push(part.kind === 'text' ? { type: 'text', data: { text: part.text } } : { type: 'face', data: { id: part.id } })
      }
      if (message.length === 0) continue
      const ok = await this.sendSegments(chat, message)
      if (!ok) return
      this.opts.log('info', '已发送到 QQ: ' + chat.ref.key + '（' + parts.length + ' 段）')
      if (interval > 0 && index < groups.length - 1) {
        await new Promise(resolve => setTimeout(resolve, interval))
      }
    }
    // 图片/表情包单独发（每张一条），图自己会说话
    for (const file of plan.images) {
      await this.sendImagePath(chat, file)
    }
  }

  /**
   * 出站预处理：把回复里的标记解析成「文字段 + 原生表情段」和「待发图片」。
   *   [图片:<路径>] / ![alt](<路径>)  → 收集为图片，解析后单独发
   *   [表情:<描述>]                   → 图库有图就当图片发；没图就换成 QQ 原生表情，**就地嵌进文字流**
   */
  private async planOutbound(chat: ChatState, text: string): Promise<{ segments: OutPart[]; images: string[] }> {
    const images: string[] = []
    const pushFile = (rawPath: string): void => {
      const cleaned = rawPath.trim().replace(/^<|>$/g, '')
      if (cleaned === '') return
      const baseDir = chat.cwd ?? normalizePath(this.opts.config.workspacePath) ?? process.cwd()
      const absolute = /^([A-Za-z]:[\\/]|\/)/.test(cleaned) ? cleaned : join(baseDir, cleaned)
      if (!existsSync(absolute)) {
        this.opts.log('warn', '要发送的图片不存在，已跳过: ' + cleaned)
        return
      }
      if (!images.includes(absolute)) images.push(absolute)
    }

    // 1) 先把图片标记摘掉（它们不进文字流）
    let body = text
      .replace(/\[图片:([^\]]+)\]/g, (_match, raw: string) => {
        for (const part of raw.split(/[,，]/)) pushFile(part)
        return ''
      })
      .replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_match, raw: string) => {
        pushFile(raw)
        return ''
      })

    // 2) 再按 [表情:…] 切分文字流，小黄脸就地插进去
    const segments: OutPart[] = []
    const pattern = /\[表情:\s*([^\]]*)\]/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(body)) !== null) {
      const before = body.slice(last, match.index)
      if (before !== '') segments.push({ kind: 'text', text: before })
      last = match.index + match[0].length
      const query = (match[1] ?? '').trim()
      let resolved = false
      if (this.opts.config.memeEnabled && query !== '') {
        const hit = await this.resolveMeme(query)
        if (hit !== undefined) {
          pushFile(hit)
          resolved = true
        }
      }
      if (!resolved && this.opts.config.faceFallback) {
        const faceId = faceFor(query, this.recentFaceIds)
        if (faceId !== undefined) {
          segments.push({ kind: 'face', id: faceId })
          this.noteFaceSent(faceId)
          resolved = true
        }
      }
      if (!resolved && this.opts.config.faceFallback && query !== '') {
        // 连关键词都对不上：给一个轮换的"通用"表情，别让用户的 [表情:…] 白写
        const generic = faceFor('开心', this.recentFaceIds) ?? '14'
        segments.push({ kind: 'face', id: generic })
        this.noteFaceSent(generic)
        resolved = true
        this.opts.log('info', '表情描述匹配不到，改用通用表情 face ' + generic + ': ' + query)
      }
      if (!resolved && query !== '') this.opts.log('info', '表情已丢弃（图库/表情都不可用）: ' + query)
    }
    const tail = body.slice(last)
    if (tail !== '') segments.push({ kind: 'text', text: tail })

    // 3) 规整文字段（去多余空行；纯空白段丢掉）
    const cleaned: OutPart[] = []
    for (const part of segments) {
      if (part.kind === 'face') {
        cleaned.push(part)
        continue
      }
      const value = part.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
      if (value.trim() !== '') cleaned.push({ kind: 'text', text: value })
    }
    return { segments: trimParts(cleaned), images }
  }

  /**
   * 计算"避重集合"：默认按图库大小自适应（约一半），图库变大窗口自动变宽，
   * 不用手动调；`memeRecentLimit` 设正数则固定，设 0 则不避重。
   */
  private async memeAvoidSet(): Promise<Set<string>> {
    const configured = Math.floor(this.opts.config.memeRecentLimit)
    if (configured === 0) return new Set()
    let window = configured
    if (configured < 0) {
      const total = await this.memeLib().size()
      // 一半左右最舒服：太少会重复，太多会导致可选图变少反而更差
      window = Math.min(50, Math.max(1, Math.floor(total / 2)))
    }
    return new Set(this.recentMemeFiles.slice(0, Math.max(0, window)))
  }

  /** 按描述从 dsh-meme 图库找图；同一张最近发过就换一张同情绪的，避免来回重复。 */
  private async resolveMeme(query: string): Promise<string | undefined> {
    const library = this.memeLib()
    const avoid = await this.memeAvoidSet()
    const hits = await library.search(query, avoid, 8)
    // 优先没发过的那张；都发过就落到下面按情绪随机换一张，避免来回重复同一张
    const fresh = hits.find(hit => !avoid.has(hit.file))
    if (fresh !== undefined) {
      this.noteMemeSent(fresh.file)
      return fresh.file
    }
    // 描述匹配不上：退回"按情绪挑"（只认明确提到的情绪词，不再默认 daily）
    const guess = query.match(/开心|笑|好耶|满意|可爱|喜欢|卖萌|赞|棒/) ? 'happy'
      : query.match(/生气|怒|气死|讨厌|烦/) ? 'angry'
        : query.match(/难过|伤心|哭|委屈|求饶|唉/) ? 'sad'
          : query.match(/无语|汗|尴尬|无奈/) ? 'sigh'
            : query.match(/害羞|脸红|不好意思|羞/) ? 'shy'
              : query.match(/困惑|疑问|惊讶|震惊|懵/) ? 'confused'
                : query.match(/睡|困|晚安|累/) ? 'sleep'
                  : undefined
    if (guess !== undefined) {
      const fallback = await library.randomInTag(guess, avoid)
      if (fallback !== undefined) {
        this.noteMemeSent(fallback.file)
        return fallback.file
      }
    }
    // 情绪也匹配不上（或该情绪用光）：默认**不发不贴题的图**，交给上层退化成小黄脸/纯文字。
    // 想要"没匹配也随便发一张"就把 memeLooseFallback 打开。
    if (this.opts.config.memeLooseFallback) {
      const anywhere = await library.randomAny(avoid)
      if (anywhere !== undefined) {
        this.noteMemeSent(anywhere.file)
        return anywhere.file
      }
    }
    return undefined
  }

  /** 记录刚发过的原生表情（用于轮换，最多 8 个）。 */
  private noteFaceSent(faceId: string): void {
    this.recentFaceIds.unshift(faceId)
    while (this.recentFaceIds.length > 8) this.recentFaceIds.pop()
  }

  private noteMemeSent(file: string): void {
    // 只负责记录（最多存 50 条），实际用多少由 memeAvoidSet() 按图库大小自动决定
    this.recentMemeFiles.unshift(file)
    while (this.recentMemeFiles.length > 50) this.recentMemeFiles.pop()
  }

  /** 懒加载表情库（优先配置目录，否则扫 DSH_HOME 下各 profile 里的 dsh-meme）。 */
  private memeLib(): MemeLibrary {
    if (this.memeLibrary !== undefined) return this.memeLibrary
    const configured = this.opts.config.memeDirs
      .split(/[\n;,]/)
      .map(part => normalizePath(part))
      .filter(part => part !== '')
    const dshHome = (process.env.DSH_HOME ?? '').trim() !== '' ? normalizePath(process.env.DSH_HOME ?? '') : join(homedir(), '.dsh')
    const dirs = configured.length > 0 ? configured : defaultMemeDirs(dshHome)
    this.memeLibrary = new MemeLibrary(dirs, (level, message) => this.opts.log(level as LogLevel, message))
    return this.memeLibrary
  }

  /** 把本地图片文件作为图片消息发出去（带重试/禁言处理；dryRun 时只记日志）。 */
  private async sendImagePath(chat: ChatState, file: string): Promise<void> {
    if (this.opts.config.dryRun) {
      this.opts.log('info', '[dryRun] 本应发送图片: ' + chat.ref.key + ' ← ' + file)
      return
    }
    let url = ''
    let name = ''
    try {
      const packed = await localToBase64Url(file, this.opts.config.outboundImageMaxBytes)
      url = packed.url
      name = packed.name
    } catch (error) {
      this.opts.log('warn', '读取待发送图片失败: ' + describe(error))
      return
    }
    const message: ObSegment[] = [{ type: 'image', data: { file: url } }]
    const sent = await this.sendSegments(chat, message)
    if (sent) this.opts.log('info', '已发送图片到 QQ: ' + chat.ref.key + ' (' + name + ')')
  }

  /** 统一的发送入口：重试 + 禁言探测；dryRun 时只记日志并返回成功。 */
  private async sendSegments(chat: ChatState, message: ObSegment[]): Promise<boolean> {
    if (!this.opts.config.enabled) {
      this.opts.log('debug', '插件已禁用（enabled=false），跳过发送')
      return false
    }
    if (this.opts.config.dryRun) {
      this.opts.log('info', '[dryRun] 本应发送到 ' + chat.ref.key + ': ' + JSON.stringify(message.slice(0, 2)).slice(0, 200))
      return true
    }
    const attempts = 3
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.opts.conn.call('send_msg', {
          message_type: chat.ref.kind,
          ...(chat.ref.kind === 'group' ? { group_id: chat.ref.id } : { user_id: chat.ref.id }),
          message,
        })
        return true
      } catch (error) {
        const reason = describe(error)
        const transient = /EventChecker|result":\s*120|timeout|ECONN|socket/i.test(reason)
        if (attempt < attempts - 1 && transient) {
          const wait = 700 * (attempt + 1)
          this.opts.log('warn', '发送被 QQ 拒绝（第 ' + (attempt + 1) + ' 次），' + wait + 'ms 后重试: ' + chat.ref.key)
          await new Promise(resolve => setTimeout(resolve, wait))
          continue
        }
        const until = await this.probeMute(chat.ref)
        if (until !== undefined && until > Date.now()) {
          this.mutedUntil.set(chat.ref.key, until)
          this.opts.log('warn', '检测到机器人被禁言，暂停发送: ' + chat.ref.key + '（解禁 ' + new Date(until).toLocaleTimeString('zh-CN') + '）')
          return false
        }
        this.opts.log('warn', '发送失败: ' + chat.ref.key + ' — ' + reason)
        return false
      }
    }
    return false
  }
}

/** 从助手消息里抽纯文本（工具调用等非文本段忽略）。 */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const item = part as { type?: string; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('')
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
/** 路径归一化：**按当前平台**统一分隔符、去尾斜杠；Windows 额外小写（盘符/路径不区分大小写）。 */
function normalizePath(input: string): string {
  const trimmed = input.trim()
  if (process.platform === 'win32') {
    let value = trimmed.replace(/\//g, '\\')
    while (value.length > 1 && value.endsWith('\\')) value = value.slice(0, -1)
    return value.toLowerCase()
  }
  // Linux / macOS：一律正斜杠（否则会生成 \workspace\memory 这种非法路径）
  let value = trimmed.replace(/\\/g, '/')
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  return value
}
/** 工作区/分组标题：群 → 群 <号>；私聊 → 私聊 <QQ>。 */
function workspaceTitle(ref: ChatRef): string {
  const id = ref.key.replace(/^[a-z]+[:：]/, '')
  return ref.kind === 'group' ? '群 ' + id : '私聊 ' + id
}
/** 出站消息片段：文字或 QQ 原生表情（就地混排）。 */
export type OutPart = { kind: 'text'; text: string } | { kind: 'face'; id: string }

/** 去掉首尾纯空白文字段（表情段保留）。 */
export function trimParts(parts: OutPart[]): OutPart[] {
  const out = [...parts]
  while (out.length > 0) {
    const first = out[0]
    if (first === undefined || first.kind !== 'text') break
    const trimmed = first.text.replace(/^\s+/, '')
    if (trimmed === '') {
      out.shift()
      continue
    }
    out[0] = { kind: 'text', text: trimmed }
    break
  }
  while (out.length > 0) {
    const lastPart = out[out.length - 1]
    if (lastPart === undefined || lastPart.kind !== 'text') break
    const trimmed = lastPart.text.replace(/\s+$/, '')
    if (trimmed === '') {
      out.pop()
      continue
    }
    out[out.length - 1] = { kind: 'text', text: trimmed }
    break
  }
  return out
}

/**
 * 把混排片段按字数上限切成多条消息（表情不占字数、跟着当前条走）。
 * maxChars <= 0 表示不分段。
 */
export function splitSegments(parts: OutPart[], maxChars: number): OutPart[][] {
  const groups: OutPart[][] = []
  let current: OutPart[] = []
  let length = 0
  const flush = (): void => {
    if (current.length > 0) {
      groups.push(current)
      current = []
      length = 0
    }
  }
  for (const part of parts) {
    if (part.kind === 'face') {
      current.push(part)
      continue
    }
    let rest = part.text
    if (maxChars <= 0) {
      current.push({ kind: 'text', text: rest })
      length += rest.length
      continue
    }
    while (rest !== '') {
      const room = Math.max(1, maxChars - length)
      const piece = rest.slice(0, room)
      rest = rest.slice(piece.length)
      current.push({ kind: 'text', text: piece })
      length += piece.length
      if (length >= maxChars) flush()
    }
  }
  flush()
  return groups
}