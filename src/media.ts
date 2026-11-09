/** 媒体收发：本地文件 ↔ base64、URL 下载、收件目录。NapCat 在远端时一律用 base64。 */

import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
/** 视频单独给更大的上限：群里的短视频十几 MB 很常见，按 20MB 卡会直接丢。 */
export const DEFAULT_MAX_VIDEO_BYTES = 120 * 1024 * 1024

export function isHttpUrl(text: string): boolean {
  return /^https?:\/\//i.test(text)
}

/** 把任意名字洗成安全的单段文件名。 */
export function safeName(name: string, fallback: string): string {
  const base = basename(name.replace(/[\\/]+$/, ''))
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .trim()
  if (base === '' || base === '.' || base === '..') return fallback
  return base.slice(0, 80)
}

/** 每个会话自己的收件箱目录（在会话 cwd 下，agent 可直接读取）。 */
export async function ensureInbox(cwd: string): Promise<string> {
  const dir = join(cwd, 'napcat-inbox')
  await mkdir(dir, { recursive: true })
  return dir
}

/** 插件自己的临时目录（下载 URL 用）。 */
export async function ensureTempDir(): Promise<string> {
  const dir = join(tmpdir(), 'dsh-napcat')
  await mkdir(dir, { recursive: true })
  return dir
}

/** 下载到目录，返回本地绝对路径；超限直接抛错。 */
export async function downloadToFile(
  url: string,
  dir: string,
  name: string,
  maxBytes: number,
): Promise<{ path: string; bytes: number }> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('下载失败 HTTP ' + response.status + ': ' + url)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) {
    throw new Error('文件超过上限 ' + Math.round(maxBytes / 1024 / 1024) + 'MB（实际 ' + Math.round(buffer.byteLength / 1024) + 'KB）')
  }
  const target = join(dir, Date.now().toString(36) + '-' + safeName(name, 'download'))
  await writeFile(target, buffer)
  return { path: target, bytes: buffer.byteLength }
}

/** 本地文件 → base64://（NapCat 在远端也能用）。 */
export async function localToBase64Url(path: string, maxBytes: number): Promise<{ url: string; bytes: number; name: string }> {
  const buffer = await readFile(path)
  if (buffer.byteLength > maxBytes) {
    throw new Error('文件超过上限 ' + Math.round(maxBytes / 1024 / 1024) + 'MB（实际 ' + Math.round(buffer.byteLength / 1024) + 'KB）: ' + path)
  }
  return { url: 'base64://' + buffer.toString('base64'), bytes: buffer.byteLength, name: safeName(path, 'file') }
}

/** 路径或 URL → base64://（URL 先下到临时目录）。 */
export async function sourceToBase64Url(
  source: string,
  maxBytes: number,
): Promise<{ url: string; bytes: number; name: string }> {
  if (!isHttpUrl(source)) return await localToBase64Url(source, maxBytes)
  const dir = await ensureTempDir()
  const name = safeName(source.split('?')[0]?.split('/').pop() ?? 'download', 'download')
  const { path, bytes } = await downloadToFile(source, dir, name, maxBytes)
  return { url: 'base64://' + (await readFile(path)).toString('base64'), bytes, name }
}

/** base64://… → Buffer（收文件时 NapCat 可能直接回 base64）。 */
export function base64UrlToBuffer(value: string): Buffer {
  const raw = value.startsWith('base64://') ? value.slice('base64://'.length) : value
  return Buffer.from(raw, 'base64')
}

/** 从「file:///path」「C:\\x\\y.png」「a.png」里取一个像样的文件名。 */
export function nameFromRef(ref: string, fallback: string): string {
  let candidate = ref
  if (candidate.startsWith('file://')) candidate = candidate.slice('file://'.length)
  candidate = candidate.split('?')[0] ?? candidate
  const segments = candidate.split(/[\\/]/)
  return safeName(segments[segments.length - 1] ?? '', fallback)
}
/** 按魔数判断图片类型（附件服务会校验声明类型，必须准确）。 */
export function imageMediaType(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return 'image/webp'
  return undefined
}

/**
 * 清理收件箱里的旧媒体（napcat-inbox 根目录下的图片/视频/音频）。
 * - 只删文件，不碰子目录（imgs/ 由 ImageCache 按日期目录自己清）
 * - 保留 _image-debug.log
 * 返回删掉的文件数。
 */
export async function pruneInbox(inbox: string, retentionDays: number, now = Date.now()): Promise<number> {
  if (retentionDays <= 0) return 0
  const cutoff = now - retentionDays * 86_400_000
  let removed = 0
  let entries
  try {
    entries = await readdir(inbox, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    // 插件自己的元数据（日志、图片频次表）不当作要清理的媒体
    if (entry.name.startsWith('_')) continue
    const path = join(inbox, entry.name)
    try {
      const info = await stat(path)
      if (info.mtimeMs < cutoff) {
        await rm(path, { force: true })
        removed += 1
      }
    } catch {
      // 单个文件失败不影响其它
    }
  }
  return removed
}

/**
 * 流式下载到文件（视频用）：边下边写，内存占用与文件大小无关；
 * 超过 maxBytes 立刻中断并删掉半成品。
 */
export async function downloadToFileStream(
  url: string,
  dir: string,
  name: string,
  maxBytes: number,
): Promise<{ path: string; bytes: number }> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('下载失败 HTTP ' + response.status + ': ' + url)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) {
    throw new Error('文件超过上限 ' + Math.round(maxBytes / 1024 / 1024) + 'MB（实际 ' + Math.round(declared / 1024 / 1024) + 'MB）')
  }
  const target = join(dir, Date.now().toString(36) + '-' + safeName(name, 'download'))
  const handle = await open(target, 'w')
  let bytes = 0
  try {
    if (response.body === null) throw new Error('服务器没有返回内容')
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) throw new Error('文件超过上限 ' + Math.round(maxBytes / 1024 / 1024) + 'MB')
      await handle.write(chunk)
    }
  } catch (error) {
    await handle.close()
    await rm(target, { force: true })
    throw error
  }
  await handle.close()
  return { path: target, bytes }
}
