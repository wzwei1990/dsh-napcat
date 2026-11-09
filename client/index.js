/**
 * dsh-napcat 设置页（浏览器半仓 · 手写客户端模块 · 免构建）。
 *
 * 形态照搬宿主自带的客户端包（@deepseek-ai/dsh-client-ui-settings-plugins）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) 里先 `var module = { exports: {} }; var exports = module.exports`，
 *   末尾 `exports.apply = apply; exports.inject = inject; return module.exports`。
 * 少了这两行 `var module/exports` 会在浏览器里抛 `ReferenceError: exports is not defined`，
 * 进而把客户端模块图带崩 —— 这是必须严格照抄的原因。
 *
 * 页面挂在「设置 → 插件」的 settings.plugins.tab 列表槽（与内置插件页同一套）。
 * 读写配置走宿主已有的 settings Remote 域（= ctx.settings / configEditor）：
 *   describe() → 当前值 + revision
 *   update(ns, patch, revision) → 写 profile 的 cordis.patch.yml 并热重载
 * 所以保存后会自动追加配置行，与别的插件行为一致。
 *
 * 顶部 window 守卫：本文件是浏览器专属；万一被 Node 侧扫描/import 时安静退出，绝不拖累宿主启动。
 */

;(() => {
  const moduleLoader = typeof window === 'undefined' ? undefined : window.__ModuleLoader__

if (moduleLoader !== undefined && moduleLoader !== null) {
  moduleLoader.load({
    id: 'dsh-napcat',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports

      const react = require('react')

      /** 设置页字段（与 src/config.ts 的 Config 一一对应）。 */
      const FIELDS = [
        // ── 分组标题（渲染时按 section 画分隔线）──
        { section: '连接' },
        { key: 'enabled', label: '启用 NapCat 连接（关掉后不连 NapCat、不处理消息）', kind: 'boolean' },
        { key: 'mode', label: '连接方式', kind: 'select', options: [['forward', 'forward：插件连 NapCat'], ['reverse', 'reverse：NapCat 拨入']] },
        { key: 'url', label: 'NapCat WebSocket 地址', kind: 'text', placeholder: 'ws://<napcat-host>:3001' },
        { key: 'accessToken', label: 'Access Token', kind: 'password', placeholder: '与 NapCat 的 WebSocket 服务器一致' },
        { key: 'host', label: 'reverse 监听地址', kind: 'text', placeholder: '0.0.0.0（NapCat 在别的机器上）' },
        { key: 'port', label: 'reverse 监听端口', kind: 'number' },
        { key: 'botQQ', label: '机器人 QQ（留空自动学习）', kind: 'text' },
        { key: 'reconnectMaxAttempts', label: '重连上限（0=无限）', kind: 'number' },
        { section: '权限与安全' },
        { key: 'adminUsers', label: '管理员 QQ（逗号分隔）', kind: 'list' },
        { key: 'dangerPolicy', label: '危险操作策略（删除/删库/强推/格式化/清空记忆等）', kind: 'select', options: [['admin-only', 'admin-only：仅管理员可发起'], ['allow', 'allow：谁都能发'], ['off', 'off：不拦截']] },
        { key: 'dangerWords', label: '额外危险词（逗号分隔，包含即命中）', kind: 'list' },
        { key: 'dangerReplyPrompt', label: '拒绝话术的提示词模板（支持 {category}，留空用内置）', kind: 'text' },
        { key: 'dmPolicy', label: '私聊策略', kind: 'select', options: [['admin', 'admin：仅管理员'], ['open', 'open：任何人'], ['disabled', 'disabled：关闭']] },
        { key: 'allowFrom', label: '私聊额外白名单（逗号分隔，留空=不限）', kind: 'list' },
        { key: 'groupPolicy', label: '群聊策略', kind: 'select', options: [['allowlist', 'allowlist：仅白名单群'], ['open', 'open：任何群'], ['disabled', 'disabled：关闭']] },
        { key: 'groupAllowFrom', label: '允许的群号（逗号分隔）', kind: 'list' },
        { key: 'requireMention', label: '群聊必须 @机器人 才响应（关掉=任何群消息都进模型）', kind: 'boolean' },
        { key: 'triggerKeywords', label: '群聊关键字触发（逗号分隔；命中就响应，不要求 @）', kind: 'list' },
        { key: 'ignoreSelf', label: '忽略机器人自己的消息', kind: 'boolean' },
        { section: '回复方式' },
        { key: 'replyAsQuote', label: '回复时引用原消息', kind: 'boolean' },
        { key: 'splitMaxChars', label: '单条消息最大字数（0=不分段）', kind: 'number' },
        { key: 'sendIntervalMs', label: '分段消息间隔（毫秒，防 QQ 风控）', kind: 'number' },
        { key: 'dryRun', label: '只读模式：不向 QQ 发送任何消息（本地测试用）', kind: 'boolean' },
        { section: '表情包' },
        { key: 'memeEnabled', label: '把 [表情:描述] 解析成 dsh-meme 图库里的图发送', kind: 'boolean' },
        { key: 'faceFallback', label: '图库没图时用 QQ 原生小黄脸兜底', kind: 'boolean' },
        { key: 'memeDirs', label: '表情库目录（留空=自动扫描 DSH_HOME 下 dsh-meme）', kind: 'string' },
        { key: 'memeRecentLimit', label: '表情避重窗口（-1=自动按图库大小，0=不避重）', kind: 'number' },
        { key: 'memeLooseFallback', label: '匹配不到时也随机发一张图（默认关，避免不贴题）', kind: 'boolean' },
        { key: 'memeNudgeAfter', label: '连续几条回复没发表情就提醒模型带一个（0=不提醒）', kind: 'number' },
        { key: 'memeMinGap', label: '表情包最小间隔（几条文字后才可再发；0=不限制）', kind: 'number' },
        { section: '图片与媒体' },
        { key: 'outboundImageMaxBytes', label: '单张待发送图片上限（字节，默认 8MB）', kind: 'number' },
        { key: 'imageCache', label: '群聊图片缓存（存表情包/分享图，便于以后回看）', kind: 'select', options: [['off', 'off：只存叫到机器人时的图'], ['all', 'all：群里的图也存（带配额）']] },
        { key: 'imageCacheMaxBytes', label: '单张图片缓存上限（字节）', kind: 'number' },
        { key: 'imageCacheDailyCap', label: '每个聊天每天最多缓存张数', kind: 'number' },
        { key: 'imageCacheRetentionDays', label: '图片缓存保留天数（超期清理）', kind: 'number' },
        { key: 'warmupImages', label: '预热时也缓存历史图片（file id 失效则标记已过期）', kind: 'boolean' },
        { key: 'warmupImageLimit', label: '单次预热最多下载几张历史图片（默认 30）', kind: 'number' },
        { section: '会话与模型' },
        { key: 'workspacePath', label: '会话工作区路径（留空=宿主 cwd）', kind: 'text' },
        { key: 'perChatWorkspace', label: '每个会话用独立子目录（群聊始终独立；私聊按此开关，目录为 workspacePath/napcat/<群号或QQ>）', kind: 'boolean' },
        { key: 'personaName', label: '用哪张人物卡', kind: 'select', options: [['default', '大肥鱼（也叫小灯）'], ['tsundere', '毒舌同事'], ['gentle', '温柔姐姐'], ['custom', '自定义（用下面人物卡文本框的 JSON）']], hint: '三张内置卡已写到 ~/.dsh/dsh-napcat/persona/{default,tsundere,gentle}.json，可以直接编辑；新增的 <名字>.json 也能用（配置里 personaName 填文件名）。选「自定义」则用下面文本框里的 JSON。' },
        { key: 'personaCard', label: '人物卡内容（选「自定义」时填；留空=用上面选的卡）', kind: 'textarea', placeholder: '{"name":"大肥鱼","aliases":["小灯"],"description":"群里的团宠兼助手","personality":"幽默风趣、嘴硬心软","mes_example":"群友：在吗\n大肥鱼：在，鱼还没睡","post_history_instructions":"回复简短精炼，不超过两句"}' },
        { key: 'agentPreset', label: 'Agent 预设（留空=宿主默认）', kind: 'text' },
        { key: 'provider', label: '模型 provider（留空=宿主默认）', kind: 'text' },
        { key: 'model', label: '模型 id（留空=宿主默认）', kind: 'text' },
        { section: '记忆' },
        { key: 'memoryEnabled', label: '群记忆：开启（最近对话缓冲 + 长期记忆）', kind: 'boolean' },
        { key: 'memoryBackend', label: '长期记忆后端', kind: 'select', options: [['mnemon', 'mnemon：每群一个记忆空间'], ['file', 'file：纯本地文件，不碰 mnemon']] },
        { key: 'memorySpacePrefix', label: '记忆空间名前缀（mnemon 模式）', kind: 'text', placeholder: 'napcat-' },
        { key: 'recentLimit', label: '每群保留最近消息条数', kind: 'number' },
        { key: 'injectRecent', label: '每次触发注入最近对话条数', kind: 'number' },
        { key: 'injectMaxChars', label: '记忆注入字符上限', kind: 'number' },
        { key: 'warmupStaleMinutes', label: '预热新鲜度：最新一条超过多少分钟视为过期', kind: 'number' },
        { section: '归档' },
        { key: 'archiveEvery', label: '归档节奏：攒够多少条消息蒸馏一次摘要/人物卡（0=关闭）', kind: 'number' },
        { key: 'archiveIdleMinutes', label: '群空闲多少分钟后起一轮独立归档（分钟）', kind: 'number' },
        { key: 'archiveEventDays', label: '事件类记忆保留天数（到期自动淡出）', kind: 'number' },
        { key: 'peopleLimit', label: '人物表上限（0=不限制）', kind: 'number' },
        { section: '主动发言' },
        { key: 'proactiveEnabled', label: '主动发言（伪人模式）：群里有话题时自己插话', kind: 'boolean' },
        { key: 'proactiveRatePerHour', label: '主动发言频率 λ（次/小时，0=不主动）', kind: 'number' },
        { key: 'proactiveCooldownMinutes', label: '两次主动发言最小间隔（分钟）· 同时决定观察窗口与每小时上限', kind: 'number' },
        { key: 'proactiveHotMessages', label: '话题门槛（观察窗口内至少多少条他人消息才考虑插话）', kind: 'number' },
        { key: 'proactiveHeatScaling', label: '按话题热度自适应：寒暄少说、聊正事多说（推荐开）', kind: 'boolean' },
      { key: 'proactiveHeatLowMax', label: '寒暄档上限：热量低于此值按寒暄处理（默认 2）', kind: 'number' },
      { key: 'proactiveHeatHotMin', label: '热聊档起点：热量达到此值放开频率（默认 3）', kind: 'number' },      { key: 'proactiveFreshSeconds', label: '冷场门：群里安静超过多少秒就不再主动开口（0=不限）', kind: 'number' },
        { key: 'proactiveQuietHours', label: '主动发言静默时段（如 00:00-08:00,12:00-13:00）', kind: 'text' },
        { section: '会话与模型' },
          {
            key: 'sessionStartTimeoutSeconds',
            label: '会话启动超时（秒，连续两轮没动静才重置会话）',
            kind: 'number',
          },
          { section: '视频与链接' },
          {
            key: 'biliEnabled',
            label: '群里出现 B 站链接时，解析弹幕/字幕，让机器人"看过"再聊（默认开）',
            kind: 'boolean',
          },
          {
            key: 'biliSubtitleChars',
            label: '有字幕时附带多少字（0=不取字幕）',
            kind: 'number',
          },
          {
            key: 'biliStoryboard',
            label: '同时抽分镜图（画面兜底，需要 dsh-bili + ffmpeg）',
            kind: 'boolean',
          },
          {
            key: 'biliPushEnabled',
            label: '接收订阅更新推送（群）',
            kind: 'boolean',
          },
          { section: 'B站订阅与回复通知' },
          { key: 'subscriptionEnabled', label: '订阅轮询（博主更新 → 推送到订阅它的群）', kind: 'boolean' },
          { key: 'subscriptionIntervalMinutes', label: '订阅轮询间隔（分钟，最小 5）', kind: 'number' },
          { key: 'subscriptionMax', label: '订阅数量上限', kind: 'number' },
          { key: 'subscriptionTypes', label: '默认订阅类型（video,dynamic）', kind: 'text' },
          { key: 'biliPushIntervalMinutes', label: '推送检查间隔（分钟）', kind: 'number' },
          { key: 'biliPushMaxPerPush', label: '单次最多推几条', kind: 'number' },
          { key: 'biliPushQuietHours', label: '推送免打扰时段（如 00:00-08:00，留空=不限）', kind: 'text' },
          {
            key: 'replyNotifyEnabled',
            label: '评论有新回复时私聊通知管理员（低频，不发群）',
            kind: 'boolean',
            hint: '只发给 adminUsers 里的人；需要先有评论监听登记。',
          },
          { key: 'replyNotifyIntervalMinutes', label: '回复检查间隔（分钟，最低 30，默认 120）', kind: 'number' },

          { section: '语音（发语音 / 收语音）' },
          {
            key: 'voiceEnabled',
            label: '1. 语音总开关：允许我发 QQ 语音',
            kind: 'boolean',
            hint: '关 = 我完全不会发语音（也不影响我听语音、识别语音）。\n开 = 下面 2~6 项才生效。',
          },
          {
            key: 'voiceTtsVoice',
            label: '2. 发语音用哪个音色（留空 = 跟 dsh-tts 设置里的音色一致）',
            kind: 'text',
            hint: 'Edge 例：zh-CN-XiaoxiaoNeural；火山例：zh_female_vv_uranus_bigtts。\n一般不填就行，改 dsh-tts 那里最省事。',
          },
          {
            key: 'voiceAlways',
            label: '4. 每次回复都发语音（不管对方发的是文字还是语音）',
            kind: 'boolean',
            hint: '勾上 = 每一条回复都额外带一条语音（比较吵，建议先不勾）。',
          },
          {
            key: 'voiceMirror',
            label: '5. 对方发语音时，我用语音回（跟对方一致）',
            kind: 'boolean',
            hint: '只在「对方发的是语音」时发语音；第 4 项勾上时以第 4 项为准。',
          },
          {
            key: 'voiceReplaceText',
            label: '6. 只发语音、不发文字（语音失败自动改发文字）',
            kind: 'boolean',
            hint: '不勾 = 文字一条 + 语音一条；勾上 = 只发语音，合成或发送失败才发文字（保证你总能收到回复）。',
          },
          {
            key: 'voiceTriggerMode',
            label: '7. 群里发语音怎么叫到我（QQ 语音没法带 @，所以必须用词叫）',
            kind: 'select',
            options: [
              ['off', 'off · 群里的语音我不理（默认）'],
              ['keywords', 'keywords · 语音里说了第 8 项的词，我才回'],
              ['always', 'always · 群里任何语音我都接（费 ASR 和模型额度）'],
            ],
            hint: '私聊不受限制：私聊发语音我直接回。',
          },
          {
            key: 'voiceTriggerKeywords',
            label: '8. 语音里要出现哪些词才算叫我（逗号分隔，留空 = 用上面全局的 triggerKeywords）',
            kind: 'text',
            hint: '例：小灯,灯灯。语音转写后出现任一个就当我被叫到。',
          },
          {
            key: 'voiceTestChatId',
            label: '9. 测试用：测试语音发到哪个会话（private:QQ号 或 group:群号；留空 = 最近说过话的会话）',
            kind: 'text',
          },
          {
            kind: 'button',
            label: '10. 发一条测试语音',
            action: 'test-voice',
            hint: '会真的往 QQ 发一条语音，用来确认 NapCat 收不收 mp3。',
          },
          { section: '游戏攻略' },
        {
          key: 'gameWikiEnabled',
          label: '群里聊到游戏时查 wiki（真问攻略给答案；只是讨论就只当背景参考，不给攻略）',
          kind: 'boolean',
        },
        { section: '运行与日志' },
        { key: 'heartbeatMinutes', label: '运行心跳：每 N 分钟打一条状态摘要（默认 10，0=关闭）', kind: 'number' },
        { key: 'logLevel', label: '日志级别', kind: 'select', options: [['info', 'info'], ['debug', 'debug'], ['warn', 'warn']] },
      ]

      const NS = 'dsh-napcat'
      const style = {
        wrap: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '620px' },
        hint: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '12px', margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' },
        row: { display: 'flex', flexDirection: 'column', gap: '4px' },
        label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #555)' },
        input: {
          font: 'inherit', fontSize: '13px', padding: '7px 9px', borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
          background: 'var(--dsw-alias-bg-l1, #fff)', color: 'inherit', width: '100%', boxSizing: 'border-box',
        },
        checkRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
        bar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
        btn: {
          font: 'inherit', fontSize: '13px', padding: '7px 14px', borderRadius: '6px', cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)', background: 'transparent', color: 'inherit',
        },
        primary: {
          font: 'inherit', fontSize: '13px', padding: '7px 14px', borderRadius: '6px', cursor: 'pointer',
          border: '1px solid transparent', background: 'var(--dsw-alias-state-business-primary, #1677ff)', color: '#fff',
        },
        error: { color: 'var(--dsw-alias-state-error-primary, #d4380d)', fontSize: '12px', margin: 0, whiteSpace: 'pre-wrap' },
        ok: { color: 'var(--dsw-alias-state-success-primary, #389e0d)', fontSize: '12px', margin: 0 },
      }

      /** 解包 Remote 结果：{ ok, value } / { ok:false, error }。 */
      function unwrap(result) {
        if (result !== null && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
          if (result.ok !== true) {
            const code = result.error && result.error.code
            const message = result.error && result.error.message
            throw new Error((code ? code + ': ' : '') + (message || 'remote call failed'))
          }
          return result.value
        }
        return result
      }

      /** Remote 方法签名（见 typert.remote-client.d.ts）：
       *  describe() → { writable, hasDocument, namespaces: SettingsNamespaceView[] }
       *  update(ns, patch, expectedRevision) → SettingsNamespaceView
       * 两者都返回 { ok, value } 包装。
       */

      /** 取 Remote 门面（客户端服务名 `remote`）。 */
      function remoteOf(ctx) {
        try {
          const viaNamespace = ctx.remote && ctx.remote.settings
          if (viaNamespace && typeof viaNamespace.describe === 'function') return { settings: viaNamespace }
          const viaService = typeof ctx.get === 'function' ? ctx.get('remote.settings') : undefined
          if (viaService && typeof viaService.describe === 'function') return { settings: viaService }
          return null
        } catch (error) {
          return null
        }
      }

      function toList(value) {
        const raw = String(value == null ? '' : value)
        return raw.split(/[,，\s]+/).map((item) => item.trim()).filter((item) => item !== '')
      }

      function renderField(field, value, onChange) {
        const id = NS + '-' + field.key
        if (field.kind === 'button') {
          // 自包含按钮：点了自己发请求、自己在按钮上显示结果（不依赖页面状态）
          return react.createElement('div', { style: style.row, key: field.key },
            react.createElement('button', {
              style: style.primary,
              onClick: (event) => {
                const button = event.currentTarget
                const input = document.getElementById(NS + '-voiceTestChatId')
                const chatId = input && typeof input.value === 'string' ? input.value.trim() : ''
                const label = button.textContent
                button.disabled = true
                button.textContent = '发送中…（合成 + 上传）'
                const url = '/dsh-napcat/api/test-voice?chat_id=' + encodeURIComponent(chatId)
                  + '&text=' + encodeURIComponent('你好，我是小灯，这是一条语音测试。')
                fetch(url, { cache: 'no-store' })
                  .then((response) => response.json())
                  .then((payload) => {
                    button.textContent = payload && payload.ok
                      ? '✅ 已发到 ' + String(payload.chat) + '（' + Math.round((payload.bytes || 0) / 1024) + 'KB）'
                      : '❌ ' + String(payload && payload.error ? payload.error : '未知错误')
                  })
                  .catch((error) => { button.textContent = '❌ ' + String(error && error.message ? error.message : error) })
                  .finally(() => {
                    button.disabled = false
                    setTimeout(() => { button.textContent = label }, 10000)
                  })
              },
            }, field.label),
            field.hint === undefined ? null : react.createElement('p', { style: style.hint }, field.hint))
        }
        if (field.kind === 'boolean') {
          return react.createElement('div', { style: style.checkRow, key: field.key },
            react.createElement('input', {
              id, type: 'checkbox', checked: Boolean(value),
              onChange: (event) => onChange(field.key, event.target.checked),
            }),
            react.createElement('label', { htmlFor: id }, field.label))
        }
        let control
        if (field.kind === 'select') {
          control = react.createElement('select', {
            id, style: style.input, value: value == null ? '' : String(value),
            onChange: (event) => onChange(field.key, event.target.value),
          }, field.options.map((pair) => react.createElement('option', { key: pair[0], value: pair[0] }, pair[1])))
        } else if (field.kind === 'number') {
          control = react.createElement('input', {
            id, type: 'number', style: style.input, value: value == null ? '' : String(value),
            onChange: (event) => onChange(field.key, event.target.value === '' ? undefined : Number(event.target.value)),
          })
        } else if (field.kind === 'textarea') {
          control = react.createElement('textarea', {
            id, style: Object.assign({}, style.input, { minHeight: '96px', fontFamily: 'inherit' }),
            placeholder: field.placeholder, value: value == null ? '' : String(value),
            onChange: (event) => onChange(field.key, event.target.value),
          })
        } else if (field.kind === 'list') {
          // value 这里就是原始文本（不是数组）：输入过程中逗号/空格原样保留，
          // 由调用方在 onChange 里解析成数组，避免"刚敲下的逗号被吃掉"。
          control = react.createElement('input', {
            id, type: 'text', style: style.input, placeholder: field.placeholder,
            value: value == null ? '' : String(value),
            onChange: (event) => onChange(field.key, event.target.value),
          })
        } else {
          control = react.createElement('input', {
            id, type: field.kind === 'password' ? 'password' : 'text', style: style.input,
            placeholder: field.placeholder, value: value == null ? '' : String(value),
            onChange: (event) => onChange(field.key, event.target.value),
          })
        }
        return react.createElement('div', { style: style.row, key: field.key },
          react.createElement('label', { style: style.label, htmlFor: id }, field.label),
          control)
      }

      /** 页面主体。 */
      function NapcatSettingsPage(props) {
        const ctx = props.ctx
        const [state, setState] = react.useState({ phase: 'loading' })
        const [draft, setDraft] = react.useState({})
        const [revision, setRevision] = react.useState(undefined)
        const [message, setMessage] = react.useState(undefined)
          const [writable, setWritable] = react.useState(true)

        const load = react.useCallback(async () => {
          const remote = remoteOf(ctx)
          if (remote === null) {
            setState({ phase: 'unsupported' })
            return
          }
          setState({ phase: 'loading' })
          try {
            const described = unwrap(await remote.settings.describe())
            const list = described && Array.isArray(described.namespaces) ? described.namespaces : []
            if (!Array.isArray(described && described.namespaces)) {
              throw new Error('describe 返回的形状不对：' + JSON.stringify(described).slice(0, 200))
            }
            setWritable(described.writable !== false)
            const row = list.find((item) => item && item.ns === NS)
            if (row === undefined) {
              setState({ phase: 'missing' })
              return
            }
            const normalized = Object.assign({}, row.value || {})
            for (const field of FIELDS) {
              if (field.kind === 'list' && Array.isArray(normalized[field.key])) {
                normalized[field.key] = normalized[field.key].join(', ')
              }
            }
            setDraft(normalized)
            setRevision(row.revision)
            setState({ phase: 'ready' })
          } catch (error) {
            setState({ phase: 'error', error: String(error && error.message ? error.message : error) })
          }
        }, [ctx])

        react.useEffect(() => { void load() }, [load])

        const save = async () => {
          const remote = remoteOf(ctx)
          if (remote === null) return
          setMessage(undefined)
          try {
            const described = unwrap(await remote.settings.describe())
            const list = described && Array.isArray(described.namespaces) ? described.namespaces : []
            if (!Array.isArray(described && described.namespaces)) {
              throw new Error('describe 返回的形状不对：' + JSON.stringify(described).slice(0, 200))
            }
            setWritable(described.writable !== false)
            const row = list.find((item) => item && item.ns === NS)
            const next = {}
            for (const field of FIELDS) {
              if (!Object.prototype.hasOwnProperty.call(draft, field.key)) continue
              // 数组字段在表单里是逗号分隔字符串，保存时再解析
              next[field.key] = field.kind === 'list' ? toList(draft[field.key]) : draft[field.key]
            }
            await unwrap(await remote.settings.update(NS, next, row ? row.revision : revision))
            setMessage({ ok: true, text: '已保存（写入 profile 的 cordis.patch.yml，插件会热重载）' })
            await load()
          } catch (error) {
            setMessage({ ok: false, text: '保存失败：' + String(error && error.message ? error.message : error) })
          }
        }

        if (state.phase === 'loading') return react.createElement('p', { style: style.hint }, '读取配置中…')

        if (state.phase === 'unsupported') {
          return react.createElement('div', { style: style.wrap },
            react.createElement('p', { style: style.hint }, '当前宿主没有暴露 settings Remote 域，无法在本页读写配置。可以手动在 profile 的 cordis.patch.yml 追加：'),
            react.createElement('pre', { style: style.hint },
              '- id: ' + NS + '\n  name: ' + NS + '\n  config:\n    mode: forward\n    url: ws://<napcat-ip>:3001\n    accessToken: <token>\n    adminUsers: [\'<你的QQ>\']'))
        }

        if (state.phase === 'missing') {
          return react.createElement('div', { style: style.wrap },
            react.createElement('p', { style: style.hint }, '宿主里没找到 dsh-napcat 的配置条目。确认插件已安装并启用，再点重试。'),
            react.createElement('button', { style: style.btn, onClick: () => void load() }, '重试'))
        }

        if (state.phase === 'error') {
          return react.createElement('div', { style: style.wrap },
            react.createElement('p', { style: style.error }, '读取配置失败：' + state.error),
            react.createElement('button', { style: style.btn, onClick: () => void load() }, '重试'))
        }

        return react.createElement('div', { style: style.wrap },
          react.createElement('p', { style: style.hint },
            '保存后写入 profile 的 cordis.patch.yml 并热重载插件。' +
            (revision === undefined ? '' : ' 当前 revision：' + revision)),
          FIELDS.map((field) => {
            // 分组标题：只画一条分隔线 + 标题，不占配置项
            if (field.section !== undefined) {
              return react.createElement('div', {
                key: 'section:' + field.section,
                style: { marginTop: '18px', paddingTop: '10px', borderTop: '1px solid var(--dsw-alias-border-l1, #e5e5e5)' },
              },
                react.createElement('div', {
                  style: { fontWeight: 600, fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #555)' },
                }, field.section))
            }
            return renderField(field, draft[field.key], (key, value) => {
              setDraft((previous) => {
                const nextDraft = Object.assign({}, previous)
                nextDraft[key] = value
                return nextDraft
              })
            })
          }),
          react.createElement('div', { style: style.bar },
            react.createElement('button', { style: style.primary, onClick: () => void save() }, '保存'),
            react.createElement('button', { style: style.btn, onClick: () => void load() }, '重新读取'),
            message === undefined ? null
              : react.createElement('p', { style: message.ok ? style.ok : style.error }, message.text)))
      }

      // remote.settings = @deepseek-ai/dsh-api-settings-controller 暴露的 settings Remote 域
      // （configEditor / ctx.settings 的浏览器半边），读写配置都走它。
      const inject = ['slots', 'remote', 'remote.settings']

      /** 注册成「设置」左侧菜单里的一个独立页面（与「内置插件」同级）。 */
      function apply(ctx) {
        const Page = (props) => react.createElement(NapcatSettingsPage, Object.assign({}, props, { ctx: ctx }))
        // 用 slots.inject 等宿主声明出 settings.section 之后再注册；
        // 直接 register 会在槽还不存在时抛错，导致整条客户端 entry 变成 failed。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'napcat',
          order: 60,
          label: () => 'NapCat',
        }, Page))
      }

      exports.apply = apply
      exports.inject = inject
      return module.exports
    },
  })
}
})()