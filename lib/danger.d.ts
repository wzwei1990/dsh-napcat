/**
 * 危险操作词表：识别「删/清/格式化/强推/关机」这类可能不可逆的请求。
 *
 * 只做**入站文本**层面的判定（不改工具、不拦截模型内部行为），
 * 目的：普通群友发这类请求时直接拒掉，不投给模型；管理员照常放行。
 *
 * 设计参考 dsh-onebot 的命令 adminOnly 门禁：判定放在「插件侧、派发之前」，
 * 这样即便模型被诱导也不会被拉起；且拒绝是确定性的，可审计。
 */
/** 一条危险词的命中结果。 */
export interface DangerHit {
    /** 命中的词（用于日志/审计，取规则代表词）。 */
    word: string;
    /** 分类：删除 / 数据库 / git / 系统 / 记忆 / 配置 / 权限。 */
    category: string;
}
/**
 * 判定一段文本是否有危险操作意图。
 * @param text 用户消息原文（已转纯文本）
 * @param extraWords 额外词表（配置项 dangerWords）
 * @returns 命中详情；没有命中返回 undefined
 */
export declare function detectDanger(text: string, extraWords?: readonly string[]): DangerHit | undefined;
/** 供测试/文档使用：内置规则的代表词列表。 */
export declare function dangerRules(): Array<{
    word: string;
    category: string;
}>;
