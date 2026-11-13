// 纯逻辑冒烟测试（不依赖宿主包，直接测编译产物 lib/）。
// 运行：npm run build && node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { base64UrlToBuffer, isHttpUrl, nameFromRef, safeName } from '../lib/media.js'
import { MemoryStore } from '../lib/memory.js'
import { decide, inQuietHours, newChatState, parseQuietHours, poissonHit, skipBackoffFactor } from '../lib/proactive.js'
import { ImageCache, dayKey, urlHash } from '../lib/imagecache.js'
import { findKeyword, mentions, parseCq, rankByFileName, scoreFileName, shortHash, splitText, stripKeyword, titleFrom, toText } from '../lib/text.js'
import { allowAccess, chatRefOf, sessionIdForChat } from '../lib/chat.js'
import { Bridge, mergeQueued, pushQueued } from '../lib/bridge.js'
import { judgeSticker, readImageHeader } from '../lib/sticker.js'
import { pruneInbox } from '../lib/media.js'
import { buildHintBlock, looksLikeHelpRequest } from '../lib/gamewiki.js'
import { bumpImageFreq, imageKey, loadImageFreq } from '../lib/imagefreq.js'
import { DEFAULT_CARD, loadCard, parseCharacterCard, renderPersona, seedPersonaDir } from '../lib/persona.js'
import { listCardsInDir, readCardInDir, validCardName, writeCardInDir } from '../lib/personacard.js'
import { extractMediaLink, lyricPreview, neteaseSongId, parseOpenGraph, renderLinkBlock } from '../lib/links.js'

const config = {
  adminUsers: ['10001'],
  dmPolicy: 'admin',
  allowFrom: [],
  groupPolicy: 'allowlist',
  groupAllowFrom: ['20002'],
}

test('splitText 按上限分段且不超长', () => {
  const text = ('第一句话。'.repeat(400)).trim()
  const chunks = splitText(text, 1200)
  assert.ok(chunks.length >= 2)
  for (const chunk of chunks) assert.ok(chunk.length <= 1200, 'segment too long: ' + chunk.length)
  assert.ok(text.includes(chunks[0]), '首段应是原文的前缀片段')
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''))
})

test('splitText 短文本原样返回', () => {
  assert.deepEqual(splitText('  hi  ', 1200), ['hi'])
  assert.deepEqual(splitText('   ', 1200), [])
})

test('toText 处理文本 / @ / 图片占位', () => {
  const message = [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 你好' } },
    { type: 'image', data: { file: 'a.jpg' } },
  ]
  assert.equal(toText(message, '99999'), '@10001 你好[图片]')
  assert.equal(toText(message, '10001'), '@你 你好[图片]')
  assert.equal(toText([{ type: 'at', data: { qq: 'all' } }], ''), '@全体成员')
})

test('mentions 只认指定 QQ', () => {
  const at = [{ type: 'at', data: { qq: '10001' } }]
  assert.equal(mentions(at, '10001'), true)
  assert.equal(mentions(at, '99999'), false)
  assert.equal(mentions(at, ''), false)
})

test('parseCq 解析兜底的 CQ 字符串', () => {
  const segments = parseCq('[CQ:image,file=a.jpg,url=https://x/y]hi&#91;1&#93;')
  assert.equal(segments.length, 2)
  assert.equal(segments[0]?.type, 'image')
  assert.equal(segments[0]?.data?.file, 'a.jpg')
  assert.equal(segments[1]?.type, 'text')
  assert.equal(segments[1]?.data?.text, 'hi[1]')
})

test('chatRefOf 区分私聊与群聊', () => {
  assert.deepEqual(chatRefOf({ post_type: 'message', message_type: 'private', user_id: 123, message: [] }),
    { kind: 'private', id: '123', key: 'private:123' })
  assert.deepEqual(chatRefOf({ post_type: 'message', message_type: 'group', group_id: 789, user_id: 1, message: [] }),
    { kind: 'group', id: '789', key: 'group:789' })
})

test('准入策略：私聊仅管理员、群聊白名单', () => {
  assert.equal(allowAccess(config, { kind: 'private', id: '10001', key: 'private:10001' }, '10001'), true)
  assert.equal(allowAccess(config, { kind: 'private', id: '10002', key: 'private:10002' }, '10002'), false)
  assert.equal(allowAccess(config, { kind: 'group', id: '20002', key: 'group:20002' }, '1'), true)
  assert.equal(allowAccess(config, { kind: 'group', id: '20003', key: 'group:20003' }, '1'), false)
})

test('session id 稳定且合法', () => {
  assert.equal(sessionIdForChat('private:123'), 'napcat-private-123')
  assert.equal(sessionIdForChat('group:789'), 'napcat-group-789')
  assert.match(sessionIdForChat('group:a b/c'), /^[A-Za-z0-9_-]+$/)
})
test('findKeyword 命中/大小写/空表', () => {
  assert.equal(findKeyword('你好 小助手 在吗', ['小助手']), '小助手')
  assert.equal(findKeyword('HELLO Bot', ['bot']), 'bot')
  assert.equal(findKeyword('随便说说', ['小助手']), undefined)
  assert.equal(findKeyword('任何内容', []), undefined)
  assert.equal(findKeyword('空词表里有空白', ['   ']), undefined)
})

test('stripKeyword 去掉第一个命中且 trim', () => {
  assert.equal(stripKeyword('小助手 帮我查天气', '小助手'), '帮我查天气')
  assert.equal(stripKeyword('帮我查天气 小助手', '小助手'), '帮我查天气')
  assert.equal(stripKeyword('没有关键字', '小助手'), '没有关键字')
})
test('shortHash 稳定且区分不同路径', () => {
  const a = shortHash('E:\\dsnworkspace\\napcat\\group-1')
  const b = shortHash('E:\\dsnworkspace\\napcat\\group-1')
  const c = shortHash('C:\\Windows\\System32')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[0-9a-z]{1,7}$/)
})

test('titleFrom 生成 MM-DD HH:mm', () => {
  const at = new Date(2026, 9, 22, 9, 5)
  assert.equal(titleFrom('小灯讲个笑话', at), '10-22 09:05')
  assert.equal(titleFrom('', new Date(2026, 0, 3, 23, 59)), '01-03 23:59')
})
test('media 小工具', () => {
  assert.equal(isHttpUrl('https://a/b.png'), true)
  assert.equal(isHttpUrl('C:\\a\\b.png'), false)
  assert.equal(safeName('../../etc/passwd', 'x'), 'passwd')
  assert.equal(safeName('a/b:c*d.png', 'x'), 'b_c_d.png')
  assert.equal(nameFromRef('file:///data/1234.jpg', 'i.png'), '1234.jpg')
  assert.equal(base64UrlToBuffer('base64://aGk=').toString('utf8'), 'hi')
})
test('文件名模糊匹配', () => {
  assert.equal(scoreFileName('自然，这是一部手稿.docx', '手稿'), 60)
  assert.equal(scoreFileName('Natural Draft.DOCX', 'natural draft'), 90)
  assert.equal(scoreFileName('abc.pdf', 'zzz'), 0)
  const ranked = rankByFileName(
    [{ n: '自然，这是一部手稿.docx' }, { n: '无关.pdf' }],
    '手稿',
    (entry) => entry.n,
  )
  assert.equal(ranked.length, 1)
})
test('记忆注入：@ 优先 + 预算截断', () => {
  const store = new MemoryStore({
    ctx: {},
    root: 'unused',
    spacePrefix: 'napcat-',
    recentLimit: 10,
    injectRecent: 3,
    injectMaxChars: 200,
    log: () => undefined,
  })
  const text = store.buildInjection({
    chatKey: 'group:1',
    recent: ['12:00 张三: 在聊啥', '12:01 李四: 聊部署'],
    recallText: '本群规矩：周五发周报',
    mention: '王五：小灯你看下这个',
  })
  assert.match(text, /当前 @你 的人/)
  assert.match(text, /王五/)
  assert.match(text, /周五发周报/)
  const long = store.buildInjection({
    chatKey: 'group:1',
    recent: Array.from({ length: 50 }, (_, i) => '12:0' + i + ' 张三: ' + 'x'.repeat(20)),
    recallText: '',
    mention: '',
  })
  assert.ok(long.length <= 260)
  assert.match(long, /记忆超预算/)
})
test('主动发言：静默时段 / 泊松 / 退避 / 门槛', () => {
  const quiet = parseQuietHours('23:00-07:00,12:00-13:00')
  assert.equal(inQuietHours(3 * 60, quiet), true)     // 03:00 在跨天静默段内
  assert.equal(inQuietHours(12 * 60 + 30, quiet), true)
  assert.equal(inQuietHours(15 * 60, quiet), false)

  assert.ok(Math.abs(poissonHit(2, 30 * 60_000) - 0.632) < 0.01)
  assert.ok(poissonHit(0, 1000) === 0)
  assert.equal(skipBackoffFactor(0), 1)
  assert.equal(skipBackoffFactor(1), 0.5)
  assert.equal(skipBackoffFactor(2), 0.5)
  assert.equal(skipBackoffFactor(5), 0.5)

  const base = {
    enabled: true, ratePerHour: 50, cooldownMinutes: 1, quietHours: '', hotMessages: 3,
  }
  const now = Date.UTC(2026, 9, 23, 4, 0, 0)
  const ok = decide({ now, minuteOfDay: 600, options: base, state: newChatState(), recentOthers: 5, random: () => 0 })
  assert.equal(ok.send, true)

  const quietMiss = decide({ now, minuteOfDay: 180, options: { ...base, quietHours: '00:00-08:00' }, state: newChatState(), recentOthers: 5, random: () => 0 })
  assert.equal(quietMiss.send, false)
  assert.equal(quietMiss.reason, 'quiet-hours')

  const few = decide({ now, minuteOfDay: 600, options: base, state: newChatState(), recentOthers: 1, random: () => 0 })
  assert.equal(few.reason, 'not-enough-chatter')

  const cooling = decide({ now, minuteOfDay: 600, options: base, state: { ...newChatState(), lastSpokeAt: now - 10_000 }, recentOthers: 5, random: () => 0 })
  assert.equal(cooling.reason, 'cooldown')
})

