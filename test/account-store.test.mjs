// 账号数据安全回归：replace 原子性、损坏文件处理、并发串行、最后账号退场。
// 全部使用临时 DSH_HOME 和内存 fetch mock，不接触真实账号/凭据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const realFetch = globalThis.fetch

function routeFor(token, uid) {
  return `wb-${createHash('sha256').update(`${token}|${uid ?? ''}`).digest('hex').slice(0, 8)}`
}

function account(route, uid = `uid-${route}`) {
  return {
    id: route.slice(3), route, credentialRef: `WORKBUDDY_${route.toUpperCase()}_API_KEY`,
    name: route, token: `fake-token-for-${route}`, uid, enterpriseId: null,
    product: 'personal', baseURL: 'http://upstream.invalid/v2', modelFilter: null,
    createdAt: 1000, lastTest: null, lastBalance: null,
  }
}

function responseSink() {
  return {
    status: 0,
    headersSent: false,
    payload: '',
    writeHead(status) { this.status = status; this.headersSent = true },
    end(body = '') { this.payload += String(body) },
    json() { return JSON.parse(this.payload) },
  }
}

async function bootstrap({ accounts, fetchImpl = async () => new Response('{}', { status: 200 }), unsetDelay = async () => {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workbuddy-store-'))
  const file = path.join(home, 'workbuddy', 'accounts.json')
  const previousDsh = process.env.DSH_HOME
  const previousCatalog = process.env.WORKBUDDY_HOME
  const cleanups = []
  const routes = new Map()
  const mutations = []
  const credentialOps = []
  process.env.DSH_HOME = home
  process.env.WORKBUDDY_HOME = path.join(home, 'empty-catalog')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof accounts === 'string' ? accounts : JSON.stringify({ version: 1, updatedAt: 0, accounts }))
  globalThis.fetch = fetchImpl

  const providers = {}
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', schema: { providers: {} }, value: { providers } }],
    mutate: async (_ns, ops) => {
      mutations.push(...ops)
      for (const op of ops) {
        if (op.op === 'set') providers[op.path.at(-1)] = op.value
        else if (op.op === 'unset') delete providers[op.path.at(-1)]
      }
    },
  }
  const credentials = {
    set: async (ref, value) => { credentialOps.push({ op: 'set', ref, value }) },
    unset: async (ref) => { await unsetDelay(ref); credentialOps.push({ op: 'unset', ref }) },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    inject(_deps, callback) { callback({ settings, credentials }) },
    webServer: { register: (spec) => { routes.set(spec.path, spec.handler); return () => {} } },
  }
  apply(ctx, {})
  const call = async (routePath, body = {}) => {
    const response = responseSink()
    const request = new EventEmitter()
    request.method = 'POST'
    request.headers = {}
    const payload = Buffer.from(JSON.stringify(body))
    queueMicrotask(() => {
      request.emit('data', payload)
      request.emit('end')
    })
    await routes.get(routePath)(request, response)
    return response
  }
  const finish = async () => {
    for (const dispose of cleanups.reverse()) {
      try { await dispose?.() } catch {}
    }
    if (previousDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDsh
    if (previousCatalog === undefined) delete process.env.WORKBUDDY_HOME
    else process.env.WORKBUDDY_HOME = previousCatalog
    globalThis.fetch = realFetch
    fs.rmSync(home, { recursive: true, force: true })
  }
  return { file, routes, mutations, credentialOps, call, finish }
}

test('replace 遇无效账号整次拒绝，不碰原账号文件', async () => {
  const original = account('wb-deadbeef')
  const env = await bootstrap({ accounts: [original] })
  try {
    for (let i = 0; i < 50 && env.mutations.length === 0; i += 1) await sleep(20)
    env.mutations.length = 0
    const before = fs.readFileSync(env.file)
    const response = await env.call('/workbuddy/import', { replace: true, text: '{"foo":"bar"}' })
    assert.equal(response.status, 400)
    assert.match(response.payload, /replace 已取消/)
    assert.deepEqual(fs.readFileSync(env.file), before, '原文件内容必须逐字节不变')
    assert.equal(env.mutations.length, 0, '不得改动 provider 配置')
  } finally {
    await env.finish()
  }
})

test('accounts.json 损坏时报错并保留原文，不把账号误判为空', async () => {
  const corrupted = '{ definitely-not-json'
  const env = await bootstrap({ accounts: corrupted })
  try {
    await sleep(120)
    assert.equal(fs.readFileSync(env.file, 'utf8'), corrupted)
    assert.equal(env.mutations.length, 0, '损坏文件不得触发任何 provider 变更')
    const state = await env.call('/workbuddy/state')
    assert.equal(state.status, 500)
    assert.match(state.payload, /账号存储已损坏/)
  } finally {
    await env.finish()
  }
})

test('同账号重新导入保留 lastTest，不因刷新余额而丢失', async () => {
  const token = 'fake-token-for-reimport-0001'
  const uid = 'uid-reimport'
  const existing = account(routeFor(token, uid), uid)
  existing.lastTest = { ok: true, status: 200, at: 123456, message: 'old result' }
  const env = await bootstrap({
    accounts: [existing],
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { TotalCredits: 100 } }), { status: 200 }),
  })
  try {
    for (let i = 0; i < 50 && env.mutations.length === 0; i += 1) await sleep(20)
    const response = await env.call('/workbuddy/import', {
      text: JSON.stringify({ accessToken: token, uid, name: 'reimport' }),
    })
    assert.equal(response.status, 200)
    const stored = JSON.parse(fs.readFileSync(env.file, 'utf8'))
    assert.equal(stored.accounts.length, 1)
    assert.equal(stored.accounts[0].lastTest.at, 123456)
  } finally {
    await env.finish()
  }
})

