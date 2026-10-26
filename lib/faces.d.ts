/**
 * 文字表情兜底：把 `[表情:描述]` 映射成 QQ 原生小黄脸（face 段），
 * 这样即使没装 dsh-meme、或图库里找不到对应图片，也还能"有表情"。
 *
 * face id 用 QQ 经典表情编号（NapCat 的 {type:'face', data:{id:'14'}}）。
 * 每条规则带若干**同义备选**（同一种情绪的不同表情），用于轮换，
 * 避免"每次说开心都发同一个 😊"。
 */
/**
 * 描述 → QQ 表情 id；匹配不到返回 undefined。
 * avoid 里是最近刚发过的 id：命中就换一个同义备选，避免一直同一个表情。
 */
export declare function faceFor(description: string, avoid?: Set<string>): string | undefined;
/** 词表（供文档/调试展示）。 */
export declare function faceCatalog(): Array<{
    id: string;
    name: string;
}>;