// 每小时上限按"本滚动小时达到过的最高档"算（B 方案）：
// 否则热聊时发过 1 条、热度回落到寒暄档（上限 1）后会被追溯判超限，整小时锁死。
test('每小时上限：热度回落后不追溯判超限', () => {
  const now = Date.UTC(2026, 10, 12, 10, 0, 0)
  const options = {
    enabled: true, ratePerHour: 4, cooldownMinutes: 5, quietHours: '', hotMessages: 1,
    heatScaling: true,
  }
  const mkState = () => ({ ...newChatState(), lastSpokeAt: now - 20 * 60_000, sentAt: [now - 30 * 60_000] })
  const input = (state, tier) => ({
    now, minuteOfDay: 720, options, state, recentOthers: 5,
    lastMessageAt: now - 10_000, heat: { score: tier === 'hot' ? 7 : 0, tier }, random: () => 0,
  })

  // 对照组：从未在热聊档记过 peak → 寒暄档上限 1，已发 1 条 → 判超限
  const coldOnly = decide(input(mkState(), 'low'))
  assert.equal(coldOnly.reason, 'hourly-cap')
  assert.equal(coldOnly.sentInHour, 1)
  assert.equal(coldOnly.capPerHour, 1)

  // 实验组：同一小时先在热聊档记下 peak=6，再回落到寒暄档 → 不应再判超限
  const shared = mkState()
  decide(input(shared, 'hot'))
  const afterDrop = decide(input(shared, 'low'))
  assert.notEqual(afterDrop.reason, 'hourly-cap')
})
test('图片缓存：日期键与 URL 去重 hash', () => {
  const t = Date.UTC(2026, 9, 23, 4, 0, 0) // 本地 2026-10-23 12:00
  assert.equal(dayKey(t).length, 8)
  assert.match(dayKey(t), /^2026\d{4}$/)
  const a = urlHash('https://example.com/a.jpg')
  assert.equal(a, urlHash('https://example.com/a.jpg'))
  assert.notEqual(a, urlHash('https://example.com/b.jpg'))
  assert.equal(a.length, 10)
})
test('预热合并不会丢历史（seedRecent 合并语义）', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'seed-test-'))
  try {
    const store = new MemoryStore({
      ctx: {}, root: dir, spacePrefix: 'napcat-', backend: 'file',
      recentLimit: 100, injectRecent: 20, injectMaxChars: 4000, log: () => undefined,
    })
    for (let i = 0; i < 40; i += 1) {
      await store.appendRecent('group:1', { nick: '张三', text: 'old-' + i, at: 1_700_000_000_000 + i * 1000 })
    }
    assert.equal(await store.recentCount('group:1'), 40)
    const fetched = []
    for (let i = 30; i < 60; i += 1) fetched.push({ nick: '张三', text: 'old-' + i, at: 1_700_000_000_000 + i * 1000 })
    await store.seedRecent('group:1', fetched)
    const after = await store.recentCount('group:1')
    assert.ok(after >= 40, '旧记录不能被顶掉，实际 ' + after)
    const lines = readFileSync(join(dir, 'group-1', 'recent.jsonl'), 'utf8').trim().split('\n')
    assert.equal(JSON.parse(lines[0]).text, 'old-0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('表情库：未安装 dsh-meme 时安静降级（不抛错、不发图）', async () => {
  const { MemeLibrary } = await import('../lib/meme.js')
  const lib = new MemeLibrary(['/definitely/not/here'], () => undefined)
  assert.deepEqual(await lib.search('干饭'), [])
  assert.equal(await lib.randomInTag('happy'), undefined)
})

