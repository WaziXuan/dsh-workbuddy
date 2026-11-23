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
    const sent = calls[0].init ?? {}
    const headers = new Headers(sent.headers)
    assert.match(headers.get('user-agent'), /^WorkBuddy\//)
    assert.equal(JSON.parse(sent.body).messages[0].role, 'system')
  } finally {
    guard.dispose()
    globalThis.fetch = realFetch
  }
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
