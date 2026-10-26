/**
 * 文字表情兜底：把 `[表情:描述]` 映射成 QQ 原生小黄脸（face 段），
 * 这样即使没装 dsh-meme、或图库里找不到对应图片，也还能"有表情"。
 *
 * face id 用 QQ 经典表情编号（NapCat 的 {type:'face', data:{id:'14'}}）。
 * 只放常用、语义清楚的十几个，避免乱映射。
 */
/** 描述 → QQ 表情 id；匹配不到返回 undefined。 */
export declare function faceFor(description: string): string | undefined;
/** 词表（供文档/调试展示）。 */
export declare function faceCatalog(): Array<{
    id: string;
    name: string;
}>;