test('表情库：坏目录/空描述也不炸', async () => {
  const { MemeLibrary } = await import('../lib/meme.js')
  const lib = new MemeLibrary([], () => undefined)
  assert.deepEqual(await lib.search(''), [])
  assert.deepEqual(await lib.search('   '), [])
})
test('原生表情兜底：描述 → QQ face id', async () => {
  const { faceFor, faceCatalog } = await import('../lib/faces.js')
  assert.equal(faceFor('开心'), '14')
  assert.equal(faceFor('笑死我了'), '13')
  assert.equal(faceFor('生气'), '11')
  assert.equal(faceFor('无语'), '27')
  assert.equal(faceFor('干饭'), '24')
  assert.equal(faceFor('完全对不上的一句话xyz'), undefined)
  assert.equal(faceFor(''), undefined)
  assert.ok(faceCatalog().length >= 15)
})
test('出站混排：小黄脸插在文字中间、分段不拆表情', async () => {
  const { splitSegments, trimParts } = await import('../lib/bridge.js')
  const parts = trimParts([
    { kind: 'text', text: '  好耶' },
    { kind: 'face', id: '14' },
    { kind: 'text', text: '那我去睡了' },
    { kind: 'face', id: '8' },
    { kind: 'text', text: '  ' },
  ])
  // 首尾空白被去掉，表情保留（共 4 段：文字、表情、文字、表情）
  assert.equal(parts.length, 4)
  assert.equal(parts[0].kind, 'text')
  assert.equal(parts[0].text, '好耶')
  assert.deepEqual(parts[1], { kind: 'face', id: '14' })
  assert.deepEqual(parts[3], { kind: 'face', id: '8' })
  // 分段：maxChars 很小时只切文字，表情跟着原位置
  const groups = splitSegments(parts, 2)
  assert.ok(groups.length >= 2)
  const flat = groups.flat()
  assert.equal(flat.filter(p => p.kind === 'face').length, 2)
  // 每段文字长度都不超上限
  for (const group of groups) {
    const len = group.filter(p => p.kind === 'text').reduce((acc, p) => acc + p.text.length, 0)
    assert.ok(len <= 2, '段内文字长度应 <= 2，实际 ' + len)
  }
})
test('原生表情轮换：连续「开心」不会一直是同一个', async () => {
  const { faceFor } = await import('../lib/faces.js')
  const first = faceFor('开心')
  assert.equal(first, '14')
  const second = faceFor('开心', new Set([first]))
  assert.notEqual(second, first)
  const third = faceFor('开心', new Set([first, second]))
  assert.notEqual(third, first)
  assert.notEqual(third, second)
  // 全都发过时 → 挑最久没用过的（历史数组末尾 = 最旧）
  const history = ['14', '13', '21', '20']
  assert.equal(faceFor('开心', history), '20')
  // 也支持传 Set（旧签名兼容）
  assert.ok(['14', '13', '21', '20'].includes(faceFor('开心', new Set(history))))
})
test('表情避重：同情绪图用尽后返回 undefined，交给全场随机扩池', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'meme-avoid-'))
  try {
    const pack = join(root, 'pack1')
    mkdirSync(join(pack, 'happy'), { recursive: true })
    writeFileSync(join(pack, 'happy', 'a.jpg'), 'x')
    writeFileSync(join(pack, 'happy', 'b.jpg'), 'x')
    // 造一个最小 index.db：用 node:sqlite
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(pack, 'index.db'))
    db.exec('CREATE TABLE memes (path TEXT PRIMARY KEY, tag TEXT, file_name TEXT, caption TEXT, keywords TEXT)')
    db.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords) VALUES (?,?,?,?,?)').run('happy/a.jpg', 'happy', 'a.jpg', '开心a', 'a')
    db.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords) VALUES (?,?,?,?,?)').run('happy/b.jpg', 'happy', 'b.jpg', '开心b', 'b')
    db.close()
    const { MemeLibrary } = await import('../lib/meme.js')
    const lib = new MemeLibrary([root], () => undefined)
    const all = await lib.search('开心', new Set(), 5)
    assert.equal(all.length, 2)
    assert.equal(await lib.size(), 2)
    const avoid = new Set(all.map(hit => hit.file))
    assert.equal(await lib.randomInTag('happy', avoid), undefined)
    // 全场随机在还有没发过的图时仍可选中
    assert.ok(await lib.randomAny(new Set()) !== undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('预热计数：缓冲已满时仍返回真正新增条数', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'cnt-'))
  try {
    const store = new MemoryStore({
      ctx: {}, root: tmp, spacePrefix: 'napcat-', backend: 'file',
      recentLimit: 5, injectRecent: 5, injectMaxChars: 4000, log: () => undefined,
    })
    for (let i = 0; i < 5; i += 1) await store.appendRecent('group:1', { nick: 'a', text: 't' + i, at: 1000 + i })
    const added = await store.seedRecent('group:1', [
      { nick: 'a', text: 'n1', at: 2000 },
      { nick: 'a', text: 'n2', at: 2001 },
      { nick: 'a', text: 'n3', at: 2002 },
    ])
    assert.equal(added, 3)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('表情匹配：2-gram + 中文同义词都能命中', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { MemeLibrary, bigrams, TAG_SYNONYMS } = await import('../lib/meme.js')
  const root = mkdtempSync(join(tmpdir(), 'meme-fuzzy-'))
  try {
    const pack = join(root, 'pack1')
    mkdirSync(join(pack, 'daily'), { recursive: true })
    mkdirSync(join(pack, 'givemoney'), { recursive: true })
    writeFileSync(join(pack, 'daily', 'ganfan.jpg'), 'x')
    writeFileSync(join(pack, 'givemoney', 'yaoqian.jpg'), 'x')
    const db = new DatabaseSync(join(pack, 'index.db'))
    db.exec('CREATE TABLE memes (path TEXT PRIMARY KEY, tag TEXT, file_name TEXT, caption TEXT, keywords TEXT)')
    db.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords) VALUES (?,?,?,?,?)').run('daily/ganfan.jpg', 'daily', 'ganfan.jpg', '捧着蓝碗干饭，星星眼吃得很香', '干饭 吃饭')
    db.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords) VALUES (?,?,?,?,?)').run('givemoney/yaoqian.jpg', 'givemoney', 'yaoqian.jpg', '捧着小钱包亮晶晶期待，求零食钱', '钱 红包')
    db.close()
    const lib = new MemeLibrary([root], () => undefined)
    // 2-gram：「吃饭」能对上 caption 里的「干饭」
    const viaGram = await lib.search('吃饭', new Set(), 3)
    assert.ok(viaGram.some(hit => hit.file.endsWith('ganfan.jpg')), '2-gram 应命中 ganfan')
    // 同义词：口语「给我钱」对上 givemoney 标签
    const viaSynonym = await lib.search('给我钱', new Set(), 3)
    assert.ok(viaSynonym.some(hit => hit.file.endsWith('yaoqian.jpg')), '同义词表应命中 yaoqian')
    assert.ok(bigrams('吃饭饭').length >= 2)
    assert.ok(TAG_SYNONYMS.givemoney?.includes('钱'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('表情一致性：caption 原文精确命中，多次结果相同', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { MemeLibrary } = await import('../lib/meme.js')
  const root = mkdtempSync(join(tmpdir(), 'meme-exact-'))
  try {
    const pack = join(root, 'pack1')
    mkdirSync(join(pack, 'daily'), { recursive: true })
    writeFileSync(join(pack, 'daily', 'a.jpg'), 'x')
    writeFileSync(join(pack, 'daily', 'b.jpg'), 'x')
    const db = new DatabaseSync(join(pack, 'index.db'))
    db.exec('CREATE TABLE memes (path TEXT PRIMARY KEY, tag TEXT, file_name TEXT, caption TEXT, keywords TEXT)')
    db.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords) VALUES (?,?,?,?,?)').run('daily/a.jpg', 'daily', 'a.jpg', '捧着碗干饭', '干饭')
    db.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords) VALUES (?,?,?,?,?)').run('daily/b.jpg', 'daily', 'b.jpg', '摸鱼躺平', '躺平')
    db.close()
    const lib = new MemeLibrary([root], () => undefined)
    const first = await lib.exact('捧着碗干饭')
    const second = await lib.exact('捧着碗干饭')
    assert.equal(first?.file, second?.file)
    assert.ok(first?.file.endsWith('a.jpg'))
    // 不是完整 caption 时不走精确路径
    assert.equal(await lib.exact('干饭'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('记忆注入：带最近发过的表情，提醒别连用', () => {
  const store = new MemoryStore({
    ctx: {}, root: tmpdir(), spacePrefix: 'napcat-', backend: 'file',
    recentLimit: 200, injectRecent: 5, injectMaxChars: 6000, log: () => undefined,
  })
  const text = store.buildInjection({
    chatKey: 'group:1', recent: [], recallText: '', spaceId: 'x',
    recentExpressions: ['捧着蓝碗干饭，星星眼吃得很香', '摸鱼躺平，半睁眼摊着不想动'],
  })
  assert.ok(text.includes('【最近发过的表情】'))
  assert.ok(text.includes('捧着蓝碗干饭'))
  assert.ok(text.includes('别连着用同一个描述'))
  // 没有历史时不出现这个块
  const plain = store.buildInjection({ chatKey: 'group:1', recent: [], recallText: '', spaceId: 'x' })
  assert.ok(!plain.includes('【最近发过的表情】'))
})
test('配置面收敛：预热目标由 recentLimit 承担，warmupHistory 已移除', async () => {
  const { DEFAULTS, Config } = await import('../lib/config.js')
  assert.equal('warmupHistory' in DEFAULTS, false)
  const dict = Config?.dict ?? {}
  assert.equal('warmupHistory' in dict, false)
  assert.equal(DEFAULTS.recentLimit, 200)
  assert.equal(DEFAULTS.injectRecent, 20)
  assert.equal(DEFAULTS.warmupStaleMinutes, 10)
})
test('归档流水线：待归档批次 → 摘要/人物 → 注入', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'arch-'))
  try {
    const store = new MemoryStore({
      ctx: {}, root: tmp, spacePrefix: 'napcat-', backend: 'file',
      recentLimit: 200, injectRecent: 20, injectMaxChars: 6000, log: () => undefined,
    })
    for (let i = 0; i < 6; i += 1) await store.appendRecent('group:1', { nick: '顿顿', text: '消息' + i, at: 1000 + i })
    // 初始水位 0 → 全部待归档
    const state = await store.archiveState('group:1')
    assert.equal(state.archivedUpTo, 0)
    const rows = await store.pendingArchiveRows('group:1', 0, 4)
    assert.equal(rows.length, 4)
    assert.equal(rows[0].text, '消息0')
    // 写批次文件
    const path = await store.writeArchiveBatch('group:1', rows)
    assert.ok(path.endsWith('archive-pending.jsonl'))
    // 摘要 + 人物
    await store.appendSummary('group:1', { from: 1000, to: 1003, text: '聊了抽卡和拼胶' })
    await store.savePeople('group:1', { 老灯: { names: ['老灯'], style: '吐槽型', topics: ['抽卡'] } })
    // 水位推进后不再重复取同一批
    await store.saveArchiveState('group:1', { archivedUpTo: 1003, lastAt: Date.now() })
    const rows2 = await store.pendingArchiveRows('group:1', (await store.archiveState('group:1')).archivedUpTo, 4)
    assert.equal(rows2.length, 2)
    assert.equal(rows2[0].text, '消息4')
    // 注入能看到摘要与人物
    // 摘要：覆盖式（再归档一次不会变两段）
    await store.saveSummary('group:1', { text: '第一版摘要', from: 1000, to: 1003 })
    await store.saveSummary('group:1', { text: '第二版摘要（合并）', from: 1000, to: 1003 })
    const summary = await store.readSummary('group:1')
    assert.equal(summary?.text, '第二版摘要（合并）')
    // facts：覆盖式
    await store.saveFacts('group:1', { glossary: ['好家伙'], setting: ['群主要叫帅哥'] })
    const facts = await store.readFacts('group:1')
    assert.deepEqual(facts.glossary, ['好家伙'])
    const people = await store.readPeople('group:1')
    const inj = store.buildInjection({
      chatKey: 'group:1', recent: [], recallText: '', spaceId: 'x',
      summary: summary?.text, facts,
      people: Object.entries(people).map(([name, card]) => ({ name, style: card.style, topics: card.topics })),
    })
    assert.ok(inj.includes('【近期脉络'))
    assert.ok(inj.includes('第二版摘要'))
    assert.ok(inj.includes('【本群固定信息'))
    assert.ok(inj.includes('群主要叫帅哥'))
    assert.ok(inj.includes('【本群人物'))
    assert.ok(inj.includes('老灯'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
test('归档提示词与解析：合并语义 + 容忍围栏', async () => {
  const { buildArchivePrompt, parseArchivePayload } = await import('../lib/archive.js')
  const prompt = buildArchivePrompt({
    path: '/workspace/memory/group-1/archive-pending.jsonl',
    count: 50,
    chatKey: 'group:1',
    existing: {
      summary: '之前在聊抽卡',
      people: [{ name: '老灯', style: '吐槽型', topics: ['抽卡'] }],
      glossary: ['好家伙'],
      setting: ['群主要叫帅哥'],
    },
  })
  assert.ok(prompt.includes('更新后的完整版本'))
  assert.ok(prompt.includes('只做归档'))
  assert.ok(prompt.includes('之前在聊抽卡'))
  assert.ok(prompt.includes('老灯'))
  // 解析：普通 JSON
  const plain = parseArchivePayload('{"summary":"聊了拼胶","people":[{"name":"顿顿","style":"技术流"}]}')
  assert.equal(plain?.summary, '聊了拼胶')
  assert.equal(plain?.people?.[0]?.name, '顿顿')
  // 解析：包在代码围栏 + 前后废话
  const fenced = parseArchivePayload('好的，结果如下：\n```json\n{"summary":"带围栏也能解析","glossary":["哦豁"]}\n```\n以上。')
  assert.equal(fenced?.summary, '带围栏也能解析')
  assert.deepEqual(fenced?.glossary, [{ text: '哦豁' }])
  // 解析：旧 <归档> 包装
  const tagged = parseArchivePayload('<归档>{"setting":["群主要叫帅哥"]}</归档>')
  assert.deepEqual(tagged?.setting, [{ text: '群主要叫帅哥' }])
  // 无效输出
  assert.equal(parseArchivePayload('这句不是 JSON'), undefined)
})
test('评分机制：同 key 合并累加 hits，低分陈旧条目被淘汰', async () => {
  const { mergeItem, pruneItems, effectiveScore, normalizeKey, topItems } = await import('../lib/memscore.js')
  const now = Date.now()
  let items = []
  items = mergeItem(items, { kind: 'setting', text: '群主要叫帅哥', weight: 5 }, now)
  // 同一条（差标点）再出现 → 合并，不新增
  items = mergeItem(items, { kind: 'setting', text: '群主要叫帅哥。', weight: 5 }, now + 1000)
  assert.equal(items.length, 1)
  assert.equal(items[0].hits, 2)
  assert.equal(normalizeKey('群主要叫帅哥。'), normalizeKey('群主要叫帅哥'))
  // 边缘条目：低权重 + 很久没出现
  items = mergeItem(items, { kind: 'glossary', text: '一次性梗', weight: 1 }, now - 365 * 24 * 3600_000)
  const pruned = pruneItems(items, { now, minScore: 0.25, forgetAfterMs: 45 * 24 * 3600_000 })
  const keys = pruned.items.map(item => item.key)
  assert.ok(keys.includes(normalizeKey('群主要叫帅哥')), '核心条目要保留')
  assert.ok(!keys.includes(normalizeKey('一次性梗')), '低分陈旧条目要淘汰')
  // 上限截断：高分优先
  let many = []
  for (let i = 0; i < 40; i += 1) many = mergeItem(many, { kind: 'glossary', text: '词' + i, weight: i % 5 + 1 }, now)
  const capped = pruneItems(many, { now, maxPerKind: 10 })
  assert.equal(capped.items.length, 10)
  assert.ok(effectiveScore(capped.items[0], now) >= effectiveScore(capped.items[9], now))
  assert.equal(topItems(capped.items, 'glossary', 3).length, 3)
})
test('新分类：偏好/氛围/待办/事件入库并注入，过期待办自动剔除', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'cats-'))
  try {
    const store = new MemoryStore({
      ctx: {}, root: tmp, spacePrefix: 'napcat-', backend: 'file',
      recentLimit: 200, injectRecent: 20, injectMaxChars: 6000, log: () => undefined,
    })
    const now = Date.now()
    await store.mergeItemsInto('group:1', [
      { kind: 'setting', text: '群主要叫帅哥', weight: 5 },
      { kind: 'preference', text: '老灯不喝咖啡', weight: 3 },
      { kind: 'style', text: '群里爱接梗互损', weight: 4 },
      { kind: 'todo', text: '周六开黑', weight: 4, expiresAt: now + 5 * 86_400_000 },
      { kind: 'todo', text: '过期的事', weight: 4, expiresAt: now - 86_400_000 },
      { kind: 'event', text: '老灯拼完了模型', weight: 2, expiresAt: now + 30 * 86_400_000 },
    ])
    const facts = {
      glossary: await store.topTexts('group:1', 'glossary', 8),
      setting: await store.topTexts('group:1', 'setting', 8),
      preference: await store.topTexts('group:1', 'preference', 6),
      style: await store.topTexts('group:1', 'style', 2),
      todo: await store.topTexts('group:1', 'todo', 5),
      event: await store.topTexts('group:1', 'event', 5),
    }
    assert.deepEqual(facts.todo, ['周六开黑'])
    assert.deepEqual(facts.preference, ['老灯不喝咖啡'])
    const inj = store.buildInjection({ chatKey: 'group:1', recent: [], recallText: '', spaceId: 'x', facts })
    assert.ok(inj.includes('【本群氛围'))
    assert.ok(inj.includes('【本群偏好/忌讳'))
    assert.ok(inj.includes('【待办/约定'))
    assert.ok(inj.includes('【最近发生的事'))
    assert.ok(!inj.includes('过期的事'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
test('重启恢复：磁盘上的待归档批次能被扫描回来', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'restore-'))
  try {
    const store = new MemoryStore({
      ctx: {}, root: tmp, spacePrefix: 'napcat-', backend: 'file',
      recentLimit: 200, injectRecent: 20, injectMaxChars: 4000, log: () => undefined,
    })
    const dir = join(tmp, 'group-660610917')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'archive-pending.jsonl'),
      JSON.stringify({ t: 1000, nick: 'a', text: 'x' }) + '\n' + JSON.stringify({ t: 2000, nick: 'b', text: 'y' }) + '\n')
    const list = await store.listPendingArchives()
    assert.equal(list.length, 1)
    assert.equal(list[0].chatKey, 'group:660610917')
    assert.equal(list[0].count, 2)
    assert.equal(list[0].from, 1000)
    assert.equal(list[0].to, 2000)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
test('归档批次：处理完清文件，重启后不再重复', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'clearbatch-'))
  try {
    const store = new MemoryStore({
      ctx: {}, root: tmp, spacePrefix: 'napcat-', backend: 'file',
      recentLimit: 200, injectRecent: 20, injectMaxChars: 4000, log: () => undefined,
    })
    const dir = join(tmp, 'group-1')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'archive-pending.jsonl')
    writeFileSync(file, JSON.stringify({ t: 1, nick: 'a', text: 'x' }) + '\n')
    assert.ok(existsSync(file))
    assert.equal((await store.listPendingArchives()).length, 1)
    await store.clearArchiveBatch('group:1')
    assert.ok(!existsSync(file))
    assert.equal((await store.listPendingArchives()).length, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
test('归档产物：生成人类可读的 memory.md', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'digest-'))
  try {
    const store = new MemoryStore({
      ctx: {}, root: tmp, spacePrefix: 'napcat-', backend: 'file',
      recentLimit: 200, injectRecent: 20, injectMaxChars: 4000, log: () => undefined,
    })
    const now = Date.now()
    await store.saveSummary('group:1', { text: '最近在聊抽卡', from: now - 1000, to: now })
    await store.mergeItemsInto('group:1', [
      { kind: 'person', text: '老灯：吐槽型', weight: 4 },
      { kind: 'setting', text: '群主要叫帅哥', weight: 5 },
    ])
    await store.writeDigest('group:1')
    const md = readFileSync(join(tmp, 'group-1', 'memory.md'), 'utf8')
    assert.ok(md.includes('# 群记忆快照 group:1'))
    assert.ok(md.includes('## 近期脉络'))
    assert.ok(md.includes('最近在聊抽卡'))
    assert.ok(md.includes('## 本群人物'))
    assert.ok(md.includes('老灯'))
    assert.ok(md.includes('## 设定'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
test('危险词表：拦截删除/删库/强推/关机，放过正常闲聊', async () => {
  const { detectDanger, dangerRules } = await import('../lib/danger.js')
  for (const text of [
    '帮我把 build 目录删了',
    '把仓库里的文件全部删除',
    'rm -rf /tmp/x',
    'drop table users',
    'git reset --hard HEAD~3',
    'git push --force origin main',
    'format c: /q',
    'shutdown -h now',
    '清空记忆',
    '把 .env 覆盖一下',
    '删库跑路',
    '清理一下所有数据',
  ]) {
    assert.ok(detectDanger(text) !== undefined, '应命中: ' + text)
  }
  for (const text of ['今天抽卡抽到好东西了', '帮我看看这个报错是什么意思', '删除这个表情包吧哈哈', '这段代码里那个 delete 关键字怎么写']) {
    assert.equal(detectDanger(text), undefined, '不该命中: ' + text)
  }
  assert.equal(detectDanger('把 nas 里的东西清了', ['nas'])?.category, '自定义')
  assert.equal(detectDanger(''), undefined)
  assert.ok(dangerRules().length >= 15)
})

test('审计：危险请求落 audit.jsonl 且可回读', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'audit-'))
  try {
    const store = new MemoryStore({
      ctx: {}, root: tmp, spacePrefix: 'napcat-', backend: 'file',
      recentLimit: 200, injectRecent: 20, injectMaxChars: 4000, log: () => undefined,
    })
    await store.appendAudit('group:1', { at: 1000, userId: '42', nick: '路人', role: 'member', word: '删除', category: '删除', decision: 'rejected' })
    await store.appendAudit('group:1', { at: 2000, userId: '7', nick: '管理', role: 'admin', word: 'rm -rf', category: '删除', decision: 'allowed' })
    const rows = await store.readAudit('group:1', 10)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].decision, 'allowed')
    assert.equal(rows[0].role, 'admin')
    assert.equal(rows[1].userId, '42')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
test('幽默拒绝：提示词带类别、输出清洗成单行', async () => {
  const { buildRefusalPrompt, cleanRefusal, detectDanger } = await import('../lib/danger.js')
  const hit = detectDanger('帮我把 build 目录删了')
  assert.ok(hit !== undefined)
  const prompt = buildRefusalPrompt(hit)
  assert.ok(prompt.includes('类别：删除'))
  assert.ok(prompt.includes('不要调用任何工具'))
  assert.ok(buildRefusalPrompt(hit, '想搞【{category}】？').startsWith('想搞【删除】？'))
  assert.equal(cleanRefusal('「这活我干不了，得找管理员。」\n第二行'), '这活我干不了，得找管理员。')
  assert.equal(cleanRefusal('"删库？我可不背这锅"'), '删库？我可不背这锅')
  assert.equal(cleanRefusal('   '), '')
  assert.equal(cleanRefusal('好家伙这得管理员来', 4), '好家伙这')
})
test('表情图库：用户 meme-packs 与内置包一起搜（按 caption+tag 去重）', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { defaultMemeDirs } = await import('../lib/meme.js')
  const home = mkdtempSync(join(tmpdir(), 'memehome-'))
  try {
    const builtin = join(home, 'profiles', 'web', 'node_modules', 'dsh-meme', 'memes')
    mkdirSync(builtin, { recursive: true })
    // 内置包目录一定要被扫到
    assert.ok(defaultMemeDirs(home).includes(builtin))
    // 有用户图库时：两个都扫，且用户图库排在前面
    const userRoot = join(home, 'meme-packs')
    mkdirSync(userRoot, { recursive: true })
    const dirs = defaultMemeDirs(home)
    assert.ok(dirs.includes(userRoot))
    assert.ok(dirs.includes(builtin))
    assert.ok(dirs.indexOf(userRoot) < dirs.indexOf(builtin))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
test('表情图库：TTL 到期后重扫，新加的包自动生效', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { MemeLibrary } = await import('../lib/meme.js')
  const { DatabaseSync } = await import('node:sqlite')
  const root = mkdtempSync(join(tmpdir(), 'memettl-'))
  const makePack = (name, caption) => {
    const dir = join(root, name)
    mkdirSync(join(dir, 'memes', 'happy'), { recursive: true })
    writeFileSync(join(dir, 'memes', 'happy', 'a.png'), 'x')
    const db = new DatabaseSync(join(dir, 'index.db'))
    db.exec('CREATE TABLE memes (path TEXT, tag TEXT, caption TEXT, keywords TEXT)')
    db.prepare('INSERT INTO memes VALUES (?,?,?,?)').run('memes/happy/a.png', 'happy', caption, '')
    db.close()
  }
  try {
    makePack('pack1', '第一张')
    const lib = new MemeLibrary([root], () => undefined, 150)
    assert.equal(await lib.size(), 1)
    makePack('pack2', '第二张')
    // 缓存期内仍是旧结果
    assert.equal(await lib.size(), 1)
    await new Promise(resolve => setTimeout(resolve, 200))
    // 过期后重扫 → 新包可见
    assert.equal(await lib.size(), 2)
    const hits = await lib.search('第二张', new Set(), 3)
    assert.equal(hits[0]?.caption, '第二张')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('人物表：peopleLimit=0 不写上限，>0 写具体数字', async () => {
  const { buildArchivePrompt } = await import('../lib/archive.js')
  const base = { path: '/tmp/batch.jsonl', count: 50, chatKey: 'group:1' }
  const unlimited = buildArchivePrompt(base)
  assert.ok(unlimited.includes('不设上限'))
  assert.ok(!unlimited.includes('最多 6 个'))
  const capped = buildArchivePrompt({ ...base, peopleLimit: 12 })
  assert.ok(capped.includes('最多 12 个'))
})
test('表情频率闸门：memeAllowed=false 时注入"本条不要发表情包"', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'memegate-'))
  try {
    const store = new MemoryStore({
      ctx: {}, root: tmp, spacePrefix: 'napcat-', backend: 'file',
      recentLimit: 200, injectRecent: 20, injectMaxChars: 4000, log: () => undefined,
    })
    const catalog = '【可用表情（共 146 张，按分类）】daily(38)：摸鱼'
    const blocked = store.buildInjection({ chatKey: 'group:1', recent: [], recallText: '', spaceId: 'x', memeCatalog: catalog, memeAllowed: false, memeSinceLast: 0 })
    const open = store.buildInjection({ chatKey: 'group:1', recent: [], recallText: '', spaceId: 'x', memeCatalog: catalog, memeAllowed: true, memeSinceLast: 3 })
    // 评分清单常驻
    assert.ok(blocked.includes('要不要发表情包·自己评一下'))
    assert.ok(open.includes('要不要发表情包·自己评一下'))
    assert.ok(open.includes('≥3 分才发'))
    // 硬底线：刚发过时明确禁止，且提示已隔条数
    assert.ok(blocked.includes('本条硬性不许发表情包'))
    assert.ok(!open.includes('本条硬性不许发表情包'))
    assert.ok(open.includes('已隔 3 条文字回复'))
    // 目录仍然在
    assert.ok(blocked.includes('【可用表情'))
    assert.ok(open.includes('【可用表情'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
test('链接话题提示：最近三条有 http 链接就提示先抓取', async () => {
  // 复刻 bridge.linkHintOf 的匹配规则（该方法是私有方法，这里验证判定逻辑）
  const linkHintOf = lines => {
    const tail = lines.slice(-3)
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const line = tail[index] ?? ''
      const match = /https?:\/\/[^\s"'）)】]+/.exec(line)
      if (match === null) continue
      return '【最新话题是一条链接】' + match[0]
    }
    return ''
  }
  const lines = [
    '御前大公公灯忠贤：对，就是把折叠屏那个梗，换成宫里的床才这么好笑',
    '户部都给事中-胡椒：【质感绝了！真人版《剑来》全新预告】 https://www.bilibili.com/video/BV15cs96zEvi/?share_source=copy_web',
    '户部都给事中-胡椒：真人版预告',
  ]
  const hint = linkHintOf(lines)
  assert.ok(hint.includes('bilibili.com/video/BV15cs96zEvi'))
  assert.equal(linkHintOf(['今天天气不错', '吃了没']), '')
  // 只看最近三条：更早的链接不该触发
  assert.equal(linkHintOf(['https://old.example.com/x', 'a', 'b', 'c']), '')
})
test('主动发言：冷却期默认闭嘴，但爆话题时可以跳队（一小时一次）', async () => {
  const base = {
    enabled: true, ratePerHour: 50, cooldownMinutes: 10, quietHours: '', hotMessages: 1,
  }
  const now = Date.UTC(2026, 9, 30, 4, 0, 0)
  const state = { lastSpokeAt: now - 60_000, sentAt: [now - 60_000], skipStreak: 0, hotJumpAt: 0, lastConsiderAt: now - 60_000 }
  const cold = decide({ now, minuteOfDay: 700, options: base, state: { ...state }, recentOthers: 5, lastMessageAt: now - 10_000, recentHot: 2, random: () => 0 })
  assert.equal(cold.reason, 'cooldown')
  // 冷却中 + 爆话题（3 分钟 12 条）→ 允许（走后面的门，chance=1 必发）
  const hot = decide({ now, minuteOfDay: 700, options: base, state: { ...state }, recentOthers: 12, lastMessageAt: now - 10_000, recentHot: 12, random: () => 0 })
  assert.equal(hot.send, true)
  // 一小时前刚跳过队 → 不许再跳
  const used = decide({ now, minuteOfDay: 700, options: base, state: { ...state, hotJumpAt: now - 20 * 60_000 }, recentOthers: 12, lastMessageAt: now - 10_000, recentHot: 12, random: () => 0 })
  assert.equal(used.reason, 'cooldown')
  // 关掉热点跳队 → 一律拦
})
test('归档解析：人物不设上限时不该被截成 8 个', async () => {
  const { parseArchivePayload } = await import('../lib/archive.js')
  const people = Array.from({ length: 12 }, (_, i) => ({ name: '角色' + (i + 1), style: '说话风格' + (i + 1), weight: 3 }))
  const json = JSON.stringify({ summary: '在聊配队', people, glossary: [], setting: [] })
  const unlimited = parseArchivePayload(json, 0)
  assert.equal(unlimited.people.length, 12)
  const capped = parseArchivePayload(json, 5)
  assert.equal(capped.people.length, 5)
})
test('客户端模块不得在顶层声明变量（会与其他插件的 classic script 撞名，拖垮整个 web boot）', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const code = readFileSync(join(import.meta.dirname, '..', 'client', 'index.js'), 'utf8')
  const offenders = code
    .split('\n')
    .filter(line => /^(const|let|var|function|class)\s/.test(line))
  assert.deepEqual(offenders, [], '顶层声明必须包进 IIFE，否则会报 Identifier already declared')
  assert.ok(code.includes('(() => {'), '客户端文件必须整体包在 IIFE 里')
})

test('游戏词表召回：命中就给出线索与工具用法，不替模型下结论', async () => {
  const { GameWiki, buildHintBlock } = await import('../lib/gamewiki.js')
  const svc = {
    list: () => [{ name: '影之刃零' }],
    detect: async (text) => (text.includes('庞镇') ? [{ game: '影之刃零', hits: ['庞镇', '雪山'] }] : []),
  }
  const ctx = { get: (name) => (name === 'dshGame' ? svc : undefined) }
  const wiki = new GameWiki({ ctx, enabled: true, log: () => {} })
  const block = await wiki.hintFor('那我应该可以直接去庞镇了吧')
  assert.ok(block !== undefined)
  assert.ok(block.includes('影之刃零'))
  assert.ok(block.includes('庞镇'))
  assert.ok(block.includes('game_wiki_search'))
  assert.ok(block.includes('随口讨论'))
  // 没有命中就不注入
  const none = await wiki.hintFor('今天吃什么')
  assert.equal(none, undefined)
})

test('游戏词表召回：未启用 / 服务缺失 / 空消息 都不注入', async () => {
  const { GameWiki } = await import('../lib/gamewiki.js')
  const svc = { list: () => [], detect: async () => [{ game: 'X', hits: ['Y'] }] }
  const on = new GameWiki({ ctx: { get: () => svc }, enabled: true, log: () => {} })
  const off = new GameWiki({ ctx: { get: () => svc }, enabled: false, log: () => {} })
  const missing = new GameWiki({ ctx: { get: () => undefined }, enabled: true, log: () => {} })
  assert.equal(await off.hintFor('庞镇在哪'), undefined)
  assert.equal(await missing.hintFor('庞镇在哪'), undefined)
  assert.equal(await on.hintFor('   '), undefined)
})

test('归档规则：event 里的游戏进度必须带游戏名', async () => {
  const { buildArchivePrompt } = await import('../lib/archive.js')
  const prompt = buildArchivePrompt({ path: 'x', count: 10, chatKey: 'group:1' })
  assert.ok(prompt.includes('群友的游戏进度'))
  assert.ok(prompt.includes('游戏名'))
})
test('B 站链接抽取：完整 URL / b23 短链 / BV 号 / av 号', async () => {
  const { extractBiliLink } = await import('../lib/bililink.js')
  assert.equal(extractBiliLink('看这个 https://www.bilibili.com/video/BV1GJ411x7h7?p=1 笑死'), 'https://www.bilibili.com/video/BV1GJ411x7h7?p=1')
  assert.equal(extractBiliLink('https://b23.tv/abc123'), 'https://b23.tv/abc123')
  assert.equal(extractBiliLink('BV1GJ411x7h7 这个'), 'https://www.bilibili.com/video/BV1GJ411x7h7')
  assert.equal(extractBiliLink('av12345'), 'https://www.bilibili.com/video/av12345')
  assert.equal(extractBiliLink('今天吃什么'), undefined)
})

test('B 站注入块：像看过一样聊天，不播报不贴链接', async () => {
  const { buildBiliBlock } = await import('../lib/bililink.js')
  const block = buildBiliBlock({
    info: { title: '测试视频', up: '某UP', durationSec: 213, pageUrl: 'https://x', stats: { view: 12000000 } },
    summary: { total: 1200, density: 5.63, peaks: [{ startSec: 0, endSec: 30, count: 737, samples: ['你被骗了'] }], samples: ['你被骗了', '欢迎回来'] },
    subtitleText: '字幕节选内容',
  })
  assert.ok(block.includes('你刚看过'))
  assert.ok(block.includes('1200'))
  assert.ok(block.includes('你被骗了'))
  assert.ok(block.includes('像真的看过一样随口接话'))
  assert.ok(block.includes('不要贴链接'))
  assert.ok(!block.includes('根据弹幕'))
})
test('QQ 分享卡片：json/xml/小程序 都能挖出 B 站链接（否则永远不触发）', async () => {
  const { toText } = await import('../lib/text.js')
  const card = JSON.stringify({ app: 'com.tencent.structmsg', meta: { news: { title: '笑死', jumpUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7?share_source=qq' } } })
  const fromJson = toText([{ type: 'json', data: { data: card } }])
  assert.ok(fromJson.includes('BV1GJ411x7h7'), 'json 卡片里的链接要保留')
  assert.ok(fromJson.includes('笑死'), '卡片标题要保留')

  const fromXml = toText([{ type: 'xml', data: { data: '<msg><item><title>枷笼山攻略</title><qqdocurl>https://b23.tv/AbCdEfG</qqdocurl></item></msg>' } }])
  assert.ok(fromXml.includes('b23.tv/AbCdEfG'), 'xml 卡片里的短链要保留')

  const fromApp = toText([{ type: 'light_app', data: { json_payload: '{"meta":{"detail_1":{"qqdocurl":"https://b23.tv/XyZ1234"}}}' } }])
  assert.ok(fromApp.includes('b23.tv/XyZ1234'), '小程序卡片里的链接要保留')

  // 转义形态（\/ ）
  const escaped = toText([{ type: 'json', data: { data: '{"jumpUrl":"https:\\/\\/www.bilibili.com\\/video\\/BV1xx411c7mD"}' } }])
  assert.ok(escaped.includes('BV1xx411c7mD'), '转义斜杠要还原')
})

test('分享卡片 → B 站联动能接上（链接可被 extractBiliLink 识别）', async () => {
  const { toText } = await import('../lib/text.js')
  const { extractBiliLink } = await import('../lib/bililink.js')
  const card = JSON.stringify({ meta: { news: { jumpUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7?share_source=qq&share_medium=android' } } })
  const text = toText([{ type: 'json', data: { data: card } }])
  assert.ok(extractBiliLink(text) !== undefined, '卡片文本里应能抽出 B 站链接')
})
test('热量分：寒暄/刷屏算 0 分，聊正事/游戏才是热聊', async () => {
  const { scoreHeat, isSmallTalk } = await import('../lib/proactive.js')
  assert.equal(isSmallTalk('早'), true)
  assert.equal(isSmallTalk('早安'), true)
  assert.equal(isSmallTalk('哈哈哈'), true)
  assert.equal(isSmallTalk('在吗'), true)
  assert.equal(isSmallTalk('庞镇那个任务怎么做啊'), false)

  const now = Date.now()
  const greetings = Array.from({ length: 8 }, (_, i) => ({ at: now - i * 1000, text: '早', sender: 'u' + (i % 3) }))
  const g = scoreHeat(greetings)
  assert.ok(g.heat <= 2, '纯寒暄热量应该很低，实际 ' + g.heat)
  assert.equal(g.tier, 'low')
  assert.equal(g.allSmallTalk, true)

  const gameTalk = [
    '庞镇那个任务怎么做啊？求指点',
    '我刚到枷笼山，玉儿的剧情还没走完',
    '红房子打完还是进不去，是不是漏了湖上那个',
    '榕树之心每周木要重新收集吗',
    '风雪刀客那套装备值不值得刷',
    '湖心任务要先打 4 个龙柱再存档',
  ].map((text, i) => ({ at: now - i * 1000, text, sender: 'u' + (i % 3) }))
  const h = scoreHeat(gameTalk)
  assert.ok(h.heat >= 3, '聊游戏应该进热聊档，实际 ' + h.heat)
  assert.equal(h.tier, 'hot')
  assert.ok(h.participants >= 2)
})

test('热量分档：寒暄档不插话，热聊档才放开频率', async () => {
  const { decide, newChatState, scoreHeat, TIERS } = await import('../lib/proactive.js')
  const options = { enabled: true, ratePerHour: 4, cooldownMinutes: 5, quietHours: '', hotMessages: 6, freshSeconds: 300, heatScaling: true, heatLowMax: 2, heatHotMin: 5 }
  const now = Date.now()
  const state = newChatState()
  state.lastConsiderAt = now - 60_000
  const greetings = scoreHeat(Array.from({ length: 8 }, (_, i) => ({ at: now - i * 1000, text: '早', sender: 'u' + (i % 3) })))

  // 寒暄档：可以偶尔插一句，但一小时最多 1 条
  let sent = 0
  const sentAt = []
  for (let i = 0; i < 50; i += 1) {
    const d = decide({ now, minuteOfDay: 600, options, state, recentOthers: 8, lastMessageAt: now - 1000, recentHot: 8, heat: greetings, random: () => 0 })
    if (d.send) { sent += 1; state.lastSpokeAt = now; sentAt.push(now); state.sentAt.push(now) }
  }
  assert.ok(sent <= 1, '寒暄档一小时最多 1 条，实际 ' + sent)

  // 热聊档：同样随机数下会发，且每小时上限存在
  const hot = scoreHeat(Array.from({ length: 8 }, (_, i) => ({ at: now - i * 1000, text: '庞镇那个任务怎么做啊？求指点', sender: 'u' + (i % 3) })))
  const hotState = newChatState()
  hotState.lastConsiderAt = now - 60_000
  let hotSent = 0
  for (let i = 0; i < 100; i += 1) {
    const d = decide({ now, minuteOfDay: 1200, options, state: hotState, recentOthers: 8, lastMessageAt: now - 1000, recentHot: 8, heat: hot, random: () => 0 })
    if (d.send) { hotSent += 1; hotState.lastSpokeAt = now; hotState.sentAt.push(now) }
  }
  assert.ok(hotSent >= 1, '热聊档应该会说话')
  assert.ok(hotSent <= TIERS.hot.capPerHour, '不能超过热聊档的每小时上限')
})

test('热量分档：关掉 heatScaling 时退回旧的固定 λ 逻辑', async () => {
  const { decide, newChatState, scoreHeat } = await import('../lib/proactive.js')
  const options = { enabled: true, ratePerHour: 4, cooldownMinutes: 5, quietHours: '', hotMessages: 6, freshSeconds: 300, heatScaling: false }
  const now = Date.now()
  const state = newChatState()
  state.lastConsiderAt = now - 60_000
  const greetings = scoreHeat(Array.from({ length: 8 }, (_, i) => ({ at: now - i * 1000, text: '早' })))
  // 旧逻辑不看热量分：随机数 0 → 必中
  const d = decide({ now, minuteOfDay: 600, options, state, recentOthers: 8, lastMessageAt: now - 1000, recentHot: 8, heat: greetings, random: () => 0 })
  assert.equal(d.send, true)
})
test('B 站订阅推送：格式化成一条群消息，且按群过滤', async () => {
  const { formatPush, BiliPusher } = await import('../lib/bilipush.js')
  const items = [
    { id: 'bili:BV1', kind: 'video', title: '新视频标题', url: 'https://b23.tv/x', pubdate: 1, groups: ['group:1'], subName: '半佛仙人', providerLabel: 'B站', extra: '3 分钟' },
    { id: 'bili:9', kind: 'dynamic', title: '发了一张图', url: '', pubdate: 2, groups: ['group:1'], subName: '半佛仙人', providerLabel: 'B站', extra: '2 张图' },
  ]
  const text = formatPush(items)
  assert.ok(text.includes('【B站更新】'))
  assert.ok(text.includes('半佛仙人'))
  assert.ok(text.includes('新视频标题'))
  assert.ok(text.includes('3 分钟'))
  assert.ok(!text.includes('undefined'))

  // 假服务：只把 group:1 的条目给 group:1
  const calls = []
  const svc = {
    pending: (consumer, limit, target) => items.filter(item => item.groups.includes(target)),
    ack: async (ids, consumer) => { calls.push({ ids, consumer }) },
  }
  const pusher = new BiliPusher({ ctx: { get: () => svc }, enabled: true, maxPerPush: 5, quietRanges: [], log: () => {} })
  assert.equal(pusher.hasService(), true)
  const taken = pusher.take('group:1')
  assert.equal(taken.items.length, 2)
  assert.equal(pusher.take('group:2'), undefined, '别的群不该拿到')
  await pusher.ack(taken.consumer, taken.items)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].consumer, 'napcat:group:1')
  assert.deepEqual(calls[0].ids.sort(), ['bili:9', 'bili:BV1'])
})

test('B 站订阅推送：没装 dsh-bili 时静默跳过', async () => {
  const { BiliPusher } = await import('../lib/bilipush.js')
  const pusher = new BiliPusher({ ctx: { get: () => undefined }, enabled: true, maxPerPush: 5, quietRanges: [], log: () => {} })
  assert.equal(pusher.hasService(), false)
  assert.equal(pusher.take('group:1'), undefined)
})
test('订阅（provider 无关）：upsert 合并类型/群、pending 按群过滤、ack 生效', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { SubscriptionStore } = await import('../lib/subscriptions.js')
  const dir = await mkdtemp(join(tmpdir(), 'napcat-sub-'))
  const store = new SubscriptionStore({ dir })
  await store.load()

  const a = await store.upsert({ provider: 'bili', key: '1', name: 'UP甲', types: ['video'], groups: ['group:1'] })
  assert.equal(a.created, true)
  const b = await store.upsert({ provider: 'bili', key: '1', name: 'UP甲', types: ['dynamic'], groups: ['group:2'] })
  assert.equal(b.created, false)
  assert.deepEqual([...b.subscription.types].sort(), ['dynamic', 'video'])
  assert.deepEqual([...b.subscription.groups].sort(), ['group:1', 'group:2'])

  await store.push([
    { id: 'bili:BV1', kind: 'video', title: '视频A', url: 'u1', pubdate: 1, provider: 'bili', providerLabel: 'B站', subKey: '1', subName: 'UP甲', groups: ['group:1'] },
    { id: 'bili:BV2', kind: 'video', title: '视频B', url: 'u2', pubdate: 2, provider: 'bili', providerLabel: 'B站', subKey: '1', subName: 'UP甲', groups: ['group:2'] },
  ])
  assert.equal(store.pending(undefined, 10, 'group:1').length, 1, '按群过滤')
  await store.ack(['bili:BV1'], 'napcat:group:1')
  assert.equal(store.pending('napcat:group:1', 10, 'group:1').length, 0)
  assert.equal(store.pending('napcat:group:2', 10, 'group:2').length, 1)
  await rm(dir, { recursive: true, force: true })
})
test('工作区目录：workspacePath 留空时群聊也必须一group一目录（否则会话混进同一格）', async () => {
  const { workspaceDirFor } = await import('../lib/workspace.js')
  const fallback = process.cwd()
  const a = workspaceDirFor({ base: '', fallbackBase: fallback, chatKey: 'group:660610917', kind: 'group', perChatWorkspace: true })
  const b = workspaceDirFor({ base: '', fallbackBase: fallback, chatKey: 'group:1103089802', kind: 'group', perChatWorkspace: true })
  assert.notEqual(a, b, '不同群不能共用一个工作区目录')
  assert.ok(a.includes('napcat'), '应落在 napcat 子目录下')
  assert.ok(a.includes('group-660610917'))

  // 即使 perChatWorkspace 关着，群聊也要独立
  const c1 = workspaceDirFor({ base: '', fallbackBase: fallback, chatKey: 'group:1', kind: 'group', perChatWorkspace: false })
  const c2 = workspaceDirFor({ base: '', fallbackBase: fallback, chatKey: 'group:2', kind: 'group', perChatWorkspace: false })
  assert.notEqual(c1, c2, 'perChatWorkspace=false 时群聊仍必须分开')

  // 私聊在关闭时退回 base
  const priv = workspaceDirFor({ base: '', fallbackBase: fallback, chatKey: 'private:123', kind: 'private', perChatWorkspace: false })
  assert.equal(priv, fallback, '私聊关闭时用共享目录')

  // 配置了 workspacePath 时基于它建
  const withBase = workspaceDirFor({ base: 'E:/dsnworkspace', fallbackBase: fallback, chatKey: 'group:9', kind: 'group', perChatWorkspace: true })
  assert.ok(withBase.startsWith('E:/dsnworkspace'), '应基于配置路径')
  assert.ok(withBase.includes('group-9'))
})
test('B 站数据源：投稿接口风控时用动态里的视频动态兜底', async () => {
  const { BiliFeedProvider } = await import('../lib/providers.js')
  const svc = {
    resolveUp: async () => ({ mid: 70666, name: '舍长驾到' }),
    upVideos: async () => { throw new Error('HTTP 412') },
    upDynamics: async () => ([
      { id: 'd1', type: 'DYNAMIC_TYPE_AV', text: '新视频：今天整点啥', pubdate: 300, url: 'https://t.bilibili.com/d1', imageCount: 0 },
      { id: 'd2', type: 'DYNAMIC_TYPE_WORD', text: '随便说两句', pubdate: 200, url: 'https://t.bilibili.com/d2', imageCount: 0 },
    ]),
    searchUser: async () => [{ mid: 70666, name: '舍长驾到' }],
  }
  const provider = new BiliFeedProvider(svc)
  const items = await provider.latest('70666', ['video'])
  assert.equal(items.length, 1, '风控时只应拿到动态里的视频动态')
  assert.equal(items[0].kind, 'video')
  assert.ok(items[0].title.includes('新视频'))
  assert.equal(items[0].extra, '来自动态')
})

test('订阅轮询：风控类错误会等 15 分钟以上再重试', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { SubscriptionStore, pollSubscription } = await import('../lib/subscriptions.js')
  const dir = await mkdtemp(join(tmpdir(), 'napcat-risk-'))
  const store = new SubscriptionStore({ dir })
  await store.load()
  const { subscription } = await store.upsert({ provider: 'bili', key: '1', name: 'UP', types: ['video'], groups: [], lastSeenPubdate: 100 })
  const broken = { latest: async () => { throw new Error('HTTP 412 风控') } }
  const before = Date.now()
  const result = await pollSubscription(subscription, { store, provider: broken, intervalMinutes: 10 })
  const waitMs = result.subscription.nextCheckAt - before
  assert.ok(result.error !== undefined)
  assert.ok(waitMs >= 14 * 60_000, '风控应至少等约 15 分钟，实际 ' + Math.round(waitMs / 60000) + ' 分钟')
  await rm(dir, { recursive: true, force: true })
})
test('B站回复通知：只发管理员、间隔不低于 30 分钟、无新增不发', async () => {
  // 这里只验证配置契约（跨插件调用需要真实 dshBili 服务，放联调）
  const { resolveConfig, DEFAULTS } = await import('../lib/config.js')
  assert.equal(DEFAULTS.replyNotifyEnabled, true, '默认开启')
  assert.equal(DEFAULTS.replyNotifyIntervalMinutes, 120, '默认两小时一次')
  const merged = resolveConfig({})
  assert.equal(merged.replyNotifyIntervalMinutes, 120)
  const custom = resolveConfig({ replyNotifyIntervalMinutes: 30 })
  assert.equal(custom.replyNotifyIntervalMinutes, 30)
})

test('mergeQueued：单条原样、多条加编号并合并 blocks', () => {
  const single = mergeQueued([{ at: 1, text: ' 就一条 ', blocks: [], parts: [], kind: 'reply' }])
  assert.equal(single.text, ' 就一条 ')

  const merged = mergeQueued([
    { at: 1, text: '谁在', blocks: [{ type: 'image' }], parts: [{ type: 'image' }], kind: 'reply' },
    { at: 2, text: ' 开黑吗', blocks: [], parts: [], kind: 'reply' },
    { at: 3, text: '来了', blocks: [], parts: [], kind: 'reply' },
  ])
  assert.ok(merged.text.startsWith('【多人同时说话，合并成一条】'), merged.text)
  assert.ok(merged.text.includes('【第1条】谁在'))
  assert.ok(merged.text.includes('【第2条】开黑吗'))
  assert.ok(merged.text.includes('【第3条】来了'))
  assert.equal(merged.blocks.length, 1)
  assert.equal(merged.parts.length, 1)
})

test('mergeQueued：超长截断到 4000 字以内', () => {
  const list = Array.from({ length: 3 }, (_, i) => ({ at: i, text: '字'.repeat(3000), blocks: [], parts: [], kind: 'reply' }))
  const merged = mergeQueued(list)
  assert.ok(merged.text.length <= 4000, String(merged.text.length))
})

test('pushQueued：同文本去重、超 6 条丢最旧', () => {
  const item = (text) => ({ at: Date.now(), text, blocks: [], parts: [], kind: 'reply' })
  const a = pushQueued([], item('一'))
  assert.equal(a.length, 1)
  const again = pushQueued(a, item('一'))
  assert.equal(again, a, '重复文本应原样返回同一个数组')

  let list = []
  for (let i = 0; i < 9; i++) list = pushQueued(list, item('第' + i + '条'))
  assert.equal(list.length, 6, '上限 6 条')
  assert.equal(list[0].text, '第3条')
  assert.equal(list[5].text, '第8条')
})

test('busy 期间不投递、turn/end 后合并成一条', async () => {
  const calls = []
  const b = Object.create(Bridge.prototype)
  b.opts = { log: () => {}, ctx: {}, config: {}, conn: {} }
  b.mem = { digest: async () => ({ people: [], style: [], glossary: [], preference: [], traits: [] }) }
  b.personaBySession = new Map()
  b.personaBuiltAt = new Map()
  b.stats = { dispatched: 0, replyTurns: 0, proactiveTurns: 0 }
  b.chats = new Map()
  b.bySession = new Map()
  b.archiveCollectors = new Map()
  b.pendingProactive = new Set()
  b.proactiveStates = new Map()
  b.proactiveStartedAt = new Map()
  b.stopped = false
  b.debugLog = () => {}
  b.sendText = async () => {}
  b.stripArchiveBlock = (x) => x

  const agent = {
    session: { id: 's1' },
    followup: (msg) => {
      const text = (msg.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('')
      calls.push(text)
      return Promise.resolve()
    },
  }
  const chat = {
    ref: { key: 'group:1', id: '1', kind: 'group' },
    agent,
    buffer: [],
    lastReplyId: '',
    recentReplyIds: [],
    fresh: true,
    dispose: async () => {},
  }
  b.chats.set('group:1', chat)
  b.bySession.set('s1', 'group:1')

  b.dispatch(chat, '第一条')
  b.dispatch(chat, '第二条')
  b.dispatch(chat, '第三条')
  assert.equal(calls.length, 1, 'busy 期间不应再投递')
  assert.equal((chat.queued ?? []).length, 2, '两条应攒进队列')

  b.onSessionEvent({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'done' } } })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(calls.length, 2, 'turn/end 后应合并投递一次')
  assert.ok(calls[1].includes('【第1条】第二条'), '合并文本应带编号: ' + calls[1])
  assert.ok(calls[1].includes('【第2条】第三条'))
  assert.equal(chat.busy, true, '合并投递后重新进入 busy')
})

// ── 表情包识别 ───────────────────────────────────────────────────────

function pngHeader(w, h, colorType) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[24] = 8
  b[25] = colorType
  return b
}
function gifHeader(w, h) {
  const b = Buffer.alloc(13)
  b.write('GIF89a', 0, 'ascii')
  b.writeUInt16LE(w, 6)
  b.writeUInt16LE(h, 8)
  return b
}
function jpegHeader(w, h) {
  const b = Buffer.alloc(20)
  b[0] = 0xff; b[1] = 0xd8
  b[2] = 0xff; b[3] = 0xc0
  b.writeUInt16BE(17, 4)
  b[6] = 8
  b.writeUInt16BE(h, 7)
  b.writeUInt16BE(w, 9)
  return b
}

test('readImageHeader 解析 PNG / GIF / JPEG 尺寸', () => {
  assert.deepEqual(readImageHeader(pngHeader(300, 280, 6)), { format: 'png', width: 300, height: 280, hasAlpha: true })
  assert.deepEqual(readImageHeader(pngHeader(800, 600, 2)), { format: 'png', width: 800, height: 600, hasAlpha: false })
  assert.deepEqual(readImageHeader(gifHeader(200, 200)), { format: 'gif', width: 200, height: 200 })
  assert.deepEqual(readImageHeader(jpegHeader(1920, 1080)), { format: 'jpeg', width: 1920, height: 1080 })
})

test('judgeSticker：表情包命中、照片/大图不误判', () => {
  // mface / summary 强信号
  assert.equal(judgeSticker({ segmentType: 'mface' }).sticker, true)
  assert.equal(judgeSticker({ summary: '[动画表情]' }).sticker, true)
  // GIF 一定是表情包
  assert.equal(judgeSticker({ header: { format: 'gif', width: 200, height: 200 }, bytes: 300 * 1024 }).sticker, true)
  // 小透明 PNG 判表情包
  assert.equal(judgeSticker({ header: { format: 'png', width: 300, height: 280, hasAlpha: true }, bytes: 120 * 1024 }).sticker, true)
  // 大透明 PNG 不判（可能是透明背景的大立绘）
  assert.equal(judgeSticker({ header: { format: 'png', width: 1200, height: 1600, hasAlpha: true }, bytes: 2 * 1024 * 1024 }).sticker, false)
  // JPEG 照片/截图不判
  assert.equal(judgeSticker({ header: { format: 'jpeg', width: 1920, height: 1080 }, bytes: 900 * 1024 }).sticker, false)
  // 小尺寸 JPEG（转存丢了透明通道的表情包）要判
  assert.equal(judgeSticker({ header: { format: 'jpeg', width: 300, height: 280 }, bytes: 90 * 1024 }).sticker, true)
  // 大一点的 JPEG 仍不判
  assert.equal(judgeSticker({ header: { format: 'jpeg', width: 600, height: 600 }, bytes: 300 * 1024 }).sticker, false)
})

test('pruneInbox：只删超期文件、保留日志与目录', async () => {
  const { mkdtemp, mkdir, writeFile, utimes } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'napcat-inbox-'))
  const old = join(dir, 'old.jpg')
  const fresh = join(dir, 'new.jpg')
  const log = join(dir, '_image-debug.log')
  await writeFile(old, 'x')
  await writeFile(fresh, 'x')
  await writeFile(log, 'x')
  await mkdir(join(dir, 'imgs'))
  const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000
  await utimes(old, tenDaysAgo, tenDaysAgo)
  const removed = await pruneInbox(dir, 7)
  assert.equal(removed, 1)
  const left = await import('node:fs').then(m => m.readdirSync(dir))
  assert.ok(left.includes('new.jpg'))
  assert.ok(left.includes('_image-debug.log'))
  assert.ok(left.includes('imgs'))
})

test('ImageCache.sweep 同时清理 imgs 日期目录和 inbox 根文件', async () => {
  const { mkdtemp, mkdir, writeFile, utimes } = await import('node:fs/promises')
  const cwd = await mkdtemp(join(tmpdir(), 'napcat-sweep-'))
  const inbox = join(cwd, 'napcat-inbox')
  const oldDay = join(inbox, 'imgs', '20200101')
  await mkdir(oldDay, { recursive: true })
  await writeFile(join(oldDay, 'a.png'), 'x')
  const oldFile = join(inbox, 'old-sticker.gif')
  const newFile = join(inbox, 'new.png')
  await writeFile(oldFile, 'x')
  await writeFile(newFile, 'x')
  await writeFile(join(inbox, '_image-debug.log'), 'x')
  const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000
  await utimes(oldDay, tenDaysAgo, tenDaysAgo)
  await utimes(oldFile, tenDaysAgo, tenDaysAgo)

  const cache = new ImageCache({ cwd, maxBytes: 1, dailyCap: 1, retentionDays: 7, log: () => {} })
  const removed = await cache.sweep()
  assert.equal(removed, 2, '日期目录 + 根目录旧文件各算一个')

  const left = await import('node:fs').then(m => m.readdirSync(inbox))
  assert.ok(left.includes('new.png'), '新文件保留')
  assert.ok(left.includes('_image-debug.log'), '日志保留')
  assert.ok(!left.includes('old-sticker.gif'), '旧表情包被清')
})

// ── 小红书 / 网易云链接 ──────────────────────────────────────────────

test('extractMediaLink 认小红书 / 网易云，不误认 B 站和普通链接', () => {
  assert.deepEqual(extractMediaLink('看这个 https://www.xiaohongshu.com/explore/abc123?xsec_token=xyz 不错'), { kind: 'xhs', url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=xyz' })
  assert.equal(extractMediaLink('https://xhslink.com/aBc12d').kind, 'xhs')
  assert.deepEqual(extractMediaLink('听听 https://music.163.com/song?id=12345&userid=1'), { kind: 'netease', url: 'https://music.163.com/song?id=12345&userid=1' })
  assert.equal(extractMediaLink('https://163cn.tv/AbCdEf').kind, 'netease')
  assert.equal(extractMediaLink('https://www.bilibili.com/video/BV1xx411c7mD'), undefined)
  assert.equal(extractMediaLink('https://example.com/a'), undefined)
})

test('parseOpenGraph 兼容属性顺序并解码实体', () => {
  const html = [
    '<meta property="og:title" content="标题 &amp; 副标题">',
    "<meta content='描述内容' property='og:description'>",
    '<meta name="og:image" content="https://img.example/a.jpg">',
  ].join('\n')
  const og = parseOpenGraph(html)
  assert.equal(og.title, '标题 & 副标题')
  assert.equal(og.description, '描述内容')
  assert.equal(og.image, 'https://img.example/a.jpg')
})

test('neteaseSongId 支持 query / path / 短链跳过', () => {
  assert.equal(neteaseSongId('https://music.163.com/song?id=12345'), '12345')
  assert.equal(neteaseSongId('https://music.163.com/#/song?id=67890'), '67890')
  assert.equal(neteaseSongId('https://music.163.com/song/112233'), '112233')
  assert.equal(neteaseSongId('https://163cn.tv/AbCdEf'), undefined)
})

test('lyricPreview 去时间戳、去空行、限行数', () => {
  const lrc = '[00:00.00]第一句\n[00:03.00]\n[00:06.00]第二句\n[00:09.00]第三句\n[00:12.00]第四句'
  assert.equal(lyricPreview(lrc, 2), '第一句\n第二句')
})

test('renderLinkBlock 给出事实与"不要播报"的约束', () => {
  const xhs = renderLinkBlock({ kind: 'xhs', url: 'https://x', title: '周末去哪玩', desc: '城郊有个花海' })
  assert.ok(xhs.includes('小红书'))
  assert.ok(xhs.includes('周末去哪玩'))
  assert.ok(xhs.includes('不要播报'))

  const music = renderLinkBlock({ kind: 'netease', url: 'https://y', title: '晴天', author: '周杰伦', desc: '叶惠美', extra: '故事的小黄花' })
  assert.ok(music.includes('晴天'))
  assert.ok(music.includes('周杰伦'))
  assert.ok(music.includes('故事的小黄花'))
  assert.ok(music.includes('不要播报'))
})

test('imageKey 同内容同大小稳定、不同内容不同', () => {
  const a = Buffer.from('abc')
  const b = Buffer.from('abd')
  assert.equal(imageKey(a, 3), imageKey(Buffer.from('abc'), 3))
  assert.notEqual(imageKey(a, 3), imageKey(b, 3))
  assert.notEqual(imageKey(a, 3), imageKey(a, 4))
})

test('bumpImageFreq 累计次数并持久化，超 500 条丢最旧', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'napcat-freq-'))
  assert.equal(await bumpImageFreq(dir, 'k1', 100), 1)
  assert.equal(await bumpImageFreq(dir, 'k1', 100), 2)
  const table = await loadImageFreq(dir)
  assert.equal(table.k1.count, 2)

  // 灌 505 条，应该只留 500
  const now = Date.now()
  const bulk = {}
  for (let i = 0; i < 505; i++) bulk['bulk' + i] = { count: 1, lastAt: now + i, bytes: 10 }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dir, '_image-counts.json'), JSON.stringify(bulk), 'utf8')
  await bumpImageFreq(dir, 'newest', 10, now + 10_000)
  const after = await loadImageFreq(dir)
  assert.equal(Object.keys(after).length, 500)
  assert.ok(after.newest !== undefined, '新的条目保留')
  assert.ok(after.bulk4 === undefined, '最旧的被丢弃')
})

// ── 人物卡 ──────────────────────────────────────────────────────────

test('parseCharacterCard：兼容 ST V2 包裹与裸字段', () => {
  const wrapped = JSON.stringify({
    spec: 'chara_card_v2',
    data: {
      name: '小灯',
      description: '一只灯',
      personality: '活泼',
      scenario: '群聊',
      mes_example: '<START>\n群友：在吗\n小灯：在的',
      post_history_instructions: '短句',
    },
  })
  const card = parseCharacterCard(wrapped)
  assert.equal(card.name, '小灯')
  assert.equal(card.personality, '活泼')
  assert.ok(card.mesExample.includes('小灯：在的'))

  const flat = parseCharacterCard('{"name":"裸卡","description":"d"}')
  assert.equal(flat.name, '裸卡')
  assert.equal(flat.personality, '')

  assert.equal(parseCharacterCard(''), undefined)
  assert.equal(parseCharacterCard('not json'), undefined)
})


test('renderPersona：包含身份/示例/关系/性格倾向，且带"不要复述"约束', () => {
  const custom = parseCharacterCard(JSON.stringify({
    name: '小灯',
    personality: '活泼',
    mes_example: '群友：在吗\n小灯：在的',
  }))
  const text = renderPersona(custom, {
    summary: '最近在聊新番',
    people: ['老王=技术宅'],
    style: ['爱发车'],
    glossary: ['车=资源'],
    preference: ['别提掉头发'],
    traits: ['被夸会嘴硬', '聊游戏变话痨'],
  })
  assert.ok(text.includes('小灯'))
  assert.ok(text.includes('活泼'))
  assert.ok(text.includes('小灯：在的'))
  assert.ok(text.includes('老王=技术宅'))
  assert.ok(text.includes('被夸会嘴硬'))
  assert.ok(text.includes('不要在回复里复述'))
})

test('MemoryStore.digest / addTrait：性格倾向能存能读、去重', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'persona-digest-'))
  const store = new MemoryStore({
    ctx: {}, root: dir, spacePrefix: 'napcat-', backend: 'file',
    recentLimit: 10, injectRecent: 3, injectMaxChars: 4000, log: () => undefined,
  })
  const traits = await store.addTrait('group:9', '被夸会嘴硬')
  assert.deepEqual(traits, ['被夸会嘴硬'])
  const again = await store.addTrait('group:9', '被夸会嘴硬')
  assert.equal(again.length, 1, '同一句不重复记')
  await store.addTrait('group:9', '聊游戏变话痨')
  const digest = await store.digest('group:9')
  assert.equal(digest.traits.length, 2)
})

test('人物卡别名：数组 / nickname / 渲染时两个名字都认', () => {
  const card = parseCharacterCard(JSON.stringify({ name: '大肥鱼', aliases: ['小灯'], description: '团宠' }))
  assert.deepEqual(card.aliases, ['小灯'])
  const viaNick = parseCharacterCard(JSON.stringify({ name: 'A', nickname: '小A' }))
  assert.deepEqual(viaNick.aliases, ['小A'])
  const text = renderPersona(parseCharacterCard(JSON.stringify({ name: '大肥鱼', aliases: ['小灯'] })), {})
  assert.ok(text.includes('大肥鱼'))
  assert.ok(text.includes('小灯'))
})

test('loadCard：内联 > 文件 > 内置 > 默认', () => {
  const files = { '/p/default.json': JSON.stringify({ name: '文件卡' }) }
  const opts = {
    name: 'default',
    dir: '/p',
    readFile: (f) => files[f],
    exists: (f) => files[f] !== undefined,
    join: (...parts) => parts.join('/'),
  }
  assert.equal(loadCard(opts).name, '文件卡')
  assert.equal(loadCard({ ...opts, name: 'tsundere' }).name, '毒舌同事')
  assert.equal(loadCard({ ...opts, name: '不存在的' }).name, DEFAULT_CARD.name)
})

// ── 游戏线索注入 ────────────────────────────────────────────────────

test('looksLikeHelpRequest 区分求解与随口讨论', () => {
  assert.equal(looksLikeHelpRequest('这个 boss 怎么打'), true)
  assert.equal(looksLikeHelpRequest('我在哪能拿到坚岩护腕？'), true)
  assert.equal(looksLikeHelpRequest('小小boss还挺牛逼'), false)
  assert.equal(looksLikeHelpRequest('这游戏画面不错'), false)
})

test('buildHintBlock：求助时要求先查并给具体下一步，禁止空话', () => {
  const help = buildHintBlock([{ game: '影之刃零', hits: ['玉儿', '血肉花'] }], { askedForHelp: true })
  assert.ok(help.includes('回答要给到点子上'))
  assert.ok(help.includes('具体答案/下一步'))
  assert.ok(help.includes('多练练'))
  assert.ok(help.includes('game_wiki_search'))

  const chat = buildHintBlock([{ game: '影之刃零', hits: [] }], { askedForHelp: false, fromRecent: true })
  assert.ok(chat.includes('本群最近在聊'))
  assert.ok(chat.includes('可以不查'))
  assert.ok(!chat.includes('回答要给到点子上'))
})

test('GameWiki：最近聊过的游戏在关键词缺失时也能补线索', async () => {
  const { GameWiki } = await import('../lib/gamewiki.js')
  const svc = { detect: async (text) => (text.includes('庞镇') ? [{ game: '影之刃零', hits: ['庞镇'] }] : []) }
  const ctx = { get: (name) => (name === 'dshGame' ? svc : undefined) }
  const wiki = new GameWiki({ ctx, enabled: true, log: () => {} })
  await wiki.hintFor('我在庞镇卡住了', 'group:1')
  const later = await wiki.hintFor('这个 boss 怎么打', 'group:1')
  assert.ok(later !== undefined)
  assert.ok(later.includes('影之刃零'))
  assert.ok(later.includes('回答要给到点子上'))
  // 别的群不该继承
  assert.equal(await wiki.hintFor('这个 boss 怎么打', 'group:2'), undefined)
})

test('seedPersonaDir：写入三张内置卡、不覆盖已存在的文件', async () => {
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'persona-seed-'))
  const written = seedPersonaDir(dir)
  assert.equal(written.length, 3, '首次写入三张')
  const def = JSON.parse(await readFile(join(dir, 'default.json'), 'utf8'))
  assert.equal(def.name, '大肥鱼')
  assert.deepEqual(def.aliases, ['小灯'])

  // 改一张，再播种不该覆盖
  await writeFile(join(dir, 'default.json'), JSON.stringify({ name: '我改过的卡' }), 'utf8')
  const again = seedPersonaDir(dir)
  assert.equal(again.length, 0, '已存在的文件不覆盖')
  const after = JSON.parse(await readFile(join(dir, 'default.json'), 'utf8'))
  assert.equal(after.name, '我改过的卡')
})

// ── 人物卡文件读写 ──────────────────────────────────────────────────

test('validCardName 拒绝路径穿越与空名', () => {
  assert.equal(validCardName('default'), true)
  assert.equal(validCardName('小灯'), true)
  assert.equal(validCardName('my-card_2'), true)
  assert.equal(validCardName(''), false)
  assert.equal(validCardName('..'), false)
  assert.equal(validCardName('../etc/passwd'), false)
  assert.equal(validCardName('a/b'), false)
})

test('writeCardInDir / readCardInDir / listCardsInDir 往返', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'persona-card-'))
  const card = { name: '小灯', aliases: ['大肥鱼'], personality: '幽默' }
  const saved = writeCardInDir(dir, '小灯', card)
  assert.equal(saved.ok, true)
  assert.deepEqual(readCardInDir(dir, '小灯'), card)
  assert.deepEqual(listCardsInDir(dir), ['小灯'])
  // 非法名字拒绝
  assert.equal(writeCardInDir(dir, '../x', card).ok, false)
  // 不存在的卡返回 undefined
  assert.equal(readCardInDir(dir, '不存在'), undefined)
})

// ── 2026-11-11 多人群聊回归 ────────────────────────────────────────────────
// 1) append 冲突不能当会话失效处理（否则正常会话被重置）
test('isAppendCollision 只认「append 正在发布」这一种错误', async () => {
  const { isAppendCollision } = await import('../lib/bridge.js')
  assert.equal(isAppendCollision('session append cannot reenter while another append is being published'), true)
  assert.equal(isAppendCollision('Error: another append is being published'), true)
  // 其它投递失败仍要走 recoverChat
  assert.equal(isAppendCollision('ENOENT: no such file or directory'), false)
  assert.equal(isAppendCollision('session not found'), false)
})

// 2) 占位符记录要保留（图片带路径），同一人连发的表情包折叠成 [表情包×N]
test('appendRecent 保留占位符并折叠连发表情包', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'napcat-noise-'))
  const store = new MemoryStore({
    ctx: {}, root: dir, spacePrefix: 'napcat-', backend: 'file',
    recentLimit: 100, injectRecent: 20, injectMaxChars: 4000, log: () => undefined,
  })
  await store.appendRecent('group:9', { nick: '甲', text: '[图片]', at: 1_760_000_000_000 })
  await store.appendRecent('group:9', { nick: '甲', text: '[视频(12秒)]', at: 1_760_000_001_000 })
  await store.appendRecent('group:9', { nick: '乙', text: '[表情包]', at: 1_760_000_002_000 })
  await store.appendRecent('group:9', { nick: '乙', text: '[表情包]', at: 1_760_000_003_000 })
  await store.appendRecent('group:9', { nick: '乙', text: '[表情包]', at: 1_760_000_004_000 })
  await store.appendRecent('group:9', { nick: '丙', text: '[图片:napcat-inbox/imgs/a.jpg]', at: 1_760_000_005_000 })
  await store.appendRecent('group:9', { nick: '丙', text: '这个好看', at: 1_760_000_006_000 })
  const { readFileSync, readdirSync } = await import('node:fs')
  const findRecent = (root) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, entry.name)
      if (entry.isDirectory()) {
        const hit = findRecent(full)
        if (hit !== null) return hit
      } else if (entry.name === 'recent.jsonl') {
        return full
      }
    }
    return null
  }
  const file = findRecent(dir)
  assert.notEqual(file, null, '应生成 recent.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
  const joined = lines.join('\n')
  assert.equal(joined.includes('[图片]'), true, '纯图片占位符要保留')
  assert.equal(joined.includes('[视频(12秒)]'), true, '视频时长是信息，要保留')
  assert.equal(joined.includes('[表情包×3]'), true, '连发的 3 个表情包应折叠成 ×3')
  assert.equal(joined.includes('napcat-inbox/imgs/a.jpg'), true, '带路径的图片记录要保留')
  assert.equal(joined.includes('这个好看'), true)
  // 乙的三条贴纸折叠后只应剩一行
  assert.equal(lines.filter(line => line.includes('表情包')).length, 1)
  rmSync(dir, { recursive: true, force: true })
})

