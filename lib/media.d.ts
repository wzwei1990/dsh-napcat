/** 媒体收发：本地文件 ↔ base64、URL 下载、收件目录。NapCat 在远端时一律用 base64。 */
export declare const DEFAULT_MAX_IMAGE_BYTES: number;
export declare const DEFAULT_MAX_FILE_BYTES: number;
export declare function isHttpUrl(text: string): boolean;
/** 把任意名字洗成安全的单段文件名。 */
export declare function safeName(name: string, fallback: string): string;
/** 每个会话自己的收件箱目录（在会话 cwd 下，agent 可直接读取）。 */
export declare function ensureInbox(cwd: string): Promise<string>;
/** 插件自己的临时目录（下载 URL 用）。 */
export declare function ensureTempDir(): Promise<string>;
/** 下载到目录，返回本地绝对路径；超限直接抛错。 */
export declare function downloadToFile(url: string, dir: string, name: string, maxBytes: number): Promise<{
    path: string;
    bytes: number;
}>;
/** 本地文件 → base64://（NapCat 在远端也能用）。 */
export declare function localToBase64Url(path: string, maxBytes: number): Promise<{
    url: string;
    bytes: number;
    name: string;
}>;
/** 路径或 URL → base64://（URL 先下到临时目录）。 */
export declare function sourceToBase64Url(source: string, maxBytes: number): Promise<{
    url: string;
    bytes: number;
    name: string;
}>;
/** base64://… → Buffer（收文件时 NapCat 可能直接回 base64）。 */
export declare function base64UrlToBuffer(value: string): Buffer;
/** 从「file:///path」「C:\\x\\y.png」「a.png」里取一个像样的文件名。 */
export declare function nameFromRef(ref: string, fallback: string): string;
/** 按魔数判断图片类型（附件服务会校验声明类型，必须准确）。 */
export declare function imageMediaType(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined;
/**
 * 清理收件箱里的旧媒体（napcat-inbox 根目录下的图片/视频/音频）。
 * - 只删文件，不碰子目录（imgs/ 由 ImageCache 按日期目录自己清）
 * - 保留 _image-debug.log
 * 返回删掉的文件数。
 */
export declare function pruneInbox(inbox: string, retentionDays: number, now?: number): Promise<number>;
