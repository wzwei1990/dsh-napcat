# dsh-napcat

> 仓库：<https://github.com/wzwei1990/dsh-napcat>
> [![ci](https://github.com/wzwei1990/dsh-napcat/actions/workflows/ci.yml/badge.svg)](https://github.com/wzwei1990/dsh-napcat/actions/workflows/ci.yml)

给 [DeepSeek Harness](https://github.com/runzhliu/deepseek-harness) 加一个 **QQ 通道**：通过 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11 协议）把群聊/私聊消息送进 dsh 的 agent，再把回复发回 QQ。

``
QQ 用户 ──消息──> NapCat ──事件(WS)──> dsh-napcat ──> 每个会话一个 dsh agent
                                          │
QQ 用户 <──回复──── NapCat <──动作(WS)────┘   （turn/end 时把助手文本分段发回）
``

自己维护的一份实现：功能按需长，结构保持薄（连接层 / 会话桥 / 工具 / 配置四块，互不缠绕）。

**当前版本 v0.3.20**（形态参考 `dsh-onebot` / `dsh-im` / `dsh-qqbot`）。

## 功能

| 类别 | 支持 |
|---|---|
| 连接 | **forward**（本插件连 NapCat，NapCat 在别的机器上时用这个）/ **reverse**（本插件监听、NapCat 拨进来）；token 校验；断线指数退避重连 |
| 触发 | @机器人 / 回复机器人 / 关键字（`triggerKeywords`，如「小灯」）；群聊可要求必须 @ |
| 准入 | 私聊 / 群聊各自策略（`open` / `allowlist` / `disabled`）+ 白名单 |
| 会话 | **一个群/一个私聊 = 一个 dsh 会话**（`napcat-group-<群号>` / `napcat-private-<QQ>`）；会话 id 里编入 cwd 哈希，重启不换会话 |
| 分组 | 每个聊天自动建一个 **工作区**（侧边栏 `群 1103089802` / `私聊 1000001`）并挂载会话 |
| 标题 | 首条消息时把会话标题写成 `MM-DD HH:mm` |
| 记忆 | **群记忆**：每群一个 mnemon 记忆空间（设定/黑话/人物/事实四层）+ 最近消息缓冲（默认 200 条）+ 历史预热；模型自动捕获与更新，无需用户命令 |
| 图片缓存 | `imageCache: all` 时把群里的图片/表情包也落盘（`<cwd>/napcat-inbox/imgs/<日期>/`），聊天记录里写成 `[图片:<文件名>]`，之后可 `read_image` 回看；带每日配额/单张上限/过期清理 |`n| 主动发言 | **伪人模式**（默认关闭）：群里有话题时按泊松概率自己插一句，接上一句不跑题，没话说自动闭嘴（`__SKIP__`） |
| 性格 | 群 / 人性格：`personaOverrides`（`group:<群号>=人设` / `private:<QQ>=人设`），按会话注入 systemPrompt；只影响语气，不复述设定 |
| 图片（收） | **原生送达**：下载到 `<会话cwd>/napcat-inbox/` → `attachments.admitPromptContent` → `ImageBlock` 进模型请求（视觉模型直接看图）；同时保留 `[图片: <路径>]` 文本兜底 |
| 文件（收） | 私聊三级兜底：`get_private_file_url` → `get_file` 的 base64 → `get_file` 的 http url；远端 NapCat 只给本机路径时给出明确原因 |
| 群文件（收） | 工具按需拉取：`napcat_list_group_files` / `napcat_fetch_group_file`，支持**模糊文件名**（用户只记得一部分也能匹配） |
| 引用消息 | 引用一条带图/文件的消息 @机器人，会通过 `get_msg` 取回被引用消息里的媒体 |
| 图片 / 文件（发） | `napcat_send_image`（本地路径或 URL，自动 base64，NapCat 在远端也能发）/ `napcat_send_file`（`file` 段，失败退回 `upload_*_file`） |
| 稳定性 | 复用宿主已存在的 agent；同一会话装配串行化；会话文件丢失（ENOENT）自愈并重投；归档过的会话改用 `-rN` 新会话（不擅自解除归档） |
| 审批 | QQ 侧无人可点「同意」，自动把该 agent 审批策略设为 `never`（GUI 里显示 `Custom` 属预期） |
| 诊断 | `<会话cwd>/napcat-inbox/_image-debug.log` 逐步记录收图（可随时删）；默认日志每消息仅两行 |

> 说明：**图片原生送达**要求主模型支持图片输入；无视觉的模型会收到宿主生成的占位文本 + 我们附加的路径注释，可用 `read_image` / 视觉桥工具读该路径。

## 群记忆

一个群（或一个私聊）一份长期记忆，**跨天复用**，与其它群互不干扰。

### 三层结构

| 层 | 内容 | 怎么用 |
|---|---|---|
| **热上下文** | 最近 N 条群消息（`recent.jsonl`，默认留 200 条） | 每次触发自动注入最近 20 条 → 「知道刚才在聊什么」 |
| **温上下文** | 滚动摘要 + 人物群像 + 设定/黑话/**偏好 / 氛围 / 待办 / 事件**（`items.json`，带评分与过期） | 每轮注入 → 「记得前几天的脉络、谁是谁、谁爱什么、约过什么」 |
| **长期记忆** | 群设定 / 黑话 / 人物关系 / 事实结论（mnemon 记忆空间，一群一个） | 显式召回（固定层 + 按需层两次） |

### 表情包：模型怎么知道有哪些图

QQ 侧的表情来自 dsh-meme 图库（`~/.dsh/meme-packs` + 插件内置示例包，按 `caption+tag` 去重）。模型本身看不到图，所以给它三层信息：

| 层 | 内容 | 成本 |
|---|---|---|
| **注入目录** | 每轮记忆块里带「【可用表情（共 N 张，按分类）】happy(29)：… / sad(23)：…」（最多 14 个分类，每类 2 条示例） | 约 300~500 字，**生成一次后缓存** |
| **检索工具** | `napcat_meme_search(query)` → 返回若干候选 `caption（分类）`；模型拿到后用 `[表情: caption 原文]` 精确锁定那张 | 按需调用 |
| **目录工具** | `napcat_meme_catalog()` → 全部分类 + 张数 + 示例 | 按需调用 |

发图链路：模型输出 `[表情: 描述]` → 插件 `exact()`（caption 完全一致直接锁定）→ 不中则 `search()` 打分（caption 包含 / 关键词 / 2-gram / 标签同义）→ 再不行按情绪词随机抽一张 → 都没有就发小黄脸或纯文本。

**图库根目录与启用开关都读 dsh-meme 自己的设置**（`<home>/.dsh/dsh-expression.json` 的 `packsDir` / `enabledPacks`），所以和 Web 面板里看到的包保持一致；面板里关掉的包不会被发出来。

**新加的表情包 60 秒内自动生效**（图库缓存 TTL=60s，到期重扫；目录摘要同样 60 秒刷新），不需要重启 DSH。

`memeDirs` 可在设置里覆盖扫描目录；`memeEnabled=false` 关闭整套表情功能。

### 安全规则：危险操作只允许管理员

照 `dsh-onebot` 的命令门禁思路，在**入站派发之前**加了一道确定性判定（不依赖模型听话）：

```
消息进来 → 危险词表匹配 → 命中且非管理员 → 直接拒绝（不投给模型）+ 审计
                        → 命中且是管理员   → 放行 + 审计
```

内置 19 条规则（`src/danger.ts`），覆盖：

| 分类 | 例子 |
|---|---|
| 删除 | `删了/删除 文件/目录/仓库`、`rm -rf`、`rmdir`、`Remove-Item` |
| 数据库 | `drop table/database`、`DELETE FROM`、`删库`、`清空所有数据` |
| git | `git reset --hard`、`git clean -f`、`git push --force` |
| 系统 | `format c:`、`diskpart`、`mkfs`、`shutdown/reboot/关机`、`rm -rf /` |
| 记忆 | `清空记忆/删除记忆/忘掉上下文`、`forget all` |
| 配置 | 删除/覆盖 `.env`、改配置、卸载插件 |
| 权限 | `chmod -R`、`chown -R`、`takeown`、`icacls` |

除内置规则外，可用 `dangerWords` 追加自定义词（包含即命中）。

被拒时**交给模型说一句幽默的拒绝**：插件起一个一次性会话（`napcat-refuse-<群>`），只喂「危险类别」、不给用户原文（防二次注入），要求 20 字内、不调工具；20 秒没出来就本条静默（不留固定文案）。

**执行层始终不放行**——模型只负责说，插件负责拦。

**同一会话 10 分钟最多回一次**，避免刷屏。每次命中都记进 `memory/<群>/audit.jsonl`：

```json
{"at":1792738405000,"userId":"11470","nick":"路人","role":"member","word":"删除","category":"删除","decision":"rejected"}
```

`role` 只有 `admin` / `member` 两种，管理员名单来自 `adminUsers`。

### 归档轮（把冷历史蒸馏成温上下文）

### 记忆分类（8 类，都有评分与生命周期）

| 分类 | 内容 | 默认权重 | 生命周期 |
|---|---|---|---|
| `setting` 设定 | 称呼/规矩/禁忌 | 5 | 长期，靠评分淡出 |
| `person` 人物 | 昵称+说话风格+常聊话题 | 4 | 长期 |
| `preference` 偏好 | 谁喜欢/讨厌什么、口味、忌讳 | 3 | 长期 |
| `style` 群氛围 | 怎么说话、什么玩笑能开 | 4 | 长期 |
| `glossary` 黑话 | 群内术语/梗/缩写 | 3 | 长期 |
| `todo` 待办 | 未来约定（带 `when`），到期次日失效 | 4 | **到期自动删除** |
| `event` 事件 | 已发生的事（带 `when`） | 2 | `archiveEventDays`(45) 天后淡出 |
| `summary` 摘要 | 滚动脉络（3~6 句） | 5 | 每次合并更新 |

评分 = 权重 60% + 频率 25% + 新鲜度 15%；有效分 < 0.25 且 45 天未出现 → 淘汰；同类超 30 条按分数保留。

人物表默认**不设上限**（`peopleLimit=0`）：提示词只要求"写真正有辨识度的"，不再机械填满 6 个；想把注入控制得更小就设 `peopleLimit=8` 之类（会同时约束归档输出、现有记忆回灌与每轮注入）。

**独立静默会话**，不是搭在回复里：攒够 `archiveEvery`（默认 50）条消息、且群空闲 `archiveIdleMinutes`（默认 2）分钟后，插件开一个 `napcat-archive-<群>` 会话，把批次文件交给它，要求模型**只输出一个 JSON**：

```json
{"summary":"合并后的 3~6 句脉络","people":[{"name":"老灯","style":"说话风格","topics":["话题"]}],"glossary":["黑话"],"setting":["称呼/规矩"]}
```

| 要点 | 做法 |
|---|---|
| **更新而不是叠加** | 提示词带上现有摘要/人物/黑话/设定，要求输出"**合并后的完整版本**"，插件整份覆盖写入 |
| 存储 | `summary.json`（单一滚动摘要）、`people.json`（按名字更新）、`facts.json`（黑话/设定各 ≤30 条） |
| 失败处理 | 解析失败下一轮重试；连续 3 次丢弃批次并 warn |
| 与聊天隔离 | 独立会话不注册到 QQ 投递，输出不会漏到群里 |

> 早期版本是"让模型在普通回复末尾附带 `<归档>` 块"，实测模型经常忽略（尤其主动发言的短回复），已废弃（仅保留解析兼容）。

### 分层标签（模型自动维护，不需要用户命令）

``
【设定】群规矩 / 称呼 / 习惯   → tags 加 setting
【黑话】群内术语 / 缩写 / 梗   → tags 加 glossary
【人物】成员身份 / 关系 / 别名 → tags 加 person
【事实】结论 / 约定 / 待办     → 无额外标签
``

- **自动捕获**：只要对话里出现上述新信息，模型自己写入（`memoryAutoCapture`，默认开）
- **更新语义**：信息变化时先 `mnemon_forget` 旧条目再写新版本（带「更新于 MM-DD」），不是只增不改
- **静默**：记忆的增/改/删都不向用户汇报过程，回复保持自然语气

### 手动入口（可选）

| 命令 | 作用 |
|---|---|
| `@机器人 记住：周五发周报` | 写一条事实 |
| `@机器人 记住设定：群里管老张叫张哥` | 写设定（也支持 `记住黑话：` / `记住人物：`） |
| `@机器人 记忆` | 检索本群长期记忆并回答 |
| `@机器人 忘掉 XXX` | 召回后软删对应条目 |

### 历史预热

缓冲不足（或最新一条已过期）时，用 NapCat 的历史接口补齐：

- 群 → `get_group_msg_history`
- 私聊 → `get_friend_msg_history`

判据是「条数够 **且** 够新」：目标是 `recentLimit`（缓冲容量）、`warmupStaleMinutes`（新鲜度）。预热是**合并**（按时间+昵称+内容去重），绝不会把已攒下的历史覆盖掉 ✗→✓。

> ⚠️ 实现要点：mnemon 的记忆操作**必须在模型本轮 turn 内**执行（插件用 `ctx.tools.execute()` 在轮次外调用会被拒绝）。所以插件只负责注入上下文 + 转投命令，**从不自己调用 mnemon 的 recall**。

### 图片与表情包

群里大量的**表情包 / 分享图**默认不会落盘（只有叫到机器人时才下载）。开启缓存后可以留档：

```yaml
imageCache: all                 # off=只存叫到机器人时的图（默认）；all=群里的图也存
imageCacheMaxBytes: 2097152     # 单张 ≤ 2MB
imageCacheDailyCap: 100         # 每个聊天每天最多 100 张
imageCacheRetentionDays: 7      # 超期目录自动清理
```

- 落盘位置：`<会话cwd>/napcat-inbox/imgs/<YYYYMMDD>/<hash>-<原名>`
- **聊天记录里会写成** `[图片:<文件名>]` → 之后模型需要时用 `read_image("/…/imgs/20261023/xxx.jpg")` 回看
- **去重**：按图片 URL 的 hash，同一张图重复发只存一份
- **表情**：`[表情]` 段记进 `imgs/faces.jsonl`（谁爱用什么表情，可做后续统计）
- **历史图片也会缓存**：消息里存的图片 URL 会过期，但 `file` id 还能用 `get_image` 重新解析 → 预热时逐张尝试：成功就落盘并写成 `[图片:<文件名>]`，解析失败（撤回/过期）标 `[图片(已过期)]`
  - 开关：`warmupImages`（默认开）、`warmupImageLimit`（单次预热最多 30 张，另有每日配额兜底）
- **记录里带可读路径**：写进聊天记录的是 `[图片:napcat-inbox/imgs/<日期>/<文件>]`（相对会话工作目录），模型想看图时用 `read_image` 传这个相对路径即可真正看到画面；只写 `[图片]` / `[图片(已过期)]` 的表示当时没缓存下来
  - 注意：**@ 它那一轮**图片是随消息直接送进模型的（真看到）；**历史/主动发言**轮默认只给记录，按需读图（避免每轮读图拖慢响应、烧 token）
- **合并永不降级**：同一条消息的两次记录（实时 `[图片:文件名]` / 历史 `[图片]`）合并时**逐字段取优**——时间取更早、昵称取非空、文本取更长 ⇒ 带文件名的记录不会被降级成 `[图片]` ✓
- **记忆里不写图片字节**：mnemon 只记"谁爱发什么梗/图"这类结论（自动捕获规则会处理），避免把空间撑爆

> 磁盘提示：`all` 模式按 100 张/天/群 + 7 天保留，单群稳定在几百 MB 以内；像 `E:\dsnworkspace\napcat\group-xxx\napcat-inbox\imgs` 可随时手动清空。

## 主动发言（伪人模式）

默认**关闭**。开启后，群里有人聊天（没叫它）时，它会按概率决定要不要自然插一句。

### 判定链（全部通过才考虑插话）

| 关卡 | 说明 | 配置 |
|---|---|---|
| 开启 | 总开关 | `proactiveEnabled` |
| 静默时段 | 如凌晨不说话 | `proactiveQuietHours`（`00:00-08:00,12:00-13:00`）|
| 冷却 | 距上次发言至少 N 分钟 | `proactiveCooldownMinutes`（默认 30）|
| 每小时上限 | 防刷屏 | `proactiveMaxPerHour`（默认 3）|
| 有人聊 | 近窗口内至少 K 条他人消息 | `proactiveMinMessages` / `proactiveWindowMinutes`（默认 3 条 / 5 分钟）|
| 概率 | 泊松过程，间隔自然不均 | `proactiveRatePerHour`（λ，默认 1.5 次/小时；设 0 用 `proactiveChance` 固定概率）|

### 结合历史与记忆，优先最近几条

主动发言的提示里会单独拎出**最后 2 条消息（含发言人）**作为锚点：

``
【最近的对话（优先从这里切入）】
12:03 张三: 这周上线拖到周五了
12:04 李四: 又要加班了？

[主动发言] 先看上面的群设定、长期记忆和完整聊天记录，判断大家在聊什么、聊到哪一步，再决定说什么；切入点优先取最近这几条，但不必死盯最后一句
要求：① ≤2 句口语化 ② 不重复别人刚说的话
     ④ 不总结、不列点、不点人名 ⑤ 没话说只回 __SKIP__
``

效果：能接着更早的梗或设定往下说，但切入点仍然贴着现场的节奏，不会岔到天南海北。

### 让模型自己决定闭嘴

通过判定后，投递一条 `[主动发言]` 请求，由模型判断"这话该不该接"：

- 有话可说 → 正常回复（≤ 2 句、口语化、不总结不列点）→ 发出并记一次发言
- 没什么可说 → 只回 `__SKIP__` → **插件丢弃这条**，并累计 `skipStreak`（连续跳过会按 1/2、1/4…退避降低下次概率）

> 设计参考：泊松触达（revive-companion）、概率+阈值（koishi-plugin-imx）、冷却与群隔离（chat-learning）、QQ 官方主动消息频控（每群 20 qpm / 1000 条/天，我们保守到每小时 3 条）。

### 出站图片与表情（QQ 侧真的发出去）

模型回复里可以带三种标记，插件会转成**真实图片消息**（而不是让用户看到文字）：

| 写法 | 行为 |
|---|---|
| `[图片:<路径>]` | 发送该文件；相对路径按会话工作目录解析 |
| `![说明](<路径>)` | 同上（markdown 图片） |
| `[表情:<描述>]` | 到 **dsh-meme 图库**里按描述/关键词找图后发送 |

- 生成图片后**不用用户再催**：提示词里已经要求「生成/挑到图就把路径写进回复」，插件负责发。
- **发送方式**：小黄脸（原生表情）**就地嵌在文字里**同一条消息发出；图片/表情包**单独一条**（每张一条）。多条之间由 `sendIntervalMs` 控制间隔。`n- **不重复的逻辑**：记住最近一段已发的图（默认**按图库大小自动**，约一半），优先换没发过的；同一描述匹配到的图发完了，先按情绪随机换，情绪池也用光就扩到全场随机（仍然避开最近 12 张）。图库越大越不容易重复——**24 张的库最多能连发约 24 张不重样**。
- **避重换图仍在**：模糊描述（「无语」「开心」）照旧走避重窗口；只有**精确抄 caption 原文**时锁定那一张（保证网页端和 QQ 显示同一张）；多样性靠模型换描述，不靠插件换图。\n- **小黄脸也轮换**：同一句「开心」不会永远 😊，会在同义表情间循环（😊→😁→😊…），最近 6 个不重样。
- **匹配是"描述/关键词级"，不是语义理解**：模型写 `[表情:<描述>]`，插件拿这段描述去图库的 `caption/keywords` 里找。所以提示词会要求模型**先搜候选、把那句描述原样写进来**，命中率才高。
- 描述和图库都对不上时：先按**明确提到的情绪词**在同情绪里挑；连情绪都没提到就**不发图**（避免发不贴题的图），退化成小黄脸或纯文字。想要"没匹配也发一张"就开 `memeLooseFallback`。
- **没装 dsh-meme 也有表情**：`[表情:…]` 按关键词换成 **QQ 原生小黄脸**（开心→😊、生气→😠、无语→😓、干饭→🍚…共 20 个词），不下载任何图片、不依赖插件；`[图片:路径]` 与 markdown 图片同样不依赖表情插件。
- 关掉：`memeEnabled: false`（表情不再解析），或 `memeDirs` 指定自己的图库目录。

### 总开关（不连 NapCat）

```yaml
enabled: false    # 默认 true
```

- **关掉后**：不建立 NapCat 连接、不处理任何消息、也不发送（发送路径直接 return）
- 插件仍然加载（设置页、工具都在），**改回 true 立即重连**，不用重启 DSH
- 适合：临时停用、换账号前先断开、排查"是不是插件在抢消息"

与 `dryRun` 的区别：

| 配置 | 连 NapCat | 跑模型 | 发消息 |
|---|---|---|---|
| `enabled: false` | ❌ | ❌ | ❌ |
| `dryRun: true` | ✅ | ✅ | ❌（只记日志） |

### 只读模式（本地 + 云端同时跑）

两个实例连同一个 QQ 会**双发消息**（每个实例都会回复同一句）。稳妥做法：

```yaml
dryRun: true     # 本地实例：只处理、只记日志，不向 QQ 发送任何消息
```

日志会显示 `[dryRun] 本应发送到 group:xxx: …`，方便本地调提示词而不打扰线上。

### 群聊感（不像 1v1）

群里注入一条「这是群聊，不是一对一」的礼仪：认人、必要时用昵称点名、谁问的回谁、**定时提醒必须带发起人昵称和事由**（不再发无主语的「提醒：…」）。这条放在注入块末尾，预算紧张时优先牺牲它，不会挤掉 @ 段和长期记忆。

### Linux 部署注意

- `workspacePath` 用**正斜杠**（如 `/workspace`）；路径归一化已按平台处理，Windows 上仍可用反斜杠。
- 记忆/图片目录都由 `workspacePath` 派生：Linux 下就是 `/workspace/memory`、`/workspace/napcat/...`。

### 被禁言了会自动停发

发送失败时会探测一次禁言状态（`get_group_member_info` 的 `shut_up_timestamp`，外加 `get_group_info` 的 `group_all_shut` 全员禁言）：

| 情况 | 插件行为 |
|---|---|
| 机器人被禁言 | 记下**解禁时间**，期间**不再发消息**、也**跳过主动发言**（日志：`本群禁言中，暂停发送 …（解禁 20:15:00）`） |
| 全员禁言 | 暂停 15 分钟后重新探测 |
| 未禁言（只是风控/发太快） | 重试 3 次（间隔递增），仍失败则本次放弃 + 提示 |

> 机器人自己的 QQ 取 `botQQ` 配置；没填时自动调 `get_login_info` 取一次并缓存，所以**不填也能生效**。

### 为什么半天没看到它说话？

主动发言是**低频**设计，用真实群聊（134 条消息 / 171 分钟）回放验证过：

| 参数组合 | 171 分钟内平均发言次数 |
|---|---|
| λ=1.5、冷却 30、上限 3、门槛 3（旧默认） | 1.22 |
| **λ=3、冷却 15、上限 4、门槛 2（现默认）** | **2.60** |

想立刻看到效果，临时用这组"测试参数"：

```yaml
proactiveRatePerHour: 30      # 相当于每条群消息 ~3% 概率
proactiveCooldownMinutes: 3
proactiveMaxPerHour: 10
proactiveMinMessages: 2
```

日志会说明每次为什么不触发（每群 10 分钟最多一条）：

```
主动发言暂不触发（距上次发言不足 15 分钟）: group:xxx
主动发言暂不触发（近 5 分钟少于 2 条他人消息）: group:xxx
主动发言已触发: group:xxx（poisson）
主动发言跳过（模型认为没必要）: group:xxx skipStreak=1
主动发言已发出: group:xxx（本小时第 1 条）
```

### 主动发言也会写记忆

主动发言那一轮同样带记忆块，并额外要求模型：

| 本群状态 | 模型要做的事 |
|---|---|
| **还没有记忆空间** | 先建空间（`mnemon_memory_body_create` → `activate` → `napcat_memory_space` 登记），再从近期群聊里提炼 1~3 条（群定位/成员称呼/黑话梗/重要约定）写进去，然后照常插话 |
| 已有记忆空间 | 只在听到值得长期记的新信息时顺手 `mnemon_remember` 记 **1 条**（没有就不记），不改变插话语气 |

所以「群里一直没人 @ 它 → 空间永远建不起来」这个死锁已经解除：第一次主动发言就会把空间建好。

> 私聊同样适用（`napcat_memory_space` 支持 `user_id`）；`memoryBackend: file` 时这一节不适用（直接写 `notes.md`，没有空间概念）。

### 推荐起步值

``yaml
proactiveEnabled: true
proactiveRatePerHour: 3        # 活跃群平均约每小时 1 次（受冷却与上限约束）
proactiveCooldownMinutes: 15
proactiveMaxPerHour: 3
proactiveQuietHours: "00:00-08:00"
proactiveMinMessages: 2
proactiveWindowMinutes: 5
``


## 群 / 人性格

配置 `personaOverrides`，每行一条：

``
group:<群号>=<人设>
private:<QQ>=<人设>
``

- 按会话精确匹配注入（`systemPrompt.context`），不同群可以有不同性格
- **只影响语气 / 称呼 / 风格**：不会把设定原文念给用户，也不会拿它当自我介绍（代码里有硬约束）
- 留空 = 不注入任何性格，纯工具人

## 快速开始

### 1. NapCat 侧

| 模式 | 说明 | NapCat 侧填法 |
|---|---|---|
| `forward`（推荐） | 插件主动连 NapCat 的 WS | NapCat 开 WebSocket 服务器，记下 `ws://<host>:<port>` + token |
| `reverse` | NapCat 连插件的 WS 服务 | NapCat 填 `ws://<插件所在机器>:<port>`；插件这边填 `host` / `port` / `accessToken` |

`accessToken` 两边必须一致。

### 2. 安装插件

``bash
# 从 GitHub
dsh plugin --profile web add github:wzwei1990/dsh-napcat

# 或本地目录
dsh plugin --profile web add /path/to/dsh-napcat
``

仓库已提交构建产物 `lib/`，纯安装不需要本地编译；改代码后 `pnpm build` 再重装/重启即可。

### 3. 配置

设置 → **NapCat**（顶层设置分区，order 60）。保存即时生效（配置项都是 `volatile`，插件监听 `settings/document-updated` 自己重建连接）。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `forward` | `forward`=插件连 NapCat；`reverse`=NapCat 连插件 |
| `url` | `ws://<napcat-host>:3001` | `forward` 模式下的 NapCat WS 地址 |
| `accessToken` | `''` | OneBot token（两边一致） |
| `host` / `port` | `0.0.0.0` / `3001` | `reverse` 模式下插件监听地址 |
| `botQQ` | `''` | 机器人 QQ；留空用事件里的 `self_id` |
| `adminUsers` | `[]` | 管理员 QQ（预留） |
| `dmPolicy` / `allowFrom` | `allowlist` / `[]` | 私聊策略与白名单 |
| `groupPolicy` / `groupAllowFrom` | `allowlist` / `[]` | 群策略与白名单（群文件工具也受它约束） |
| `triggerKeywords` | `[]` | 触发关键字（如 `小灯`） |
| `requireMention` | `true` | 群聊是否必须 @；关键字/回复命中则不需要 |
| `ignoreSelf` | `true` | 忽略机器人自己发的消息 |
| `replyAsQuote` | `false` | 回复时是否引用原消息 |
| `enabled` | `true` | 总开关：关掉不连 NapCat、不处理消息、不发送 |
| `dryRun` | `false` | 只读模式：不向 QQ 发送任何消息（本地测试用，避免与线上双发） |
| `memeEnabled` | `true` | 把 `[表情:描述]` 解析成 dsh-meme 图库里的图并发送 |
| `memeLooseFallback` | `false` | 描述/情绪都匹配不上时是否仍随机发图（默认关，避免不贴题） |
| `memeRecentLimit` | `-1` | 表情避重窗口：`-1`=自动（约图库一半、上限 50）；`0`=不避重；正数=固定张数 |
| `memeDirs` | `'` | 表情库目录（留空=自动扫描 DSH_HOME 下 dsh-meme） |
| `faceFallback` | `true` | 图库没图时把 `[表情:描述]` 换成 QQ 原生小黄脸 |
| `outboundImageMaxBytes` | `8388608` | 单张待发送图片大小上限（字节） |
| `sendIntervalMs` | `500` | 分段消息之间的间隔（毫秒），避免 QQ 风控连发；0=不限 |
| `splitMaxChars` | `1200` | 长消息分段长度 |
| `reconnectMaxAttempts` | `10` | 重连次数（2s→60s 退避） |
| `perChatWorkspace` | `true` | 每个聊天一个独立工作区/分组 |
| `workspacePath` | `''` | 工作区根目录（留空=当前目录下的 `napcat/`） |
| `personaOverrides` | `''` | 群/人性格，多行 `group:<群号>=人设` / `private:<QQ>=人设` |
| `personaOverrides` | `'` | 群/人性格，多行 `group:<群号>=人设` / `private:<QQ>=人设`（只影响语气，不复述设定） |
| `memoryEnabled` | `true` | 群记忆总开关（最近对话缓冲 + 长期记忆） |
| `memoryBackend` | `mnemon` | `mnemon`=每群一个记忆空间（推荐）/ `file`=纯本地文件，完全不碰 mnemon |
| `memoryAutoCapture` | `true` | 模型自动判断并写入设定/黑话/人物/事实（关掉则只响应显式「记住」） |
| `memorySpaces` | `'` | 手填空间 id（`group:<群号>=<id>`）；留空由模型首次使用时自动创建并登记 |
| `memorySpacePrefix` | `napcat-` | 自动创建空间时的名字前缀 |
| `memeNudgeAfter` | `2` | 连续几条回复没带表情就注入提醒一次（0=不提醒） |
| `archiveEvery` | `50` | 归档节奏：攒够这么多条就让模型蒸馏一次（0=关闭） |
| `archiveEventDays` | `45` | 事件类记忆保留天数（到期自动淡出） |
| `dangerPolicy` | `admin-only` | 危险操作策略：admin-only=仅管理员可发起 / allow=谁都能发 / off=不拦截 |
| `dangerWords` | `[]` | 额外危险词（包含即命中） |
| `dangerReplyPrompt` | （空） | 拒绝话术的提示词模板，支持 `{category}`；留空用内置 |`n| `peopleLimit` | `0` | 人物表上限：0=不限制（默认），>0 按权重保留前 N 个 |
| `archiveIdleMinutes` | `2` | 群空闲多少分钟后起一轮**独立归档**（模型专门跑，输出不进 QQ） |
| `recentLimit` | `200` | 缓冲容量：保留多少条 = 预热补到多少条（含"最多存多少"与"补多少"两层含义；调小=少存少补） |
| `injectRecent` | `20` | 每次触发注入最近对话条数（直接影响 token 成本） |
| `injectMaxChars` | `4000` | 记忆注入总字符上限（超出截断并提示压缩） |

| `warmupImages` | `true` | 预热时也缓存历史消息里的图片（file id 失效则记 `[图片(已过期)]`） |
| `warmupImageLimit` | `30` | 单次预热最多下载几张历史图片 |
| `warmupStaleMinutes` | `10` | 缓冲最新一条超过多少分钟视为过期、需要重新预热 |
| `imageCache` | `off` | 群聊图片缓存：`all`=把群里的图片/表情包也落盘（默认只在叫到机器人时存） |
| `imageCacheMaxBytes` | `2097152` | 单张图片缓存上限（2MB） |
| `imageCacheDailyCap` | `100` | 每个聊天每天最多缓存张数 |
| `imageCacheRetentionDays` | `7` | 图片缓存保留天数（超期自动清理） |
| `proactiveEnabled` | `false` | 主动发言（伪人模式）总开关 |
| `proactiveRatePerHour` | `3` | 泊松 λ：每小时期望主动发言次数（0=改用固定概率） |
| `proactiveChance` | `0.02` | 固定概率模式的插话概率（λ>0 时不生效） |
| `proactiveCooldownMinutes` | `15` | 两次主动发言最小间隔 |
| `proactiveMaxPerHour` | `4` | 每小时最多主动发言次数 |
| `proactiveQuietHours` | `00:00-08:00` | 静默时段（逗号分隔多段） |
| `proactiveMinMessages` | `2` | 窗口内至少多少条他人消息才考虑 |
| `proactiveWindowMinutes` | `5` | 观察窗口（分钟） |
| `agentPreset` | `''` | 会话使用的 preset（留空=宿主默认） |
| `provider` / `model` | `''` | 覆盖模型（留空=宿主默认模型） |
| `logLevel` | `info` | `debug` 看投递/图片细节 |

## 工具（agent 可调用）

| 工具 | 作用 |
|---|---|
| `napcat_send_message` | 主动发文本（`private:123` / `group:456`，超长自动分段） |
| `napcat_list_targets` | 列好友与群，确定 `chat_id` |
| `napcat_send_image` | 发图片（本地路径或 URL；自动 base64） |
| `napcat_send_file` | 发文件（`file` 段 → 退回 `upload_*_file`） |
| `napcat_list_group_files` | 列群文件（`get_group_root_files` / `get_group_files_by_folder`，可按关键字过滤） |
| `napcat_fetch_group_file` | 下载群文件（**模糊文件名**；多个同分返回候选清单） |
| `napcat_memory_space` | 把本群 mnemon 记忆空间 id 登记给插件（插件缓存后自动带入上下文） |
| `napcat_api` | 白名单内的原始 OneBot 动作 |

省略 `chat_id` 时，工具默认作用于当前会话。

## 工作原理（读代码前先看这六条）

1. **一条 QQ 消息 → 一个 dsh 会话**：`chatRefOf()` 得 `group:<号>` / `private:<QQ>`，`ensureChat()` 建/恢复会话（cwd 哈希进 id）。
2. **媒体先落盘再进模型**：下载 → `attachments.admitPromptContent` → `ImageBlock`；`createUserMessage({ content: [...blocks, text] })` → `agent.followup()`。
3. **回复靠会话事件**：监听 `session/event`，`assistant/message` + `turn/end` 拼文本 → `send_msg`（按 `splitMaxChars` 分段）。
4. **分组靠工作区注册表**：`workspaceRegistry.resolveByPath/create` + `attachSession`（宿主要求工作区路径 == 会话 cwd）。
5. **记忆 = 两层**：`recent.jsonl`（热上下文，插件自己写）+ mnemon 空间（长期，**只能由模型在轮内读写**——插件在轮次外调会被 View 拒绝）。
6. **主动发言 = 判定 + 自决**：`src/proactive.ts` 做纯判定（静默/冷却/限流/条数/泊松），通过后投递 `[主动发言]`，模型回 `__SKIP__` 则丢弃并累计退避。

## 排错

| 现象 | 检查 |
|---|---|
| 消息没反应 | 群里是否 @ / 命中关键字；`groupAllowFrom` 是否含该群 |
| 每轮 `blocked` 没回复 | 审批策略未设成 `never`（应自动设；GUI 显示 `Custom` 属预期） |
| 图片只有路径 | 看 `napcat-inbox/_image-debug.log`：`admit ok` 表示图已进会话；无视觉模型收到占位文本属正常 |
| 收图/收文件失败 | 远端 NapCat 常只给**本机路径**（`/app/...`）→ 需开文件直链或共享目录 |
| 群文件列表失败 | 老 NapCat 用 `get_group_file_list`，新版用 `get_group_root_files`；插件两个都试，失败会列具体原因 |
| 会话重复/串台 | `workspacePath` 是否变过（变了会换会话）；归档过的会话会自动换 `-rN` |
| 记忆不生效 | 看 `memory/<群>/space.json` 是否已登记空间 id；`memory/_debug.log` 里出现 `Recall requires the View` 属已知噪音（模型轮内调用正常） |
| 记忆回复太啰嗦 | 已内置静默规则（不复述设定、不解释机制）；若仍啰嗦说明跑的是旧版本 |
| 主动发言一直不触发 | 依次查：`proactiveEnabled` 是否开 / 静默时段 / 冷却 30 分钟 / 每小时 3 条上限 / 近 5 分钟是否够 3 条他人消息；`logLevel: debug` 会打印 `主动发言不触发(<原因>)` |
| 主动发言跑题 | 提示里已锚定最后 2 条消息；若仍跑题可下调 `proactiveRatePerHour`（少而精） |

## 开发

``bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc → lib/
pnpm test        # node --test
``

``
src/
  index.ts      插件入口（inject / apply / 设置热更新 / 人设注入）
  bridge.ts     QQ ↔ DSH 桥（会话装配、收媒体、投递、回复泵、工作区）
  onebot.ts     OneBot 连接（forward/reverse、echo RPC、退避重连）
  text.ts       消息解析、CQ 码、分段、关键字、模糊文件名、标题
  media.ts      base64 / 下载 / 收件箱 / 图片类型嗅探
  tools.ts      agent 可调工具
  config.ts     schemastery 配置（每字段 volatile）
client/
  index.js      设置页（settings.section）
``

## Roadmap

- [x] 收发文本（@ / 关键字 / 回复触发）
- [x] 每聊天独立会话 + 工作区分组
- [x] 群 / 人性格（`systemPrompt.context`）
- [x] 图片原生送达（`ImageBlock`）+ 路径兜底
- [x] 私聊文件 / 引用消息媒体 / 群文件（模糊匹配）
- [x] 会话标题、归档会话自动换新、诊断日志
- [x] **群记忆（mnemon 分层）**：热上下文缓冲 + 设定/黑话/人物/事实四层 + 自动捕获 + 更新语义 + 历史预热
- [x] **主动发言（伪人模式）**：泊松概率 + 静默/冷却/限流 + `__SKIP__` 自决 + 退避 + 话题锚定
- [ ] 语音消息（STT / TTS）
- [x] 发文件：`file` 段 base64 已验证可用（远端 NapCat 生效）；`upload_*_file` 仅作兜底（官方要求本地路径或 URL，base64 未文档化）

## License

MIT
