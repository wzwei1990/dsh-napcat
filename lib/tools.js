/** 模型可调用的工具：主动发消息、列会话、受白名单约束的原始 OneBot 调用。 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_IMAGE_BYTES, downloadToFile, ensureTempDir, localToBase64Url, sourceToBase64Url } from './media.js';
import { rankByFileName } from './text.js';
import { splitText } from './text.js';
/** 允许通过 napcat_api 透传的动作白名单（只读 + 发消息，避免模型乱调用管理类动作）。 */
const ALLOWED_ACTIONS = new Set([
    'send_msg',
    'send_private_msg',
    'send_group_msg',
    'get_login_info',
    'get_status',
    'get_version_info',
    'get_friend_list',
    'get_group_list',
    'get_group_info',
    'get_group_member_info',
    'get_group_member_list',
    'get_stranger_info',
]);
function textOutput() {
    return {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
    };
}
function parseChatId(raw) {
    const match = /^(private|group):(.+)$/.exec(raw.trim());
    if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new Error('chat_id 格式应为 private:<QQ号> 或 group:<群号>，收到: ' + raw);
    }
    const kind = match[1] === 'private' ? 'private' : 'group';
    return { kind, id: match[2].trim() };
}
export function registerTools(ctx, conn, log, deps = {}) {
    const keyForSession = deps.keyForSession;
    const maxImageBytes = deps.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    /** 解析目标会话：显式 chat_id 优先，否则用当前 agent 的会话。 */
    const resolveChat = (explicit, exec) => {
        const raw = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : undefined;
        if (raw !== undefined)
            return parseChatId(raw);
        const sessionId = exec?.agent?.session?.id;
        const derived = sessionId === undefined || keyForSession === undefined ? undefined : keyForSession(String(sessionId));
        if (derived === undefined || derived === '') {
            throw new Error('需要 chat_id（形如 private:123456 或 group:789012）：当前调用不在某个 QQ 会话里');
        }
        return parseChatId(derived);
    };
    const sendSegments = async (target, message) => {
        const result = await conn.call('send_msg', {
            message_type: target.kind,
            ...(target.kind === 'group' ? { group_id: target.id } : { user_id: target.id }),
            message,
        });
        return result?.message_id === undefined ? undefined : String(result.message_id);
    };
    ctx.tools.register(defineTool({
        name: 'napcat_send_message',
        description: '主动给一个 QQ 会话发文本消息（不需要对方先说话）。chat_id 形如 private:123456 或 group:789012。超长文本会自动分段。',
        parameters: {
            chat_id: { type: 'string', required: true, description: '目标会话：private:<QQ号> 或 group:<群号>' },
            text: { type: 'string', required: true, description: '要发送的纯文本' },
            quote_message_id: { type: 'string', description: '可选：引用（回复）这条消息的 id' },
        },
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const input = args;
            const target = parseChatId(input.chat_id);
            const chunks = splitText(input.text, 1200);
            const ids = [];
            for (let index = 0; index < chunks.length; index += 1) {
                const chunk = chunks[index];
                if (chunk === undefined)
                    continue;
                const message = [];
                if (index === 0 && typeof input.quote_message_id === 'string' && input.quote_message_id !== '') {
                    message.push({ type: 'reply', data: { id: input.quote_message_id } });
                }
                message.push({ type: 'text', data: { text: chunk } });
                const result = await conn.call('send_msg', {
                    message_type: target.kind,
                    ...(target.kind === 'group' ? { group_id: target.id } : { user_id: target.id }),
                    message,
                });
                if (result?.message_id !== undefined)
                    ids.push(String(result.message_id));
            }
            log('info', '工具发送 ' + input.chat_id + ' (' + chunks.length + ' 段)');
            return '已发送 ' + chunks.length + ' 段到 ' + input.chat_id + (ids.length > 0 ? '（message_id: ' + ids.join(', ') + '）' : '');
        },
    }));
    ctx.tools.register(defineTool({
        name: 'napcat_list_targets',
        description: '列出机器人账号的好友和群（用来确定 napcat_send_message 的 chat_id）。',
        parameters: {},
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async () => {
            let friends = [];
            let groups = [];
            let firstError;
            try {
                friends = await conn.call('get_friend_list', {});
            }
            catch (error) {
                firstError = error instanceof Error ? error.message : String(error);
            }
            try {
                groups = await conn.call('get_group_list', {});
            }
            catch (error) {
                firstError = firstError ?? (error instanceof Error ? error.message : String(error));
            }
            if (friends.length === 0 && groups.length === 0 && firstError !== undefined) {
                throw new Error('取好友/群失败：' + firstError + '（多半是 NapCat 未连接：检查 mode/url/accessToken，以及反向 WS 是否已接入）');
            }
            const lines = [];
            lines.push('好友（' + friends.length + '）：');
            for (const friend of friends.slice(0, 50)) {
                lines.push('  private:' + String(friend.user_id ?? '') + '  ' + String(friend.remark ?? friend.nickname ?? ''));
            }
            lines.push('群（' + groups.length + '）：');
            for (const group of groups.slice(0, 50)) {
                lines.push('  group:' + String(group.group_id ?? '') + '  ' + String(group.group_name ?? '') + '（' + String(group.member_count ?? '?') + ' 人）');
            }
            if (friends.length === 0 && groups.length === 0)
                lines.push('（没有取到任何会话；确认 NapCat 已登录且 get_friend_list/get_group_list 可用）');
            return lines.join('\n');
        },
    }));
    ctx.tools.register(defineTool({
        name: 'napcat_api',
        description: '直接调用一个 OneBot 11 动作（只允许白名单内的只读动作与发送动作）。params_json 是 JSON 字符串，如 {"group_id":"789012","message":[{"type":"text","data":{"text":"hi"}}]}。',
        parameters: {
            action: { type: 'string', required: true, description: 'OneBot 动作名，如 get_group_list / send_group_msg' },
            params_json: { type: 'string', description: '动作参数（JSON 字符串，可省略）' },
        },
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const input = args;
            if (!ALLOWED_ACTIONS.has(input.action)) {
                throw new Error('动作不在白名单内: ' + input.action + '（允许: ' + [...ALLOWED_ACTIONS].join(', ') + '）');
            }
            let params = {};
            if (typeof input.params_json === 'string' && input.params_json.trim() !== '') {
                const parsed = JSON.parse(input.params_json);
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('params_json 必须是 JSON 对象');
                }
                params = parsed;
            }
            const data = await conn.call(input.action, params);
            return JSON.stringify(data ?? null, null, 2);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'napcat_send_image',
        description: '给 QQ 会话发图片（本地路径或 http(s) 链接；自动转 base64，NapCat 在远端也能发）。省略 chat_id 时发到当前会话。',
        parameters: {
            source: { type: 'string', required: true, description: '本地图片绝对路径，或 http(s) 图片链接' },
            chat_id: { type: 'string', description: '目标会话：private:<QQ号> 或 group:<群号>；省略=当前会话' },
            caption: { type: 'string', description: '可选：图片前的文字说明' },
        },
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const input = args;
            const target = resolveChat(input.chat_id, exec);
            const image = await sourceToBase64Url(input.source, maxImageBytes);
            const message = [];
            if (typeof input.caption === 'string' && input.caption.trim() !== '') {
                message.push({ type: 'text', data: { text: input.caption.trim() } });
            }
            message.push({ type: 'image', data: { file: image.url } });
            const id = await sendSegments(target, message);
            log('info', '工具发图片 ' + String(target.id) + ' (' + Math.round(image.bytes / 1024) + 'KB)');
            return '已发送图片 ' + image.name + '（' + Math.round(image.bytes / 1024) + 'KB）' + (id === undefined ? '' : '，message_id: ' + id);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'napcat_send_file',
        description: '给 QQ 会话发文件（本地路径；自动转 base64 走上传接口）。省略 chat_id 时发到当前会话。',
        parameters: {
            path: { type: 'string', required: true, description: '本地文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话：private:<QQ号> 或 group:<群号>；省略=当前会话' },
            name: { type: 'string', description: '可选：对方看到的文件名（默认用原文件名）' },
        },
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const input = args;
            const target = resolveChat(input.chat_id, exec);
            const file = await localToBase64Url(input.path, maxFileBytes);
            const displayName = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : file.name;
            const errors = [];
            // ① 先试文件消息段（部分 NapCat 版本支持 base64）
            try {
                const id = await sendSegments(target, [{ type: 'file', data: { file: file.url, name: displayName } }]);
                log('info', '工具发文件（file 段）' + String(target.id) + ' (' + Math.round(file.bytes / 1024) + 'KB)');
                return '已发送文件 ' + displayName + '（' + Math.round(file.bytes / 1024) + 'KB）' + (id === undefined ? '' : '，message_id: ' + id);
            }
            catch (error) {
                errors.push('file 段失败: ' + (error instanceof Error ? error.message : String(error)));
            }
            // ② 退回群文件/私聊文件上传接口
            try {
                if (target.kind === 'group') {
                    await conn.call('upload_group_file', { group_id: target.id, file: file.url, name: displayName });
                }
                else {
                    await conn.call('upload_private_file', { user_id: target.id, file: file.url, name: displayName });
                }
                log('info', '工具发文件（upload）' + String(target.id) + ' (' + Math.round(file.bytes / 1024) + 'KB)');
                return '已通过上传接口发送文件 ' + displayName + '（' + Math.round(file.bytes / 1024) + 'KB）';
            }
            catch (error) {
                errors.push('上传接口失败: ' + (error instanceof Error ? error.message : String(error)));
            }
            throw new Error('发送文件失败：' + errors.join('；') + '（NapCat 远端时文件消息支持有限，可先试发图片或将文件放到公共可访问 URL）');
        },
    }));
    const allowedGroups = deps.allowedGroups;
    const resolveGroup = (explicit, exec) => {
        const raw = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : undefined;
        let groupId = raw;
        if (groupId === undefined) {
            const sessionId = exec?.agent?.session?.id;
            const derived = sessionId === undefined || keyForSession === undefined ? undefined : keyForSession(String(sessionId));
            if (derived !== undefined && derived.startsWith('group:'))
                groupId = derived.slice('group:'.length);
        }
        if (groupId === undefined || groupId === '')
            throw new Error('需要 group_id（当前不在群会话里就请显式传群号）');
        const allowed = allowedGroups?.() ?? [];
        if (allowed.length > 0 && !allowed.includes(groupId)) {
            throw new Error('群 ' + groupId + ' 不在 groupAllowFrom 白名单里，拒绝操作');
        }
        return groupId;
    };
    const listGroupFiles = async (groupId, folderId) => {
        // NapCat 新版移除了 get_group_file_list，改用 get_group_root_files / get_group_files_by_folder
        const attempts = [
            folderId === undefined || folderId === ''
                ? { action: 'get_group_root_files', params: { group_id: groupId } }
                : { action: 'get_group_files_by_folder', params: { group_id: groupId, folder_id: folderId } },
            { action: 'get_group_file_list', params: { group_id: groupId } },
        ];
        const errors = [];
        for (const attempt of attempts) {
            try {
                const data = await conn.call(attempt.action, attempt.params);
                if (Array.isArray(data?.files))
                    return data.files;
            }
            catch (error) {
                errors.push(attempt.action + ': ' + (error instanceof Error ? error.message : String(error)));
            }
        }
        throw new Error('列群文件失败（该 NapCat 版本可能不支持群文件接口）：' + errors.join('；'));
    };
    const sizeText = (bytes) => {
        const value = bytes ?? 0;
        if (value >= 1024 * 1024)
            return Math.round(value / 1024 / 1024) + 'MB';
        return Math.max(1, Math.round(value / 1024)) + 'KB';
    };
    ctx.tools.register(defineTool({
        name: 'napcat_list_group_files',
        description: '列出 QQ 群文件（可选按关键字模糊过滤）。用于"看看群文件里有哪些/有没有 XX 文件"。',
        parameters: {
            group_id: { type: 'string', description: '群号；省略=当前群会话' },
            keyword: { type: 'string', description: '可选：按文件名模糊过滤' },
        },
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const input = args;
            const groupId = resolveGroup(input.group_id, exec);
            const files = await listGroupFiles(groupId);
            if (files.length === 0)
                return '群 ' + groupId + ' 的文件列表是空的（或 NapCat 没返回）';
            const keyword = typeof input.keyword === 'string' && input.keyword.trim() !== '' ? input.keyword.trim() : '';
            const chosen = keyword === ''
                ? files.map(file => ({ item: file, score: 1 }))
                : rankByFileName(files, keyword, file => String(file.file_name ?? ''));
            if (chosen.length === 0) {
                return '群 ' + groupId + ' 里没有匹配「' + keyword + '」的文件；现有文件：\n' + files.slice(0, 15).map((file, index) => (index + 1) + '. ' + String(file.file_name ?? '?')).join('\n');
            }
            const lines = chosen.slice(0, 20).map((entry, index) => {
                const file = entry.item;
                return (index + 1) + '. ' + String(file.file_name ?? '?') + '  (' + sizeText(file.file_size) + ')  file_id=' + String(file.file_id ?? '');
            });
            return '群 ' + groupId + ' 匹配到 ' + chosen.length + ' 个文件：\n' + lines.join('\n');
        },
    }));
    ctx.tools.register(defineTool({
        name: 'napcat_fetch_group_file',
        description: '把 QQ 群文件下载到本地供阅读。可用 file_id 精确定位，或给（可能不完整的）文件名做模糊匹配；匹配到多个会退回候选清单。',
        parameters: {
            name: { type: 'string', description: '文件名（可以只写一部分，会模糊匹配）' },
            file_id: { type: 'string', description: '精确的 file_id（从 napcat_list_group_files 拿到）' },
            group_id: { type: 'string', description: '群号；省略=当前群会话' },
        },
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const input = args;
            const groupId = resolveGroup(input.group_id, exec);
            const files = await listGroupFiles(groupId);
            if (files.length === 0)
                throw new Error('群 ' + groupId + ' 的文件列表为空，拿不到要下载的文件');
            let target;
            if (typeof input.file_id === 'string' && input.file_id.trim() !== '') {
                const wantedId = input.file_id.trim();
                target = files.find(file => String(file.file_id ?? '') === wantedId);
                if (target === undefined)
                    throw new Error('群 ' + groupId + ' 里没有 file_id=' + input.file_id);
            }
            else {
                const query = typeof input.name === 'string' ? input.name.trim() : '';
                if (query === '')
                    throw new Error('请给 name（可用部分文件名）或 file_id');
                const ranked = rankByFileName(files, query, file => String(file.file_name ?? ''));
                if (ranked.length === 0) {
                    throw new Error('群 ' + groupId + ' 里没有匹配「' + query + '」的文件；现有：' + files.slice(0, 10).map(file => String(file.file_name ?? '?')).join('、'));
                }
                if (ranked.length > 1 && (ranked[1]?.score ?? 0) === ranked[0]?.score) {
                    const candidates = ranked.filter(entry => entry.score === ranked[0]?.score).slice(0, 8);
                    return '「' + query + '」匹配到多个同名/近似文件，请指定 file_id：\n' + candidates.map((entry, index) => (index + 1) + '. ' + String(entry.item.file_name ?? '?') + '  file_id=' + String(entry.item.file_id ?? '')).join('\n');
                }
                target = ranked[0]?.item;
            }
            if (target === undefined)
                throw new Error('没能定位到目标文件');
            const size = target.file_size ?? 0;
            if (size > maxFileBytes)
                throw new Error('文件太大（' + sizeText(size) + '，上限 ' + sizeText(maxFileBytes) + '）');
            const urlData = await conn.call('get_group_file_url', {
                group_id: groupId,
                file_id: String(target.file_id ?? ''),
                busid: target.busid ?? 102,
            });
            const url = urlData?.url;
            if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
                throw new Error('get_group_file_url 没返回可下载的 http 链接（NapCat 可能只给了本机路径）');
            }
            const dir = await ensureTempDir();
            const saved = await downloadToFile(url, dir, String(target.file_name ?? 'group-file'), maxFileBytes);
            const fileName = String(target.file_name ?? 'group-file');
            return '已下载群文件「' + fileName + '」（' + sizeText(saved.bytes) + '）\n[文件: ' + saved.path + ']';
        },
    }));
    // ── 记忆空间登记 ──────────────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'napcat_memory_space',
        description: '把本群/私聊的 mnemon 记忆空间 id 登记给插件（插件记到本地缓存，之后自动带进上下文）。',
        parameters: {
            group_id: { type: 'string', description: '群号；私聊可省略（改用 user_id）' },
            user_id: { type: 'string', description: '私聊对方 QQ 号；群聊可省略' },
            space_id: { type: 'string', description: 'mnemon 记忆空间 id' },
        },
        output: textOutput(),
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const input = args;
            const spaceId = (input.space_id ?? '').trim();
            if (spaceId === '')
                throw new Error('需要 space_id');
            const sessionId = exec?.agent?.session?.id;
            const derived = sessionId === undefined || keyForSession === undefined ? undefined : keyForSession(String(sessionId));
            const groupId = (input.group_id ?? (derived?.startsWith('group:') === true ? derived.slice(6) : '')).trim();
            if (groupId !== '') {
                await deps.rememberSpace?.('group:' + groupId, spaceId);
                return '已登记：group:' + groupId + ' → ' + spaceId + '（之后自动注入给模型）';
            }
            const userId = (input.user_id ?? (derived?.startsWith('private:') === true ? derived.slice(8) : '')).trim();
            if (userId === '')
                throw new Error('需要 group_id 或 user_id（当前会话身份未知）');
            await deps.rememberSpace?.('private:' + userId, spaceId);
            return '已登记：private:' + userId + ' → ' + spaceId + '（之后自动注入给模型）';
        },
    }));
    if (deps.memeSearch !== undefined) {
        ctx.tools.register(defineTool({
            name: 'napcat_meme_search',
            description: '在本机表情图库里按描述查可用表情，返回候选描述（caption）与分类。查到后回复里写 [表情: 候选描述原文] 就能精确发出那张图。',
            parameters: {
                query: { type: 'string', required: true, description: '描述/情绪关键词，如「害羞」「摸鱼」「无语」' },
                limit: { type: 'number', description: '最多返回几条（默认 5，最多 10）' },
            },
            output: textOutput(),
            isConcurrencySafe: () => true,
            execute: async (args) => {
                const input = args;
                const limit = Math.min(10, Math.max(1, Math.floor(Number(input.limit ?? 5) || 5)));
                const hits = await deps.memeSearch(String(input.query ?? ''), limit);
                if (hits.length === 0)
                    return '没查到匹配的表情；可以换个说法，或用 napcat_meme_catalog 看分类。';
                return hits.map(hit => '- ' + hit.caption + '（分类 ' + hit.tag + '）').join('\n');
            },
        }));
    }
    if (deps.memeCatalog !== undefined) {
        ctx.tools.register(defineTool({
            name: 'napcat_meme_catalog',
            description: '列出本机表情图库的分类、张数与示例描述（想知道"有哪些图"时用）。',
            parameters: {},
            output: textOutput(),
            isConcurrencySafe: () => true,
            execute: async () => {
                const catalog = await deps.memeCatalog();
                if (catalog.length === 0)
                    return '表情图库是空的（检查 memeEnabled / memeDirs）。';
                const total = catalog.reduce((sum, entry) => sum + entry.count, 0);
                const lines = catalog.map(entry => entry.tag + '(' + entry.count + ')' + (entry.samples.length > 0 ? '：' + entry.samples.join(' / ') : ''));
                return '共 ' + total + ' 张\n' + lines.join('\n');
            },
        }));
    }
}
