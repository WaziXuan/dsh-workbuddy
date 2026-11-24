// 回归测试：下游（DSH）断开时，池子必须把取消信号传给上游。
// 全部用假上游 + 回环，不碰真实账号。
// 跑法：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startPool } from '../lib/pool.js'

const realFetch = globalThis.fetch
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ACCOUNT = { route: 'r1', name: 'fake', token: 'not-a-real-token', baseURL: 'http://upstream.invalid/v2' }
const QUIET_LOGGER = { info() {}, warn() {} }

/** 装一个会数生产块数、会记录 abort 的假上游。 */
function installMockUpstream({ total = 40, interval = 20, firstByteDelay = 0 }) {
  const state = { produced: 0, aborted: false, calls: 0 }
  globalThis.fetch = async (_url, init) => {
    state.calls += 1
    init?.signal?.addEventListener('abort', () => {
      state.aborted = true
    })
    if (firstByteDelay) await sleep(firstByteDelay)
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      async pull(controller) {
        if (state.produced >= total) {
          controller.close()
          return
        }
        await sleep(interval)
        state.produced += 1
        controller.enqueue(enc.encode(`data: {"n":${state.produced}}\n\n`))
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return state
}

function makePool(accounts = [ACCOUNT]) {
  return startPool({ getAccounts: () => accounts, logger: QUIET_LOGGER })
}

async function postChat(url, signal) {
  return realFetch(`${url}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ model: 'fake-model', stream: true }),
    signal,
  })
}

test('流式传输途中下游断开 → 上游被 abort，生产停止', async () => {
  const upstream = installMockUpstream({ total: 40, interval: 20 })
  const pool = await makePool()
  try {
    const clientAbort = new AbortController()
    const res = await postChat(pool.url, clientAbort.signal)
    assert.equal(res.status, 200)

    const reader = res.body.getReader()
    for (let i = 0; i < 3; i += 1) await reader.read()
    const atDisconnect = upstream.produced
    try { await reader.cancel() } catch {}
    clientAbort.abort()

    await sleep(400) // 不修的话这段时间会再生产约 20 块
    assert.ok(upstream.aborted, '上游必须收到 abort 信号')
    assert.ok(
      upstream.produced <= atDisconnect + 3,
      `断开后只允许少量在途块，实际多生产了 ${upstream.produced - atDisconnect} 块`,
    )
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('正常读完不受影响 → 不误 abort，块数完整', async () => {
  const upstream = installMockUpstream({ total: 5, interval: 5 })
  const pool = await makePool()
  try {
    const res = await postChat(pool.url)
    let got = 0
    const reader = res.body.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
      got += 1
    }
    assert.equal(got, 5)
    await sleep(50)
    assert.equal(upstream.aborted, false, '正常结束不应触发 abort')
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})

test('还在等首包时下游断开 → 挂起的 fetch 也要被 abort', async () => {
  const upstream = installMockUpstream({ total: 5, interval: 5, firstByteDelay: 300 })
  const pool = await makePool()
  try {
    const clientAbort = new AbortController()
    const pending = postChat(pool.url, clientAbort.signal).catch(() => null)
    // 等到池子真的向上游发出请求后再断开，避免在读完请求体之前 abort 导致没走到上游。
    for (let i = 0; i < 30 && upstream.calls === 0; i += 1) await sleep(10)
    clientAbort.abort()
    await pending
    await sleep(100)
    assert.ok(upstream.aborted, '等首包阶段断开也必须取消上游请求')
    assert.equal(upstream.calls, 1, '断开后不应再换号重试')
  } finally {
    await pool.dispose()
    globalThis.fetch = realFetch
  }
})
