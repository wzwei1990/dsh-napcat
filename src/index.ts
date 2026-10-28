/**
 * dsh-napcat —— 把 DeepSeek Harness 接上 QQ（NapCat / OneBot 11）。
 *
 * 接线方式（forward 模式，NapCat 在别的机器上时用这个）：
 *   插件 --ws--> NapCat 的 WebSocket 服务
 *   用户 QQ --消息--> NapCat --事件--> 插件 --> 每会话一个 dsh agent
 *
 * 配置见 ./config.ts；安装与 NapCat 侧配置见 README.md。
 */

import type { Context } from '@deepseek-ai/cordis'

import { Bridge } from './bridge.js'
import { Config, resolveConfig } from './config.js'
import type { Config as ConfigShape } from './config.js'
import { OneBotConnection, type LogLevel } from './onebot.js'
import { registerTools } from './tools.js'
import type { ObEvent } from './types.js'

export { Config }

export const name = 'dsh-napcat'
/** tools = 注册工具；agents = 按 QQ 会话创建/恢复 agent；workspaceRegistry = 把会话挂进工作区。 */
export const inject = ['tools', 'agents', 'workspaceRegistry', 'sessionPersistence', 'systemPrompt', 'agentDefaultModel', 'agentPresets', 'approval', 'sessionTitle', 'attachments']

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2 }

export function apply(ctx: Context, rawConfig: ConfigShape): void {
  // volatile 字段可能没有 schema 默认值，统一用内置默认值补齐
  const config = resolveConfig(rawConfig)
  const threshold = LEVEL_RANK[config.logLevel] ?? 1
  const log = (level: LogLevel, message: string): void => {
    if ((LEVEL_RANK[level] ?? 1) < threshold) return
    const line = '[dsh-napcat] ' + message
    if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  // 连接与桥互相引用，先用一个可替换的事件入口打断循环。
  let onEvent: (event: ObEvent) => void = event => {
    log('debug', '收到事件但桥还没就绪: ' + String(event.post_type))
  }

  const conn = new OneBotConnection({
    mode: config.mode,
    url: config.url,
    host: config.host,
    port: config.port,
    accessToken: config.accessToken,
    reconnectMaxAttempts: config.reconnectMaxAttempts,
    log,
    onEvent: event => onEvent(event),
    onStatus: connected => {
      if (connected) log('info', 'NapCat 通道就绪')
      else log('warn', 'NapCat 通道断开（会自动重连 / 反向模式等待接入）')
    },
  })

  const bridge = new Bridge({ ctx, config, conn, log })
  onEvent = event => {
    void bridge.handleEvent(event).catch(error => {
      log('warn', '处理入站事件失败: ' + (error instanceof Error ? error.message : String(error)))
    })
  }

  if (config.mode === 'forward' && config.accessToken === '') {
    log('warn', 'forward 模式下 accessToken 为空：NapCat 若配了 token，连接会被拒')
  }

  registerTools(ctx, conn, log, {
    keyForSession: sessionId => bridge.keyForSession(sessionId),
    allowedGroups: () => config.groupAllowFrom,
    rememberSpace: (chatKey, spaceId) => bridge.saveMemorySpace(chatKey, spaceId),
  memeSearch: (query, limit) => bridge.searchMemeForTool(query, limit),
  memeCatalog: () => bridge.memeCatalogForTool(),
  })

  // 群/人性格：照 dsh-im 的动态提示词上下文（按 sessionId 注入额外人设）
  ctx.inject(['systemPrompt'], promptCtx => {
      const sp = (promptCtx as unknown as {
        systemPrompt?: { context?(options: { name: string; order: number; text: (assembly: unknown) => string }): () => void }
      }).systemPrompt
      if (sp?.context === undefined) return
      return sp.context({
        name: 'dsh-napcat:persona',
        order: 100,
        text: assembly => bridge.personaText(assembly as { agent?: { session?: { id?: unknown } } } | undefined),
      })
  })

  // volatile 配置是"活值"：设置页保存不会重挂载插件，这里自己重建连接。
  const subscribeSettings = (ctx as unknown as {
    on(name: string, listener: (ns: string) => void): () => void
  })
  ctx.effect(() =>
    subscribeSettings.on('settings/document-updated', ns => {
      if (ns !== 'dsh-napcat') return
      const next = resolveConfig(rawConfig)
      if (JSON.stringify(next) === JSON.stringify(config)) return
      const wasEnabled = config.enabled
      Object.assign(config, next)
      bridge.refreshPersonas()
      if (next.enabled !== wasEnabled) {
        if (next.enabled) {
          log('info', '开关已打开：连接 NapCat')
          bridge.start()
          conn.start()
        } else {
          log('info', '开关已关闭：断开 NapCat，停止处理消息')
          void bridge.stop()
          void conn.stop()
        }
        return
      }
      if (!next.enabled) {
        log('info', '配置已更新，但插件处于禁用状态，保持断开')
        return
      }
      log('info', '配置已更新（设置页保存），重建 NapCat 连接')
      conn.reconfigure({
        mode: next.mode,
        url: next.url,
        host: next.host,
        port: next.port,
        accessToken: next.accessToken,
        reconnectMaxAttempts: next.reconnectMaxAttempts,
      })
    }),
  )

  ctx.effect(() => {
    if (!config.enabled) {
      log('info', 'dsh-napcat 已禁用（enabled=false）：不连接 NapCat，也不处理任何消息')
      return () => undefined
    }
    bridge.start()
    conn.start()
    return async () => {
      await bridge.stop()
      await conn.stop()
    }
  })

  // 老配置兼容提示：warmupHistory 已并入 recentLimit（只提示，不报错）
  const legacyWarmup = (rawConfig as { warmupHistory?: unknown } | undefined)?.warmupHistory
  if (legacyWarmup !== undefined) {
    log('info', 'warmupHistory 已并入 recentLimit（预热目标=缓冲容量），配置里这一项可以删掉')
  }
  log('info', 'dsh-napcat 已加载（mode=' + config.mode + (config.mode === 'forward' ? ', url=' + config.url : ', port=' + String(config.port)) + (config.enabled ? '' : '，但已禁用（enabled=false）') + '）')
}