// 3) 队列策略：merge 等、insert 立刻插、hybrid 跑够久才插
test('shouldInterrupt 按 queueMode 决定攒着还是插队', async () => {
  const { shouldInterrupt } = await import('../lib/bridge.js')
  assert.equal(shouldInterrupt('merge', 999_999, 20_000), false, 'merge 永不插队')
  assert.equal(shouldInterrupt('insert', 0, 20_000), true, 'insert 总是插队')
  assert.equal(shouldInterrupt('hybrid', 5_000, 20_000), false, 'hybrid 未到阈值先攒着')
  assert.equal(shouldInterrupt('hybrid', 20_000, 20_000), true, 'hybrid 到阈值插队')
  // 阈值下限 1s，防止配成 0 后每条消息都插队
  assert.equal(shouldInterrupt('hybrid', 500, 0), false)
  assert.equal(shouldInterrupt('hybrid', 1_000, 0), true)
})

// 小黑盒：从分享链接里取 link_id；接口降级时不抛异常
test('小黑盒：抽 link_id 与正文块降级', async () => {
  const { extractHeyboxLink, fetchHeyboxPost, renderHeyboxBlock } = await import('../lib/heybox.js')

  // 线上真实形态（link_id 之外的参数都是分享埋点，不该影响解析）
  const shared = '看看这个 https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_session_id=De5FTqJMLl9AtmC8&h_src=YXBwX3NoYXJl&link_id=8cc472ceb6a0&new_post_share_style_v2=1 挺好笑的'
  const ref = extractHeyboxLink(shared)
  assert.equal(ref?.linkId, '8cc472ceb6a0')
  assert.match(ref?.url ?? '', /xiaoheihe\.cn/)

  // 不是小黑盒的链接不该被误判
  assert.equal(extractHeyboxLink('https://example.com/x?link_id=1'), null)
  assert.equal(extractHeyboxLink('没有链接'), null)

  // 接口返回：text 是文本块序列化 JSON，里面混了图片块
  const payload = {
    status: 'ok',
    result: {
      link: {
        title: '孩子们，听说魂哥的雷霆摄像头是少主推荐他买的',
        description: '一段摘要',
        text: JSON.stringify([
          { type: 'text', text: '第一段正文' },
          { type: 'img', url: 'https://cdn/x.jpg' },
          { type: 'text', text: '第二段正文' },
        ]),
        user: { username: '老吃家贵州良子-书' },
      },
    },
  }
  const fakeFetch = async () => ({ ok: true, json: async () => payload })
  const post = await fetchHeyboxPost('8cc472ceb6a0', { fetchImpl: fakeFetch })
  assert.equal(post?.title, payload.result.link.title)
  assert.equal(post?.author, '老吃家贵州良子-书')
  assert.deepEqual(post?.paragraphs, ['第一段正文', '第二段正文'])
  assert.match(renderHeyboxBlock(post), /标题：/)

  // 风控/结构变更：status 不是 ok → 返回 null（调用方回落到通用提示）
  const badFetch = async () => ({ ok: true, json: async () => ({ status: 'error' }) })
  assert.equal(await fetchHeyboxPost('8cc472ceb6a0', { fetchImpl: badFetch }), null)

  // 网络异常也不该抛
  const throwFetch = async () => { throw new Error('boom') }
  assert.equal(await fetchHeyboxPost('8cc472ceb6a0', { fetchImpl: throwFetch }), null)
})

