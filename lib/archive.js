/**
 * 归档（记忆蒸馏）的纯函数部分：提示词构造 + 输出解析。
 *
 * 设计参考 mem0 / LangMem / Zep：
 * - 提取与对话生成分离（独立静默一轮，只输出 JSON）
 * - **更新语义**：带上现有记忆，要求输出"合并后的完整版本"
 * - **权重**：每条给 weight(1~5)，配合频率/新鲜度做保留或淘汰
 * - **长期层**：要求模型把值得记的条目写进 mnemon（轮内调用合法）
 */
/** 构造归档轮的提示词（只读素材 + 只输出 JSON + 合并更新 + 写 mnemon）。 */
export function buildArchivePrompt(input) {
    const existing = input.existing;
    const lines = [];
    lines.push('你是这个 QQ 群的记忆整理员。这一轮**只做归档**：不回答别人、不闲聊、不发消息。');
    lines.push('');
    lines.push('## 素材');
    lines.push('- 文件：' + input.path);
    lines.push('- 内容：' + input.count + ' 条群聊消息，JSONL 每行 {"t":毫秒时间戳,"nick":"昵称","text":"内容"}');
    lines.push('- 会话：' + input.chatKey);
    lines.push('- 先用文件工具**读完这个文件**（可以分次读），再动笔。');
    lines.push('');
    const hasExisting = (existing?.summary !== undefined && existing.summary !== '')
        || (existing?.people !== undefined && existing.people.length > 0)
        || (existing?.glossary !== undefined && existing.glossary.length > 0)
        || (existing?.setting !== undefined && existing.setting.length > 0)
        || (existing?.preference !== undefined && existing.preference.length > 0)
        || (existing?.style !== undefined && existing.style.length > 0)
        || (existing?.todo !== undefined && existing.todo.length > 0)
        || (existing?.event !== undefined && existing.event.length > 0);
    if (hasExisting) {
        lines.push('## 已有记忆（关键：输出的是**更新后的完整版本**，不是增量）');
        if (existing?.summary !== undefined && existing.summary !== '')
            lines.push('【现有摘要】' + existing.summary);
        if (existing?.people !== undefined && existing.people.length > 0) {
            lines.push('【现有人物】');
            for (const person of existing.people) {
                lines.push('- ' + person.name + (person.style !== undefined && person.style !== '' ? '：' + person.style : '')
                    + (person.topics !== undefined && person.topics.length > 0 ? '（常聊 ' + person.topics.join('/') + '）' : ''));
            }
        }
        if (existing?.glossary !== undefined && existing.glossary.length > 0)
            lines.push('【现有黑话】' + existing.glossary.join('、'));
        if (existing?.setting !== undefined && existing.setting.length > 0)
            lines.push('【现有设定】' + existing.setting.join('；'));
        if (existing?.preference !== undefined && existing.preference.length > 0)
            lines.push('【现有偏好】' + existing.preference.join('；'));
        if (existing?.style !== undefined && existing.style.length > 0)
            lines.push('【现有群氛围】' + existing.style.join('；'));
        if (existing?.todo !== undefined && existing.todo.length > 0)
            lines.push('【现有待办】' + existing.todo.join('；'));
        if (existing?.event !== undefined && existing.event.length > 0)
            lines.push('【现有事件】' + existing.event.join('；'));
        lines.push('');
    }
    lines.push('## 任务（每项都输出**合并后的完整内容**，不要只写新增）');
    lines.push('1. summary：把【现有摘要】与新消息合并成 3~6 句（过时的删掉、同主题并成一句，不拼接、不写流水账）。');
    const peopleLimit = Math.max(0, Math.floor(input.peopleLimit ?? 0));
    lines.push('2. people：更新后的完整人物表（' + (peopleLimit > 0 ? '最多 ' + peopleLimit + ' 个，按 weight 保留最重要的' : '不设上限，只写真正有辨识度、值得长期记住的人') + '）。已有的人在原条目上更新 style/topics，不重复建条目；新人只加有辨识度的；同一人多称呼合并。每人给 weight（1~5，越重要越大）。');
    lines.push('3. glossary：合并后的完整黑话列表（最多 15 条），每条 {"text":"…","weight":1~5}。');
    lines.push('4. setting：合并后的完整设定列表（最多 15 条），称呼/规矩/禁忌，被取代的旧条目要替换掉，每条 {"text":"…","weight":1~5}。');
    lines.push('5. preference：偏好列表（最多 10 条）——谁喜欢/讨厌什么、口味、忌讳话题，如 {"text":"老灯不喝咖啡","weight":3}；涉及人时带上昵称。');
    lines.push('6. style：群氛围（最多 3 条）——这个群怎么说话、什么玩笑能开、什么话题别碰，如 {"text":"群里爱接梗互损，别端着","weight":4}。');
    lines.push('7. todo：**未来**要做的事（最多 8 条），每条 {"text":"周六晚八点开黑","when":"2026-11-01","weight":4}；when 用 YYYY-MM-DD，说不清就省略。');
    lines.push('8. event：**已经发生**的事（最多 8 条），每条 {"text":"老灯通宵把模型拼完了","when":"2026-10-25","weight":2}；只写有信息量的，不写寒暄。');
    lines.push('');
    lines.push('## weight 怎么打（决定以后保留还是淡出）');
    lines.push('- 5 = 核心（群规矩、称呼约定、关键人物）');
    lines.push('- 3 = 一般（常见梗、次要人物）');
    lines.push('- 1 = 边缘（一次性话题、短期信息）');
    lines.push('');
    if (input.spaceId !== undefined && input.spaceId !== '') {
        lines.push('## 不要记的东西（很重要）');
        lines.push('- 「闭嘴」「别说了」「滚」这类**一次性情绪/玩笑**不要写进设定/偏好/事件，也不要写成"机器人应该少说话"的规则；');
        lines.push('  只有当它**明确、反复**形成长期约定（如"本群禁止机器人插话"）才记，并写清来源人和日期。');
        lines.push('- 临时话题、寒暄、玩笑话都别沉淀；只留能长期复用的事实（称呼/规矩/黑话/偏好/约定/重要事件）。');
        lines.push('');
        lines.push('## 长期记忆（mnemon，必须做）');
        lines.push('- 本群空间 id：' + input.spaceId);
        lines.push('- 先召回：mnemon_recall({ memoryBodyIds: ["' + input.spaceId + '"], query: "设定 称呼 黑话 人物" })');
        lines.push('- 再写入新出现或已变化的条目：mnemon_remember({ memoryBodyIds: ["' + input.spaceId + '"], content: "【设定】群主要叫帅哥（更新于 MM-DD）", tags: ["setting"] })');
        lines.push('- 前缀与 tags 固定：设定→【设定】/setting，黑话→【黑话】/glossary，人物→【人物】/person，事实→【事实】无标签');
        lines.push('- **冲突就替换**：能 mnemon_forget 就先忘旧的再写新的；不能就在新内容里标「更新于 MM-DD」，不要留两条矛盾说法');
        lines.push('- 只写值得长期记的（称呼/规矩/黑话/人物特征/重要结论），闲聊细节不写');
        lines.push('');
    }
    lines.push('## 输出格式（必须严格遵守）');
    lines.push('- **只输出一个 JSON 对象**：不解释、不加代码块围栏、不说"好的"。');
    lines.push('- 字段名小写：summary / people / glossary / setting / preference / style / todo / event。');
    lines.push('- 没把握的字段直接省略，绝不编造。');
    lines.push('');
    lines.push('示例：');
    lines.push('{"summary":"最近在聊抽卡配队和拼胶，老灯吐槽加班到十点。","people":[{"name":"老灯","style":"吐槽型，爱用「好家伙」","topics":["抽卡","拼胶"],"weight":4}],"glossary":[{"text":"好家伙","weight":3}],"setting":[{"text":"群主要叫帅哥","weight":5}],"preference":[{"text":"老灯不喝咖啡","weight":3}],"style":[{"text":"群里爱接梗互损，别端着","weight":4}],"todo":[{"text":"周六晚八点开黑","when":"2026-11-01","weight":4}],"event":[{"text":"老灯通宵把模型拼完了","when":"2026-10-25","weight":2}]}');
    return lines.join('\n');
}
/** 把 glossary/setting 项归一成 {text, weight}（兼容纯字符串写法）。 */
function pickWeighted(value, limit) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const raw of value.slice(0, limit)) {
        if (typeof raw === 'string') {
            const text = raw.trim();
            if (text !== '')
                out.push({ text });
            continue;
        }
        if (raw === null || typeof raw !== 'object')
            continue;
        const item = raw;
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (text === '')
            continue;
        const entry = { text };
        if (typeof item.weight === 'number' && Number.isFinite(item.weight))
            entry.weight = item.weight;
        out.push(entry);
    }
    return out;
}
/** 解析带时间的条目（todo/event）：{text, when?, weight?}。 */
function pickDated(value, limit) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const raw of value.slice(0, limit)) {
        if (typeof raw === 'string') {
            const text = raw.trim();
            if (text !== '')
                out.push({ text });
            continue;
        }
        if (raw === null || typeof raw !== 'object')
            continue;
        const item = raw;
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (text === '')
            continue;
        const entry = { text };
        if (typeof item.when === 'string' && /^\d{4}-\d{2}-\d{2}/.test(item.when.trim()))
            entry.when = item.when.trim().slice(0, 10);
        if (typeof item.weight === 'number' && Number.isFinite(item.weight))
            entry.weight = item.weight;
        out.push(entry);
    }
    return out;
}
/** 从模型输出里抠出第一个合法 JSON 对象（容忍代码围栏、前后杂字、<归档> 包装）。 */
export function parseArchivePayload(text) {
    const candidates = [];
    const tagRe = /<\s*(?:归档|archive)\s*>([\s\S]*?)<\s*\/\s*(?:归档|archive)\s*>/gi;
    for (const match of text.matchAll(tagRe))
        candidates.push(match[1] ?? '');
    if (candidates.length === 0)
        candidates.push(text);
    for (const candidate of candidates) {
        const cleaned = candidate.replace(/```[a-zA-Z]*/g, '');
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start < 0 || end <= start)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(cleaned.slice(start, end + 1));
        }
        catch {
            continue;
        }
        if (parsed === null || typeof parsed !== 'object')
            continue;
        const record = parsed;
        const payload = {};
        if (typeof record.summary === 'string' && record.summary.trim() !== '') {
            payload.summary = record.summary.trim().slice(0, 1500);
        }
        if (Array.isArray(record.people)) {
            const people = [];
            for (const raw of record.people.slice(0, 8)) {
                if (raw === null || typeof raw !== 'object')
                    continue;
                const item = raw;
                const name = typeof item.name === 'string' ? item.name.trim() : '';
                if (name === '')
                    continue;
                const entry = { name };
                if (typeof item.style === 'string' && item.style.trim() !== '')
                    entry.style = item.style.trim();
                if (Array.isArray(item.topics)) {
                    const topics = item.topics.filter((topic) => typeof topic === 'string' && topic.trim() !== '');
                    if (topics.length > 0)
                        entry.topics = topics.slice(0, 5).map(topic => topic.trim());
                }
                if (typeof item.weight === 'number' && Number.isFinite(item.weight))
                    entry.weight = item.weight;
                people.push(entry);
            }
            if (people.length > 0)
                payload.people = people;
        }
        const glossary = pickWeighted(record.glossary, 20);
        if (glossary.length > 0)
            payload.glossary = glossary;
        const setting = pickWeighted(record.setting, 20);
        if (setting.length > 0)
            payload.setting = setting;
        const preference = pickWeighted(record.preference, 15);
        if (preference.length > 0)
            payload.preference = preference;
        const style = pickWeighted(record.style, 6);
        if (style.length > 0)
            payload.style = style;
        const todo = pickDated(record.todo, 10);
        if (todo.length > 0)
            payload.todo = todo;
        const event = pickDated(record.event, 10);
        if (event.length > 0)
            payload.event = event;
        if (payload.summary !== undefined || payload.people !== undefined || payload.glossary !== undefined || payload.setting !== undefined
            || payload.preference !== undefined || payload.style !== undefined || payload.todo !== undefined || payload.event !== undefined) {
            return payload;
        }
    }
    return undefined;
}
/** weight(1~5) → 0~1 的重要性分。 */
export function weightToScore(weight, fallback = 0.6) {
    if (weight === undefined || !Number.isFinite(weight))
        return fallback;
    return Math.min(1, Math.max(0.1, weight / 5));
}
