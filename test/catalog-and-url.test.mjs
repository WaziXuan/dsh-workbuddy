// 目录标记、modelFilter 语义与 baseURL 归一化回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadCatalog, selectModels } from '../lib/catalog.js'
import { normalizeAccount } from '../lib/index.js'

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

test('完整 chat URL 与尾斜杠 baseURL 都归一到 API 根', () => {
  const source = { accessToken: 'x'.repeat(32), uid: 'uid-1' }
  const fromChatUrl = normalizeAccount({ ...source, baseURL: 'https://copilot.tencent.com/v2/chat/completions' }, 0)
  const fromTrailingSlash = normalizeAccount({ ...source, baseURL: 'https://copilot.tencent.com/v2/' }, 0)
  assert.equal(fromChatUrl.ok, true)
  assert.equal(fromChatUrl.account.baseURL, 'https://copilot.tencent.com/v2')
  assert.equal(fromTrailingSlash.account.baseURL, 'https://copilot.tencent.com/v2')
})
