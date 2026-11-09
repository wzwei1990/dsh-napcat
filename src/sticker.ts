/**
 * 表情包识别（纯本地、零依赖）。
 *
 * 目的不是"省 token"，而是让模型知道这张图是**群友的情绪表达**：
 *   - 表情包 → 仍然作为 image block 给模型（它看得懂梗），但提示词里只许接情绪，
 *     不许描述画面；
 *   - 普通图（照片/截图）→ 维持原来的"该看就看、该说就说"。
 *
 * 判据按可靠性排序（见 judgeSticker）：
 *   1) QQ 商店表情的 mface 段 / summary 里带「动画表情」
 *   2) GIF / WebP（QQ 表情包主格式）
 *   3) 小尺寸 + 透明通道的 PNG（近似方形、体积不大）
 *   4) JPEG 等 → 当普通图
 */

export interface ImageHeader {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | undefined
  width?: number
  height?: number
  /** PNG 有 alpha 通道（colorType 4/6） */
  hasAlpha?: boolean
}

export interface StickerSignals {
  /** OneBot 段类型：image / mface（QQ 商店表情） */
  segmentType?: string
  /** segment.data.summary，NapCat 对动画表情常给「[动画表情]」 */
  summary?: string
  fileName?: string
  bytes?: number
  header?: ImageHeader
}

export type StickerVerdict = { sticker: boolean; reason: string }

const STICKER_MAX_SIDE = 512
const STICKER_MAX_BYTES = 800 * 1024

/** 从图片文件头解析格式/尺寸/透明通道（只需前 ~64 字节，JPEG 要多扫一点）。 */
export function readImageHeader(buffer: Buffer): ImageHeader {
  // PNG：89 50 4E 47 ... IHDR，宽高在 16/20（大端），colorType 在 25
  if (buffer.length >= 33 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    const colorType = buffer[25]
    return {
      format: 'png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      hasAlpha: colorType === 4 || colorType === 6,
    }
  }
  // GIF：GIF8 后面宽高是小端 u16
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { format: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  // WebP：RIFF....WEBP
  if (
    buffer.length >= 30 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    const chunk = buffer.toString('ascii', 12, 16)
    if (chunk === 'VP8X') {
      const b24 = buffer[24] ?? 0
      const b25 = buffer[25] ?? 0
      const b26 = buffer[26] ?? 0
      const b27 = buffer[27] ?? 0
      const b28 = buffer[28] ?? 0
      const b29 = buffer[29] ?? 0
      const w = 1 + (b24 | (b25 << 8) | (b26 << 16))
      const h = 1 + (b27 | (b28 << 8) | (b29 << 16))
      return { format: 'webp', width: w, height: h }
    }
    return { format: 'webp' }
  }
  // JPEG：扫 SOF 段拿宽高
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) { i += 1; continue }
      const marker = buffer[i + 1] ?? 0
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      const length = buffer.readUInt16BE(i + 2)
      if (isSof) {
        return { format: 'jpeg', height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) }
      }
      if (length <= 0) break
      i += 2 + length
    }
    return { format: 'jpeg' }
  }
  return { format: undefined }
}

/** 判断这条媒体是不是表情包。 */
export function judgeSticker(signals: StickerSignals): StickerVerdict {
  const type = signals.segmentType ?? 'image'
  const summary = signals.summary ?? ''
  const header = signals.header
  const bytes = signals.bytes ?? 0

  if (type === 'mface') return { sticker: true, reason: 'mface（QQ 商店表情）' }
  if (/动画表情|表情包|表情/.test(summary)) return { sticker: true, reason: 'summary=' + summary.slice(0, 20) }
  if (header?.format === 'gif') return { sticker: true, reason: 'GIF 动图（QQ 表情包主格式）' }
  if (header?.format === 'webp' && bytes > 0 && bytes <= STICKER_MAX_BYTES * 2) {
    return { sticker: true, reason: 'WebP 小图' }
  }
  if (header?.format === 'png' && header.hasAlpha === true) {
    const w = header.width ?? 0
    const h = header.height ?? 0
    const ratio = w > 0 && h > 0 ? w / h : 0
    if (w > 0 && h > 0 && w <= STICKER_MAX_SIDE && h <= STICKER_MAX_SIDE && bytes <= STICKER_MAX_BYTES && ratio >= 0.6 && ratio <= 1.7) {
      return { sticker: true, reason: '小尺寸透明 PNG ' + String(w) + 'x' + String(h) + '（' + Math.round(bytes / 1024) + 'KB）' }
    }
  }
  // 小尺寸、近似方形的 JPEG 也可能是表情包（很多图转存后丢了透明通道）
  if (header?.format === 'jpeg') {
    const w = header.width ?? 0
    const h = header.height ?? 0
    const ratio = w > 0 && h > 0 ? w / h : 0
    if (w > 0 && h > 0 && w <= 500 && h <= 500 && bytes > 0 && bytes <= 200 * 1024 && ratio >= 0.6 && ratio <= 1.7) {
      return { sticker: true, reason: '小尺寸 JPEG ' + String(w) + 'x' + String(h) + '（' + Math.round(bytes / 1024) + 'KB）' }
    }
    return { sticker: false, reason: 'JPEG（照片/截图）' }
  }
  return { sticker: false, reason: '未命中表情包特征' }
}
