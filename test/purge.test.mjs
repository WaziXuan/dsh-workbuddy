// purge 空结果缓存：没有装 dsh-purge 时也不能每轮扫盘。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPurgeText } from '../lib/purge.js'

test('空结果命中缓存，第二次读取不再扫描目录', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workbuddy-purge-'))
  const previous = process.env.DSH_HOME
  const originalReaddir = fs.readdirSync
  let scans = 0
  process.env.DSH_HOME = home
  fs.readdirSync = () => { scans += 1; return [] }
  try {
    assert.equal(readPurgeText(0), '', '首次空扫描应返回空串')
    scans = 0
    assert.equal(readPurgeText(60_000), '', '空结果应命中缓存')
    assert.equal(scans, 0, '缓存命中时不能再次扫描目录')
  } finally {
    fs.readdirSync = originalReaddir
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})
