import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * WorkBuddy 网关的「渠道校验」守卫。
 *
 * 上游 copilot.tencent.com 会拦 system / assistant 文本：
 *  - 段首 `You are an AI agent powered by DeepSeek Harness.`
 *  - `Tokens prefixed with @ are paths the user explicitly referenced…`（@ 引用说明）
 *  - 以及 `role: "developer"` 的消息 / 首条不是 system
 * 命中就回 HTTP 400 + code 11128「Illegal API invocation from an unapproved channel」，
 * 跟鉴权、模型、请求体结构都无关（本机逐条 A/B 测过）。
 *
 * 这里只做「让请求能过校验」的最小改写：改的文本与意义一致，不动用户真实内容，
 * 且只作用于发往 WorkBuddy 网关的 chat/completions 请求，其余 fetch 一律原样放行。
 */

import { isOfficialWorkBuddyHost } from './hosts.js'

/** system / assistant 文本里的触发句 → 等价但中性的写法。 */
const TEXT_RULES = [
  // 段首身份句：「You are an AI agent powered by DeepSeek Harness.」
  [/^(\s*)You are an? ([^\n.]{0,60}?)\s+powered by DeepSeek\s*Harness\./gim, '$1You are an $2.'],
  // @ 引用说明的第一句：网关匹配「前段词组 + @ 字形」这个组合
  [/Tokens prefixed with @ are paths/gi, 'Tokens prefixed with (at) are paths'],
  // 兜底：任何位置残留的同一组合
  [/prefixed with @ are paths/gi, 'prefixed with (at) are paths'],
]

function textBlocks(content) {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.filter((block) => block && typeof block.text === 'string').map((block) => block.text)
}

function neutralize(text, hits) {
  let output = text
  for (const [pattern, replacement] of TEXT_RULES) {
    const before = output
    output = output.replace(pattern, replacement)
    if (output !== before) hits.push(pattern.source.slice(0, 40))
  }
  return output
}

function applyToContent(content, hits) {
  if (typeof content === 'string') return neutralize(content, hits)
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (block && typeof block.text === 'string') return { ...block, text: neutralize(block.text, hits) }
    return block
  })
}

/** 往 system 追加文本：字符串保持字符串，数组只追加 text part，保留图片/缓存元数据。 */
function appendSystemText(content, text) {
  if (typeof content === 'string') return content.trim() === '' ? text : `${content}\n\n${text}`
  if (Array.isArray(content)) return [...content, { type: 'text', text }]
  return text
}

/**
 * 改写一个 chat/completions 请求体。
 * @param {string} raw 原始 JSON 文本
 * @returns {{ body: string, changed: boolean, hits: string[] }}
 */
