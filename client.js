// dsh-shared-bash — 浏览器半边：在设置里给共享 bash 会话一个管理页面。
//
// 这个文件是手写的模块工厂（与编译产物的形式一致）：外壳在启动时只注册工厂，
// 首次使用时才执行模块体。它不依赖构建步骤，也不需要 @deepseek-ai/* 的运行时包：
// React 与槽位服务都由外壳提供。

window.__ModuleLoader__.load({
  id: 'dsh-shared-bash',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // 与 src/web.js 的 API_PREFIX 对应；用 document.baseURI 解析，桌面端把页面
    // 挂在 dsh-app:// 下时也能落到同一个同源前缀。
    const API = (() => {
      try { return new URL('api/shared-bash', document.baseURI).pathname } catch { return '/api/shared-bash' }
    })()

    const ZH = String((typeof navigator === 'object' && navigator.language) || '').toLowerCase().startsWith('zh')
    const TEXT = {
      nav: ZH ? 'Bash 终端' : 'Bash terminals',
      intro: ZH
        ? '每个 DSH 会话在这里有一个长驻 PTY 终端，用会话 id 寻址：可以接入之前会话留下的那个 shell，命令、退出码与 cwd 都保留在里面。命令是异步的——发送后拿到 job，结果在后面收取。'
        : 'Every DSH session gets a long-lived PTY terminal here, addressed by session id: you can attach to the shell an earlier session left behind, with its commands, exit codes and cwd intact. Commands run as jobs — sending one returns a handle, and the result comes later.',
      refresh: ZH ? '刷新' : 'Refresh',
      auto: ZH ? '自动刷新' : 'Auto refresh',
      sessions: ZH ? '终端' : 'Terminals',
      empty: ZH ? '还没有终端。按会话 id 接入，或让 agent 直接调用 bash_exec（会自动开一个）。' : 'No terminals yet. Attach by session id, or let an agent call bash_exec, which opens one on demand.',
      name: ZH ? '会话 id' : 'Session id',
      status: ZH ? '状态' : 'Status',
      cwd: ZH ? '目录' : 'Directory',
      commands: ZH ? '命令数' : 'Commands',
      activity: ZH ? '最近活动' : 'Last activity',
      actions: ZH ? '操作' : 'Actions',
      interrupt: ZH ? '中断' : 'Interrupt',
      close: ZH ? '关闭' : 'Close',
      closeAll: ZH ? '关闭全部' : 'Close all',
      confirmCloseAll: ZH ? '关闭全部终端？正在跑的命令会被终止。' : 'Close every terminal? Running commands are terminated.',
      busy: ZH ? '运行中' : 'busy',
      idle: ZH ? '空闲' : 'idle',
      output: ZH ? '输出' : 'Output',
      outputHint: ZH ? '只显示最近保留的 4000 行。' : 'Only the retained lines (4000 max) are kept.',
      noOutput: ZH ? '没有输出。' : 'No output.',
      send: ZH ? '执行' : 'Run',
      commandPlaceholder: ZH ? '在这个会话的终端里执行一条命令…' : 'Run a command in this session\'s terminal…',
      open: ZH ? '按会话接入' : 'Attach by session',
      openName: ZH ? 'DSH 会话 id（UUID）' : 'DSH session id (UUID)',
      openCwd: ZH ? '目录（可选，例如 /tmp 或 C:\\proj）' : 'Directory (optional, e.g. /tmp or C:\\proj)',
      create: ZH ? '接入' : 'Attach',
      loading: ZH ? '加载中…' : 'Loading…',
      failed: ZH ? '无法连接插件后端' : 'Cannot reach the plugin backend',
      retry: ZH ? '重试' : 'Retry',
      footer: ZH
        ? '真 PTY：交互式 shell 与 Ctrl-C 语义都在，中断发的是 SIGINT。命令按 job 异步结算，关闭终端等于丢掉那个 shell。'
        : 'Real PTY: interactive shells and Ctrl-C semantics work, and Interrupt sends a real SIGINT. Commands settle asynchronously as jobs; closing a terminal discards that shell.',
    }
    const t = key => TEXT[key] ?? key

    async function api(path, options) {
      const { timeout = 10000, ...rest } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(API + path, {
          ...rest,
          redirect: 'error',
          signal: controller.signal,
          headers: rest.body === undefined ? rest.headers : { 'content-type': 'application/json', ...rest.headers },
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
          const error = new Error(payload.error ?? `HTTP ${response.status}`)
          error.code = payload.code
          throw error
        }
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0 24px' },
      intro: { margin: 0, fontSize: '13px', lineHeight: 1.6, opacity: 0.75 },
      bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
      button: {
        font: 'inherit', fontSize: '12px', padding: '4px 10px', cursor: 'pointer',
        borderRadius: '6px', border: '1px solid rgba(127,127,127,.4)', background: 'transparent', color: 'inherit',
      },
      danger: { borderColor: 'rgba(220,80,80,.55)', color: 'rgb(200,70,70)' },
      input: {
        font: 'inherit', fontSize: '12px', padding: '4px 8px', minWidth: '160px',
        borderRadius: '6px', border: '1px solid rgba(127,127,127,.4)', background: 'transparent', color: 'inherit',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: { textAlign: 'left', fontWeight: 600, padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,.3)', opacity: 0.7 },
      td: { padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,.14)', verticalAlign: 'top' },
      rowActive: { background: 'rgba(120,160,255,.12)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
      terminal: {
        margin: 0, padding: '10px', minHeight: '120px', maxHeight: '320px', overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px', lineHeight: 1.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        border: '1px solid rgba(127,127,127,.3)', borderRadius: '8px', background: 'rgba(127,127,127,.07)',
      },
      tag: { fontSize: '11px', padding: '1px 6px', borderRadius: '999px', border: '1px solid rgba(127,127,127,.4)' },
      error: { fontSize: '12px', color: 'rgb(200,70,70)' },
      hint: { fontSize: '12px', opacity: 0.6 },
      h2: { margin: '0 0 6px', fontSize: '13px', fontWeight: 600 },
    }

    const time = value => {
      const stamp = typeof value === 'string' ? Date.parse(value) : Number(value)
      if (!Number.isFinite(stamp)) return ''
      return new Date(stamp).toLocaleTimeString()
    }

    function SharedBashPage() {
      const [sessions, setSessions] = useState([])
      const [selected, setSelected] = useState('')
      const [output, setOutput] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [auto, setAuto] = useState(true)
      const [command, setCommand] = useState('')
      const [draftName, setDraftName] = useState('')
      const [draftCwd, setDraftCwd] = useState('')
      const [sending, setSending] = useState(false)
      const outputRef = useRef(null)

      const loadSessions = useCallback(async () => {
        const payload = await api('/sessions')
        const list = Array.isArray(payload.sessions) ? payload.sessions : []
        setSessions(list)
        setError('')
        setSelected(current => {
          if (current !== '' && list.some(item => item.session_id === current)) return current
          return list.length > 0 ? list[0].session_id : ''
        })
      }, [])

      const loadOutput = useCallback(async name => {
        if (name === '') { setOutput(''); return }
        const payload = await api(`/output?session_id=${encodeURIComponent(name)}&lines=400`)
        setOutput(typeof payload.text === 'string' ? payload.text : '')
      }, [])

      useEffect(() => {
        let alive = true
        void (async () => {
          setBusy(true)
          try {
            await loadSessions()
          } catch (failure) {
            if (alive) setError(failure.message || t('failed'))
          } finally {
            if (alive) setBusy(false)
          }
        })()
        return () => { alive = false }
      }, [loadSessions])

      useEffect(() => {
        let alive = true
        void (async () => {
          try { await loadOutput(selected) } catch { /* the session may be closing */ }
        })()
        return () => { alive = false }
      }, [selected, loadOutput])

      useEffect(() => {
        if (!auto) return undefined
        const timer = setInterval(() => {
          void loadSessions().catch(() => {})
          if (selected !== '') void loadOutput(selected).catch(() => {})
        }, 2500)
        return () => clearInterval(timer)
      }, [auto, selected, loadSessions, loadOutput])

      useEffect(() => {
        const node = outputRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [output])

      const act = useCallback(async (path, body) => {
        setSending(true)
        setError('')
        try {
          await api(path, { method: 'POST', body: JSON.stringify(body) })
          await loadSessions()
          await loadOutput(selected)
        } catch (failure) {
          setError(failure.message || t('failed'))
        } finally {
          setSending(false)
        }
      }, [loadSessions, loadOutput, selected])

      const send = useCallback(async () => {
        const text = command.trim()
        if (text === '' || selected === '') return
        setSending(true)
        setError('')
        try {
          const started = await api('/exec', {
            method: 'POST',
            body: JSON.stringify({ session_id: selected, command: text }),
          })
          setCommand('')
          // Async on purpose: the page collects the job instead of holding the
          // request open, so a long build cannot time out the browser call.
          await api(`/wait?job_id=${encodeURIComponent(started.job_id)}&timeout_ms=300000`, { timeout: 310000 })
            .catch(() => {})
          await loadSessions()
          await loadOutput(selected)
        } catch (failure) {
          setError(failure.message || t('failed'))
        } finally {
          setSending(false)
        }
      }, [command, selected, loadSessions, loadOutput])

      const current = useMemo(() => sessions.find(item => item.session_id === selected), [sessions, selected])

      return h('div', { style: styles.page },
        h('p', { style: styles.intro }, t('intro')),
        h('div', { style: styles.bar },
          h('button', { style: styles.button, onClick: () => { void loadSessions().catch(() => {}) }, disabled: busy }, t('refresh')),
          h('label', { style: { ...styles.hint, display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            h('input', { type: 'checkbox', checked: auto, onChange: event => setAuto(event.target.checked) }),
            t('auto')),
          sessions.length > 0 ? h('button', {
            style: { ...styles.button, ...styles.danger },
            disabled: sending,
            onClick: () => {
              if (!window.confirm(t('confirmCloseAll'))) return
              void act('/close', { all: true })
            },
          }, t('closeAll')) : null,
          h('span', { style: { flex: '1 1 auto' } }),
          error !== '' ? h('span', { style: styles.error }, error) : null,
        ),

        h('div', null,
          h('h2', { style: styles.h2 }, t('sessions')),
          sessions.length === 0
            ? h('p', { style: styles.hint }, busy ? t('loading') : t('empty'))
            : h('table', { style: styles.table },
                h('thead', null, h('tr', null,
                  h('th', { style: styles.th }, t('name')),
                  h('th', { style: styles.th }, t('status')),
                  h('th', { style: styles.th }, t('cwd')),
                  h('th', { style: styles.th }, t('commands')),
                  h('th', { style: styles.th }, t('activity')),
                  h('th', { style: styles.th }, t('actions')),
                )),
                h('tbody', null, sessions.map(item => h('tr', {
                  key: item.session_id,
                  style: item.session_id === selected ? styles.rowActive : undefined,
                  onClick: () => setSelected(item.session_id),
                },
                  h('td', { style: { ...styles.td, ...styles.mono, cursor: 'pointer' } }, item.session_id),
                  h('td', { style: styles.td },
                    h('span', { style: { ...styles.tag, ...styles.mono } }, item.busy ? t('busy') : t('idle'))),
                  h('td', { style: { ...styles.td, ...styles.mono } }, item.cwd ?? ''),
                  h('td', { style: styles.td }, String(item.commands ?? 0)),
                  h('td', { style: styles.td }, time(item.lastActivityAt)),
                  h('td', { style: styles.td },
                    h('div', { style: { display: 'flex', gap: '6px' } },
                      h('button', {
                        style: styles.button,
                        disabled: sending,
                        onClick: event => { event.stopPropagation(); void act('/interrupt', { session_id: item.session_id }) },
                      }, t('interrupt')),
                      h('button', {
                        style: { ...styles.button, ...styles.danger },
                        disabled: sending,
                        onClick: event => {
                          event.stopPropagation()
                          if (item.busy && !window.confirm(t('confirmCloseAll'))) return
                          void act('/close', { session_id: item.session_id })
                        },
                      }, t('close')),
                    )),
                ))),
              )),

        h('div', null,
          h('div', { style: styles.bar },
            h('h2', { style: { ...styles.h2, margin: 0 } }, `${t('output')}${current ? ` · ${current.session_id}` : ''}`),
            h('span', { style: styles.hint }, t('outputHint'))),
          h('pre', { ref: outputRef, style: styles.terminal }, output === '' ? t('noOutput') : output),
          h('div', { style: { ...styles.bar, marginTop: '8px' } },
            h('input', {
              style: { ...styles.input, flex: '1 1 260px' },
              placeholder: t('commandPlaceholder'),
              value: command,
              disabled: selected === '' || sending,
              onChange: event => setCommand(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } },
            }),
            h('button', { style: styles.button, disabled: selected === '' || sending || command.trim() === '', onClick: () => { void send() } }, t('send')),
          ),
        ),

        h('div', null,
          h('h2', { style: styles.h2 }, t('open')),
          h('div', { style: styles.bar },
            h('input', {
              style: styles.input, placeholder: t('openName'), value: draftName,
              onChange: event => setDraftName(event.target.value),
            }),
            h('input', {
              style: { ...styles.input, minWidth: '220px' }, placeholder: t('openCwd'), value: draftCwd,
              onChange: event => setDraftCwd(event.target.value),
            }),
            h('button', {
              style: styles.button,
              disabled: sending || draftName.trim() === '',
              onClick: () => {
                void act('/attach', {
                  session_id: draftName.trim(),
                  cwd: draftCwd.trim() === '' ? undefined : draftCwd.trim(),
                }).then(() => { setDraftName(''); setDraftCwd('') })
              },
            }, t('create')),
          ),
        ),

        h('p', { style: styles.hint }, t('footer')),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'shared-bash',
        order: 36,
        label: () => t('nav'),
      }, () => h(SharedBashPage)))
    }

    exports.name = 'shared-bash'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