test('并发 remove + test 串行执行，删除不会覆盖刚写入的测试结果', async () => {
  const a = account('wb-aaaaaaaa')
  const b = account('wb-bbbbbbbb')
  const env = await bootstrap({
    accounts: [a, b],
    fetchImpl: async (url) => {
      if (String(url).includes('/chat/completions')) {
        await sleep(20)
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response('{}', { status: 200 })
    },
    unsetDelay: async (ref) => { if (ref === b.credentialRef) await sleep(100) },
  })
  try {
    for (let i = 0; i < 50 && env.mutations.length === 0; i += 1) await sleep(20)
    const removing = env.call('/workbuddy/remove', { route: b.route })
    const testing = env.call('/workbuddy/test', { route: a.route })
    const [removed, tested] = await Promise.all([removing, testing])
    assert.equal(removed.status, 200)
    assert.equal(tested.status, 200)
    const stored = JSON.parse(fs.readFileSync(env.file, 'utf8'))
    assert.equal(stored.accounts.length, 1)
    assert.equal(stored.accounts[0].route, a.route)
    assert.ok(stored.accounts[0].lastTest, '后执行的测试元数据不能被先前的删除快照覆盖')
  } finally {
    await env.finish()
  }
})

test('删除最后一个账号后 pool URL、provider 与凭据一起清空', async () => {
  const only = account('wb-cccccccc')
  const env = await bootstrap({ accounts: [only] })
  try {
    for (let i = 0; i < 50 && env.mutations.length === 0; i += 1) await sleep(20)
    const response = await env.call('/workbuddy/remove', { route: only.route })
    assert.equal(response.status, 200)
    assert.equal(response.json().state.pool.url, null, '最后一个账号删除后池 URL 必须清空')
    const unsetRoutes = env.mutations.filter((op) => op.op === 'unset').map((op) => op.path.at(-1))
    assert.ok(unsetRoutes.includes('workbuddy'))
    assert.ok(env.credentialOps.some((op) => op.op === 'unset' && op.ref === 'WORKBUDDY_POOL_KEY'))
  } finally {
    await env.finish()
  }
})
