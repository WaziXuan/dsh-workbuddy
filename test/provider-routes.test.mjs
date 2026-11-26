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
      product: 'personal', baseURL: 'http://127.0.0.1:9/v2', modelFilter: null,
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

test('public account panel requires verified Access and DSH sessions and uses a separate panel key', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto')
  const origin = 'https://panel.example.test'
  const issuer = 'https://account-team.cloudflareaccess.com'
  const audience = 'a'.repeat(64)
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' }
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  function accessToken(claims = {}, header = {}, signer = key.privateKey) {
    const input = [encode({ alg: 'RS256', kid: jwk.kid, ...header }),
      encode({ iss: issuer, aud: [audience], sub: 'synthetic-user', exp: now + 600, ...claims })].join('.')
    return [input, sign('RSA-SHA256', Buffer.from(input), signer).toString('base64url')].join('.')
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workbuddy-remote-'))
  const previousHome = process.env.DSH_HOME
  const previousSkipAuth = process.env.DSH_SKIP_AUTH
  const previousFetch = globalThis.fetch
  const handlers = new Map()
  const cleanups = []
  let keyLoads = 0
  process.env.DSH_HOME = home
  delete process.env.DSH_SKIP_AUTH
  globalThis.fetch = async (url) => {
    assert.equal(url, issuer + '/cdn-cgi/access/certs')
    keyLoads += 1
    return new Response(JSON.stringify({ keys: [jwk] }))
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    inject(deps, callback) {
      if (deps.includes('connection')) {
        callback({ connection: { requestRejection: (request) => request.headers.cookie === 'dsh=authenticated' ? undefined : 401 } })
      }
    },
    webServer: { register(route) { handlers.set(route.path, route.handler); return () => {} } },
  }

  async function request(route, { headers = {}, method = 'GET', remoteAddress = '127.0.0.1' } = {}) {
    const fullHeaders = {
      host: 'panel.example.test',
      origin,
      'sec-fetch-site': 'same-origin',
      'x-dsh-workbuddy-panel': '1',
      'cf-access-jwt-assertion': accessToken(),
      cookie: 'dsh=authenticated',
      ...headers,
    }
    let result
    const response = {
      writeHead(status, responseHeaders) { result = { status, headers: responseHeaders }; return this },
      setHeader() {},
      end(body) { result.body = JSON.parse(body) },
    }
    await handlers.get(route)({ method, headers: fullHeaders, socket: { remoteAddress, localPort: 47821 } }, response)
    return result
  }

  const bootstrap = (options) => request('/workbuddy/session', options)
  try {
    apply(ctx, { remotePanel: { origin, issuer, audience } })
    assert.equal((await bootstrap({ headers: { cookie: undefined } })).status, 401)
    assert.equal((await bootstrap({ headers: { 'cf-access-jwt-assertion': undefined } })).status, 403)
    assert.equal((await bootstrap({ headers: { 'cf-access-jwt-assertion': accessToken({ aud: ['wrong'] }) } })).status, 403)
    assert.equal((await bootstrap({ headers: { 'cf-access-jwt-assertion': accessToken({ exp: now - 10 }) } })).status, 403)
    assert.equal((await bootstrap({ headers: { 'cf-access-jwt-assertion': accessToken({ iss: 'https://wrong.example' }) } })).status, 403)
    assert.equal((await bootstrap({ headers: { 'cf-access-jwt-assertion': accessToken({}, { alg: 'HS256' }) } })).status, 403)
    assert.equal((await bootstrap({ headers: { origin: 'https://wrong.example' } })).status, 403)
    assert.equal((await bootstrap({ headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
    assert.equal((await bootstrap({ headers: { host: 'wrong.example', 'x-forwarded-host': 'panel.example.test' } })).status, 403)
    assert.equal((await bootstrap({ remoteAddress: '192.0.2.4' })).status, 403)
    assert.equal((await bootstrap({ method: 'POST' })).status, 405)
    assert.equal(keyLoads, 0)

    const forged = generateKeyPairSync('rsa', { modulusLength: 2048 })
    assert.equal((await bootstrap({ headers: { 'cf-access-jwt-assertion': accessToken({}, {}, forged.privateKey) } })).status, 403)
    const remote = await bootstrap({ headers: { origin: undefined } })
    assert.equal(remote.status, 200)
    const remoteKey = remote.body.token
    assert.ok(remoteKey)
    const localHeaders = { host: '127.0.0.1:47821', origin: undefined, cookie: undefined, 'cf-access-jwt-assertion': undefined }
    const local = await bootstrap({ headers: localHeaders })
    assert.equal(local.status, 200)
    assert.notEqual(remoteKey, local.body.token)
    const authorized = { authorization: 'Bearer ' + remoteKey }
    assert.equal((await request('/workbuddy/state', { headers: authorized })).status, 200)
    assert.equal((await request('/workbuddy/state', { headers: { ...authorized, 'cf-access-jwt-assertion': undefined } })).status, 403)
    assert.equal((await request('/workbuddy/state', { headers: { authorization: 'Bearer ' + local.body.token } })).status, 401)
    assert.equal((await request('/workbuddy/state', { headers: { ...localHeaders, ...authorized } })).status, 401)
    assert.equal((await request('/workbuddy/import', { method: 'POST', headers: { ...authorized, origin: undefined } })).status, 403)
    assert.equal((await request('/workbuddy/local', { method: 'POST', headers: authorized })).status, 403)
    assert.equal((await request('/workbuddy/jailbreak', { method: 'POST', headers: authorized })).status, 403)
    process.env.DSH_SKIP_AUTH = '1'
    assert.equal((await bootstrap()).status, 401)
    assert.equal(keyLoads, 1)
  } finally {
    for (const dispose of cleanups.reverse()) await dispose()
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousSkipAuth === undefined) delete process.env.DSH_SKIP_AUTH
    else process.env.DSH_SKIP_AUTH = previousSkipAuth
    fs.rmSync(home, { recursive: true, force: true })
  }
})
