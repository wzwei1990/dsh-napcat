/**
 * dsh-meme 表情包图库的只读访问层。
 *
 * 图库布局（dsh-meme 插件目录下，每个包一个库）：
 *   <plugin>/memes/<pack>/index.db      SQLite，表 memes(path, tag, file_name, caption, keywords, ...)
 *   <plugin>/memes/<pack>/<path>        图片本体（path 相对包目录）
 *
 * 用途：QQ 侧没有前端帮忙把 `[表情: 描述]` 渲染成图，所以这里按描述/关键词查库，
 * 找到文件后由 NapCat 以图片消息真的发出去。
 * node:sqlite 在 Node 22.5+ 可用（本插件要求 Node >=22）；不可用或库损坏时静默跳过。
 */
import { existsSync, readdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export interface MemeHit {
  /** 图片绝对路径 */
  file: string
  /** 描述（候选里显示的那句） */
  caption: string
  /** 情绪分类 */
  tag: string
  /** 所属包目录 */
  pack: string
}

interface Row {
  path: string
  tag: string
  caption: string
  keywords: string
}

/** 默认扫描位置（DSH_HOME 下的 profile 里装的 dsh-meme）。 */
export function defaultMemeDirs(dshHome: string): string[] {
  const root = join(dshHome, 'profiles')
  const dirs: string[] = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name, 'node_modules', 'dsh-meme', 'memes')
      if (existsSync(dir)) dirs.push(dir)
    }
  } catch {
    // 目录不存在就算了
  }
  return dirs
}

export class MemeLibrary {
  private readonly loaded = new Map<string, Row[]>()
  private readonly missing = new Set<string>()

  constructor(
    private readonly dirs: string[],
    private readonly log: (level: string, message: string) => void = () => undefined,
  ) {}

