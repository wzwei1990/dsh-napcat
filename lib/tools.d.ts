/** 模型可调用的工具：主动发消息、列会话、受白名单约束的原始 OneBot 调用。 */
import type { Context } from '@deepseek-ai/cordis';
import type { LogLevel, OneBotConnection } from './onebot.js';
export interface ToolDeps {
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
}
export declare function registerTools(ctx: Context, conn: OneBotConnection, log: (level: LogLevel, message: string) => void, deps?: ToolDeps): void;
