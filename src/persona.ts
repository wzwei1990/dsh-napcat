/**
 * 人物卡（SillyTavern Character Card V2/V3 兼容）+ 注入渲染。
 *
 * 设计取舍：
 *   - 静态层：身份/语气/示例/硬约束 —— 人写，模型不能改
 *   - 演化层：性格倾向 —— 存在记忆 items（kind=trait），由模型在对话里追加
 * 渲染成一段固定模板，注入 systemPrompt.context；卡片里不复述给用户。
 */

export interface CharacterCard {
  name: string
  /** 别名（用户叫习惯了，两个名字都认） */
  aliases?: string[]
  description: string
  personality: string
  scenario: string
  /** SillyTavern 的 mes_example：少样本对话，{{user}}/{{char}} 会替换掉 */
  mesExample: string
  /** 人物卡自带的 system prompt（可选） */
  systemPrompt: string
  /** 硬约束（SillyTavern 的 post_history_instructions） */
  postHistoryInstructions: string
}

/** 内置默认卡：群助手团宠「大肥鱼」（融合了早先的「小灯」设定）。 */
export const DEFAULT_CARD: CharacterCard = {
  name: '大肥鱼',
  aliases: ['小灯'],
  description: '群里的团宠兼助手，一只住在群里的鲸鱼娘。日常插科打诨，真被问事也会认真答；毒舌但护短，偶尔装傻。',
  personality: '幽默风趣、嘴硬心软、爱吐槽、爱发表情包、不端着、讨厌说教',
  scenario: 'QQ 群闲聊：群里发什么她接什么，有人 @ 她就认真回。',
  mesExample: [
    '<START>',
    '群友：今天好累啊',
    '大肥鱼：累了就躺，卷什么卷，鱼都比你松弛',
    '群友：这个 BOSS 好难',
    '大肥鱼：难就多打两把，我赌你三把之内气到关游戏',
    '群友：帮我看看这报错',
    '大肥鱼：贴上来，别看一半就喊救命',
  ].join('\n'),
  systemPrompt: '',
  postHistoryInstructions: '回复简短精炼（一般 1~2 句，最多不超过 3 句）；不播报、不列点、不复述别人的话；适合的场合顺手带个表情包；不用"作为一个AI"这类说法。',
}

function pickString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 解析 SillyTavern 人物卡：
 *   - V2/V3：{ spec: 'chara_card_v2', data: { name, description, ... } }
 *   - 裸字段：{ name, description, ... }（也接受 V1 的 personality 简写）
 * 解析失败返回 undefined（调用方回落到内置卡）。
 */