  /** 读取一个图库根目录下所有包的 memes 行。 */
  private async rowsOf(root: string): Promise<Row[]> {
    const cached = this.loaded.get(root)
    if (cached !== undefined) return cached
    if (this.missing.has(root)) return []
    if (!existsSync(root)) {
      this.missing.add(root)
      return []
    }
    const rows: Row[] = []
    try {
      const packs = await readdir(root, { withFileTypes: true })
      const { DatabaseSync } = await import('node:sqlite') as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => { prepare(sql: string): { all(...args: unknown[]): unknown[] }; close(): void } }
      for (const pack of packs) {
        if (!pack.isDirectory()) continue
        const packDir = join(root, pack.name)
        const dbPath = join(packDir, 'index.db')
        if (!existsSync(dbPath)) continue
        try {
          const db = new DatabaseSync(dbPath, { readOnly: true })
          const list = db.prepare('SELECT path, tag, caption, keywords FROM memes').all() as Row[]
          for (const row of list) {
            if (typeof row.path !== 'string' || row.path === '') continue
            const file = resolve(packDir, row.path)
            if (!file.startsWith(resolve(packDir) + sep) && file !== resolve(packDir)) continue
            if (!existsSync(file)) continue
            rows.push({ path: file, tag: String(row.tag ?? ''), caption: String(row.caption ?? ''), keywords: String(row.keywords ?? '') })
          }
          db.close()
        } catch (error) {
          this.log('debug', '读取表情库失败 ' + dbPath + ': ' + (error instanceof Error ? error.message : String(error)))
        }
      }
    } catch (error) {
      this.log('debug', '扫描表情库失败 ' + root + ': ' + (error instanceof Error ? error.message : String(error)))
    }
    this.loaded.set(root, rows)
    if (rows.length > 0) this.log('debug', '表情库已加载 ' + rows.length + ' 张（' + root + '）')
    return rows
  }

  /** 图库总张数（自适应避重窗口用）。 */
  async size(): Promise<number> {
    return (await this.allRows()).length
  }

  private async allRows(): Promise<Row[]> {
    const out: Row[] = []
    for (const dir of this.dirs) out.push(...await this.rowsOf(dir))
    return out
  }

  /**
   * 按描述/关键词找图。
   * @param query `[表情: …]` 里的描述（通常就是候选 caption 原文）
   * @param avoid 最近发过的文件路径（用于避免连续重复同一张）
   */
  async search(query: string, avoid: Set<string> = new Set(), limit = 6): Promise<MemeHit[]> {
    const text = query.trim()
    if (text === '') return []
    const rows = await this.allRows()
    if (rows.length === 0) return []
    const scored: Array<{ hit: MemeHit; score: number }> = []
    const needles = [text, ...text.split(/[\s,，、。;；:：]+/).filter(part => part.length >= 2)]
    // 字形重合：把描述切成 2-gram，命中的越多越相关（"吃饭" 能命中 "捧着碗干饭"）
    const grams = bigrams(text)
    for (const row of rows) {
      const haystack = row.caption + ' ' + row.keywords + ' ' + row.path
      let score = 0
      if (row.caption === text) score += 100
      else if (row.caption.includes(text)) score += 60
      if (row.keywords.split(/\s+/).includes(text)) score += 40
      for (const needle of needles) {
        if (needle !== text && haystack.includes(needle)) score += 12
      }
      // 2-gram 重合度：每个命中的字组 +8，最多累计 32
      let overlap = 0
      for (const gram of grams) {
        if (haystack.includes(gram)) overlap += 1
      }
      if (overlap > 0) score += Math.min(32, overlap * 8)
      // 同义词表：口语 ↔ 标签（+25），补 2-gram 覆盖不到的说法
      const synonyms = TAG_SYNONYMS[row.tag] ?? []
      for (const word of synonyms) {
        if (text.includes(word)) {
          score += 25
          break
        }
      }
      if (score === 0) continue
      if (avoid.has(row.path)) score -= 30
      scored.push({ hit: { file: row.path, caption: row.caption, tag: row.tag, pack: '' }, score })
    }
    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, limit).map(item => item.hit)
  }

  /** 同情绪里随机抽一张（描述匹配不上时的兜底），只从没发过的里面挑；该情绪用光就返回 undefined。 */
  async randomInTag(tag: string, avoid: Set<string> = new Set(), random: () => number = Math.random): Promise<MemeHit | undefined> {
    const rows = await this.allRows()
    const pool = rows.filter(row => row.tag === tag && !avoid.has(row.path))
    if (pool.length === 0) return undefined
    const pick = pool[Math.floor(random() * pool.length) % pool.length]
    if (pick === undefined) return undefined
    return { file: pick.path, caption: pick.caption, tag: pick.tag, pack: '' }
  }

  /**
   * 精确命中：描述**完全等于**某张图的 caption（模型抄的是候选原文）。
   * 这种情况必须返回那一张，不能再参与"避重换图"——否则 Web 端按同一段描述
   * 显示的是这张、QQ 端却换成另一张，同一个回复两边不一致。
   */
  async exact(caption: string): Promise<MemeHit | undefined> {
    const text = caption.trim()
    if (text === '') return undefined
    const rows = await this.allRows()
    const row = rows.find(item => item.caption.trim() === text)
    if (row === undefined) return undefined
    return { file: row.path, caption: row.caption, tag: row.tag, pack: '' }
  }

  /**
   * 全场随机（不限情绪），只避开最近发过的 —— 同情绪图用光时扩池，
   * 让轮换范围从「3 张开心」扩到「整个图库」。
   */
  async randomAny(avoid: Set<string> = new Set(), random: () => number = Math.random): Promise<MemeHit | undefined> {
    const rows = await this.allRows()
    const pool = rows.filter(row => !avoid.has(row.path))
    if (pool.length === 0) return undefined
    const pick = pool[Math.floor(random() * pool.length) % pool.length]
    if (pick === undefined) return undefined
    return { file: pick.path, caption: pick.caption, tag: pick.tag, pack: '' }
  }
}
/** 中文 2-gram（去重、只保留含中文/字母的组），用于粗粒度相关度打分。 */
/** 中文说法 → 图库标签的同义词表（标签多是英文，靠这张表把口语对上）。 */
export const TAG_SYNONYMS: Record<string, string[]> = {
  givemoney: ['钱', '红包', '打钱', '要钱', '零花', '零食', '工资', '借钱', '穷'],
  meow: ['猫', '喵', '猫爪', '小虎牙', '卖萌'],
  cpu: ['加班', '崩溃', '抓狂', '脑子转不动', '烧脑', '累死', '想不通'],
  baka: ['嫌弃', '笨蛋', '鄙视', '不想理', '侧目'],
  see: ['围观', '看戏', '震惊', '吓到', '惊吓'],
  color: ['花痴', '爱心', '心动', '喜欢', '流口水'],
  morning: ['早上', '早安', '早', '打招呼'],
  work: ['上班', '工作', '打工', '摸鱼', '躺平', '不想动', '累了'],
  sleep: ['睡', '困', '晚安', '熬夜', '打盹'],
  daily: ['日常', '吃', '干饭', '吃饭', '饭', '饿了'],
  sigh: ['无语', '叹气', '无奈', '瘫', '生无可恋'],
  shy: ['害羞', '脸红', '不好意思', '偷看', '羞'],
  like: ['比心', '卖萌', '喜欢', '爱了', '超开心'],
  happy: ['开心', '好耶', '满意', '得意', '飘了', '不错', '牛'],
  angry: ['生气', '气鼓鼓', '发火', '愤怒', '讨厌'],
  sad: ['难过', '伤心', '哭', '晕了', '委屈', '求饶'],
  confused: ['疑惑', '问号', '托腮', '思考', '加载', '懵'],
  surprised: ['吓到', '大叫', '吃惊', '居然'],
  fool: ['不行', '拒绝', '摇头', '不要'],
}

export function bigrams(text: string): string[] {
  const clean = text.replace(/[^\p{L}\p{N}]+/gu, '')
  const grams = new Set<string>()
  for (let i = 0; i + 1 < clean.length; i += 1) grams.add(clean.slice(i, i + 2))
  return [...grams]
}