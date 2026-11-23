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
  return startPool({ getAccounts: () => accounts, logger: QUIET_LOGGER })
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
