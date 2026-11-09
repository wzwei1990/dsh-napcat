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
    format: 'png' | 'jpeg' | 'gif' | 'webp' | undefined;
    width?: number;
    height?: number;
    /** PNG 有 alpha 通道（colorType 4/6） */
    hasAlpha?: boolean;
}
export interface StickerSignals {
    /** OneBot 段类型：image / mface（QQ 商店表情） */
    segmentType?: string;
    /** segment.data.summary，NapCat 对动画表情常给「[动画表情]」 */
    summary?: string;
    fileName?: string;
    bytes?: number;
    header?: ImageHeader;
}
export type StickerVerdict = {
    sticker: boolean;
    reason: string;
};
/** 从图片文件头解析格式/尺寸/透明通道（只需前 ~64 字节，JPEG 要多扫一点）。 */
export declare function readImageHeader(buffer: Buffer): ImageHeader;
/** 判断这条媒体是不是表情包。 */
export declare function judgeSticker(signals: StickerSignals): StickerVerdict;
