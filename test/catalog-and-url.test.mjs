// 目录标记、modelFilter 语义与 baseURL 归一化回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadCatalog, selectModels } from '../lib/catalog.js'
import { collectAccountObjects, normalizeAccount } from '../lib/index.js'

test('fallback 目录保留 friendly / reasoning 标记', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workbuddy-catalog-'))
  const previous = process.env.WORKBUDDY_HOME
  process.env.WORKBUDDY_HOME = path.join(home, 'empty')
  try {
    const catalog = loadCatalog()
    assert.equal(catalog.source, 'fallback')
    assert.ok(catalog.models.length > 0)
    for (const model of catalog.models) {
      assert.equal(typeof model.friendly, 'boolean')
      assert.equal(typeof model.onlyReasoning, 'boolean')
      assert.equal(typeof model.canDisable, 'boolean')
    }
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_HOME
    else process.env.WORKBUDDY_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('非空 modelFilter 无匹配时返回空，不再静默放大成全部模型', () => {
  const models = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(selectModels(models, []), models)
  assert.deepEqual(selectModels(models, ['a']), [{ id: 'a' }])
  assert.deepEqual(selectModels(models, ['missing']), [])
})

test('账号身份按 uid + 企业 ID 稳定，token 轮换不换 route', () => {
  const first = normalizeAccount({ accessToken: 'a'.repeat(32), uid: 'same-uid', enterpriseId: 'tenant-1' }, 0)
  const rotated = normalizeAccount({ accessToken: 'b'.repeat(32), uid: 'same-uid', enterpriseId: 'tenant-1' }, 0)
  const otherTenant = normalizeAccount({ accessToken: 'a'.repeat(32), uid: 'same-uid', enterpriseId: 'tenant-2' }, 0)
  assert.equal(first.ok, true)
  assert.equal(rotated.ok, true)
  assert.equal(otherTenant.ok, true)
  assert.equal(rotated.account.route, first.account.route)
  assert.notEqual(otherTenant.account.route, first.account.route)
})

test('file/ftp 等非 http(s) baseURL 被拒绝', () => {
  const source = { accessToken: 'x'.repeat(32), uid: 'uid-1' }
  assert.equal(normalizeAccount({ ...source, baseURL: 'file:///etc/passwd' }, 0).ok, false)
  assert.equal(normalizeAccount({ ...source, baseURL: 'ftp://example.com/v2' }, 0).ok, false)
})

test('完整 chat URL 与尾斜杠 baseURL 都归一到 API 根', () => {
  const source = { accessToken: 'x'.repeat(32), uid: 'uid-1' }
  const fromChatUrl = normalizeAccount({ ...source, baseURL: 'https://copilot.tencent.com/v2/chat/completions' }, 0)
  const fromTrailingSlash = normalizeAccount({ ...source, baseURL: 'https://copilot.tencent.com/v2/' }, 0)
  assert.equal(fromChatUrl.ok, true)
  assert.equal(fromChatUrl.account.baseURL, 'https://copilot.tencent.com/v2')
  assert.equal(fromTrailingSlash.account.baseURL, 'https://copilot.tencent.com/v2')
})

test('账号收集支持 map 结构（键为邮箱）并能归一化', () => {
  const text = JSON.stringify({
    version: 1,
    current: 'a@example.com',
    users: {
      'a@example.com': { accessToken: 'a'.repeat(40), uid: 'uid-a' },
      'b@example.com': { accessToken: 'b'.repeat(40), uid: 'uid-b' },
    },
  })
  const candidates = collectAccountObjects(text)
  assert.equal(candidates.length, 2)
  const first = normalizeAccount(candidates[0], 0)
  assert.equal(first.ok, true)
  assert.equal(first.account.name, 'a@example.com')
  assert.equal(first.account.uid, 'uid-a')
})

test('账号收集支持任意深度嵌套与祖先字段合并', () => {
  const text = JSON.stringify({
    uid: 'top-uid',
    data: { state: { session: { auth: { accessToken: 'c'.repeat(40) } } } },
  })
  const candidates = collectAccountObjects(text)
  assert.equal(candidates.length, 1)
  const result = normalizeAccount(candidates[0], 0)
  assert.equal(result.ok, true)
  assert.equal(result.account.uid, 'top-uid')
})

test('账号收集仍支持数组形式', () => {
  const text = JSON.stringify({ accounts: [{ accessToken: 'd'.repeat(40) }, { accessToken: 'e'.repeat(40) }] })
  assert.equal(collectAccountObjects(text).length, 2)
})

test('整个文件是加密信封时给出可操作提示', () => {
  const text = JSON.stringify({ $wbEncrypted: 1, envelope: 'QUJDREVGRw==' })
  const candidates = collectAccountObjects(text)
  assert.equal(candidates.length, 1)
  const result = normalizeAccount(candidates[0], 0)
  assert.equal(result.ok, false)
  assert.match(result.reason, /加密信封/)
})

test('允许直接粘贴裸 token 或 Authorization 请求头', () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(30)}.${'b'.repeat(20)}`
  const bare = collectAccountObjects(jwt)
  assert.equal(bare.length, 1)
  assert.equal(normalizeAccount(bare[0], 0).ok, true)

  const fromHeader = collectAccountObjects(`Authorization: Bearer ${jwt}`)
  assert.equal(fromHeader.length, 1)
  assert.equal(normalizeAccount(fromHeader[0], 0).account.token, jwt)
})

test('账号缺少 baseURL 时按默认端点处理，不被白名单拒绝', async () => {
  const { isAllowedBaseURL } = await import('../lib/hosts.js')
  assert.equal(isAllowedBaseURL(undefined), true, '未指定端点应视为使用默认值')
  assert.equal(isAllowedBaseURL(''), true)
  assert.equal(isAllowedBaseURL('https://attacker.example/v2'), false, '显式非法值仍要拒绝')
  const result = normalizeAccount({ accessToken: 'x'.repeat(40) }, 0)
  assert.equal(result.ok, true)
  assert.equal(result.account.baseURL, 'https://copilot.tencent.com/v2')
})
