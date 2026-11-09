/**
 * 群内图片频次表：同一张图被反复发，大概率是大家常用的表情包。
 *
 * 为什么需要它：单看文件头只能认出「GIF / 小透明 PNG」这类特征，
 * 但很多表情包是 JPEG（微信/QQ 转存后丢了透明通道），光看格式会漏。
 * 群友反复发同一张图，是个又便宜又准的信号 —— 用「文件头 64KB + 大小」算指纹，
 * 不需要解码整张图。
 */

import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_ENTRIES = 500

export interface ImageFreqEntry {
  count: number
  lastAt: number
  bytes: number
}

export type ImageFreqTable = Record<string, ImageFreqEntry>

/** 指纹：前 64KB + 文件大小（不解码整图，够区分不同图片）。 */
export function imageKey(head: Buffer, size: number): string {
  return createHash('sha1').update(head).update(':' + String(size)).digest('hex').slice(0, 16)
}

function statsPath(inbox: string): string {
  return join(inbox, '_image-counts.json')
}

/** 读频次表（不存在/坏了都返回空表）。 */
export async function loadImageFreq(inbox: string): Promise<ImageFreqTable> {
  try {
    const raw = await readFile(statsPath(inbox), 'utf8')
    const parsed = JSON.parse(raw) as ImageFreqTable
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 记一次出现，返回累计次数；顺手把表裁剪到上限。 */
export async function bumpImageFreq(inbox: string, key: string, bytes: number, now = Date.now()): Promise<number> {
  const table = await loadImageFreq(inbox)
  const prev = table[key]
  const next: ImageFreqEntry = {
    count: (prev?.count ?? 0) + 1,
    lastAt: now,
    bytes,
  }
  table[key] = next
  // 超上限：保留最近的 MAX_ENTRIES 条
  const keys = Object.keys(table)
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (table[b]?.lastAt ?? 0) - (table[a]?.lastAt ?? 0))
      .slice(MAX_ENTRIES)
      .forEach(k => { delete table[k] })
  }
  try {
    const target = statsPath(inbox)
    const temp = target + '.tmp'
    await writeFile(temp, JSON.stringify(table), 'utf8')
    await rename(temp, target)
  } catch {
    // 写失败不影响这一轮判定
  }
  return next.count
}
