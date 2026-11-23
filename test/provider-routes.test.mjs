// 回归：应用 WorkBuddy 账号池不能删除用户自己的其他 provider。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('applyPool 只清理 wb-* 旧账号路由，保留其他 provider', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workbuddy-routes-'))
  const previousHome = process.env.DSH_HOME
  const previousCatalogHome = process.env.WORKBUDDY_HOME
  const cleanups = []
  const mutations = []
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

  const providers = {
    workbuddy: { baseURL: 'http://old-pool.invalid' },
    'wb-deadbeef': { baseURL: 'http://old-account.invalid' },
    openai: { baseURL: 'https://api.openai.com/v1' },
    codebuddy: { baseURL: 'http://codebuddy.invalid' },
  }
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', schema: { providers: {} }, value: { providers } }],
    mutate: async (_ns, ops) => { mutations.push(...ops) },
  }
  const credentials = { set: async () => {}, unset: async () => {} }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    inject(_deps, callback) { callback({ settings, credentials }) },
    webServer: { register: () => () => {} },
  }

  try {
    apply(ctx, {})
    for (let i = 0; i < 50 && mutations.length === 0; i += 1) await sleep(20)
    assert.ok(mutations.length > 0, '启动时应自动应用账号池')
    const unset = mutations.filter((op) => op.op === 'unset').map((op) => op.path.at(-1))
    assert.ok(unset.includes('wb-deadbeef'), '旧的每账号路由仍应被清理')
    assert.ok(!unset.includes('openai'), '不能删除 openai')
    assert.ok(!unset.includes('codebuddy'), '不能删除 codebuddy')
    assert.ok(!unset.includes('workbuddy'), '不能删除正在使用的池路由')
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
