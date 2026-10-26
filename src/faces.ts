/**
 * 文字表情兜底：把 `[表情:描述]` 映射成 QQ 原生小黄脸（face 段），
 * 这样即使没装 dsh-meme、或图库里找不到对应图片，也还能"有表情"。
 *
 * face id 用 QQ 经典表情编号（NapCat 的 {type:'face', data:{id:'14'}}）。
 * 每条规则带若干**同义备选**（同一种情绪的不同表情），用于轮换，
 * 避免"每次说开心都发同一个 😊"。
 */

interface FaceRule {
  id: string
  name: string
  /** 同一情绪下可替换的其他表情（轮换用） */
  alts: string[]
  keywords: string[]
}

const RULES: FaceRule[] = [
  { id: '14', name: '微笑', alts: ['13', '21', '20'], keywords: ['微笑', '开心', '高兴', '好耶', '满意', '喜欢', '可爱', '卖萌', '嘿嘿', '不错', '赞'] },
  { id: '13', name: '呲牙', alts: ['14', '21', '12'], keywords: ['大笑', '哈哈', '笑死', '乐', '滑稽', '嘿嘿嘿'] },
  { id: '11', name: '发怒', alts: ['18', '104'], keywords: ['生气', '发怒', '气死', '愤怒', '讨厌', '烦'] },
  { id: '27', name: '流汗', alts: ['34', '22', '104'], keywords: ['无语', '流汗', '尴尬', '汗', '无奈'] },
  { id: '15', name: '难过', alts: ['5', '105'], keywords: ['难过', '伤心', '失落', '唉'] },
  { id: '5', name: '流泪', alts: ['15', '105'], keywords: ['哭', '流泪', '呜呜', '泪'] },
  { id: '6', name: '害羞', alts: ['21', '20'], keywords: ['害羞', '脸红', '不好意思', '羞'] },
  { id: '32', name: '疑问', alts: ['0', '34'], keywords: ['疑问', '困惑', '不解', '为什么', '懵', '嗯?'] },
  { id: '0', name: '惊讶', alts: ['32', '34'], keywords: ['惊讶', '震惊', '吃惊', '居然', '卧槽'] },
  { id: '8', name: '睡', alts: ['25', '34'], keywords: ['睡', '困', '晚安', '累'] },
  { id: '22', name: '白眼', alts: ['104', '27'], keywords: ['白眼', '翻白眼', '无语子'] },
  { id: '104', name: '鄙视', alts: ['22', '11'], keywords: ['鄙视', '嫌弃', '看不惯'] },
  { id: '105', name: '委屈', alts: ['15', '5'], keywords: ['委屈', '可怜', '求饶'] },
  { id: '99', name: '鼓掌', alts: ['14', '13'], keywords: ['鼓掌', '棒', '加油', '厉害', '牛'] },
  { id: '20', name: '偷笑', alts: ['14', '12'], keywords: ['偷笑', '窃喜', '腹黑'] },
  { id: '12', name: '调皮', alts: ['20', '13'], keywords: ['调皮', '坏笑', '嘿嘿哈'] },
  { id: '16', name: '酷', alts: ['14', '20'], keywords: ['酷', '帅', '装酷'] },
  { id: '18', name: '抓狂', alts: ['11', '34'], keywords: ['抓狂', '崩溃', '疯了'] },
  { id: '34', name: '晕', alts: ['27', '32'], keywords: ['晕', '头大', '转圈'] },
  { id: '24', name: '饥饿', alts: ['14'], keywords: ['饿', '干饭', '吃', '馋'] },
]

/**
 * 描述 → QQ 表情 id；匹配不到返回 undefined。
 * avoid 里是最近刚发过的 id：命中就换一个同义备选，避免一直同一个表情。
 */
/**
 * 描述 → QQ 表情 id；匹配不到返回 undefined。
 * recent 是**最近发过的 id 列表（越靠前越新）**：命中就换同义备选；
 * 全都发过就挑最久没用的那个（不再死守主表情，避免"永远同一个"）。
 */
export function faceFor(description: string, recent: readonly string[] | Set<string> = []): string | undefined {
  const history = Array.isArray(recent) ? recent : [...recent]
  const text = description.trim()
  if (text === '') return undefined
  // 先精确包含关键词的（越长的关键词越优先，避免「开心」抢了「不开心」）
  let best: { rule: FaceRule; length: number } | undefined
  for (const rule of RULES) {
    for (const keyword of rule.keywords) {
      if (!text.includes(keyword)) continue
      if (best === undefined || keyword.length > best.length) best = { rule, length: keyword.length }
    }
  }
  const rule = best?.rule ?? RULES.find(item => text.includes(item.name))
  if (rule === undefined) return undefined
  const candidates = [rule.id, ...rule.alts]
  // 优先没发过的
  for (const id of candidates) {
    if (!history.includes(id)) return id
  }
  // 都发过了：挑最久没用过的（history 越靠后越旧）
  let pick = candidates[0] as string
  let worst = -1
  for (const id of candidates) {
    const index = history.indexOf(id)
    const age = index === -1 ? Number.MAX_SAFE_INTEGER : index
    if (age > worst) {
      worst = age
      pick = id
    }
  }
  return pick
}

/** 词表（供文档/调试展示）。 */
export function faceCatalog(): Array<{ id: string; name: string }> {
  return RULES.map(rule => ({ id: rule.id, name: rule.name }))
}
