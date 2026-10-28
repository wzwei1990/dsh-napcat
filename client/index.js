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
        { key: 'enabled', label: '启用 NapCat 连接（关掉后不连 NapCat、不处理消息）', kind: 'boolean' },
        { key: 'mode', label: '连接方式', kind: 'select', options: [['forward', 'forward：插件连 NapCat'], ['reverse', 'reverse：NapCat 拨入']] },
        { key: 'url', label: 'NapCat WebSocket 地址', kind: 'text', placeholder: 'ws://<napcat-host>:3001' },
        { key: 'accessToken', label: 'Access Token', kind: 'password', placeholder: '与 NapCat 的 WebSocket 服务器一致' },
        { key: 'host', label: 'reverse 监听地址', kind: 'text', placeholder: '0.0.0.0（NapCat 在别的机器上）' },
        { key: 'port', label: 'reverse 监听端口', kind: 'number' },
        { key: 'botQQ', label: '机器人 QQ（留空自动学习）', kind: 'text' },
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
        { key: 'replyAsQuote', label: '回复时引用原消息', kind: 'boolean' },
        { key: 'splitMaxChars', label: '单条消息最大字数（0=不分段）', kind: 'number' },
        { key: 'sendIntervalMs', label: '分段消息间隔（毫秒，防 QQ 风控）', kind: 'number' },
        { key: 'dryRun', label: '只读模式：不向 QQ 发送任何消息（本地测试用）', kind: 'boolean' },
        { key: 'memeEnabled', label: '把 [表情:描述] 解析成 dsh-meme 图库里的图发送', kind: 'boolean' },
        { key: 'faceFallback', label: '图库没图时用 QQ 原生小黄脸兜底', kind: 'boolean' },
        { key: 'memeDirs', label: '表情库目录（留空=自动扫描 DSH_HOME 下 dsh-meme）', kind: 'string' },
        { key: 'memeRecentLimit', label: '表情避重窗口（-1=自动按图库大小，0=不避重）', kind: 'number' },
        { key: 'memeLooseFallback', label: '匹配不到时也随机发一张图（默认关，避免不贴题）', kind: 'boolean' },
        { key: 'memeNudgeAfter', label: '连续几条回复没发表情就提醒模型带一个（0=不提醒）', kind: 'number' },
        { key: 'outboundImageMaxBytes', label: '单张待发送图片上限（字节，默认 8MB）', kind: 'number' },
        { key: 'reconnectMaxAttempts', label: '重连上限（0=无限）', kind: 'number' },
        { key: 'workspacePath', label: '会话工作区路径（留空=宿主 cwd）', kind: 'text' },
  { key: 'perChatWorkspace', label: '每个会话用独立子目录（workspacePath/napcat/<群号或QQ>）', kind: 'boolean' },
  { key: 'personaOverrides', label: '群/人性格（每行 group:<群号>=<人设> 或 private:<QQ>=<人设>）', kind: 'textarea', placeholder: 'group:123456=你是群宠小灯，语气活泼\nprivate:10001=你是我的私人助理，正式一点' },
        { key: 'agentPreset', label: 'Agent 预设（留空=宿主默认）', kind: 'text' },
        { key: 'provider', label: '模型 provider（留空=宿主默认）', kind: 'text' },
        { key: 'model', label: '模型 id（留空=宿主默认）', kind: 'text' },
        { key: 'logLevel', label: '日志级别', kind: 'select', options: [['info', 'info'], ['debug', 'debug'], ['warn', 'warn']] },
        { key: 'memoryEnabled', label: '群记忆：开启（最近对话缓冲 + 长期记忆）', kind: 'boolean' },
        { key: 'memoryBackend', label: '长期记忆后端', kind: 'select', options: [['mnemon', 'mnemon：每群一个记忆空间'], ['file', 'file：纯本地文件，不碰 mnemon']] },
        { key: 'memorySpacePrefix', label: '记忆空间名前缀（mnemon 模式）', kind: 'text', placeholder: 'napcat-' },
        { key: 'recentLimit', label: '每群保留最近消息条数', kind: 'number' },
        { key: 'injectRecent', label: '每次触发注入最近对话条数', kind: 'number' },
        { key: 'injectMaxChars', label: '记忆注入字符上限', kind: 'number' },
        { key: 'warmupStaleMinutes', label: '预热新鲜度：最新一条超过多少分钟视为过期', kind: 'number' },
        { key: 'archiveEvery', label: '归档节奏：攒够多少条消息蒸馏一次摘要/人物卡（0=关闭）', kind: 'number' },
        { key: 'archiveIdleMinutes', label: '群空闲多少分钟后起一轮独立归档（分钟）', kind: 'number' },
        { key: 'archiveEventDays', label: '事件类记忆保留天数（到期自动淡出）', kind: 'number' },
        { key: 'peopleLimit', label: '人物表上限（0=不限制）', kind: 'number' },
        { key: 'warmupImages', label: '预热时也缓存历史图片（file id 失效则标记已过期）', kind: 'boolean' },
        { key: 'warmupImageLimit', label: '单次预热最多下载几张历史图片（默认 30）', kind: 'number' },
        { key: 'proactiveEnabled', label: '主动发言（伪人模式）：群里有话题时自己插话', kind: 'boolean' },
        { key: 'proactiveRatePerHour', label: '主动发言频率 λ（次/小时，0=改用固定概率）', kind: 'number' },
        { key: 'proactiveChance', label: '固定概率模式的插话概率（0~1）', kind: 'number' },
        { key: 'proactiveCooldownMinutes', label: '两次主动发言最小间隔（分钟）', kind: 'number' },
        { key: 'proactiveMaxPerHour', label: '每小时最多主动发言次数', kind: 'number' },
        { key: 'proactiveQuietHours', label: '主动发言静默时段（如 00:00-08:00,12:00-13:00）', kind: 'text' },
        { key: 'proactiveMinMessages', label: '窗口内至少多少条他人消息才考虑插话', kind: 'number' },
        { key: 'proactiveWindowMinutes', label: '观察窗口（分钟）', kind: 'number' },
        { key: 'imageCache', label: '群聊图片缓存（存表情包/分享图，便于以后回看）', kind: 'select', options: [['off', 'off：只存叫到机器人时的图'], ['all', 'all：群里的图也存（带配额）']] },
        { key: 'imageCacheMaxBytes', label: '单张图片缓存上限（字节）', kind: 'number' },
        { key: 'imageCacheDailyCap', label: '每个聊天每天最多缓存张数', kind: 'number' },
        { key: 'imageCacheRetentionDays', label: '图片缓存保留天数（超期清理）', kind: 'number' },
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
          FIELDS.map((field) => renderField(field, draft[field.key], (key, value) => {
            setDraft((previous) => {
              const nextDraft = Object.assign({}, previous)
              nextDraft[key] = value
              return nextDraft
            })
          })),
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
