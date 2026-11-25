/**
 * 账号池：让"一个提供商"服务多个 WorkBuddy 账号。
 *
 * llm-pi-ai 的 provider 是静态的（一个 apiKeyEnv + 一组固定 headers），
 * 所以多账号只能在中间放一层本地转发：
 *
 *   DSH → llm-pi-ai(route=workbuddy) → 127.0.0.1:<port>/v2 → 账号池 → copilot.tencent.com
 *
 * 池子负责：挑账号（轮询 + 冷却）、失败换号重试、把响应原样流式回传。
 * 下游断开时必须把取消信号继续传给上游：生成是上游在推，不主动 abort 的话
 * 它会一直生成到自然结束，并照常计积分。
 * 破甲注入与 11128 改写仍然由 guard 完成 —— 池转发到上游的那一跳会再次经过
 * 被包装的 fetch，所以这两件事不会被绕过。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { isAllowedBaseURL } from './hosts.js'

const CHAT_PATH = '/chat/completions'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const COOLDOWN = { auth: 300_000, rate: 30_000, server: 10_000, network: 30_000, other: 0, block: 60_000 }

/** 网关的「渠道校验」拒绝码：400 + code 11128，跟账号、模型都无关，跟请求内容有关。 */
const CHANNEL_BLOCK = /"code"\s*:\s*11128|Illegal API invocation from an unapproved channel/i

function isChannelBlock(text) {
  return CHANNEL_BLOCK.test(String(text))
}

/** 命中 11128 时留一份现场：只记线索片段，不落整段用户提示词。 */
const SUSPECTS = [
  [/deepseek[-_ ]?harness/gi, 'deepseek-harness'],
  [/\bdsh\b/gi, 'dsh'],
  [/\bpi-ai\b/gi, 'pi-ai'],
  [/powered by/gi, 'powered-by'],
  [/prefixed with @/gi, 'at-path-hint'],
  [/\bopenai\/js\b/gi, 'openai-js'],
  [/\bundici\b/gi, 'undici'],
]

