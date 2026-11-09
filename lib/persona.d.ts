/**
 * 人物卡（SillyTavern Character Card V2/V3 兼容）+ 注入渲染。
 *
 * 设计取舍：
 *   - 静态层：身份/语气/示例/硬约束 —— 人写，模型不能改
 *   - 演化层：性格倾向 —— 存在记忆 items（kind=trait），由模型在对话里追加
 * 渲染成一段固定模板，注入 systemPrompt.context；卡片里不复述给用户。
 */
export interface CharacterCard {
    name: string;
    /** 别名（用户叫习惯了，两个名字都认） */
    aliases?: string[];
    description: string;
    personality: string;
    scenario: string;
    /** SillyTavern 的 mes_example：少样本对话，{{user}}/{{char}} 会替换掉 */
    mesExample: string;
    /** 人物卡自带的 system prompt（可选） */
    systemPrompt: string;
    /** 硬约束（SillyTavern 的 post_history_instructions） */
    postHistoryInstructions: string;
}
/** 内置默认卡：群助手团宠「大肥鱼」（融合了早先的「小灯」设定）。 */
export declare const DEFAULT_CARD: CharacterCard;
/**
 * 解析 SillyTavern 人物卡：
 *   - V2/V3：{ spec: 'chara_card_v2', data: { name, description, ... } }
 *   - 裸字段：{ name, description, ... }（也接受 V1 的 personality 简写）
 * 解析失败返回 undefined（调用方回落到内置卡）。
 */
export declare function parseCharacterCard(json: string): CharacterCard | undefined;
/** 配置里的卡文本 → 卡（空/坏 JSON 都用内置卡）。 */
export declare function cardFromConfig(text: string): CharacterCard;
/** 只取示例对话里的前 N 组（够定语气，不占太多上下文）。 */
export declare function exampleLines(example: string, maxTurns?: number): string[];
export interface PersonaDigest {
    summary?: string;
    people?: string[];
    style?: string[];
    glossary?: string[];
    preference?: string[];
    traits?: string[];
}
/**
 * 渲染注入块：人物卡 → 本群关系 → 最近性演倾向。
 * 约 400~700 字，按「靠后的约束更被重视」排布。
 */
export declare function renderPersona(card: CharacterCard, digest?: PersonaDigest): string;
/** 内置可选人物卡（personaName 填这些名字就能切）。 */
export declare const BUILTIN_CARDS: Record<string, CharacterCard>;
/** 列出可用卡片：内置 + persona 目录下的文件名（不含 .json）。 */
export declare function listCards(dirEntries: readonly string[]): string[];
/**
 * 取当前人物卡：
 *   ① 配置里内联 JSON 非空 → 用它（最高优先级）
 *   ② persona/<name>.json 存在 → 读文件
 *   ③ 内置卡 BUILTIN_CARDS[name]
 *   ④ 兜底 DEFAULT_CARD
 */
export declare function loadCard(options: {
    name: string;
    inline: string;
    dir: string;
    readFile: (path: string) => string;
    exists: (path: string) => boolean;
    join: (...parts: string[]) => string;
}): CharacterCard;
/**
 * 把人模板写进 persona 目录（只在文件不存在时写，不覆盖用户改过的卡）。
 * 这样三张内置卡和其它自定义卡形态一致：都能直接编辑。
 */
export declare function seedPersonaDir(dir: string): string[];
