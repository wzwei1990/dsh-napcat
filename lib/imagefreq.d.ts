/**
 * 群内图片频次表：同一张图被反复发，大概率是大家常用的表情包。
 *
 * 为什么需要它：单看文件头只能认出「GIF / 小透明 PNG」这类特征，
 * 但很多表情包是 JPEG（微信/QQ 转存后丢了透明通道），光看格式会漏。
 * 群友反复发同一张图，是个又便宜又准的信号 —— 用「文件头 64KB + 大小」算指纹，
 * 不需要解码整张图。
 */
export interface ImageFreqEntry {
    count: number;
    lastAt: number;
    bytes: number;
}
export type ImageFreqTable = Record<string, ImageFreqEntry>;
/** 指纹：前 64KB + 文件大小（不解码整图，够区分不同图片）。 */
export declare function imageKey(head: Buffer, size: number): string;
/** 读频次表（不存在/坏了都返回空表）。 */
export declare function loadImageFreq(inbox: string): Promise<ImageFreqTable>;
/** 记一次出现，返回累计次数；顺手把表裁剪到上限。 */
export declare function bumpImageFreq(inbox: string, key: string, bytes: number, now?: number): Promise<number>;
