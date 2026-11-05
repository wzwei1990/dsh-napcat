/**
 * 工作区目录计算（2026-11-05 抽出，方便测试）。
 *
 * 侧边栏的"分组"= 工作区，而宿主要求 **工作区路径 == 会话 cwd**，
 * 所以目录怎么算直接决定会话会被归到哪个格子。
 *
 * 规则：
 *   - 群聊：一个群一个子目录（共用目录会让不同群挤进同一格，实测踩过）
 *   - 私聊：按 perChatWorkspace 决定
 *   - workspacePath 留空：以宿主 cwd 为基准
 */
export function workspaceDirFor(input: {
  /** 配置里的 workspacePath（可空） */
  base: string
  /** 宿主进程 cwd（base 为空时用它） */
  fallbackBase: string
  /** 会话 key，如 group:660610917 */
  chatKey: string
  kind: 'group' | 'private'
  perChatWorkspace: boolean
}): string {
  const base = input.base.trim() !== '' ? input.base : input.fallbackBase
  const needsOwnDir = input.kind === 'group' || input.perChatWorkspace
  if (!needsOwnDir) return base
  const safe = input.chatKey.replace(/[^A-Za-z0-9._-]+/g, '-')
  const separator = base.endsWith('/') || base.endsWith('\\') ? '' : '/'
  return base + separator + 'napcat' + '/' + safe
}