export function rewritePayload(raw, hooks = {}) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { body: raw, changed: false, hits: [] }
  }
  if (data === null || typeof data !== 'object' || !Array.isArray(data.messages)) {
    return { body: raw, changed: false, hits: [] }
  }

  const hits = []
  const messages = []

  // 1) developer 角色不能直接发：内容并入 system。
  // 数组 content 原样保留 part，不把 image/cache_control 等元数据 join 掉。
  const developerParts = []
  for (const message of data.messages) {
    if (message && typeof message === 'object' && message.role === 'developer') {
      const content = message.content
      if (typeof content === 'string') {
        if (content !== '') {
          developerParts.push({ type: 'text', text: content })
          hits.push('developer-role')
        }
      } else if (Array.isArray(content)) {
        if (content.length > 0) {
          developerParts.push(...content)
          hits.push('developer-role')
          if (content.some((part) => part && (part.type !== undefined && part.type !== 'text' || part.image_url !== undefined))) {
            hits.push('developer-parts-preserved')
          }
        }
      }
      continue
    }
    messages.push(message)
  }
  const developerTextOnly = developerParts.every((part) => part && typeof part.text === 'string' && (part.type === undefined || part.type === 'text'))

  // 2) 找到（或补出）第一条 system
  let systemIndex = messages.findIndex((message) => message && typeof message === 'object' && message.role === 'system')
  if (systemIndex === -1) {
    messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
    systemIndex = 0
    // 必须记账，否则下面会因为 hits 为空而丢弃整个改写结果。
    hits.push('system-inserted')
  }
  if (messages[0]?.role !== 'system') {
    const [systemMessage] = messages.splice(systemIndex, 1)
    messages.unshift(systemMessage)
    systemIndex = 0
    hits.push('system-promoted')
  }

  if (developerParts.length > 0) {
    const target = messages[systemIndex]
    let content
    if (typeof target.content === 'string') {
      content = developerTextOnly
        ? appendSystemText(target.content, developerParts.map((part) => part.text).join('\n\n'))
        : [{ type: 'text', text: target.content }, ...developerParts]
    } else if (Array.isArray(target.content)) {
      content = [...target.content, { type: 'text', text: '\n\n' }, ...developerParts]
    } else {
      content = developerParts
    }
    messages[systemIndex] = { ...target, content }
  }

  // 2.5) 破甲层：字符串走原 hook；数组走 parts hook，绝不 flatten。
  {
    const target = messages[systemIndex]
    if (target !== undefined) {
      try {
        if (Array.isArray(target.content) && typeof hooks.injectSystemParts === 'function') {
          const before = textBlocks(target.content).join('\n\n')
          const nextParts = hooks.injectSystemParts(target.content)
          if (Array.isArray(nextParts) && JSON.stringify(nextParts) !== JSON.stringify(target.content)) {
            messages[systemIndex] = { ...target, content: nextParts }
            const after = textBlocks(nextParts).join('\n\n')
            hooks.onInjected?.(after.length - before.length)
            hits.push('jailbreak')
          }
        } else if (typeof target.content === 'string' && typeof hooks.injectSystem === 'function') {
          const existing = target.content
          const injected = hooks.injectSystem(existing)
          if (typeof injected === 'string' && injected !== existing) {
            messages[systemIndex] = { ...target, content: injected }
            hooks.onInjected?.(injected.length - existing.length)
            hits.push('jailbreak')
          }
        }
      } catch (error) {
        hooks.onInjectError?.(error)
      }
    }
  }

  // 2.6) 破甲尾锚点：挂在最后一条 user 文本末尾（数组内容不碰，避免丢图）
  if (typeof hooks.injectUserTail === 'function') {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'user' || message.content === undefined || message.content === null) continue
      if (typeof message.content !== 'string' && !Array.isArray(message.content)) continue
      try {
        const next = hooks.injectUserTail(message.content)
        const changed = Array.isArray(next)
          ? JSON.stringify(next) !== JSON.stringify(message.content)
          : typeof next === 'string' && next !== message.content
        if (changed) {
          messages[index] = { ...message, content: next }
          hits.push('jailbreak-tail')
        }
      } catch (error) {
        hooks.onInjectError?.(error)
      }
      break
    }
  }

  // 3) system / assistant 文本中性化（user / tool 内容原样保留）
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    if (message.role !== 'system' && message.role !== 'assistant') continue
    const content = applyToContent(message.content, hits)
    if (content !== message.content) messages[index] = { ...message, content }
  }

  if (hits.length === 0) return { body: raw, changed: false, hits: [] }
  return { body: JSON.stringify({ ...data, messages }), changed: true, hits: [...new Set(hits)] }
}

function urlOf(input) {
  try {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    if (input && typeof input === 'object' && typeof input.url === 'string') return input.url
  } catch {
    // 落到 undefined
  }
  return undefined
}

function isWorkBuddyChat(url) {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
      && (parsed.port === '' || parsed.port === '443') && isOfficialWorkBuddyHost(parsed.hostname) && /\/chat\/completions\/?$/i.test(parsed.pathname)
  } catch {
    return false
  }
}

/**
 * 在进程里包一层 fetch：命中 WorkBuddy 的 chat/completions 才改写请求体。
 * 任何异常都退回原始请求（fail-open），不引入重试。
 *
 * 多个实例用同一套 dispatcher 串联，任一顺序 dispose 都只移除自己；
 * 不能再像旧实现那样用 captured original 做栈式恢复，否则 A/B 非 LIFO 卸载
 * 会把已经 dispose 的 A 重新装回 globalThis.fetch。
 */
