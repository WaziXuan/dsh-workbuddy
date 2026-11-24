// 回归：自动恢复与手动 apply 并发时必须共享同一个账号池。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

function fakeResponse() {
  return {
    headersSent: false,
    payload: '',
    writeHead() { this.headersSent = true },
    end(body = '') { this.payload += String(body) },
  }
}

test('并发 ensurePool 只产生一个监听 URL', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workbuddy-startup-'))
  const previousHome = process.env.DSH_HOME
  const previousCatalogHome = process.env.WORKBUDDY_HOME
  const cleanups = []
  const routes = new Map()
  const poolUrls = []
  process.env.DSH_HOME = home
  process.env.WORKBUDDY_HOME = path.join(home, 'empty-catalog')
  fs.mkdirSync(path.join(home, 'workbuddy'), { recursive: true })
  fs.writeFileSync(path.join(home, 'workbuddy', 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [{
      id: 'fake0001', route: 'wb-fake0001', credentialRef: 'WORKBUDDY_FAKE',
      name: 'fake', token: 'not-a-real-token', uid: null, enterpriseId: null,
      product: 'personal', baseURL: 'http://upstream.invalid/v2', modelFilter: null,
    }],
  }))

  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', schema: { providers: {} }, value: { providers: {} } }],
    mutate: async (_ns, ops) => {
      for (const op of ops) {
        if (op.op === 'set' && op.path.at(-1) === 'workbuddy') poolUrls.push(op.value.baseURL)
      }
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    inject(_deps, callback) { callback({ settings, credentials: { set: async () => {} } }) },
    webServer: {
      register(spec) { routes.set(spec.path, spec.handler); return () => {} },
    },
  }

  try {
    apply(ctx, {})
    const applyRoute = routes.get('/workbuddy/apply')
    assert.ok(applyRoute, 'apply 路由应已注册')
    const panelToken = fs.readFileSync(path.join(home, 'workbuddy', 'http-token'), 'utf8').trim()
    const headers = { host: '127.0.0.1:34567', authorization: `Bearer ${panelToken}` }
    // 与 queueMicrotask 里的启动自动恢复重叠，覆盖启动竞态窗口。
    await Promise.all([
      applyRoute({ method: 'POST', headers }, fakeResponse()),
      applyRoute({ method: 'POST', headers }, fakeResponse()),
    ])
    assert.ok(poolUrls.length >= 2)
    assert.equal(new Set(poolUrls).size, 1, `并发 apply 产生了多个池：${poolUrls.join(', ')}`)
  } finally {
    for (const dispose of cleanups.reverse()) {
      try { await dispose?.() } catch {}
    }
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousCatalogHome === undefined) delete process.env.WORKBUDDY_HOME
    else process.env.WORKBUDDY_HOME = previousCatalogHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