// 启动清理：groups 为空的订阅、孤儿队列项、超过 24h 的旧条目都要被丢掉
test('订阅清理：空 groups 订阅 / 孤儿队列 / 过期条目', async () => {
  const { SubscriptionStore } = await import('../lib/subscriptions.js')
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const dir = mkdtempSync(join(tmpdir(), 'napcat-sub-'))
  const now = Date.UTC(2026, 10, 13, 4, 0, 0)
  const dayMs = 24 * 60 * 60_000
  const sub = (key, groups) => ({
    id: 'bili:' + key, provider: 'bili', key, name: 'UP-' + key, types: ['video'],
    groups, lastSeenPubdate: 0, recentIds: [], failures: 0, nextCheckAt: 0, enabled: true, createdAt: now,
  })
  writeFileSync(join(dir, 'subscriptions.json'), JSON.stringify({
    subscriptions: [sub('111', ['group:1']), sub('222', [])],
  }), 'utf8')
  const queueItem = (id, subKey, addedAt) => JSON.stringify({
    id, kind: 'video', title: id, url: 'https://x/' + id, pubdate: 0,
    provider: 'bili', providerLabel: 'B站', subKey, subName: 'UP', groups: ['group:1'], addedAt, deliveredTo: [],
  })
  writeFileSync(join(dir, 'queue.jsonl'), [
    queueItem('fresh', '111', now - 60_000),      // 保留
    queueItem('expired', '111', now - 2 * dayMs), // 过期 → 丢
    queueItem('orphan', '999', now - 60_000),     // 孤儿 → 丢
  ].join('\n') + '\n', 'utf8')

  const store = new SubscriptionStore({ dir })
  await store.load()
  const removed = await store.pruneStale({ now, maxAgeMs: dayMs })
  assert.deepEqual(removed, { subs: 1, orphans: 1, expired: 1 })
  assert.equal(store.list().length, 1, '空 groups 的订阅被丢掉')
  assert.equal(store.list()[0].key, '111', '留下的是有推送目标的订阅')

  const lines = readFileSync(join(dir, 'queue.jsonl'), 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1, '只剩一条没过期、且 subKey 仍存在的条目')
  assert.match(lines[0], /"fresh"/)
})
