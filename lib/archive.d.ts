/**
 * 归档（记忆蒸馏）的纯函数部分：提示词构造 + 输出解析。
 *
 * 设计参考 mem0 / LangMem / Zep：
 * - 提取与对话生成分离（独立静默一轮，只输出 JSON）
 * - **更新语义**：带上现有记忆，要求输出"合并后的完整版本"
 * - **权重**：每条给 weight(1~5)，配合频率/新鲜度做保留或淘汰
 * - **长期层**：要求模型把值得记的条目写进 mnemon（轮内调用合法）
 */
/** 单条带权重的条目。 */
export interface WeightedItem {
    text: string;
    weight?: number;
}
/** 归档结果（模型输出解析后的形状）。 */
export interface ArchivePayload {
    summary?: string;
    people?: Array<{
        name: string;
        style?: string;
        topics?: string[];
        weight?: number;
    }>;
    glossary?: WeightedItem[];
    setting?: WeightedItem[];
    preference?: WeightedItem[];
    style?: WeightedItem[];
    todo?: Array<{
        text: string;
        when?: string;
        weight?: number;
    }>;
    event?: Array<{
        text: string;
        when?: string;
        weight?: number;
    }>;
}
/** 已有记忆：喂给模型让它"合并更新"而不是"另起一段"。 */
export interface ArchiveExisting {
    summary?: string;
    people?: Array<{
        name: string;
        style?: string;
        topics?: string[];
    }>;
    glossary?: string[];
    setting?: string[];
    preference?: string[];
    style?: string[];
    todo?: string[];
    event?: string[];
}
/** 构造归档轮的提示词（只读素材 + 只输出 JSON + 合并更新 + 写 mnemon）。 */
export declare function buildArchivePrompt(input: {
    path: string;
    count: number;
    chatKey: string;
    existing?: ArchiveExisting;
    spaceId?: string;
    peopleLimit?: number;
}): string;
/** 从模型输出里抠出第一个合法 JSON 对象（容忍代码围栏、前后杂字、<归档> 包装）。 */
export declare function parseArchivePayload(text: string, peopleLimit?: number): ArchivePayload | undefined;
/** weight(1~5) → 0~1 的重要性分。 */
export declare function weightToScore(weight: number | undefined, fallback?: number): number;
