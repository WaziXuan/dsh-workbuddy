// 第二轮回归：模型路由、模型错误换号、连接失败冷却。
// 只使用假上游和回环地址，不接触真实凭据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { startPool, writeWithBackpressure } from '../lib/pool.js'

const realFetch = globalThis.fetch
const QUIET_LOGGER = { info() {}, warn() {} }

function account(route, modelFilter = null) {
  return {
    route,
    name: route,
    token: `fake-token-for-${route}`,
    baseURL: `http://${route}.invalid/v2`,
    modelFilter,
  }
}

async function makePool(accounts) {
  return startPool({ getAccounts: () => accounts, logger: QUIET_LOGGER, validateBaseURL: () => true })
}

async function post(pool, model = 'test-model') {
  const response = await realFetch(`${pool.url}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ model, stream: true, messages: [] }),
  })
  const text = await response.text()
  return { response, text }
}

function okResponse() {
  return new Response('data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

test('按 modelFilter 选择能承接该模型的账号', async () => {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(new URL(url).hostname)
    return okResponse()
  }
  const pool = await makePool([
    account('a', ['model-a']),
    account('b', ['model-b']),
  ])
  try {
    const { response } = await post(pool, 'model-b')
    assert.equal(response.status, 200)
    assert.deepEqual(calls, ['b.invalid'], '不能先把请求发给未声明支持该模型的账号')
    assert.equal(response.headers.get('x-workbuddy-account'), 'b')
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('上游明确返回模型不可用 → 自动换下一个账号', async () => {
  const calls = []
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname
    calls.push(host)
    if (host === 'a.invalid') {
      return new Response(JSON.stringify({ error: { code: 'model_not_supported', message: "model 'test-model' is not available for this account" } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    return okResponse()
  }
  const pool = await makePool([account('a'), account('b')])
  try {
    const { response } = await post(pool)
    assert.equal(response.status, 200, '模型权限错误不应直接终止整个账号池请求')
    assert.deepEqual(calls, ['a.invalid', 'b.invalid'])
    assert.equal(response.headers.get('x-workbuddy-account'), 'b')
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('普通 400 原样返回，不换号也不吃错误正文', async () => {
  const calls = []
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname
    calls.push(host)
    return new Response(JSON.stringify({ error: { message: 'messages are required' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }
  const pool = await makePool([account('a'), account('b')])
  try {
    const { response, text } = await post(pool)
    assert.equal(response.status, 400)
    assert.match(text, /messages are required/)
    assert.deepEqual(calls, ['a.invalid'])
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('没有账号声明支持该模型时，不发送任何上游请求', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return okResponse() }
  const pool = await makePool([account('a', ['model-a'])])
  try {
    const { response, text } = await post(pool, 'model-b')
    assert.equal(response.status, 400)
    assert.match(text, /没有账号声明支持模型 model-b/)
    assert.equal(calls, 0)
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('连接失败的账号进入冷却，后续请求不反复陪跑', async () => {
  let badCalls = 0
  let goodCalls = 0
  globalThis.fetch = async (url) => {
    if (new URL(url).hostname === 'bad.invalid') {
      badCalls += 1
      throw new Error('mock connection refused')
    }
    goodCalls += 1
    return okResponse()
  }
  const pool = await makePool([account('bad'), account('good')])
  try {
    for (let i = 0; i < 3; i += 1) {
      const { response } = await post(pool)
      assert.equal(response.status, 200)
    }
    assert.equal(goodCalls, 3)
    assert.equal(badCalls, 1, '坏账号第一次失败后应冷却，而不是每两轮再撞一次')
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('账号存储抛错时请求返回 500，进程不因未捕获异常退出', async () => {
  const pool = await startPool({
    getAccounts: () => { throw new Error('mock corrupted accounts.json') },
    logger: QUIET_LOGGER,
    validateBaseURL: () => true,
  })
  try {
    const response = await realFetch(`${pool.url}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'test-model' }),
    })
    assert.equal(response.status, 500)
    assert.match(await response.text(), /mock corrupted accounts\.json/)
  } finally {
    await pool.dispose()
  }
})

