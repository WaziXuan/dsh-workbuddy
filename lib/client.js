window.__ModuleLoader__.load({
  id: 'dsh-workbuddy',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const inject = ['slots']

    const styles = {
      launcher: {
        position: 'fixed',
        right: 18,
        bottom: 96,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 12px',
        borderRadius: 999,
        border: '1px solid rgba(0,0,0,0.10)',
        background: '#111827',
        color: '#f9fafb',
        font: '12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif',
        boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
        cursor: 'pointer',
        pointerEvents: 'auto',
      },
      backdrop: {
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'rgba(15,23,42,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        pointerEvents: 'auto',
      },
      card: {
        width: 'min(720px, 100%)',
        maxHeight: 'min(84vh, 780px)',
        overflow: 'auto',
        borderRadius: 16,
        background: '#ffffff',
        color: '#111827',
        boxShadow: '0 24px 60px rgba(15,23,42,0.28)',
        font: '13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '16px 18px 10px',
        borderBottom: '1px solid #eef0f3',
      },
      title: { fontWeight: 600, fontSize: 15 },
      sub: { color: '#6b7280', fontSize: 12, marginTop: 2 },
      body: { padding: '14px 18px 18px' },
      textarea: {
        width: '100%',
        minHeight: 118,
        resize: 'vertical',
        boxSizing: 'border-box',
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid #d8dce3',
        font: '12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace',
        background: '#fbfcfd',
        color: '#111827',
        outline: 'none',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 },
      button: {
        padding: '7px 13px',
        borderRadius: 9,
        border: '1px solid #d8dce3',
        background: '#ffffff',
        color: '#111827',
        font: '12px/1.2 inherit',
        cursor: 'pointer',
      },
      primary: {
        padding: '7px 14px',
        borderRadius: 9,
        border: '1px solid #111827',
        background: '#111827',
        color: '#ffffff',
        font: '12px/1.2 inherit',
        cursor: 'pointer',
      },
      ghost: {
        padding: '4px 9px',
        borderRadius: 8,
        border: '1px solid #e2e5ea',
        background: '#ffffff',
        color: '#374151',
        font: '11px/1.2 inherit',
        cursor: 'pointer',
      },
      list: { marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 },
      item: {
        border: '1px solid #eef0f3',
        borderRadius: 12,
        padding: '10px 12px',
        display: 'flex',
        justifyContent: 'space-between',
        gap: 10,
        alignItems: 'flex-start',
      },
      mono: { font: '11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace', color: '#6b7280' },
      badgeOk: { color: '#047857', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 999, padding: '1px 8px', fontSize: 11 },
      badgeBad: { color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 999, padding: '1px 8px', fontSize: 11 },
      hint: { marginTop: 10, color: '#6b7280', fontSize: 12 },
      log: {
        marginTop: 12,
        padding: '8px 10px',
        borderRadius: 10,
        background: '#f8fafc',
        border: '1px solid #eef0f3',
        font: '12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 168,
        overflow: 'auto',
      },
      link: { color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' },
      bar: {
        marginTop: 5,
        height: 5,
        borderRadius: 999,
        background: '#eef0f3',
        overflow: 'hidden',
        maxWidth: 260,
      },
      barFill: { height: '100%', borderRadius: 999, transition: 'width .25s ease' },
      plan: {
        color: '#4b5563',
        background: '#f3f4f6',
        border: '1px solid #e5e7eb',
        borderRadius: 999,
        padding: '0 7px',
        fontSize: 11,
      },
      badgePool: {
        color: '#1d4ed8',
        background: '#eff6ff',
        border: '1px solid #bfdbfe',
        borderRadius: 999,
        padding: '1px 7px',
        fontSize: 11,
      },
      badgeFriendly: {
        color: '#047857',
        background: '#ecfdf5',
        border: '1px solid #a7f3d0',
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11,
      },
      modelBox: {
        marginTop: 8,
        padding: '8px 10px',
        borderRadius: 10,
        background: '#fbfcfd',
        border: '1px solid #eef0f3',
      },
      modelGrid: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        maxHeight: 176,
        overflow: 'auto',
      },
      chipFriendly: {
        color: '#065f46',
        background: '#ecfdf5',
        border: '1px solid #a7f3d0',
        borderRadius: 8,
        padding: '2px 7px',
        fontSize: 11,
        cursor: 'default',
      },
      chipThinking: {
        color: '#6b7280',
        background: '#f9fafb',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: '2px 7px',
        fontSize: 11,
        cursor: 'default',
      },
    }

    function formatCredits(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—'
    }

    function BalanceLine({ balance }) {
      if (!balance) {
        return h('div', { style: { ...styles.mono, marginTop: 6 } }, '余额：未知，点「刷新余额」查询')
      }
      if (balance.ok !== true) {
        return h('div', { style: { ...styles.mono, marginTop: 6, color: '#b91c1c' } }, `余额：${balance.message || `查询失败（${balance.status || '无响应'}）`}`)
      }
      const total = balance.total || 0
      const remain = balance.remain || 0
      const ratio = total > 0 ? Math.max(0, Math.min(1, remain / total)) : 0
      const low = total > 0 && ratio < 0.1
      return h(
        'div',
        { style: { marginTop: 7 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: low ? '#b91c1c' : '#047857' } }, `剩余 ${formatCredits(remain)}`),
          h('span', { style: styles.mono }, `/ ${formatCredits(total)} 积分`),
          balance.plan ? h('span', { style: styles.plan }, balance.plan) : null,
          balance.used > 0 ? h('span', { style: styles.mono }, `已用 ${formatCredits(balance.used)}`) : null,
        ),
        h('div', { style: styles.bar }, h('div', { style: { ...styles.barFill, width: `${Math.round(ratio * 100)}%`, background: low ? '#dc2626' : '#10b981' } })),
        Array.isArray(balance.groups) && balance.groups.length > 0
          ? h('div', { style: { ...styles.mono, marginTop: 3 } }, balance.groups.map((group) => `${group.name} ${formatCredits(group.remain)}/${formatCredits(group.total)}`).join(' · '))
          : null,
      )
    }

    const EXAMPLE = [
      '{',
      '  "accessToken": "eyJhbGciOiJSUzI1NiIs…",',
      '  "uid": "7f773d8a-d7a0-438a-b403-8aafa4d4b7c7",',
      '  "product": "personal",',
      '  "name": "Felix"',
      '}',
    ].join('\n')

    let panelTokenPromise = null
    async function panelToken() {
      if (panelTokenPromise === null) {
        panelTokenPromise = fetch('/workbuddy/session', {
          headers: { 'x-dsh-workbuddy-panel': '1' },
          credentials: 'same-origin',
        }).then(async (response) => {
          const payload = await response.json()
          if (!response.ok || typeof payload.token !== 'string') throw new Error(payload.error || '无法获取本地面板 key')
          return payload.token
        }).catch((error) => {
          panelTokenPromise = null
          throw error
        })
      }
      return panelTokenPromise
    }

    async function call(pathname, init) {
      let token = await panelToken()
      const send = () => fetch(pathname, {
        ...init,
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(init && init.headers),
        },
      })
      let response = await send()
      if (response.status === 401) {
        // 插件热重载后 key 可能轮换，清缓存重取一次。
        panelTokenPromise = null
        token = await panelToken()
        response = await send()
      }
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { ok: false, error: text.slice(0, 300) }
      }
      if (!response.ok && payload.ok !== false) payload.ok = false
      return payload
    }

    function Panel() {
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [log, setLog] = React.useState('')
      const [expanded, setExpanded] = React.useState({})

      const refresh = React.useCallback(async () => {
        try {
          const payload = await call('/workbuddy/state')
          setState(payload)
        } catch (error) {
          setLog(`读取状态失败：${error && error.message ? error.message : error}`)
        }
      }, [])

      React.useEffect(() => {
        if (open && state === null) refresh()
      }, [open, state, refresh])

      // 打开面板时，若还有账号没有余额，自动拉一次（一个请求覆盖全部账号）。
      const autoBalanceTried = React.useRef(false)
      React.useEffect(() => {
        if (!open || state === null || autoBalanceTried.current) return
        const accountsNow = state.accounts || []
        if (accountsNow.length === 0) return
        if (accountsNow.every((account) => account.balance !== null && account.balance !== undefined)) return
        autoBalanceTried.current = true
        ;(async () => {
          try {
            const payload = await call('/workbuddy/balance', { method: 'POST', body: '{}' })
            if (payload.state) setState(payload.state)
          } catch {
            // 自动刷新失败不打扰用户，手动点按钮再看原因
          }
        })()
      }, [open, state])

      const run = async (label, pathname, body) => {
        setBusy(label)
        setLog(`$ ${label} …`)
        try {
          const payload = await call(pathname, { method: 'POST', body: JSON.stringify(body || {}) })
          if (payload.state) setState(payload.state)
          setLog(formatResult(label, payload))
          // 只有导入且全部成功才清空草稿；测试/余额/部分失败不能吃掉用户还没导入的文本。
          if (pathname === '/workbuddy/import' && payload.ok && Array.isArray(payload.results)
            && payload.results.length > 0 && payload.results.every((item) => item.ok)) setText('')
        } catch (error) {
          setLog(`$ ${label} 失败：${error && error.message ? error.message : error}`)
        } finally {
          setBusy('')
        }
      }

      const formatResult = (label, payload) => {
        const lines = [`$ ${label}`]
        if (Array.isArray(payload.results)) {
          for (const item of payload.results) {
            if (!item.ok) {
              lines.push(`  ✗ ${item.name} — ${item.error || item.balance?.message || '失败'}`)
              continue
            }
            const parts = []
            if (typeof item.models === 'number') parts.push(`${item.models} 个模型`)
            const balance = item.balance
            if (balance && balance.ok === true) {
              parts.push(`余额 ${formatCredits(balance.remain)}/${formatCredits(balance.total)}${balance.plan ? ` · ${balance.plan}` : ''}`)
            } else if (balance && balance.ok === false) {
              parts.push(`余额查询失败`)
            }
            lines.push(`  ✓ ${item.name}${parts.length > 0 ? ` → ${parts.join('，')}` : ''}`)
          }
        }
        if (payload.result) {
          const prefix = payload.result.ok ? '  ✓' : '  ✗'
          lines.push(`${prefix} ${payload.result.message || payload.result.status}`)
          if (payload.result.snippet) lines.push(`    ${payload.result.snippet}`)
        }
        if (payload.error) lines.push(`  ✗ ${payload.error}`)
        if (payload.applyError) lines.push(`  ✗ 应用失败：${payload.applyError}`)
        if (!payload.ok && !payload.error && !payload.applyError && lines.length === 1) lines.push('  （没有结果）')
        return lines.join('\n')
      }

      // 池子每个账号的承接情况（命中次数 / 冷却）挂到账号行上
      const poolMembers = new Map(
        (((state && state.pool && state.pool.detail && state.pool.detail.members) || [])).map((member) => [member.route, member]),
      )
      const accounts = ((state && state.accounts) || []).map((account) => ({
        ...account,
        poolStats: poolMembers.get(account.route) ?? null,
      }))
      const catalog = state && state.catalog

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            style: styles.launcher,
            title: 'WorkBuddy 账号 → 模型提供商',
            onClick: () => {
              setOpen(true)
              refresh()
            },
          },
          h('span', { style: { fontSize: 13 } }, 'WB'),
          h('span', null, '导入 WorkBuddy 账号'),
        ),
        open
          ? h(
              'div',
              {
                style: styles.backdrop,
                onClick: (event) => {
                  if (event.target === event.currentTarget) setOpen(false)
                },
              },
              h(
                'div',
                { style: styles.card },
                h(
                  'div',
                  { style: styles.header },
                  h(
                    'div',
                    null,
                    h('div', { style: styles.title }, 'WorkBuddy 账号池'),
                    h(
                      'div',
                      { style: styles.sub },
                      state && state.pool
                        ? `一家提供商「${state.pool.displayName}」· 池内 ${state.pool.accounts} 个账号 · ${state.pool.models} 个模型${catalog && catalog.source === 'local' ? '（本机目录）' : ''}`
                        : catalog
                          ? `${catalog.count} 个模型（${catalog.source === 'local' ? '本机目录' : '内置目录'}）`
                          : '读取中…',
                    ),
                  ),
                  h('button', { type: 'button', style: styles.ghost, onClick: () => setOpen(false) }, '关闭'),
                ),
                h(
                  'div',
                  { style: styles.body },
                  h('textarea', {
                    style: styles.textarea,
                    value: text,
                    placeholder: EXAMPLE,
                    spellCheck: false,
                    onChange: (event) => setText(event.target.value),
                  }),
                  h(
                    'div',
                    { style: styles.row },
                    h(
                      'button',
                      {
                        type: 'button',
                        style: styles.primary,
                        disabled: busy !== '' || text.trim() === '',
                        onClick: () => run('导入并应用', '/workbuddy/import', { text, test: true }),
                      },
                      busy === '导入并应用' ? '导入中…' : '导入并应用',
                    ),
                    h(
                      'button',
                      { type: 'button', style: styles.button, disabled: busy !== '', onClick: () => run('全部重新应用', '/workbuddy/apply', {}) },
                      busy === '全部重新应用' ? '应用中…' : '全部重新应用',
                    ),
                    h('button', { type: 'button', style: styles.button, disabled: busy !== '', onClick: refresh }, '刷新'),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: styles.button,
                        disabled: busy !== '' || accounts.length === 0,
                        onClick: () => run('刷新余额', '/workbuddy/balance', {}),
                      },
                      busy === '刷新余额' ? '查询中…' : '刷新余额',
                    ),
                  ),
                  h(
                    'div',
                    { style: styles.hint },
                    '支持一次粘贴多个账号：JSON 数组、多个对象拼接、或 WorkBuddy 的 workbuddy-desktop.info 原文都行。',
                    ' 所有账号共用一家提供商 ',
                    h('b', null, 'WorkBuddy'),
                    '，模型是池内并集，请求按账号轮流转发（失败的账号自动冷却跳过）。',
                  ),
                  h(
                    'div',
                    { style: { ...styles.hint, marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('span', null, '破甲（融合 dsh-purge）：'),
                    state && state.jailbreak
                      ? h(
                          'b',
                          { style: { color: state.jailbreak.enabled ? '#047857' : '#9ca3af' } },
                          state.jailbreak.enabled
                            ? `开 · ${state.jailbreak.mode}${state.jailbreak.userTail ? ' + 尾锚点' : ''}${state.jailbreak.lastAddedTokens ? ` · 上次 +${state.jailbreak.lastAddedTokens} tokens` : ''}`
                            : '关',
                        )
                      : h('span', null, '读取中…'),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: styles.ghost,
                        disabled: busy !== '' || !state || !state.jailbreak,
                        onClick: () =>
                          run(
                            `${state && state.jailbreak && state.jailbreak.enabled ? '关闭' : '开启'}破甲`,
                            '/workbuddy/jailbreak',
                            { enabled: !(state && state.jailbreak && state.jailbreak.enabled) },
                          ),
                      },
                      state && state.jailbreak && state.jailbreak.enabled ? '关闭' : '开启',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: styles.ghost,
                        disabled: busy !== '' || !state || !state.jailbreak,
                        onClick: () =>
                          run('切换注入强度', '/workbuddy/jailbreak', {
                            mode: (state && state.jailbreak && state.jailbreak.mode) === 'auto' ? 'always' : 'auto',
                          }),
                      },
                      state && state.jailbreak && state.jailbreak.mode === 'always' ? '改回 auto' : '强制全文注入',
                    ),
                  ),
                  accounts.length > 0
                    ? h(
                        'div',
                        { style: styles.list },
                        accounts.map((account) =>
                          h(
                            'div',
                            { key: account.route, style: styles.item },
                            h(
                              'div',
                              { style: { minWidth: 0 } },
                              h(
                                'div',
                                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                                h('b', null, account.name),
                                h('span', { style: styles.badgePool }, '池内'),
                                account.credentialMissing
                                  ? h('span', { style: styles.badgeBad }, '凭据缺失')
                                  : null,
                                account.baseURLAllowed === false
                                  ? h('span', { style: styles.badgeBad }, 'baseURL 被拒绝')
                                  : null,
                                h('span', { style: styles.mono }, `${account.modelCount} 个模型`),
                                account.friendlyCount > 0
                                  ? h('span', { style: styles.badgeFriendly }, `✅ 破甲友好 ${account.friendlyCount}`)
                                  : null,
                                account.poolStats && account.poolStats.hits > 0
                                  ? h('span', { style: styles.mono }, `已用 ${account.poolStats.hits} 次${account.poolStats.cooling ? ' · 冷却中' : ''}`)
                                  : null,
                                account.lastTest
                                  ? h('span', { style: account.lastTest.ok ? styles.badgeOk : styles.badgeBad }, account.lastTest.ok ? '可用' : `失败 ${account.lastTest.status || ''}`)
                                  : null,
                              ),
                              h(
                                'div',
                                { style: styles.mono },
                                `token ${account.token} · uid ${account.uid || '—'} · ${account.product || '—'}`,
                              ),
                              account.lastTest && account.lastTest.message
                                ? h('div', { style: { ...styles.mono, color: account.lastTest.ok ? '#047857' : '#b91c1c' } }, account.lastTest.message)
                                : null,
                              h(BalanceLine, { balance: account.balance }),
                              expanded[account.route]
                                ? h(
                                    'div',
                                    { style: styles.modelBox },
                                    h(
                                      'div',
                                      { style: { ...styles.mono, marginBottom: 6 } },
                                      '✅ 破甲友好（可关思考）· 🤔 必思考（思考阶段更容易自我审视，硬拒时优先换 ✅）',
                                    ),
                                    h(
                                      'div',
                                      { style: styles.modelGrid },
                                      (account.models || []).map((model) =>
                                        h(
                                          'span',
                                          {
                                            key: model.id,
                                            style: model.friendly ? styles.chipFriendly : styles.chipThinking,
                                            title: `${model.id}${model.credits ? ` · ${model.credits}` : ''}`,
                                          },
                                          `${model.friendly ? '✅' : '🤔'} ${model.name}`,
                                        ),
                                      ),
                                    ),
                                  )
                                : null,
                            ),
                            h(
                              'div',
                              { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  style: styles.ghost,
                                  onClick: () => setExpanded((prev) => ({ ...prev, [account.route]: !prev[account.route] })),
                                },
                                expanded[account.route] ? '收起模型' : '模型',
                              ),
                              h(
                                'button',
                                { type: 'button', style: styles.ghost, disabled: busy !== '', onClick: () => run(`测试 ${account.name}`, '/workbuddy/test', { route: account.route }) },
                                '测试',
                              ),
                              h(
                                'button',
                                { type: 'button', style: styles.ghost, disabled: busy !== '', onClick: () => run(`余额 ${account.name}`, '/workbuddy/balance', { route: account.route }) },
                                '余额',
                              ),
                              h(
                                'button',
                                { type: 'button', style: styles.ghost, disabled: busy !== '', onClick: () => run(`删除 ${account.name}`, '/workbuddy/remove', { route: account.route }) },
                                '删除',
                              ),
                            ),
                          ),
                        ),
                      )
                    : h('div', { style: styles.hint }, '还没有账号。粘贴 JSON 后点「导入并应用」。'),
                  log !== '' ? h('div', { style: styles.log }, log) : null,
                  state && state.guard
                    ? h(
                        'div',
                        { style: styles.hint },
                        `渠道守卫：${state.guard.rewrites > 0 ? `已改写 ${state.guard.rewrites} 次请求（${(state.guard.lastHits || []).join(', ')}）` : '已就绪，尚未触发'} · 拦截 WorkBuddy 的 11128 校验`,
                      )
                    : null,
                  state && state.serviceReady === false
                    ? h('div', { style: { ...styles.hint, color: '#b45309' } }, 'settings / credentials 服务还没就绪：等 DSH 启动完成后再试。')
                    : null,
                ),
              ),
            )
          : null,
      )
    }

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-workbuddy-panel', order: 55 }, Panel),
      )
    }

    const module = { exports: {} }
    module.exports = { name: 'dsh-workbuddy', inject, apply }
    return module.exports
  },
})
