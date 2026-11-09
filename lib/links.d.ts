/**
 * 小红书 / 网易云链接 → "看过了"的上下文块（零依赖、零安装）。
 *
 * 定位与 bililink.ts 一致：群友发链接时机器人要能接话，而不是复述卡片。
 * 这里只做「免登录能拿到的信息」：
 *   - 小红书：og:title / og:description（页面元信息，免 cookie）
 *   - 网易云：官方 api/song/detail（歌名/歌手/专辑）+ api/song/lyric 前几句
 * 想拿更深内容（正文/多图/评论）需要 XHS-Downloader 之类的本地工具，本模块不依赖它。
 */
export type LinkKind = 'xhs' | 'netease';
export interface MediaLink {
    kind: LinkKind;
    url: string;
}
export interface LinkCard {
    kind: LinkKind;
    url: string;
    title: string;
    author?: string;
    desc?: string;
    extra?: string;
}
/** 从一段文本里抽第一个小红书 / 网易云链接。 */
export declare function extractMediaLink(text: string): MediaLink | undefined;
/** 解析页面里的 og:title / og:description / og:image（属性顺序两种都兼容）。 */
export declare function parseOpenGraph(html: string): {
    title?: string;
    description?: string;
    image?: string;
};
/** 从网易云链接里抽歌曲 id（song?id= / /song/<id> / songid=）。 */
export declare function neteaseSongId(url: string): string | undefined;
/** 只取歌词正文的前几行（去掉时间戳和空行）。 */
export declare function lyricPreview(lrc: string, maxLines?: number): string;
/** 取一张链接卡片；失败返回 undefined（调用方静默回落到通用提示）。 */
export declare function fetchLinkCard(link: MediaLink, options?: {
    timeoutMs?: number;
}): Promise<LinkCard | undefined>;
/** 把卡片渲染成注入块（语气与 bililink 一致：看过了、随口聊、不播报）。 */
export declare function renderLinkBlock(card: LinkCard): string;