test('池数据面要求正确的 bearer key', async () => {
  globalThis.fetch = async () => okResponse()
  const pool = await startPool({
    getAccounts: () => [account('a')],
    logger: QUIET_LOGGER,
    authKey: 'pool-secret-key',
    validateBaseURL: () => true,
  })
  try {
    const body = JSON.stringify({ model: 'test-model', stream: true })
    const missing = await realFetch(`${pool.url}/chat/completions`, { method: 'POST', body })
    const wrong = await realFetch(`${pool.url}/chat/completions`, {
      method: 'POST', body, headers: { authorization: 'Bearer wrong' },
    })
    const good = await realFetch(`${pool.url}/chat/completions`, {
      method: 'POST', body, headers: { authorization: 'Bearer pool-secret-key' },
    })
    assert.equal(missing.status, 401)
    assert.equal(wrong.status, 401)
    assert.equal(good.status, 200)
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('背压：写缓冲区满时等待 drain', async () => {
  class FakeResponse extends EventEmitter {
    write() { return false }
  }
  const response = new FakeResponse()
  let settled = false
  const pending = writeWithBackpressure(response, Buffer.from('chunk')).then(() => { settled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'drain 之前不能继续拉取上游')
  response.emit('drain')
  await pending
  assert.equal(settled, true)
})

test('背压：等待 drain 期间下游 close 也能退出', async () => {
  class FakeResponse extends EventEmitter {
    write() { return false }
  }
  const response = new FakeResponse()
  const pending = writeWithBackpressure(response, Buffer.from('chunk'))
  response.emit('close')
  await pending
  assert.equal(response.listenerCount('drain'), 0, '退出后不能残留 drain 监听器')
  assert.equal(response.listenerCount('close'), 0, '退出后不能残留 close 监听器')
})

test('11128 渠道校验 → 换下一个账号，全部被封才回原文', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wb-block-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const blocked = JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' })
  const calls = []
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname
    calls.push(host)
    if (host === 'a.invalid') return new Response(blocked, { status: 400, headers: { 'content-type': 'application/json' } })
    return okResponse()
  }
  const pool = await makePool([account('a'), account('b')])
  try {
    const { response } = await post(pool)
    assert.equal(response.status, 200, '一个账号被渠道校验拦下不该让整次请求失败')
    assert.deepEqual(calls, ['a.invalid', 'b.invalid'])
    const report = JSON.parse(fs.readFileSync(path.join(home, 'workbuddy', 'last-blocked.json'), 'utf8'))
    assert.equal(report.code, 11128)
    assert.equal(report.model, 'test-model')
    assert.ok(Array.isArray(report.suspicious), '现场只记线索片段')
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('两个账号都被 11128 拦下时，把上游原文回给下游', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wb-block2-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const blocked = JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' })
  globalThis.fetch = async () => new Response(blocked, { status: 400, headers: { 'content-type': 'application/json' } })
  const pool = await makePool([account('a'), account('b')])
  try {
    const { response, text } = await post(pool)
    assert.equal(response.status, 400)
    assert.match(text, /11128/)
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('国际版端点自动补 Origin/Referer，默认端点保持不动', async () => {
  const captured = []
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), headers: init?.headers ?? {} })
    return okResponse()
  }
  const intl = account('intl')
  intl.baseURL = 'https://www.workbuddy.ai/v2'
  const pool = await makePool([intl])
  try {
    const { response } = await post(pool)
    assert.equal(response.status, 200)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].headers.origin, 'https://www.workbuddy.ai')
    assert.equal(captured[0].headers.referer, 'https://www.workbuddy.ai/')
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('默认端点不带 Origin/Referer，避免给国内链路引入新变量', async () => {
  const captured = []
  globalThis.fetch = async (url, init) => {
    captured.push(init?.headers ?? {})
    return okResponse()
  }
  const cn = account('cn')
  cn.baseURL = 'https://copilot.tencent.com/v2'
  const pool = await makePool([cn])
  try {
    await post(pool)
    assert.equal(captured[0].origin, undefined)
    assert.equal(captured[0].referer, undefined)
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('额度用尽（14018）即便包在 400 里也换号', async () => {
  const hits = []
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname
    hits.push(host)
    if (host === 'quota.invalid') {
      return new Response(JSON.stringify({ error: { data: { code: 14018, msg: '额度已用尽，请购买加量包' } } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    return okResponse()
  }
  const pool = await makePool([account('quota'), account('ok')])
  try {
    const { response } = await post(pool)
    assert.equal(response.status, 200, '一个账号额度用尽不该让整轮失败')
    assert.deepEqual(hits, ['quota.invalid', 'ok.invalid'])
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('限流（6004）包在 400 里也换号', async () => {
  const hits = []
  globalThis.fetch = async (url) => {
    const host = new URL(url).hostname
    hits.push(host)
    if (host === 'rate.invalid') {
      return new Response(JSON.stringify({ code: 6004, msg: '您的使用量已超出频率限制，将在稍后重置' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    return okResponse()
  }
  const pool = await makePool([account('rate'), account('ok')])
  try {
    const { response } = await post(pool)
    assert.equal(response.status, 200)
    assert.deepEqual(hits, ['rate.invalid', 'ok.invalid'])
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})