function noteBlocked(member, bodyText, upstreamText) {
  try {
    const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
    const file = path.join(home, 'workbuddy', 'last-blocked.json')
    let parsed = null
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      // 不是 JSON 也照记长度
    }
    const suspicious = []
    for (const [pattern, label] of SUSPECTS) {
      const matcher = new RegExp(pattern.source, pattern.flags)
      let match
      let count = 0
      while ((match = matcher.exec(bodyText)) !== null && count < 2) {
        count += 1
        const from = Math.max(0, match.index - 60)
        suspicious.push({ kind: label, snippet: bodyText.slice(from, match.index + 60) })
        if (match.index === matcher.lastIndex) matcher.lastIndex += 1
      }
    }
    const report = {
      at: Date.now(),
      member: member.name,
      route: member.route,
      status: 400,
      code: 11128,
      model: parsed?.model ?? null,
      bodyBytes: bodyText.length,
      topKeys: parsed === null ? [] : Object.keys(parsed),
      messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : 0,
      roles: Array.isArray(parsed?.messages) ? parsed.messages.map((m) => m?.role).slice(0, 12) : [],
      toolCount: Array.isArray(parsed?.tools) ? parsed.tools.length : 0,
      stream: parsed?.stream === true,
      upstream: String(upstreamText).slice(0, 400),
      suspicious,
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch {
    // 记不下来不影响转发
  }
}

function now() {
  return Date.now()
}

/** 把账号转成池子认识的形态。 */
function toMember(account) {
  return {
    route: account.route,
    name: account.name,
    token: account.token,
    uid: account.uid,
    product: account.product,
    enterpriseId: account.enterpriseId,
    baseURL: account.baseURL,
    modelFilter: Array.isArray(account.modelFilter) ? account.modelFilter.map(String) : null,
  }
}

function upstreamHeaders(member) {
  const headers = {
    authorization: `Bearer ${member.token}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'accept-encoding': 'identity',
  }
  if (member.uid) headers['x-user-id'] = String(member.uid)
  if (member.product) headers['x-product'] = String(member.product)
  if (member.enterpriseId) {
    headers['x-enterprise-id'] = String(member.enterpriseId)
    headers['x-tenant-id'] = String(member.enterpriseId)
  }
  return headers
}

function retryable(status) {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500
}

function cooldownFor(status) {
  if (status === 0) return COOLDOWN.network
  if (status === 401 || status === 403) return COOLDOWN.auth
  if (status === 429) return COOLDOWN.rate
  if (status >= 500) return COOLDOWN.server
  return 0
}

/** 只把明确的模型错误拿去换号，普通 400 仍原样返回，避免掩盖请求体问题。 */
function modelFailure(status, text) {
  if (status !== 400 && status !== 404) return false
  return /model|模型/i.test(text) && /not[._ -]?support|not[._ -]?available|unknown|invalid|not[._ -]?found|permission|forbidden|unauthori[sz]ed|access|无权|权限|不支持|不可用|不存在|未开通/i.test(text)
}

/** response.write 返回 false 时等待 drain；下游先关闭也要解除等待。 */
export function writeWithBackpressure(response, chunk) {
  if (response.write(chunk)) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      response.off('drain', done)
      response.off('close', done)
      resolve()
    }
    response.once('drain', done)
    response.once('close', done)
  })
}

/**
 * 启动账号池。
 * @param {{ getAccounts: () => object[], logger?: object }} options
 * @returns {{ url: string, port: number, stats: () => object, dispose: () => Promise<void>, refresh: () => void }}
 */
export function startPool(options) {
  const logger = options.logger ?? console
  const getAccounts = options.getAccounts
  const authKey = typeof options.authKey === 'string' ? options.authKey : ''
  const validateBaseURL = typeof options.validateBaseURL === 'function' ? options.validateBaseURL : isAllowedBaseURL

  function authorized(request) {
    if (authKey === '') return true // 兼容库的独立使用；插件生产路径始终传入 key
    const raw = request.headers.authorization ?? request.headers['x-api-key'] ?? request.headers['api-key']
    if (typeof raw !== 'string') return false
    const value = raw.startsWith('Bearer ') ? raw.slice(7) : raw
    const supplied = Buffer.from(value)
    const expected = Buffer.from(authKey)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  let members = []
  const health = new Map() // route -> { fail: number, lastStatus: number, cooldownUntil: number, hits: number, lastUsedAt: number }
  let cursor = 0

  function refresh() {
    members = (getAccounts() || [])
      .map(toMember)
      .filter((member) => member.token && validateBaseURL(member.baseURL))
    const alive = new Set(members.map((member) => member.route))
    for (const route of [...health.keys()]) if (!alive.has(route)) health.delete(route)
  }

  function record(route, status) {
    const row = health.get(route) ?? { fail: 0, lastStatus: 0, cooldownUntil: 0, hits: 0, lastUsedAt: 0 }
    row.hits += 1
    row.lastStatus = status
    row.lastUsedAt = now()
    if (status === 0 || retryable(status)) {
      row.fail += 1
      row.cooldownUntil = now() + cooldownFor(status)
    } else if (status >= 200 && status < 300) {
      row.fail = 0
      row.cooldownUntil = 0
    }
    health.set(route, row)
  }

  /** 单独压一个冷却：用于 11128 这种"状态码好着但这次不能用"的情况。 */
  function penalize(route, ms) {
    const row = health.get(route) ?? { fail: 0, lastStatus: 0, cooldownUntil: 0, hits: 0, lastUsedAt: 0 }
    row.cooldownUntil = Math.max(row.cooldownUntil, now() + ms)
    health.set(route, row)
  }

  /** 排队：先过滤模型，再跳过冷却中的账号；全部冷却时用最早恢复的那个。 */
  function pickOrder(model) {
    const eligible = members.filter((member) => {
      if (!model || !Array.isArray(member.modelFilter) || member.modelFilter.length === 0) return true
      return member.modelFilter.includes(model)
    })
    if (eligible.length === 0) return []
    const stamp = now()
    const start = cursor % eligible.length
    const ordered = []
    for (let index = 0; index < eligible.length; index += 1) {
      const member = eligible[(start + index) % eligible.length]
      ordered.push({ member, cooling: (health.get(member.route)?.cooldownUntil ?? 0) > stamp })
    }
    ordered.sort((a, b) => Number(a.cooling) - Number(b.cooling))
    cursor = (start + 1) % eligible.length
    return ordered.map((row) => row.member)
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let settled = false
      const cleanup = () => {
        request.off('data', onData)
        request.off('end', onEnd)
        request.off('error', onError)
        request.off('aborted', onAborted)
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onData = (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          const error = new Error('请求体过大')
          error.status = 413
          fail(error)
          request.resume()
          return
        }
        chunks.push(chunk)
      }
      const onEnd = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve(Buffer.concat(chunks))
      }
      const onError = () => {
        const error = new Error('请求体读取失败')
        error.status = 400
        fail(error)
      }
      const onAborted = () => {
        const error = new Error('客户端中断了请求')
        error.status = 400
        fail(error)
      }
      request.on('data', onData)
      request.once('end', onEnd)
      request.once('error', onError)
      request.once('aborted', onAborted)
    })
  }

  async function handleRequest(request, response) {
    if (!authorized(request)) {
      response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'invalid pool key' }))
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.endsWith('/health')) {
      const payload = JSON.stringify({
        ok: true,
        members: members.length,
        models: url.searchParams.get('models') ?? undefined,
        health: Object.fromEntries(health),
      })
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(payload)
      return
    }
    if (!url.pathname.endsWith(CHAT_PATH) || request.method !== 'POST') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }

    const rawBody = await readBody(request)
    const bodyText = rawBody.toString('utf8')
    let model = ''
    try {
      model = String(JSON.parse(bodyText)?.model ?? '')
    } catch {
      // 解析失败也照发，交给上游报错
    }

    refresh()
    const order = pickOrder(model)
    if (members.length === 0) {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: '账号池为空：先在 WorkBuddy 面板导入账号' }))
      return
    }
    if (order.length === 0) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: `池内没有账号声明支持模型 ${model || 'unknown'}` }))
      return
    }

    // 下游（DSH）随时可能中断。close 在 response.end() 正常结束后也会触发，
    // 那时再 abort 已无副作用。
    let downstreamClosed = false
    let currentAbort = null
    response.on('close', () => {
      downstreamClosed = true
      currentAbort?.abort()
    })

    let lastFailure = null
    for (const member of order) {
      if (downstreamClosed) return // 客户端已经走了，不要再换号重试
      const target = `${member.baseURL.replace(/\/+$/, '')}${CHAT_PATH}`
      // 每次尝试独立一个 controller：换号重试时上一个已经被 abort 掉了。
      const abort = new AbortController()
      currentAbort = abort
      const timer = setTimeout(() => abort.abort(), 600_000)
      try {
        const upstream = await fetch(target, {
          method: 'POST',
          headers: upstreamHeaders(member),
          body: bodyText,
          signal: abort.signal,
        })
        record(member.route, upstream.status)
        // 400/404 要先看错误正文：只有明确指向模型权限/可用性时才换号。
        // 若不该重试，则用缓冲正文继续原样回传，不能把上游错误吃掉。
        let bufferedBody = null
        if (retryable(upstream.status) || upstream.status === 400 || upstream.status === 404) {
          const text = await upstream.text().catch(() => '')
          // 11128 跟账号、模型无关：换个账号先试，全部被封才把原文回给下游。
          const blocked = isChannelBlock(text)
          if (blocked) {
            noteBlocked(member, bodyText, text)
            penalize(member.route, COOLDOWN.block)
            logger.warn?.(`workbuddy pool: ${member.name} 命中 11128 渠道校验，换下一个账号`)
          }
          if (retryable(upstream.status) || blocked || modelFailure(upstream.status, text)) {
            lastFailure = { status: upstream.status, text: text.slice(0, 300), member, blocked }
            if (!blocked) logger.warn?.(`workbuddy pool: ${member.name} 返回 ${upstream.status}，换下一个账号`)
            continue
          }
          bufferedBody = text
        }
        logger.info?.(`workbuddy pool: ${member.name} 承接 ${model || 'unknown'}`)
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
          'cache-control': 'no-store',
          'x-workbuddy-account': encodeURIComponent(member.name),
        })
        if (bufferedBody !== null) {
          response.end(bufferedBody)
          return
        }
        if (upstream.body === null) {
          response.end()
          return
        }
        const reader = upstream.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done || downstreamClosed) break
            if (value) await writeWithBackpressure(response, Buffer.from(value))
          }
        } catch (error) {
          // 下游断开时 abort 会让 read() 抛 AbortError，属预期路径而非故障
          if (!downstreamClosed) logger.warn?.(`workbuddy pool: 上游流中断（${error?.message ?? error}）`)
        }
        response.end()
        return
      } catch (error) {
        if (downstreamClosed) return // 客户端已断开，不再换号重试
        lastFailure = { status: 0, text: String(error?.message ?? error), member }
        record(member.route, 0)
        logger.warn?.(`workbuddy pool: ${member.name} 连接失败（${error?.message ?? error}），换下一个账号`)
      } finally {
        clearTimeout(timer)
        if (currentAbort === abort) currentAbort = null
      }
    }

    // 全池都被渠道校验拦下时把上游原文回给下游，别用 502 把 11128 的真实原因盖掉。
    if (lastFailure?.blocked === true) {
      response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(lastFailure.text)
      return
    }

    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        error: '账号池里所有账号都失败了',
        detail: lastFailure?.text ?? '',
        status: lastFailure?.status ?? 0,
      }),
    )
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      logger.warn?.(`workbuddy pool: 请求处理失败（${error?.message ?? error}）`)
      if (response.headersSent) {
        response.destroy()
        return
      }
      const status = Number(error?.status) >= 400 ? Number(error.status) : 500
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: String(error?.message ?? error) }))
    })
  })
  // 半截 HTTP 请求 / RST 不能变成未捕获异常。
  server.on('clientError', (_error, socket) => {
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    } catch {
      socket.destroy()
    }
  })

  // 优先固定端口。provider 的 baseURL 在 cordis.patch.yml 里写死了这个值，
  // 端口每次随机漂移会让 provider 指向一个已经关闭的端口——表现为"模型选择器
  // 里有模型，但每个请求都失败"。被占用时回退系统分配，宁可漂移也不能起不来
  // （applyPool 成功会把真实 url 重新写进 provider）。
  // 测试并行跑多个池子，抢同一个固定端口只会互相踩，保持原来的随机行为。
  const PREFERRED_PORT = process.env.NODE_TEST_CONTEXT ? 0 : 47812
  return new Promise((resolve, reject) => {
    let settled = false
    let fellBack = false
    const onListening = () => {
      // Node 在 listen 失败后重试时可能把前一次的回调也放出来，只认第一次。
      if (settled) return
      settled = true
      try {
        refresh()
      } catch (error) {
        logger.warn?.(`workbuddy pool: 初始化账号失败（${error?.message ?? error}）`)
        members = []
      }
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('账号池端口绑定失败'))
        return
      }
      const port = address.port
      if (port !== PREFERRED_PORT) {
        logger.warn?.(`workbuddy pool: 端口 ${PREFERRED_PORT} 被占用，改用 ${port}`)
      }
      logger.info?.(`workbuddy pool: 监听 http://127.0.0.1:${port}/v2（${members.length} 个账号）`)
      resolve({
        url: `http://127.0.0.1:${port}/v2`,
        port,
        refresh,
        stats: () => ({
          port,
          members: members.map((member) => ({
            route: member.route,
            name: member.name,
            hits: health.get(member.route)?.hits ?? 0,
            fail: health.get(member.route)?.fail ?? 0,
            lastStatus: health.get(member.route)?.lastStatus ?? 0,
            cooling: (health.get(member.route)?.cooldownUntil ?? 0) > now(),
          })),
        }),
        dispose: () =>
          new Promise((done) => {
            server.close(() => done())
            try {
              server.closeAllConnections?.()
            } catch {
              // 老版本 Node 没有这个接口
            }
          }),
      })
    }
    const onError = (error) => {
      if (settled) return
      // 固定端口被别的实例占了：回退系统分配，并且这次之后任何错误直接失败。
      if (!fellBack && PREFERRED_PORT !== 0 && error?.code === 'EADDRINUSE') {
        fellBack = true
        server.listen(0, '127.0.0.1', onListening)
        return
      }
      settled = true
      reject(error)
    }
    server.on('error', onError)
    server.listen(PREFERRED_PORT, '127.0.0.1', onListening)
  })
}
