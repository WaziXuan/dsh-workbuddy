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

const CHAT_PATH = '/chat/completions'
const COOLDOWN = { auth: 300_000, rate: 30_000, server: 10_000, network: 30_000, other: 0 }

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

  let members = []
  const health = new Map() // route -> { fail: number, lastStatus: number, cooldownUntil: number, hits: number, lastUsedAt: number }
  let cursor = 0

  function refresh() {
    members = (getAccounts() || []).map(toMember).filter((member) => member.token)
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
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', reject)
    })
  }

  const server = http.createServer(async (request, response) => {
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
          if (retryable(upstream.status) || modelFailure(upstream.status, text)) {
            lastFailure = { status: upstream.status, text: text.slice(0, 300), member }
            logger.warn?.(`workbuddy pool: ${member.name} 返回 ${upstream.status}，换下一个账号`)
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

    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        error: '账号池里所有账号都失败了',
        detail: lastFailure?.text ?? '',
        status: lastFailure?.status ?? 0,
      }),
    )
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      refresh()
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
    })
  })
}
