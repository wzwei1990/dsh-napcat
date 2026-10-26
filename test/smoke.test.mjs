// 纯逻辑冒烟测试（不依赖宿主包，直接测编译产物 lib/）。
// 运行：npm run build && node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'

import { base64UrlToBuffer, isHttpUrl, nameFromRef, safeName } from '../lib/media.js'
import { MemoryStore } from '../lib/memory.js'
import { decide, inQuietHours, newChatState, parseQuietHours, poissonHit, skipBackoffFactor } from '../lib/proactive.js'
import { dayKey, urlHash } from '../lib/imagecache.js'
import { findKeyword, mentions, parseCq, parsePersonaOverrides, rankByFileName, scoreFileName, shortHash, splitText, stripKeyword, titleFrom, toText } from '../lib/text.js'
import { allowAccess, chatRefOf, sessionIdForChat } from '../lib/chat.js'

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
test('parsePersonaOverrides 解析群/人性格', () => {
  const map = parsePersonaOverrides([
    '# 注释行',
    'group:123456=你是群宠小灯，语气活泼',
    'private:10001 = 私人助理，正式一点',
    '',
    '  乱写一行没有等号',
    'group:999=',
  ].join('\n'))
  assert.equal(map.get('group:123456'), '你是群宠小灯，语气活泼')
  assert.equal(map.get('private:10001'), '私人助理，正式一点')
  assert.equal(map.has('group:999'), false)   // 空文本丢弃
  assert.equal(map.size, 2)
})

test('parsePersonaOverrides 空输入返回空表', () => {
  assert.equal(parsePersonaOverrides('').size, 0)
  assert.equal(parsePersonaOverrides('group:1=x\nprivate:2=y').size, 2)
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

  const base = {
    enabled: true, ratePerHour: 0, chance: 1, cooldownMinutes: 30,
    maxPerHour: 3, quietHours: '', minMessages: 3, windowMinutes: 5,
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