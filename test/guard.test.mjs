// 渠道守卫回归：system 补位、Request 形式、改写后的 content-length。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installFetchGuard, rewritePayload } from '../lib/guard.js'

const TARGET = 'https://copilot.tencent.com/v2/chat/completions'
const realFetch = globalThis.fetch
const QUIET_LOGGER = { info() {}, warn() {} }

test('无 system 的 user-only 请求必须补出 system 并标记为已改写', () => {
  const raw = JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: 'hello' }] })
  const result = rewritePayload(raw)
  assert.equal(result.changed, true)
  assert.equal(JSON.parse(result.body).messages[0].role, 'system')
  assert.ok(result.hits.includes('system-inserted'))
})

test('fetch(Request) 形式也要经过守卫并替换 User-Agent', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }) }
  const guard = installFetchGuard(QUIET_LOGGER, {})
  try {
    const request = new Request(TARGET, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.2.1' },
      body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: 'hello' }] }),
    })
    await fetch(request)
    assert.equal(guard.stats().requests, 1)
    assert.equal(calls.length, 1)
    const sent = calls[0].url
    assert.ok(sent instanceof Request)
    assert.match(sent.headers.get('user-agent'), /^WorkBuddy\//)
    const payload = JSON.parse(await sent.clone().text())
    assert.equal(payload.messages[0].role, 'system')
  } finally {
    guard.dispose()
    globalThis.fetch = realFetch
  }
})

test('多层 guard 任意顺序 dispose 不复活旧 wrapper', async () => {
  const original = async () => new Response('{}', { status: 200 })
  globalThis.fetch = original
  const request = () => fetch(TARGET, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.2.1' },
    body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: 'hello' }] }),
  })

  const a = installFetchGuard(QUIET_LOGGER, { injectUserTail: (text) => `${text} A` })
  const b = installFetchGuard(QUIET_LOGGER, { injectUserTail: (text) => `${text} B` })
  try {
    a.dispose() // 非 LIFO：先卸载早安装的层
    await request()
    assert.equal(b.stats().rewrites, 1, '后安装的层必须仍然存活')
    assert.notEqual(globalThis.fetch, original)
    b.dispose()
    assert.equal(globalThis.fetch, original, '全部卸载后必须回到原始 fetch')

    const c = installFetchGuard(QUIET_LOGGER, { injectUserTail: (text) => `${text} C` })
    const d = installFetchGuard(QUIET_LOGGER, { injectUserTail: (text) => `${text} D` })
    d.dispose() // 先卸载后安装的层
    await request()
    assert.equal(c.stats().rewrites, 1, '先安装的层不能被误删')
    c.dispose()
    assert.equal(globalThis.fetch, original)
  } finally {
    a.dispose()
    b.dispose()
    globalThis.fetch = realFetch
  }
})

test('system content 数组保留非文本块与 cache_control，不 flatten', () => {
  const image = { type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }
  const raw = JSON.stringify({
    model: 'fake',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }, image] },
      { role: 'developer', content: [{ type: 'text', text: 'developer note', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'hello' },
    ],
  })
  const result = rewritePayload(raw)
  assert.equal(result.changed, true)
  const system = JSON.parse(result.body).messages[0].content
  assert.ok(Array.isArray(system), 'system content 必须保持数组')
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral' })
  assert.ok(system.some((part) => part.type === 'image_url'))
  assert.ok(system.some((part) => part.text === 'developer note'))
})

test('injectSystemParts 将破甲头尾作为独立 text part 包裹原数组', () => {
  const image = { type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }
  const raw = JSON.stringify({
    messages: [{ role: 'system', content: [{ type: 'text', text: 'sys' }, image] }, { role: 'user', content: 'hi' }],
  })
  const result = rewritePayload(raw, {
    injectSystemParts: (parts) => [
      { type: 'text', text: 'HEAD' },
      ...parts,
      { type: 'text', text: 'TAIL' },
    ],
  })
  const content = JSON.parse(result.body).messages[0].content
  assert.equal(content[0].text, 'HEAD')
  assert.equal(content.at(-1).text, 'TAIL')
  assert.ok(content.some((part) => part.type === 'image_url'))
  assert.ok(result.hits.includes('jailbreak'))
})

test('user content 数组加尾锚点时保留图片块', () => {
  const image = { type: 'image_url', image_url: { url: 'https://example.invalid/y.png' } }
  const raw = JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'text', text: '看看这张图' }, image] }],
  })
  const result = rewritePayload(raw, { injectUserTail: (content) => Array.isArray(content) ? [...content, { type: 'text', text: 'TAIL' }] : content })
  const content = JSON.parse(result.body).messages.at(-1).content
  assert.ok(Array.isArray(content))
  assert.ok(content.some((part) => part.type === 'image_url'))
  assert.equal(content.at(-1).text, 'TAIL')
})

test('改写 body 后删除过期的 content-length', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }) }
  const guard = installFetchGuard(QUIET_LOGGER, {})
  try {
    const body = JSON.stringify({ model: 'fake', messages: [
      { role: 'developer', content: 'merged developer instructions' },
      { role: 'user', content: 'hello' },
    ] })
    await fetch(TARGET, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
    })
    assert.equal(calls.length, 1)
    const headers = new Headers(calls[0].init.headers)
    assert.equal(headers.get('content-length'), null, '必须让 fetch 重新计算长度')
    assert.notEqual(calls[0].init.body, body, 'body 应已被改写')
  } finally {
    guard.dispose()
    globalThis.fetch = realFetch
  }
})

test('探针半开：保留 system 补位，跳过注入，不计 rewrites', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }) }
  const guard = installFetchGuard(QUIET_LOGGER, {
    injectSystem: (system) => `${system}\nINJECTED`,
    injectUserTail: (text) => `${text}\nTAIL`,
  })
  try {
    await fetch(TARGET, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.2.1', 'x-dsh-workbuddy-probe': '1' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
    })
    assert.equal(guard.stats().rewrites, 0)
    assert.equal(guard.stats().probes, 1)
    const sent = calls[0]
    const headers = new Headers(sent.init.headers)
    assert.equal(headers.get('x-dsh-workbuddy-probe'), null)
    const payload = JSON.parse(sent.init.body)
    assert.equal(payload.messages[0].role, 'system')
    assert.ok(!payload.messages[0].content.includes('INJECTED'))
    assert.ok(!JSON.stringify(payload).includes('TAIL'))
  } finally {
    guard.dispose()
    globalThis.fetch = realFetch
  }
})

test('下游请求失败只发一次，不静默重发', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new Error('upstream boom') }
  const guard = installFetchGuard(QUIET_LOGGER, {})
  try {
    await assert.rejects(() => fetch(TARGET, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.2.1' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }), /upstream boom/)
    assert.equal(calls, 1, '下游失败后不能重发原始请求')
  } finally {
    guard.dispose()
    globalThis.fetch = realFetch
  }
})
