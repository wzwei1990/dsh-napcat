/**
 * 危险操作词表：识别「删/清/格式化/强推/关机」这类可能不可逆的请求。
 *
 * 只做**入站文本**层面的判定（不改工具、不拦截模型内部行为），
 * 目的：普通群友发这类请求时直接拒掉，不投给模型；管理员照常放行。
 *
 * 设计参考 dsh-onebot 的命令 adminOnly 门禁：判定放在「插件侧、派发之前」，
 * 这样即便模型被诱导也不会被拉起；且拒绝是确定性的，可审计。
 */

/** 一条危险词的命中结果。 */
export interface DangerHit {
  /** 命中的词（用于日志/审计，取规则代表词）。 */
  word: string
  /** 分类：删除 / 数据库 / git / 系统 / 记忆 / 配置 / 权限。 */
  category: string
}

interface DangerRule {
  word: string
  category: string
  pattern: RegExp
}

/** 内置规则：宁可多拦一点，命中后由管理员决定要不要继续。 */
const RULES: readonly DangerRule[] = [
  // ── 删除文件/目录 ──
  { word: '删除', category: '删除', pattern: /(删|清)(掉|除)?\s*(文件|目录|文件夹|工程|项目|仓库|源码|代码)/ },
  { word: '删除', category: '删除', pattern: /(文件|目录|文件夹|工程|项目|仓库|源码|代码)\s*(全部|全都|都|一并|整个)?\s*(删掉|删了|删除|清掉|清空)/ },
  { word: 'rm -rf', category: '删除', pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-[a-zA-Z]*r)\b/ },
  { word: 'rmdir', category: '删除', pattern: /\brmdir\b|\bdel\s+\/[sqf]/i },
  { word: 'Remove-Item', category: '删除', pattern: /\bRemove-Item\b|\bdel\s+[A-Za-z]:\\/i },
  // ── 数据库 ──
  { word: 'DROP', category: '数据库', pattern: /\bdrop\s+(table|database|schema|index)\b|\btruncate\s+table\b/i },
  { word: 'DELETE', category: '数据库', pattern: /\bdelete\s+from\b|\bupdate\s+\w+\s+set\b[\s\S]*\bwhere\s+1\s*=\s*1\b/i },
  { word: '删库', category: '数据库', pattern: /删库|(清空|清理|清掉)[\s\S]{0,4}(数据库|数据表|表数据|所有数据|全部数据)/ },
  // ── git ──
  { word: 'git reset --hard', category: 'git', pattern: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-zA-Z]*f/i },
  { word: 'git push --force', category: 'git', pattern: /\bgit\s+push\b[^\n]*\s(-f|--force)\b/i },
  // ── 系统 ──
  { word: 'format', category: '系统', pattern: /\bformat\s+[a-zA-Z]:|\bdiskpart\b|\bmkfs\.[a-z]+\b/i },
  { word: 'shutdown', category: '系统', pattern: /\b(shutdown|reboot|poweroff|halt)\b|关机|重启(系统|机器|服务器|电脑)/i },
  { word: 'rm -rf /', category: '系统', pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$)|\brm\s+-rf\s+~|\bdel\s+[A-Z]:\\\*/i },
  // ── 记忆/上下文 ──
  { word: '清空记忆', category: '记忆', pattern: /(清空|删除|忘掉|清除)(所有)?(记忆|长期记忆|聊天记录|对话历史|上下文)/ },
  { word: 'forget all', category: '记忆', pattern: /\bforget\s+all\b|\bwipe\s+(memory|history)\b/i },
  // ── 配置/凭据 ──
  { word: '改配置', category: '配置', pattern: /(删除|覆盖|清空)\s*\.env|改\s*(配置|config)|修改\s*(token|密钥|密码)/i },
  { word: '改配置', category: '配置', pattern: /(\.env|配置文件|config)\s*(覆盖|清空|删除|改掉)|覆盖\s*(\.env|配置文件)/i },
  { word: '卸载插件', category: '配置', pattern: /卸载\s*(插件|dsh|deepseek)|uninstall\s+(the\s+)?plugin/i },
  // ── 权限 ──
  { word: 'chmod -R', category: '权限', pattern: /\bchmod\s+-R\b|\bchown\s+-R\b|\btakeown\b|\bicacls\b.*\/grant/i },
]

/** 把用户额外配置的词编译成"包含即命中"的规则。 */
function compileExtra(words: readonly string[]): DangerRule[] {
  const out: DangerRule[] = []
  for (const raw of words) {
    const word = raw.trim()
    if (word === '') continue
    out.push({ word, category: '自定义', pattern: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
  }
  return out
}

/**
 * 判定一段文本是否有危险操作意图。
 * @param text 用户消息原文（已转纯文本）
 * @param extraWords 额外词表（配置项 dangerWords）
 * @returns 命中详情；没有命中返回 undefined
 */
export function detectDanger(text: string, extraWords: readonly string[] = []): DangerHit | undefined {
  const source = text.trim()
  if (source === '') return undefined
  for (const rule of [...RULES, ...compileExtra(extraWords)]) {
    if (rule.pattern.test(source)) return { word: rule.word, category: rule.category }
  }
  return undefined
}

/** 供测试/文档使用：内置规则的代表词列表。 */
export function dangerRules(): Array<{ word: string; category: string }> {
  return RULES.map(rule => ({ word: rule.word, category: rule.category }))
}
/**
 * 生成"让模型来拒绝"的提示词。
 *
 * 注意：**不把用户原文塞进去**，只给危险类别 —— 避免模型被原始指令二次注入。
 * @param hit 命中的危险类别
 * @param template 可配置模板，支持 {category}
 * @returns 交给一次性会话的提示词
 */
export function buildRefusalPrompt(hit: DangerHit, template = ''): string {
  const source = template.trim() !== '' ? template : '用户刚才请求了一个危险操作（类别：{category}）。'
  const base = source.replace(/\{category\}/g, hit.category)
  return [
    base,
    '',
    '你的任务：**只回一句拒绝的话**，要幽默、不刻薄、不超过 20 个字，明确表示这事只有管理员能碰。',
    '硬性要求：',
    '- 不要调用任何工具，不要执行任何操作，不要解释安全策略。',
    '- 只输出这一句中文，不要加引号、不要加表情代码、不要换行。',
  ].join('\n')
}

/**
 * 清洗模型给出的拒绝文案：单行、限长、去引号。
 * @param text 模型输出
 * @param maxChars 最大字数
 * @returns 可直接发到群里的文本；空文本返回空串
 */
export function cleanRefusal(text: string, maxChars = 60): string {
  const first = text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  const stripped = first.replace(/^["'“”「」『』\s]+|["'“”「」『』\s]+$/g, '')
  return stripped.slice(0, Math.max(1, maxChars))
}