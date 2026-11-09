/** 模型可调用的工具：主动发消息、列会话、受白名单约束的原始 OneBot 调用。 */
import type { Context } from '@deepseek-ai/cordis';
import type { ProviderRegistry } from './providers.js';
import type { SubscriptionStore } from './subscriptions.js';
import type { LogLevel, OneBotConnection } from './onebot.js';
export interface ToolDeps {
    /** 本群关系 + 性格倾向摘要 */
    personaDigest?: (chatKey: string) => Promise<{
        summary?: string;
        people: string[];
        style: string[];
        glossary: string[];
        preference: string[];
        traits: string[];
    }>;
    /** 追加一条性格倾向，返回最新列表 */
    personaTrait?: (chatKey: string, text: string) => Promise<string[]>;
    /** 当前人物卡（只取展示用字段） */
    personaCard?: () => {
        name: string;
        personality: string;
        aliases?: string[];
    };
    /** 可用人物卡列表（内置 + persona 目录） */
    personaCards?: () => string[];
    /** 会话 id → 当前 QQ 会话（省略 chat_id 时用） */
    keyForSession?: (sessionId: string) => string | undefined;
    maxImageBytes?: number;
    maxFileBytes?: number;
    /** 允许操作的群号（群文件工具用），省略=不限制 */
    allowedGroups?: () => readonly string[];
    /** 把 chatKey → mnemon 空间 id 写进插件缓存 */
    rememberSpace?: (chatKey: string, spaceId: string) => Promise<void>;
    /** 表情库检索（由 Bridge 提供，避免 tools 里重复扫库） */
    memeSearch?: (query: string, limit: number) => Promise<Array<{
        caption: string;
        tag: string;
    }>>;
    /** 表情库目录（分类 + 张数 + 示例） */
    memeCatalog?: () => Promise<Array<{
        tag: string;
        count: number;
        samples: string[];
    }>>;
    /** 订阅：数据源注册表 + 订阅表（由 Bridge 提供） */
    subscriptions?: {
        registry: ProviderRegistry;
        store: SubscriptionStore;
    };
    /** QQ 语音设置（napcat_send_voice） */
    voice?: {
        enabled: boolean;
        ttsVoice: string;
    };
}
export declare function registerTools(ctx: Context, conn: OneBotConnection, log: (level: LogLevel, message: string) => void, deps?: ToolDeps): void;
