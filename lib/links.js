/**
 * 小红书 / 网易云链接 → "看过了"的上下文块（零依赖、零安装）。
 *
 * 定位与 bililink.ts 一致：群友发链接时机器人要能接话，而不是复述卡片。
 * 这里只做「免登录能拿到的信息」：
 *   - 小红书：og:title / og:description（页面元信息，免 cookie）
 *   - 网易云：官方 api/song/detail（歌名/歌手/专辑）+ api/song/lyric 前几句
 * 想拿更深内容（正文/多图/评论）需要 XHS-Downloader 之类的本地工具，本模块不依赖它。
 */
const DEFAULT_TIMEOUT_MS = 20_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
/** 小红书桌面 UA 会被重定向到 /login；移动端 UA 能拿到带 og 标签的分享页。 */
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
/** 从一段文本里抽第一个小红书 / 网易云链接。 */
export function extractMediaLink(text) {
    // 注意：这里的三个形式分开写，不用 (?:a|b|c) 交替——
    // 实测带 user/profile 分支的交替会让整个正则匹配失败（V8 行为），分开匹配最稳。
    const xhs = /https?:\/\/(?:www\.)?xiaohongshu\.com\/explore\/[A-Za-z0-9]+[^\s"'）)】]*/i.exec(text)
        ?? /https?:\/\/(?:www\.)?xiaohongshu\.com\/discovery\/item\/[A-Za-z0-9]+[^\s"'）)】]*/i.exec(text)
        ?? /https?:\/\/(?:www\.)?xiaohongshu\.com\/user\/profile\/[^/\s]+\/[A-Za-z0-9]+[^\s"'）)】]*/i.exec(text);
    if (xhs !== null)
        return { kind: 'xhs', url: xhs[0].slice(0, 400) };
    const shortXhs = /https?:\/\/xhslink\.com\/[A-Za-z0-9/-]+/i.exec(text);
    if (shortXhs !== null)
        return { kind: 'xhs', url: shortXhs[0].slice(0, 400) };
    const neteaseSong = /https?:\/\/[^\s"'）)】]*(?:music\.163\.com|y\.music\.163\.com)\/[^\s"'）)】]*song[^\s"'）)】]*/i.exec(text);
    if (neteaseSong !== null)
        return { kind: 'netease', url: neteaseSong[0].slice(0, 400) };
    const neteaseShort = /https?:\/\/163cn\.tv\/[A-Za-z0-9]+/i.exec(text);
    if (neteaseShort !== null)
        return { kind: 'netease', url: neteaseShort[0].slice(0, 400) };
    return undefined;
}
function decodeEntities(text) {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_all, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}
/** 解析页面里的 og:title / og:description / og:image（属性顺序两种都兼容）。 */
export function parseOpenGraph(html) {
    const out = {};
    const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of metas) {
        const property = /property\s*=\s*["']og:([a-z_]+)["']/i.exec(tag)?.[1]
            ?? /name\s*=\s*["']og:([a-z_]+)["']/i.exec(tag)?.[1];
        if (property === undefined)
            continue;
        const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
        if (content === undefined)
            continue;
        const value = decodeEntities(content).trim();
        if (value === '')
            continue;
        if (property === 'title' && out.title === undefined)
            out.title = value;
        if (property === 'description' && out.description === undefined)
            out.description = value;
        if (property === 'image' && out.image === undefined)
            out.image = value;
    }
    return out;
}
/** 从网易云链接里抽歌曲 id（song?id= / /song/<id> / songid=）。 */
export function neteaseSongId(url) {
    const fromQuery = /[?&](?:id|songid)=(\d{3,20})/i.exec(url);
    if (fromQuery !== null)
        return fromQuery[1];
    const fromPath = /\/song\/(\d{3,20})/i.exec(url);
    if (fromPath !== null)
        return fromPath[1];
    return undefined;
}
/** 只取歌词正文的前几行（去掉时间戳和空行）。 */
export function lyricPreview(lrc, maxLines = 4) {
    const lines = lrc
        .split('\n')
        .map(line => line.replace(/^\[[^\]]*\]/g, '').trim())
        .filter(line => line !== '');
    return lines.slice(0, maxLines).join('\n');
}
async function fetchText(url, timeoutMs, userAgent = UA) {
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': userAgent, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    });
    if (!response.ok)
        return undefined;
    return { finalUrl: response.url === '' ? url : response.url, text: await response.text() };
}
async function xhsCard(url, timeoutMs) {
    const page = await fetchText(url, timeoutMs, UA_MOBILE);
    if (page === undefined)
        return undefined;
    // 失效/登录页没有内容，别硬编
    if (/\/404|\/login/i.test(page.finalUrl))
        return undefined;
    const og = parseOpenGraph(page.text);
    const plainTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(page.text)?.[1] ?? '';
    const title = (og.title ?? decodeEntities(plainTitle)).replace(/\s*-\s*小红书$/, '').trim();
    if (title === '' || title === '小红书')
        return undefined;
    // 小红书摘要里夹着制表符/换行，压成一个空格再截断，别把排版垃圾喂给模型
    const desc = (og.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return {
        kind: 'xhs',
        url: page.finalUrl,
        title: title.slice(0, 120),
        desc: desc === '' ? undefined : desc,
    };
}
async function neteaseCard(url, timeoutMs) {
    let id = neteaseSongId(url);
    if (id === undefined) {
        // 短链（163cn.tv）先跟一次跳转拿真实地址
        const page = await fetchText(url, timeoutMs);
        if (page === undefined)
            return undefined;
        id = neteaseSongId(page.finalUrl);
        if (id === undefined) {
            const fromHtml = /song\?id=(\d{3,20})/.exec(page.text);
            if (fromHtml !== null)
                id = fromHtml[1];
        }
    }
    if (id === undefined)
        return undefined;
    const detail = await fetchText('https://music.163.com/api/song/detail?ids=%5B' + id + '%5D', timeoutMs);
    if (detail === undefined)
        return undefined;
    let song;
    try {
        song = JSON.parse(detail.text).songs?.[0];
    }
    catch {
        return undefined;
    }
    const name = (song?.name ?? '').trim();
    if (name === '')
        return undefined;
    const artists = (song?.artists ?? []).map(a => a.name ?? '').filter(n => n !== '').join(' / ');
    const album = (song?.album?.name ?? '').trim();
    let extra;
    try {
        const lyric = await fetchText('https://music.163.com/api/song/lyric?id=' + id + '&lv=1&kv=1&tv=-1', timeoutMs);
        const lrc = lyric === undefined
            ? ''
            : (JSON.parse(lyric.text).lrc?.lyric ?? '');
        const preview = lyricPreview(lrc, 3);
        if (preview !== '')
            extra = preview;
    }
    catch {
        // 歌词拿不到不影响主信息
    }
    return {
        kind: 'netease',
        url: 'https://music.163.com/song?id=' + id,
        title: name.slice(0, 120),
        author: artists === '' ? undefined : artists.slice(0, 120),
        desc: album === '' ? undefined : album,
        extra,
    };
}
/** 取一张链接卡片；失败返回 undefined（调用方静默回落到通用提示）。 */
export async function fetchLinkCard(link, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
        if (link.kind === 'xhs')
            return await xhsCard(link.url, timeoutMs);
        return await neteaseCard(link.url, timeoutMs);
    }
    catch {
        return undefined;
    }
}
/** 把卡片渲染成注入块（语气与 bililink 一致：看过了、随口聊、不播报）。 */
export function renderLinkBlock(card) {
    const lines = [];
    if (card.kind === 'xhs') {
        lines.push('【群友刚发的小红书，你已经看过了】');
        lines.push('标题：' + card.title);
        if (card.desc !== undefined)
            lines.push('内容概要：' + card.desc);
        lines.push('怎么说：像刷到过一样随口接一句（共鸣/吐槽/追问都行），不要播报、不要贴链接、不要列点；别复述标题原文。');
    }
    else {
        lines.push('【群友刚分享的网易云歌曲，你已经听过了】');
        lines.push('歌曲：' + card.title + (card.author === undefined ? '' : ' — ' + card.author));
        if (card.desc !== undefined)
            lines.push('专辑：' + card.desc);
        if (card.extra !== undefined)
            lines.push('歌词片段：' + card.extra.replace(/\n/g, ' / '));
        lines.push('怎么说：随口接一句（评价氛围/联想到什么/问他在听什么），不要播报、不要贴链接、不要背歌词。');
    }
    return lines.join('\n') + '\n';
}