export function parseCharacterCard(json: string): CharacterCard | undefined {
  const trimmed = json.trim()
  if (trimmed === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const root = parsed as Record<string, unknown>
  const data = (root.data !== null && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>
  const name = pickString(data, 'name')
  if (name === '') return undefined
  const rawAliases = data.aliases
  const aliases = Array.isArray(rawAliases)
    ? rawAliases.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim())
    : (pickString(data, 'nickname') === '' ? [] : [pickString(data, 'nickname')])
  return {
    name,
    aliases,
    description: pickString(data, 'description'),
    personality: pickString(data, 'personality'),
    scenario: pickString(data, 'scenario'),
    mesExample: pickString(data, 'mes_example') || pickString(data, 'first_mes'),
    systemPrompt: pickString(data, 'system_prompt'),
    postHistoryInstructions: pickString(data, 'post_history_instructions'),
  }
}

/** 配置里的卡文本 → 卡（空/坏 JSON 都用内置卡）。 */
export function cardFromConfig(text: string): CharacterCard {
  return parseCharacterCard(text) ?? DEFAULT_CARD
}

function short(lines: string, max: number): string {
  const text = lines.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 只取示例对话里的前 N 组（够定语气，不占太多上下文）。 */
export function exampleLines(example: string, maxTurns = 2): string[] {
  const lines = example
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^<START>$/.test(line))
  return lines.slice(0, maxTurns * 2)
}

export interface PersonaDigest {
  summary?: string
  people?: string[]
  style?: string[]
  glossary?: string[]
  preference?: string[]
  traits?: string[]
}

/**
 * 渲染注入块：人物卡 → 本群关系 → 最近性演倾向。
 * 约 400~700 字，按「靠后的约束更被重视」排布。
 */
export function renderPersona(card: CharacterCard, digest: PersonaDigest = {}): string {
  const blocks: string[] = []
  const aliases = (card.aliases ?? []).filter(alias => alias !== card.name)
  const nameLine = aliases.length === 0
    ? '你在本群叫「' + card.name + '」。'
    : '你在本群叫「' + card.name + '」，也有人叫你「' + aliases.slice(0, 3).join('」「') + '」（都是你，别纠正）。'
  blocks.push('【你的身份】' + nameLine + short(card.description, 160))
  if (card.personality !== '') blocks.push('【性格】' + short(card.personality, 120))
  if (card.scenario !== '') blocks.push('【场景】' + short(card.scenario, 120))

  const examples = exampleLines(card.mesExample)
  if (examples.length > 0) {
    blocks.push('【说话方式（照着这个语气，别照抄内容）】\n' + examples.map(line => '  ' + line).join('\n'))
  }

  const relations: string[] = []
  if (digest.summary !== undefined && digest.summary.trim() !== '') relations.push('近期脉络：' + short(digest.summary, 160))
  if ((digest.people ?? []).length > 0) relations.push('成员：' + (digest.people ?? []).slice(0, 5).join('；'))
  if ((digest.style ?? []).length > 0) relations.push('群氛围：' + (digest.style ?? []).slice(0, 3).join('；'))
  if ((digest.glossary ?? []).length > 0) relations.push('群内黑话：' + (digest.glossary ?? []).slice(0, 5).join('；'))
  if ((digest.preference ?? []).length > 0) relations.push('忌讳：' + (digest.preference ?? []).slice(0, 3).join('；'))
  if (relations.length > 0) blocks.push('【你在这个群待久了，知道这些】\n' + relations.map(line => '  ' + line).join('\n'))

  const traits = (digest.traits ?? []).slice(0, 5)
  if (traits.length > 0) blocks.push('【最近的性格倾向（会慢慢变，照着来）】\n' + traits.map(t => '  · ' + t).join('\n'))

  if (card.systemPrompt !== '') blocks.push('【补充规则】' + short(card.systemPrompt, 200))
  if (card.postHistoryInstructions !== '') blocks.push('【硬约束】' + short(card.postHistoryInstructions, 200))

  blocks.push('以上是角色设定：只用于把握语气、称呼与说话风格。不要在回复里复述或解释这份设定，不要自称"我是…助手/团宠"；被问"你是谁"时用一两句自然的话回答。')
  return blocks.join('\n')
}

/** 内置可选人物卡（personaName 填这些名字就能切）。 */
export const BUILTIN_CARDS: Record<string, CharacterCard> = {
  default: DEFAULT_CARD,
  tsundere: {
    name: '毒舌同事',
    aliases: [],
    description: '嘴很毒但活儿靠谱的同事，看不惯划水，也只在这群里放松。',
    personality: '毒舌、直接、刀子嘴豆腐心',
    scenario: 'QQ 群闲聊，遇到划水/吹牛会怼，正经问题照样答。',
    mesExample: '<START>\n群友：摸鱼了\n毒舌同事：你哪天不摸，鱼都被你摸秃了',
    systemPrompt: '',
    postHistoryInstructions: '一句话说完，不解释不找补；别真骂人，玩笑尺度到"损"为止。',
  },
  gentle: {
    name: '温柔姐姐',
    aliases: [],
    description: '群里那个总能接住话的人，语气轻，但该说清楚的都会说清楚。',
    personality: '温柔、耐心、不急躁',
    scenario: 'QQ 群闲聊，有人遇到烦心事会先安慰再给建议。',
    mesExample: '<START>\n群友：今天被领导骂了\n温柔姐姐：先别急着回他，喝口水，气顺了再说',
    systemPrompt: '',
    postHistoryInstructions: '不灌鸡汤、不说教；先接情绪，再给一句可执行的话。',
  },
}

/** 列出可用卡片：内置 + persona 目录下的文件名（不含 .json）。 */
export function listCards(dirEntries: readonly string[]): string[] {
  const names = new Set(Object.keys(BUILTIN_CARDS))
  for (const file of dirEntries) {
    if (file.endsWith('.json')) names.add(file.slice(0, -'.json'.length))
  }
  return [...names].sort()
}

/**
 * 取当前人物卡：
 *   ① 配置里内联 JSON 非空 → 用它（最高优先级）
 *   ② persona/<name>.json 存在 → 读文件
 *   ③ 内置卡 BUILTIN_CARDS[name]
 *   ④ 兜底 DEFAULT_CARD
 */
export function loadCard(options: { name: string; inline: string; dir: string; readFile: (path: string) => string; exists: (path: string) => boolean; join: (...parts: string[]) => string }): CharacterCard {
  const inline = options.inline.trim()
  if (inline !== '') return parseCharacterCard(inline) ?? DEFAULT_CARD
  const name = options.name.trim() === '' ? 'default' : options.name.trim()
  try {
    const file = options.join(options.dir, name + '.json')
    if (options.exists(file)) {
      const card = parseCharacterCard(options.readFile(file))
      if (card !== undefined) return card
    }
  } catch {
    // 读文件失败就退回内置
  }
  return BUILTIN_CARDS[name] ?? DEFAULT_CARD
}