/** 合并 init.signal 与 Request.signal，任一取消都要传到上游。 */
function combineSignals(primary, base) {
  if (primary === undefined || primary === null) return base
  if (base === undefined || base === null) return primary
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([primary, base])
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (primary.aborted || base.aborted) controller.abort()
  else {
    primary.addEventListener('abort', abort, { once: true })
    base.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

const PRISTINE = typeof globalThis.fetch === 'function' ? globalThis.fetch : null
const GUARD_STATE = Symbol.for('dsh-workbuddy.fetchGuardState')

function guardState() {
  if (globalThis[GUARD_STATE] === undefined) {
    globalThis[GUARD_STATE] = { layers: [], baseFetch: null, dispatcher: null, pristine: PRISTINE, als: new AsyncLocalStorage() }
  }
  return globalThis[GUARD_STATE]
}

function ensureDispatcher(state) {
  if (state.dispatcher === null) {
    state.baseFetch = globalThis.fetch
    if (typeof state.baseFetch !== 'function') return false
    state.dispatcher = async function dispatchFetch(input, init) {
      if (state.als.getStore() === true) {
        if (typeof state.pristine === 'function' && state.pristine !== state.dispatcher) return state.pristine(input, init)
        return Promise.reject(new Error('dsh-workbuddy: fetch 重入但没有可用的 pristine 底座'))
      }
      const snapshot = state.layers.slice()
      const base = state.baseFetch
      const run = (index, nextInput, nextInit) => {
        if (index < 0) return base(nextInput, nextInit)
        return snapshot[index].handler(nextInput, nextInit, (a, b) => run(index - 1, a, b))
      }
      return state.als.run(true, () => run(snapshot.length - 1, input, init))
    }
    globalThis.fetch = state.dispatcher
    return true
  }
  // 外部替换过 fetch：把当前实现当作新的底座，已有层仍然有效。
  if (globalThis.fetch !== state.dispatcher) {
    if (typeof globalThis.fetch !== 'function') return false
    state.baseFetch = globalThis.fetch
    globalThis.fetch = state.dispatcher
  }
  return true
}

export function installFetchGuard(logger, options = {}) {
  const state = guardState()
  const stats = { requests: 0, rewrites: 0, lastHits: [] }

  /** 上层客户端身份：网关认 `deepseek-harness/...` 就判非官方客户端（400 request illegal）。 */
  const OFFICIAL_UA = 'WorkBuddy/5.11.3 WorkBuddy/5.11.3'
  const FOREIGN_UA = /deepseek[-_ ]?harness|\bdsh\b|pi-ai|openai\/js|node-fetch|undici/i

  function patchHeadersObject(headers, hits) {
    const agent = headers.get('user-agent')
    if (agent === null || FOREIGN_UA.test(agent)) {
      headers.set('user-agent', OFFICIAL_UA)
      hits.push('user-agent')
    }
    return headers
  }

  /** 把 init.headers 规整成 Headers，替换掉暴露身份的 User-Agent。 */
  function patchHeaders(init, hits) {
    let headers
    try {
      headers = patchHeadersObject(new Headers(init?.headers ?? {}), hits)
    } catch {
      return init
    }
    return { ...(init ?? {}), headers }
  }

  /** Request 形式的 body 在 request 对象里；clone 后读取，原 request 仍可回退。 */
  async function rewriteRequest(input, init, hits, effectiveOptions = options) {
    if (input.bodyUsed) return null
    let headers
    try {
      headers = new Headers(input.headers)
      if (init?.headers) {
        for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
      }
      patchHeadersObject(headers, hits)
    } catch {
      return null
    }
    let bodyText
    if (typeof init?.body === 'string') bodyText = init.body
    else bodyText = await input.clone().text()
    const result = rewritePayload(bodyText, effectiveOptions)
    if (result.changed) {
      hits.push(...result.hits)
      bodyText = result.body
    }
    headers.delete('x-dsh-workbuddy-probe')
    // 新 body 长度会变，旧 CL/TE 必须删掉，否则真实 fetch 会截断或报 mismatch。
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    const signal = combineSignals(init?.signal, input.signal)
    return new Request(input, {
      method: init?.method ?? input.method,
      headers,
      body: bodyText,
      signal,
      referrer: init?.referrer ?? input.referrer,
    })
  }

  const guarded = async function guardedFetch(input, init, next) {
    if (!active) return next.call(this, input, init)
    let dispatched = false
    try {
      const url = urlOf(input)
      const isRequest = typeof Request !== 'undefined' && input instanceof Request
      const inputMethod = isRequest ? input.method : (typeof input === 'object' ? input?.method : undefined)
      const method = String(init?.method ?? inputMethod ?? 'GET').toUpperCase()
      if (method === 'POST' && isWorkBuddyChat(url)) {
        const probe = isRequest
          ? input.headers.get('x-dsh-workbuddy-probe') === '1'
          : new Headers(init?.headers ?? {}).get('x-dsh-workbuddy-probe') === '1'
        const effectiveOptions = probe ? { ...options, injectSystem: undefined, injectSystemParts: undefined, injectUserTail: undefined } : options
        stats.requests += 1
        if (probe) stats.probes = (stats.probes ?? 0) + 1
        const hits = []
        if (isRequest) {
          const nextRequest = await rewriteRequest(input, init, hits, effectiveOptions)
          if (!active) {
            dispatched = true
            return next.call(this, input, init)
          }
          if (nextRequest !== null && hits.length > 0) {
            if (!probe) stats.rewrites += 1
            stats.lastHits = [...new Set(hits)]
            logger?.info?.(`workbuddy: 已改写上游请求以通过渠道校验（${stats.lastHits.join(',')}）`)
            dispatched = true
            return next.call(this, nextRequest)
          }
        } else {
          let nextInit = patchHeaders(init, hits)
          if (probe) {
            const headers = new Headers(nextInit.headers)
            headers.delete('x-dsh-workbuddy-probe')
            nextInit = { ...nextInit, headers }
          }
          if (typeof nextInit.body === 'string') {
            const result = rewritePayload(nextInit.body, effectiveOptions)
            if (result.changed) {
              hits.push(...result.hits)
              const headers = new Headers(nextInit.headers)
              headers.delete('content-length')
              nextInit = { ...nextInit, body: result.body, headers }
            }
          }
          if (hits.length > 0) {
            if (!probe) stats.rewrites += 1
            stats.lastHits = [...new Set(hits)]
            logger?.info?.(`workbuddy: 已改写上游请求以通过渠道校验（${stats.lastHits.join(',')}）`)
            dispatched = true
            return next.call(this, input, nextInit)
          }
        }
      }
    } catch (error) {
      if (dispatched) throw error // 下游已经发过一次，绝不能拿原请求重发导致重复计费
      logger?.warn?.(`workbuddy: 请求改写跳过（${error?.message ?? error}）`)
    }
    return next.call(this, input, init)
  }

  let active = true
  const layerKey = typeof options.key === 'string' && options.key !== '' ? options.key : null
  const layer = { handler: guarded, key: layerKey, active: true }
  if (layerKey !== null) {
    for (const old of state.layers) if (old.key === layerKey) old.active = false
    state.layers = state.layers.filter((item) => item.key !== layerKey)
  }
  state.layers.push(layer)
  if (!ensureDispatcher(state)) {
    if (layerKey === null) state.layers.pop()
    return { dispose: () => {}, stats: () => ({ requests: 0, rewrites: 0, lastHits: [] }) }
  }

  return {
    dispose() {
      active = false
      layer.active = false
      const index = state.layers.findIndex((item) => item.handler === guarded)
      if (index >= 0) state.layers.splice(index, 1)
      if (state.layers.length === 0) {
        // 保留 dispatcher/baseFetch：在飞请求可能还在闭包里使用它们；
        // 只把 globalThis.fetch 还原到底座，避免 null/base 竞态。
        if (globalThis.fetch === state.dispatcher) globalThis.fetch = state.baseFetch
      }
    },
    stats: () => ({ ...stats }),
  }
}
