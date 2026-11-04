/**
 * 游戏 wiki 联动（模型自决版）。
 *
 * 设计（2026-11-04 与用户确认）：
 *   ① 词表召回（零成本、代码）：dsh-game 用 wiki 全站标题建词表，识别群聊里的地名/道具名；
 *   ② 把命中结果 + 可用工具写进注入，交给**模型自己判断**：
 *        真在问攻略 → 调 game_wiki_search / game_wiki_read，用自己的话答（不贴来源）
 *        只是讨论     → 可以不查；查了也只当背景，不列点、不给教程、不说"wiki 上写着"
 *   ③ 插件不做阈值判定、不做预算限流：工具自身已有缓存与 6s 串行。
 *
 * 所有失败静默（没装 dsh-game / 词表没建 / 出错），绝不把错误甩到群里。
 */
import type { Context } from '@deepseek-ai/cordis'

/** dsh-game 暴露的服务（只依赖这一小部分） */
export interface GameService {
  list?: () => Array<{ name: string; aliases?: string[] }>
  /** 词表召回：返回命中的游戏与命中词（只召回，不判断） */
  detect?: (text: string) => Promise<Array<{ game: string; hits: string[]; pages?: string[] }>>
}

export interface GameHintOptions {
  ctx: Context
  enabled: boolean
  log: (level: 'debug' | 'info' | 'warn', message: string) => void
}

export class GameWiki {
  private readonly options: GameHintOptions

  constructor(options: GameHintOptions) {
    this.options = options
  }

  private service(): GameService | undefined {
    try {
      const get = this.options.ctx.get as ((name: string) => unknown) | undefined
      const svc = get?.('dshGame') as GameService | undefined
      if (svc === undefined || svc === null || typeof svc.detect !== 'function') return undefined
      return svc
    } catch {
      return undefined
    }
  }

  /**
   * 返回要注入的"话题线索"块；没有命中 / 未启用 / 服务不在 → undefined。
   * 注意：这里**不查 wiki**，只告诉模型"可能是这个游戏、这些词、可以这样查"。
   */
  async hintFor(text: string): Promise<string | undefined> {
    if (!this.options.enabled) return undefined
    const trimmed = text.trim()
    if (trimmed === '') return undefined
    const svc = this.service()
    const detect = svc?.detect
    if (detect === undefined) return undefined
    try {
      const candidates = await detect(trimmed)
      if (candidates.length === 0) return undefined
      const top = candidates.slice(0, 2)
      this.options.log('debug', '游戏词表命中：' + top.map(c => c.game + '[' + c.hits.join('/') + ']').join(' '))
      return buildHintBlock(top)
    } catch (error) {
      this.options.log('debug', '词表召回失败（静默跳过）: ' + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }
}

export interface Candidate {
  game: string
  hits: string[]
  pages?: string[]
}

/** 注入块：线索 + 工具用法 + 两种意图的不同要求 */
export function buildHintBlock(candidates: readonly Candidate[]): string {
  const lines = ['【话题线索·可能相关的游戏】']
  for (const candidate of candidates) {
    const words = candidate.hits.slice(0, 4).join('、')
    lines.push('· ' + candidate.game + '：命中「' + words + '」')
    const first = candidate.hits[0]
    if (first !== undefined) {
      lines.push('  可查：game_wiki_search(game="' + candidate.game + '", keyword="' + first + '")'
        + ' → game_wiki_read(game="' + candidate.game + '", title=命中标题)')
    }
  }
  lines.push('[怎么用] 这条消息真在问攻略 → 查完用你自己的话讲（别贴链接/来源、别整段搬）；')
  lines.push('         只是随口讨论/评价 → 可以不查；查了也只当背景，不要列点、不要给攻略步骤、不要说"wiki 上写着"。')
  return lines.join('\n')
}
