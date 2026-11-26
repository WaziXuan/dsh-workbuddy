/**
 * dsh-workbuddy —— 把 WorkBuddy 账号导入成 DSH 的模型提供商。
 *
 * 做法：把每个账号写成 `llm-pi-ai` 里的一条自定义 provider 路由
 * （OpenAI Chat Completions 协议，指向 copilot.tencent.com 网关），
 * 于是模型选择器里直接出现「WorkBuddy · 账号名」下的全部模型。
 *
 * 账号令牌走 DSH 凭据服务，不落在配置里。
 *
 * 另外装一层 fetch 守卫：WorkBuddy 网关会对 system/assistant 文本做渠道校验
 * （`You are an AI agent powered by DeepSeek Harness.`、`@` 引用说明、developer 角色
 * 都会触发 400/11128），守卫只改写发往它的 chat/completions 请求。
 *
 * 守卫同时把 dsh-purge 的破甲层压进这条通道的 system：前端注入压在最前 +
 * 末尾锚点，让模型在这条协议上也不再自我审查（见 lib/purge.js）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadCatalog, selectModels } from './catalog.js'
import { isAllowedBaseURL } from './hosts.js'
import { installFetchGuard } from './guard.js'
import { startPool } from './pool.js'
import { createRemotePanel } from './remote-panel.js'
import { estimateTokens, injectPurge, injectPurgeParts, injectUserTail, readPurgeText } from './purge.js'

export const name = 'dsh-workbuddy'
export const inject = ['webServer']

const DEFAULT_BASE_URL = 'https://copilot.tencent.com/v2'
const DEFAULT_NAMESPACE = 'llm-pi-ai'

const REMOTE_PANEL_METHODS = new Map([
  ['/workbuddy/session', 'GET'],
  ['/workbuddy/state', 'GET'],
  ['/workbuddy/catalog', 'GET'],
  ['/workbuddy/import', 'POST'],
  ['/workbuddy/apply', 'POST'],
  ['/workbuddy/test', 'POST'],
  ['/workbuddy/balance', 'POST'],
  ['/workbuddy/remove', 'POST'],
])
/** 唯一对外的 provider 路由名：所有账号共用这一条。 */
const POOL_ROUTE = 'workbuddy'
/** 池子自己的凭据引用（值只是占位，真正的 token 由池子按账号注入）。 */
const POOL_KEY_REF = 'WORKBUDDY_POOL_KEY'

/**
 * 池 key 的凭据引用名，按池的监听端口区分。
 *
 * credentials 是 DSH home 级别的共享存储：桌面客户端（池 47812）和远端 web 宿主
 * （池 47812 被占时回退到随机端口）如果共用一个 `WORKBUDDY_POOL_KEY`，
 * 后启动的那个会把先启动的那个覆盖掉，被覆盖的一方 provider 拿着别人的 key
 * 去问自己的池，直接 401「API Key 无效」。端口是每实例唯一且稳定的判别位。
 */
export function poolKeyRef(url) {
  try {
    const port = new URL(url).port
    if (port !== '') return `${POOL_KEY_REF}_${port}`
  } catch {
    // url 不是合法地址时退回共用名字（单实例场景下等价）。
  }
  return POOL_KEY_REF
}
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** DSH 主目录（支持 DSH_HOME 覆盖）。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
}

function stateFile() {
  return path.join(dshHome(), 'workbuddy', 'accounts.json')
}

function emptyStore() {
  return { version: 1, updatedAt: 0, accounts: [] }
}

/**
 * 把账号记录里的端点收敛到可用值。
 *
 * 只放行官方域和本机回环，其余一律回落默认端点 —— 这些值本来也用不了，
 * 留着只会让账号在池里被判非法、让面板反复显示"baseURL 不被允许"。
 */
function healBaseURL(value) {
  if (typeof value === 'string' && value !== '' && isAllowedBaseURL(value)) return value
  return DEFAULT_BASE_URL
}

function readStore() {
  let raw
  try {
    raw = fs.readFileSync(stateFile(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore()
    throw error
  }
  // 文件存在但损坏时必须报错。把它当成空池会让后续导入静默覆盖原账号。
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`账号存储已损坏，未做任何修改：${stateFile()}（${error?.message ?? error}）`)
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) {
    throw new Error(`账号存储格式无效，未做任何修改：${stateFile()}`)
  }
  // 历史记录里的 baseURL 可能是 missing（undefined 序列化被丢掉）、空串、
  // 或者早期版本写进去的脏值。三种都收敛到官方默认端点：否则账号会被判成非法，
  // 池里 0 个成员、面板上永远挂着一句"baseURL 不被允许"。
  const accounts = parsed.accounts
    .filter((account) => account && typeof account === 'object')
    .map((account) => ({
      ...account,
      baseURL: healBaseURL(account.baseURL),
    }))
  return { version: 1, updatedAt: Number(parsed.updatedAt) || 0, accounts }
}

function writeStore(store, { stripTokensFor = null } = {}) {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  // 只有已经确认写入凭据服务的路由才允许剥离 token；
  // 迁移失败/服务未就绪时保留旧值，宁可留明文也不能丢凭据。
  const accounts = (Array.isArray(store.accounts) ? store.accounts : []).map((account) => {
    if (stripTokensFor?.has(account.route)) {
      const { token, accessToken, access_token, refreshToken, apiKey, api_key, ...rest } = account
      return rest
    }
    return account
  })
  const payload = JSON.stringify({ ...store, accounts, version: 1, updatedAt: Date.now() }, null, 2)
  try {
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch {}
    throw error
  }
}

// ---------------------------------------------------------------- 账号解析

function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

function looksEncrypted(value) {
  return value !== null && typeof value === 'object' && (value.wbEncrypted !== undefined || value.$wbEncrypted !== undefined || typeof value.envelope === 'string')
}

/** 把用户可能填成完整 chat 端点或带尾斜杠的 baseURL 规范成 API 根。 */
function normalizeBaseURL(value) {
  const raw = firstString(value)
  if (raw === undefined) return undefined
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    const suffix = '/chat/completions'
    let pathname = parsed.pathname.replace(/\/+$/, '')
    if (pathname.toLowerCase().endsWith(suffix)) pathname = pathname.slice(0, -suffix.length)
    parsed.pathname = pathname
    parsed.search = ''
    parsed.hash = ''
    const normalized = parsed.href.replace(/\/$/, '')
    return isAllowedBaseURL(normalized) ? normalized : undefined
  } catch {
    return undefined
  }
}

/** 从任意粘贴文本里切出顶层 JSON 值（对象或数组），容忍前后缀文字与多个对象拼接。 */
export function extractJsonBlocks(text) {
  const blocks = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}' || char === ']') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        blocks.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return blocks
}

const TOKEN_FIELDS = ['accessToken', 'access_token', 'token', 'apiKey', 'api_key', 'key']

function objectHasToken(value) {
  if (TOKEN_FIELDS.some((field) => value[field] !== undefined)) return true
  const auth = value.auth
  return auth !== null && typeof auth === 'object' && !Array.isArray(auth) && TOKEN_FIELDS.some((field) => auth[field] !== undefined)
}

/**
 * 把一段文本解析成「候选账号对象」列表。
 *
 * 桌面端的 `.info` 既可能是数组，也可能是 `{ users: { "邮箱": { accessToken } } }`
 * 这类 map，甚至嵌在 data/state 等任意层级里，所以这里做通用递归：
 * 只要某个对象自己（或它的 auth 子对象）带 token 字段，就当成一个账号。
 * 祖先对象上的标量字段会合并进来，避免 uid/nickname 在上一层时丢失。
 */
export function collectAccountObjects(text) {
  const candidates = []
  const seen = new Set()
  const walk = (value, ancestors, keyHint) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, ancestors, undefined)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    // 整个文件被加密成信封：交给 normalizeAccount 给出可操作提示
    if (value.$wbEncrypted === 1 && typeof value.envelope === 'string') {
      candidates.push(value)
      return
    }
    if (objectHasToken(value)) {
      const merged = {}
      for (const ancestor of ancestors) {
        for (const [key, item] of Object.entries(ancestor)) {
          if (item === null || typeof item !== 'object') merged[key] = item
        }
      }
      Object.assign(merged, value)
      if (keyHint !== undefined && merged.keyHint === undefined) merged.keyHint = keyHint
      candidates.push(merged)
      // 同一个对象族不再往下钻，避免同一个 token 被重复收成多个账号
      return
    }
    ancestors.push(value)
    for (const [key, item] of Object.entries(value)) {
      walk(item, ancestors, item !== null && typeof item === 'object' ? key : keyHint)
    }
    ancestors.pop()
  }
  for (const block of extractJsonBlocks(text)) {
    const before = candidates.length
    let parsed
    try {
      parsed = JSON.parse(block)
    } catch {
      continue // 忽略无法解析的片段
    }
    walk(parsed, [], undefined)
    // 一个 token 字段都没找到时，退回原诊断路径：
    // 把最像账号的那一层交出去，由 normalizeAccount 报「没有找到 accessToken」，
    // 而不是笼统地说「没解析出 JSON」。
    if (candidates.length === before) candidates.push(...fallbackCandidates(parsed))
  }
  if (candidates.length === 0) {
    // 允许直接粘贴裸 token 或 `Authorization: Bearer <token>` 头，
    // 方便从浏览器 DevTools 复制后直接导入。
    const bare = extractBareToken(text)
    if (bare !== undefined) candidates.push({ accessToken: bare })
  }
  return candidates
}

/** 从纯文本里抽取一个可以直接当 accessToken 用的字符串。 */
export function extractBareToken(text) {
  if (typeof text !== 'string') return undefined
  const bearer = /Bearer\s+([A-Za-z0-9._~+/-]{20,}={0,2})/i.exec(text)
  if (bearer !== null) return bearer[1]
  const trimmed = text.trim()
  if (/^[A-Za-z0-9._~-]{20,}={0,2}$/.test(trimmed)) return trimmed
  return undefined
}

function fallbackCandidates(parsed) {
  if (parsed === null || typeof parsed !== 'object') return []
  for (const key of ['accounts', 'allAccounts', 'items', 'list', 'data', 'users']) {
    const nested = parsed[key]
    if (Array.isArray(nested) && nested.length > 0 && nested.every((item) => item !== null && typeof item === 'object')) return nested
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      const values = Object.values(nested)
      if (values.length > 0 && values.every((item) => item !== null && typeof item === 'object')) return values
    }
  }
  if (Array.isArray(parsed)) return parsed
  return [parsed]
}

function routeFromToken(token, uid, enterpriseId) {
  // 有稳定 uid 时用 uid + 企业 ID 做身份，token 轮换不会重复建号；
  // 没有 uid 时才退化到 token 派生身份。
  const identity = uid ? `uid:${uid}|enterprise:${enterpriseId ?? ''}` : `token:${token}`
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 8)
  return { route: `wb-${digest}`, claim: `WORKBUDDY_WB_${digest.toUpperCase()}_API_KEY`, id: digest }
}

/**
 * 把一个候选对象归一化成账号记录。
 * @returns {{ ok: true, account: object } | { ok: false, reason: string }}
 */
export function normalizeAccount(source, index) {
  if (source === null || typeof source !== 'object') return { ok: false, reason: '不是一个 JSON 对象' }
  if (source.$wbEncrypted === 1 && typeof source.envelope === 'string') {
    return { ok: false, reason: '整个文件是加密信封（$wbEncrypted + envelope），插件无法解密；请改用 WorkBuddy 生成的 API Key（ck_ 开头），或从网页版复制明文 accessToken' }
  }
  const auth = source.auth !== null && typeof source.auth === 'object' ? source.auth : {}
  const accountInfo = source.account !== null && typeof source.account === 'object' ? source.account : {}

  const rawToken = source.accessToken ?? source.access_token ?? source.token ?? source.apiKey ?? source.api_key ?? source.key ?? auth.accessToken ?? auth.access_token ?? auth.token
  if (looksEncrypted(rawToken)) {
    return { ok: false, reason: '这个文件里的 token 是加密的（$wbEncrypted），需要在 WorkBuddy 里生成 API Key（ck_ 开头）或从网页版复制明文 accessToken' }
  }
  const token = firstString(rawToken, typeof rawToken === 'string' ? rawToken : undefined)
  if (token === undefined) return { ok: false, reason: '没有找到 accessToken / token / apiKey 字段' }
  if (token.length < 16) return { ok: false, reason: 'token 太短，看起来不像有效凭据' }

  const uid = firstString(source.uid, source.userId, source.user_id, source.userUid, accountInfo.uid, accountInfo.userId)
  const enterpriseId = firstString(source.enterpriseId, source.tenantId, accountInfo.enterpriseId)
  const declaredProduct = firstString(source.product, source.accountType, source.type, accountInfo.type)
  const isApiKey = token.startsWith('ck_')
  const product = declaredProduct ?? (isApiKey ? 'SaaS' : 'personal')
  const label = firstString(
    source.name,
    source.nickname,
    source.displayName,
    source.remark,
    typeof accountInfo.nickname === 'string' ? accountInfo.nickname : undefined,
    accountInfo.email,
    source.email,
    // map 结构的键通常是邮箱/uid，作为最后的名称兜底
    typeof source.keyHint === 'string' ? source.keyHint : undefined,
  )
  const name = label ?? `WorkBuddy ${index + 1}`
  const rawBaseURL = firstString(source.baseURL, source.baseUrl, source.endpoint, source.apiBase)
  // 未指定就用默认官方端点；显式给了非法值才拒绝。
  const baseURL = rawBaseURL === undefined ? DEFAULT_BASE_URL : normalizeBaseURL(rawBaseURL)
  if (baseURL === undefined) {
    return { ok: false, reason: 'baseURL 不被允许：只支持 copilot.tencent.com / *.workbuddy.cn / *.tencentbuddy.com 或本机回环地址' }
  }
  const modelFilter = Array.isArray(source.models)
    ? source.models.map((item) => (typeof item === 'string' ? item : item?.id)).filter((id) => typeof id === 'string' && id !== '')
    : undefined

  const { route, claim, id } = routeFromToken(token, uid, enterpriseId)
  return {
    ok: true,
    account: {
      id,
      route,
      credentialRef: claim,
      name,
      token,
      uid: uid ?? null,
      enterpriseId: enterpriseId ?? null,
      product,
      baseURL,
      modelFilter: modelFilter ?? null,
      createdAt: Date.now(),
      lastTest: null,
    },
  }
}

// ---------------------------------------------------------------- 提供商配置

/** DSH（pi-ai）认的思考档位，顺序即升级顺序。 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 把产品目录里的思考档位翻成 DSH 的 `reasoningEfforts`（档位 → 发给上游的值）。
 *
 * DSH 只有看到这个字段才在模型选择器里给出"思考程度"，缺省就当成"模型不推理"，
 * 一个档位都不显示。`off: null` 是官方约定：档位留在列表里，但发请求时不带
 * `reasoning_effort`（等价于关闭思考），所以关思考不需要知道具体参数名。
 */
export function reasoningEffortsFor(model) {
  const levels = Array.isArray(model?.efforts)
    ? model.efforts.filter((level) => THINKING_LEVELS.includes(level) && level !== 'off')
    : []
  if (levels.length === 0) return undefined
  // 只有一个固定档位又不能关思考：没有可选空间，给控件反而更迷惑。
  if (levels.length === 1 && model.canDisable !== true) return undefined
  const efforts = {}
  if (model.canDisable === true) efforts.off = null
  for (const level of levels) efforts[level] = level
  return efforts
}

/**
 * provider 里 `models` 数组的唯一构造点。
 *
 * 池路由和（历史的）每账号路由必须走这里，否则很容易只改到没人调用的那份
 * ——之前 buildProfile / buildPoolProfile 各写一份，改错了地方，思考档位一直不出现。
 */
function profileModels(models) {
  return models.map((model) => {
    const reasoningEfforts = reasoningEffortsFor(model)
    return {
      id: model.id,
      name: model.name,
      ...(model.ctx > 0 ? { contextWindow: model.ctx } : {}),
      ...(model.out > 0 ? { maxTokens: model.out } : {}),
      input: model.img === true ? ['text', 'image'] : ['text'],
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    }
  })
}

// ---------------------------------------------------------------- 余额（积分）

/** 余额缓存：面板先看缓存，点「刷新余额」才真正打接口。 */
const balanceCache = new Map()

/** 账号的 REST 网关 origin：额度接口在根域下，不在 chat 的 /v2 前缀里。 */
function accountOrigin(account) {
  try {
    return new URL(account.baseURL).origin
  } catch {
    return 'https://www.workbuddy.cn'
  }
}

function toCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function balanceHeaders(account) {
  const headers = {
    authorization: `Bearer ${account.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-language': 'zh',
    'x-ide-type': 'WorkBuddy',
    'x-ide-name': 'WorkBuddy',
    'x-private-data': 'true',
    'user-agent': 'WorkBuddy/5.11.3',
  }
  if (account.uid) headers['x-user-id'] = String(account.uid)
  if (account.product) headers['x-product'] = String(account.product)
  return headers
}

function cachedBalance(route) {
  return balanceCache.get(route)?.data ?? null
}

/**
 * 查一个账号的积分余额。
 *
 * 个人账号：POST /billing/meter/get-user-resource-summary
 *   → TotalCredits + CreditGroups[CycleTotalCapacity / CycleRemainCapacity] + SubscriptionPackageName
 * 企业账号：POST /billing/meter/get-enterprise-user-usage（带 X-Enterprise-Id）
 *   → { limitNum, credit, cycleResetTime }
 */
async function fetchBalance(account) {
  if (!isAllowedBaseURL(account.baseURL)) {
    return { ok: false, status: 0, fetchedAt: Date.now(), source: 'personal', message: 'baseURL 不被允许，已拒绝发送账号凭据' }
  }
  const origin = accountOrigin(account)
  const fetchedAt = Date.now()
  const headers = balanceHeaders(account)
  try {
    if (account.enterpriseId) {
      headers['x-enterprise-id'] = String(account.enterpriseId)
      headers['x-tenant-id'] = String(account.enterpriseId)
      const response = await fetch(`${origin}/billing/meter/get-enterprise-user-usage`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(15000),
      })
      const text = await response.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      const row = parsed?.data?.data ?? parsed?.data ?? parsed
      const limit = toCount(row?.limitNum)
      if (response.ok && row !== undefined && row !== null && limit > 0) {
        const used = toCount(row?.credit)
        return {
          ok: true,
          status: response.status,
          fetchedAt,
          source: 'enterprise',
          plan: '企业版',
          paid: true,
          total: limit,
          remain: Math.max(0, limit - used),
          used,
          groups: [],
          resetAt: row?.cycleResetTime ? Date.parse(row.cycleResetTime) || null : null,
        }
      }
      return { ok: false, status: response.status, fetchedAt, source: 'enterprise', message: upstreamHint(response.status, text.slice(0, 200)) }
    }

    const response = await fetch(`${origin}/billing/meter/get-user-resource-summary`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(15000),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const data = parsed?.data
    if (!response.ok || parsed === null || parsed.code !== 0 || data === undefined || data === null) {
      return { ok: false, status: response.status, fetchedAt, source: 'personal', message: upstreamHint(response.status, text.slice(0, 200)) }
    }
    const groups = (Array.isArray(data.CreditGroups) ? data.CreditGroups : [])
      .map((group) => ({
        kind: String(group?.Kind ?? ''),
        name: String(group?.Name ?? group?.Kind ?? ''),
        total: toCount(group?.CycleTotalCapacity),
        remain: toCount(group?.CycleRemainCapacity),
        used: toCount(group?.CycleUsedCapacity),
      }))
      .filter((group) => group.total > 0 || group.remain > 0 || group.used > 0)
    const packages = Array.isArray(data.Packages) ? data.Packages : []
    const total = toCount(data.TotalCredits) || packages.reduce((sum, row) => sum + toCount(row?.CycleTotalCapacity), 0)
    const groupRemain = groups.reduce((sum, group) => sum + group.remain, 0)
    const remain = groups.length > 0 ? (total > 0 ? Math.min(total, groupRemain) : groupRemain) : packages.reduce((sum, row) => sum + toCount(row?.CycleRemainCapacity), 0)
    return {
      ok: true,
      status: response.status,
      fetchedAt,
      source: 'personal',
      plan: String(data.SubscriptionPackageName ?? ''),
      paid: data.IsPaidUser === true,
      total,
      remain,
      used: Math.max(0, total - remain),
      groups,
    }
  } catch (error) {
    return { ok: false, status: 0, fetchedAt, source: 'personal', message: `查询余额失败：${redactSecret(error?.message ?? error)}` }
  }
}

function maskToken(token) {
  return typeof token === 'string' && token !== '' ? '••••••••' : ''
}

function publicAccount(account, catalog, token) {
  const models = selectModels(catalog.models, account.modelFilter)
  return {
    id: account.id,
    route: account.route,
    name: account.name,
    uid: account.uid,
    product: account.product,
    baseURL: account.baseURL,
    token: maskToken(token),
    credentialRef: account.credentialRef,
    credentialMissing: !token,
    baseURLAllowed: isAllowedBaseURL(account.baseURL),
    modelCount: models.length,
    friendlyCount: models.filter((model) => model.friendly === true).length,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      credits: model.credits ?? '',
      friendly: model.friendly === true,
      thinkingOnly: model.onlyReasoning === true && model.canDisable !== true,
      efforts: Array.isArray(model.efforts) ? model.efforts : [],
    })),
    modelFilter: account.modelFilter,
    createdAt: account.createdAt,
    lastTest: account.lastTest ?? null,
    balance: cachedBalance(account.route) ?? account.lastBalance ?? null,
  }
}

// ---------------------------------------------------------------- HTTP 工具

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function parseHostHeader(host) {
  if (typeof host !== 'string' || host === '') return null
  // 显式解析，避免 new URL('http://127.0.0.1#@evil') 把 fragment 当成 host 的绕过。
  const match = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(host)
  if (match === null) return null
  return { hostname: match[1].toLowerCase(), port: match[2] === undefined ? null : Number(match[2]) }
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 同源检查：真实对端、Host 语法/端口、Origin 三层都必须是本机面板。 */
function sameOrigin(request) {
  const remoteAddress = request.socket?.remoteAddress
  if (typeof remoteAddress === 'string' && remoteAddress !== '' && !isLoopbackAddress(remoteAddress)) return false
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') return false
  const host = parseHostHeader(request.headers.host)
  if (host === null || !isLoopbackHostname(host.hostname)) return false
  const localPort = request.socket?.localPort
  if (host.port !== null && typeof localPort === 'number' && host.port !== localPort) return false
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      const parsed = new URL(origin)
      const originHost = parseHostHeader(parsed.host)
      if (originHost === null || !isLoopbackHostname(originHost.hostname)) return false
      if (originHost.hostname !== host.hostname || originHost.port !== host.port) return false
    } catch {
      return false
    }
  }
  return true
}

function redactSecret(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, '[redacted-jwt]')
    .replace(/ck_[A-Za-z0-9._-]{8,}/gi, '[redacted-key]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted-hex]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted-secret]')
}

function safeSecretEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function joinUrl(baseURL, suffix) {
  const trimmed = baseURL.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}${suffix}`
}

// ---------------------------------------------------------------- 插件入口

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const remotePanel = createRemotePanel(config.remotePanel)
  const remotePanelToken = remotePanel === null ? null : randomBytes(32).toString('hex')
  let connectionContext
  if (remotePanel !== null) {
    ctx.inject(['connection'], (child) => { connectionContext = child })
  }
  const namespace = typeof config.settingsNamespace === 'string' && config.settingsNamespace !== '' ? config.settingsNamespace : DEFAULT_NAMESPACE

  // 破甲层：与 dsh-purge 融合。持久化开关落在 ~/.dsh/workbuddy/settings.json。
  const jailbreakFile = path.join(dshHome(), 'workbuddy', 'settings.json')
  const jailbreak = {
    enabled: config.jailbreak !== false,
    mode: typeof config.jailbreakMode === 'string' ? config.jailbreakMode : 'auto',
    userTail: config.jailbreakUserTail !== false,
    lastAdded: 0,
    lastAt: 0,
  }
  try {
    const stored = JSON.parse(fs.readFileSync(jailbreakFile, 'utf8'))
    if (typeof stored?.jailbreak === 'boolean') jailbreak.enabled = stored.jailbreak
    if (typeof stored?.jailbreakMode === 'string') jailbreak.mode = stored.jailbreakMode
    if (typeof stored?.jailbreakUserTail === 'boolean') jailbreak.userTail = stored.jailbreakUserTail
  } catch {
    // 没有配置文件时用默认值
  }
  function persistJailbreak() {
    try {
      fs.mkdirSync(path.dirname(jailbreakFile), { recursive: true })
      fs.writeFileSync(
        jailbreakFile,
        JSON.stringify({ jailbreak: jailbreak.enabled, jailbreakMode: jailbreak.mode, jailbreakUserTail: jailbreak.userTail }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch (error) {
      logger.warn?.(`workbuddy: 保存破甲开关失败（${error?.message ?? error}）`)
    }
  }

  // 渠道校验 + 破甲守卫：只改写发往 WorkBuddy 网关的 chat/completions 请求。
  const guard = installFetchGuard(logger, {
    key: 'dsh-workbuddy',
    injectSystem: (system) => {
      const purgeText = jailbreak.enabled ? readPurgeText() : ''
      return injectPurge(system, { enabled: jailbreak.enabled, mode: jailbreak.mode, purgeText }).system
    },
    injectSystemParts: (content) => {
      const purgeText = jailbreak.enabled ? readPurgeText() : ''
      return injectPurgeParts(content, { enabled: jailbreak.enabled, mode: jailbreak.mode, purgeText }).content
    },
    onInjected: (addedChars) => {
      jailbreak.lastAdded = addedChars
      jailbreak.lastAt = Date.now()
    },
    injectUserTail: (text) => injectUserTail(text, jailbreak.enabled && jailbreak.userTail !== false),
    onInjectError: (error) => logger.warn?.(`workbuddy: 破甲注入跳过（${error?.message ?? error}）`),
  })
  ctx.effect(() => () => guard.dispose(), 'workbuddy: fetch guard')

  const services = { settings: undefined, credentials: undefined }
  ctx.inject(['settings', 'credentials'], (child) => {
    services.settings = child.settings
    services.credentials = child.credentials
    // 服务就绪的这一刻最靠得住：比 queueMicrotask 稳，也省掉等待定时器。
    // 延到下一个宏任务再挂：inject 可能同步回调，此时下面的 boot 还没初始化。
    setTimeout(() => { void boot('inject') }, 0)
  })

  // 本地面板与账号池各自一把随机 key。面板 key 落 0600 文件，池 key 每次
  // 启动重新生成并通过 DSH credentials 交给 provider，不写入账号文件。
  const httpTokenFile = path.join(dshHome(), 'workbuddy', 'http-token')
  let httpToken = ''
  try {
    fs.mkdirSync(path.dirname(httpTokenFile), { recursive: true })
    // 每次 apply 轮换，tmp+rename 原子替换；符号链接会连同链接一起被替换。
    httpToken = randomBytes(32).toString('hex')
    const httpTokenTmp = `${httpTokenFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    fs.writeFileSync(httpTokenTmp, httpToken, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(httpTokenTmp, httpTokenFile)
    try { fs.chmodSync(httpTokenFile, 0o600) } catch {}
  } catch (error) {
    httpToken = randomBytes(32).toString('hex')
    logger.warn?.(`workbuddy: 本地面板鉴权文件不可用，使用临时 key（${error?.message ?? error}）`)
  }
  const poolKey = randomBytes(32).toString('hex')

  function requestAuthorized(request, expectedToken) {
    const header = request.headers?.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    return safeSecretEqual(header.slice(7), expectedToken)
  }

  async function remotePanelRejection(request, routePath) {
    const expectedMethod = REMOTE_PANEL_METHODS.get(routePath)
    if (!expectedMethod || !remotePanel.trustedRequest(request)) return 403
    if (expectedMethod !== request.method) return 405
    if (process.env.DSH_SKIP_AUTH === '1') return 401
    try {
      const connection = connectionContext?.connection
      if (typeof connection?.requestRejection !== 'function') return 401
      const rejection = connection.requestRejection(request)
      if (rejection !== undefined) return rejection === 403 ? 403 : 401
    } catch {
      return 401
    }
    return await remotePanel.verifyAccess(request) ? undefined : 403
  }

  // token 只存在进程内存里。写盘由 writeStore 统一剥离。
  const tokenCache = new Map()
  const credentialWarnings = new Map()
  const migratedRoutes = new Set()
  let hydrated = false
  let hydratePromise = null

  function persistStore(store, options = {}) {
    return writeStore(store, { ...options, stripTokensFor: migratedRoutes })
  }

  function credentialRefFor(account) {
    if (typeof account.credentialRef === 'string' && account.credentialRef !== '') return account.credentialRef
    return `WORKBUDDY_${String(account.route ?? 'account').replace(/[^a-z0-9]/gi, '_').toUpperCase()}_API_KEY`
  }

  function credentialValue(value) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (value !== null && typeof value === 'object') {
      for (const key of ['value', 'secret', 'token', 'apiKey']) {
        if (typeof value[key] === 'string' && value[key].trim() !== '') return value[key].trim()
      }
    }
    return undefined
  }

  async function readCredential(ref) {
    const credentials = services.credentials
    if (credentials === undefined) throw new Error('凭据服务未就绪')
    for (const method of ['resolve', 'get', 'read']) {
      if (typeof credentials[method] === 'function') {
        return credentialValue(await credentials[method](ref))
      }
    }
    throw new Error('DSH 凭据服务未提供读取接口')
  }

  /** 把旧 accounts.json 里的明文 token 一次性搬进凭据服务。 */
  async function ensureHydrated(force = false) {
    if (hydrated && !force) return true
    if (hydratePromise !== null) return hydratePromise
    hydratePromise = (async () => {
      let store
      try {
        store = readStore()
      } catch (error) {
        credentialWarnings.set('__store__', '账号存储不可读，未做任何修改')
        hydrated = true
        return false
      }
      if (store.accounts.length === 0) {
        hydrated = true
        return true
      }
      if (services.credentials === undefined) {
        for (const account of store.accounts) {
          if (typeof account.token === 'string' && account.token !== '') tokenCache.set(account.route, account.token)
        }
        credentialWarnings.set('__service__', 'DSH 凭据服务未就绪，token 仍留在旧文件中')
        return false
      }
      const migratedNow = new Map()
      let complete = true
      for (const account of store.accounts) {
        const ref = credentialRefFor(account)
        account.credentialRef = ref
        const legacy = typeof account.token === 'string' && account.token.trim() !== '' ? account.token.trim() : undefined
        if (legacy !== undefined) {
          try {
            await services.credentials.set(ref, legacy)
            tokenCache.set(account.route, legacy)
            migratedRoutes.add(account.route)
            migratedNow.set(account.route, legacy)
            credentialWarnings.delete(account.route)
          } catch (error) {
            tokenCache.set(account.route, legacy)
            credentialWarnings.set(account.route, `迁移到凭据服务失败：${redactSecret(error?.message ?? error)}`)
            complete = false
          }
          continue
        }
        try {
          const token = await readCredential(ref)
          if (token === undefined) {
            tokenCache.delete(account.route)
            credentialWarnings.set(account.route, '凭据服务里找不到这个账号的 token')
            complete = false
          } else {
            tokenCache.set(account.route, token)
            credentialWarnings.delete(account.route)
          }
        } catch (error) {
          tokenCache.delete(account.route)
          credentialWarnings.set(account.route, `读取凭据失败：${redactSecret(error?.message ?? error)}`)
          complete = false
        }
      }
      if (migratedNow.size > 0) {
        // 凭据写入期间允许 import/remove 进入；只合并迁移成功的账号，
        // 不能拿整份旧快照覆盖新账号或复活已删除账号。
        await serializeStoreMutation(async () => {
          const latest = readStore()
          let changed = false
          for (const [route, legacy] of migratedNow) {
            const row = latest.accounts.find((account) => account.route === route)
            if (row === undefined) continue
            if (row.token !== undefined && row.token !== legacy) continue // 已被新导入替换
            if (row.token !== undefined) { delete row.token; changed = true }
            if (!row.credentialRef) { row.credentialRef = credentialRefFor(row); changed = true }
          }
          if (changed) persistStore(latest)
        })
      }
      hydrated = complete
      return complete
    })().finally(() => {
      hydratePromise = null
    })
    return hydratePromise
  }

  /** 池子只拿到当前有 token 的账号；缺凭据的账号在面板里显式标出。 */
  function poolAccounts() {
    return readStore().accounts
      .filter((account) => isAllowedBaseURL(account.baseURL))
      .map((account) => ({ ...account, token: tokenCache.get(account.route) }))
      .filter((account) => typeof account.token === 'string' && account.token !== '')
  }

  // 账号池：一个 provider 后面挂所有账号。启动中的 Promise 也共享，
  // 否则自动恢复与手动 apply 并发时会监听多个端口，并留下无法释放的孤儿池。
  let pool = null
  let poolStarting = null
  ctx.effect(() => () => {
    const current = pool
    const starting = poolStarting
    pool = null
    poolStarting = null
    if (current) current.dispose?.()
    else starting?.then((pending) => pending.dispose()).catch(() => {})
  }, 'workbuddy: account pool')

  /** 找到真正承载 providers 字典的 settings 命名空间。 */
  function resolveNamespace() {
    const settings = services.settings
    if (settings === undefined) return undefined
    let rows = []
    try {
      rows = settings.describe?.({ redactSecrets: true }) ?? []
    } catch {
      rows = []
    }
    const hasProviders = (row) => {
      try {
        return JSON.stringify(row?.schema ?? {}).includes('"providers"')
      } catch {
        return false
      }
    }
    const preferred = rows.find((row) => row?.ns === namespace && hasProviders(row))
    if (preferred !== undefined) return preferred.ns
    const anyProviders = rows.find((row) => hasProviders(row))
    return anyProviders?.ns
  }

  function currentCatalog() {
    return loadCatalog()
  }

  // ---------------------------------------------------------------- 账号池

  /** 池内所有账号可用模型的并集（同名去重，保留 friendly 标记）。 */
  function unionModels(catalog) {
    const map = new Map()
    for (const account of poolAccounts()) {
      for (const model of selectModels(catalog.models, account.modelFilter)) {
        if (!map.has(model.id)) map.set(model.id, model)
      }
    }
    return [...map.values()]
  }

  /** 当前 provider 配置里已有哪些路由（用来清理旧的每账号路由）。 */
  function configuredRoutes(ns) {
    try {
      const rows = services.settings?.describe?.({ redactSecrets: true }) ?? []
      const row = rows.find((item) => item.ns === ns)
      return Object.keys(row?.value?.providers ?? {})
    } catch {
      return []
    }
  }

  function buildPoolProfile(url, models) {
    return {
      displayName: 'WorkBuddy',
      api: 'openai-completions',
      baseURL: url,
      apiKeyEnv: poolKeyRef(url),
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
      },
      defaultContextWindow: 262144,
      defaultMaxTokens: 32768,
      timeoutMs: 600000,
      streamIdleTimeoutMs: 300000,
      models: profileModels(models),
    }
  }

  /** 启动（或复用）本地账号池。 */
  async function ensurePool() {
    if (pool !== null) {
      pool.refresh()
      return pool
    }
    if (poolStarting === null) {
      poolStarting = startPool({ getAccounts: poolAccounts, logger, authKey: poolKey, validateBaseURL: isAllowedBaseURL })
        .then((started) => {
          pool = started
          return started
        })
        .finally(() => {
          poolStarting = null
        })
    }
    return poolStarting
  }

  /**
   * 把「所有账号」写成一个 provider：DSH 里只出现 WorkBuddy 这一家，
   * 模型是池内并集，请求由本地池挑账号转发。
   */
  async function applyPool(catalog) {
    const settings = services.settings
    const credentials = services.credentials
    if (settings === undefined || credentials === undefined) throw new Error('DSH 的 settings / credentials 服务还没就绪，稍后再试')
    await ensureHydrated()
    const ns = resolveNamespace()
    if (ns === undefined) throw new Error(`没有找到带 providers 的 settings 命名空间（期望 ${namespace}）`)

    const store = readStore()
    const existing = configuredRoutes(ns)
    // 只清理由旧版本创建的 wb-<hash> 每账号路由；其他 provider 属于用户，不能动。
    const staleRoutes = existing.filter((route) => /^wb-[a-f0-9]{8}$/i.test(route))

    if (store.accounts.length === 0) {
      // 最后一个账号被删除后，provider、pool 凭据和监听端口都必须一起退场。
      tokenCache.clear()
      const current = pool
      pool = null
      const refs = new Set([POOL_KEY_REF])
      if (typeof current?.url === 'string') refs.add(poolKeyRef(current.url))
      if (current) await current.dispose()
      for (const ref of refs) {
        try {
          await credentials.unset(ref)
        } catch {
          // 凭据可能本来就不存在；provider 仍应继续清理。
        }
      }
      const ops = []
      if (existing.includes(POOL_ROUTE)) ops.push({ op: 'unset', path: ['providers', POOL_ROUTE] })
      for (const route of staleRoutes) ops.push({ op: 'unset', path: ['providers', route] })
      if (ops.length > 0) await settings.mutate(ns, ops)
      return { namespace: ns, accounts: 0, models: 0, url: null, cleaned: ops.length }
    }

    const models = unionModels(catalog)
    if (models.length === 0) throw new Error('池内账号的模型过滤没有匹配到任何模型；检查 modelFilter 或本机产品目录')

    const active = await ensurePool()
    await credentials.set(poolKeyRef(active.url), poolKey)

    const ops = [{ op: 'set', path: ['providers', POOL_ROUTE], value: buildPoolProfile(active.url, models) }]
    for (const route of staleRoutes) ops.push({ op: 'unset', path: ['providers', route] })
    await settings.mutate(ns, ops)

    return { namespace: ns, accounts: store.accounts.length, models: models.length, url: active.url, cleaned: staleRoutes.length }
  }

  async function removeAccount(account) {
    const credentials = services.credentials
    tokenCache.delete(account.route)
    credentialWarnings.delete(account.route)
    migratedRoutes.delete(account.route)
    if (credentials !== undefined) {
      try {
        await credentials.unset(credentialRefFor(account))
      } catch {
        // 凭据可能本来就不存在
      }
    }
  }

  async function testAccount(account, catalog, override = {}) {
    if (!isAllowedBaseURL(account.baseURL)) {
      return { ok: false, status: 0, ms: 0, model: '', snippet: '', message: 'baseURL 不被允许，已拒绝发送账号凭据' }
    }
    const models = selectModels(catalog.models, account.modelFilter)
    const wanted = typeof override.model === 'string' && override.model !== '' ? override.model : undefined
    const modelId = wanted ?? models[0]?.id ?? 'glm-5.3-flash'
    // 诊断用：允许调用方塞一段 system 文本，用来复现「渠道校验」到底卡在哪句。
    const systemText = typeof override.system === 'string' ? override.system : ''
    const promptText = typeof override.prompt === 'string' && override.prompt !== '' ? override.prompt : 'ping'
    const messages = systemText === ''
      ? [{ role: 'user', content: promptText }]
      : [{ role: 'system', content: systemText }, { role: 'user', content: promptText }]
    const headers = {
      authorization: `Bearer ${account.token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-request-id': `dsh-wb-${Date.now().toString(16)}`,
      'x-dsh-workbuddy-probe': '1',
    }
    if (account.uid) headers['x-user-id'] = String(account.uid)
    if (account.product) headers['x-product'] = String(account.product)
    if (account.enterpriseId) headers['x-enterprise-id'] = String(account.enterpriseId)
    const started = Date.now()
    try {
      const response = await fetch(joinUrl(account.baseURL, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          stream: true,
          max_tokens: 16,
          messages,
        }),
        signal: AbortSignal.timeout(25000),
      })
      const text = await response.text().catch(() => '')
      const ms = Date.now() - started
      const snippet = redactSecret(text.replace(/\s+/g, ' ').slice(0, 400))
      return {
        ok: response.ok,
        status: response.status,
        ms,
        model: modelId,
        snippet,
        message: response.ok ? `连接正常（${modelId}，${ms}ms）` : upstreamHint(response.status, snippet),
      }
    } catch (error) {
      return { ok: false, status: 0, ms: Date.now() - started, model: modelId, snippet: '', message: `连接失败：${redactSecret(error?.message ?? error)}` }
    }
  }

  function upstreamHint(status, snippet) {
    if (status === 401 || status === 403) return '鉴权失败：accessToken 过期或不是这个账号的（JWT 约 60 天有效期），请重新复制一次'
    if (status === 429) return '触发限流：这个账号请求太密，稍后再试或换账号'
    if (status === 404) return '端点不存在：确认 baseURL 是 https://copilot.tencent.com/v2'
    return `上游返回 HTTP ${status}：${redactSecret(snippet) || '（无内容）'}`
  }

  async function statePayload() {
    await ensureHydrated()
    const catalog = currentCatalog()
    const store = readStore()
    return {
      ok: true,
      namespace: resolveNamespace() ?? null,
      serviceReady: services.settings !== undefined && services.credentials !== undefined,
      startup: bootState,
      storePath: stateFile(),
      defaultBaseURL: DEFAULT_BASE_URL,
      security: {
        poolAuth: true,
        credentialWarnings: [...credentialWarnings].map(([route, message]) => ({ route, message })),
      },
      pool: {
        route: POOL_ROUTE,
        displayName: 'WorkBuddy',
        url: pool?.url ?? null,
        accounts: store.accounts.length,
        models: unionModels(catalog).length,
        detail: pool?.stats?.() ?? null,
      },
      guard: guard.stats(),
      jailbreak: {
        enabled: jailbreak.enabled,
        mode: jailbreak.mode,
        userTail: jailbreak.userTail,
        purgeChars: jailbreak.enabled ? readPurgeText().length : 0,
        lastAddedChars: jailbreak.lastAdded,
        lastAddedTokens: estimateTokens(jailbreak.lastAdded),
        lastAt: jailbreak.lastAt || null,
      },
      catalog: { source: catalog.source, path: catalog.path ?? null, count: catalog.models.length, models: catalog.models },
      accounts: store.accounts.map((account) => publicAccount(account, catalog, tokenCache.get(account.route))),
    }
  }

  const routes = []

  // accounts.json 的读-改-写必须串行。网络请求期间仍允许其他请求进入，
  // 但它们会排队，不能拿着旧 store 快照覆盖刚完成的导入或删除。
  let storeQueue = Promise.resolve()
  let storeLockDepth = 0
  function serializeStoreMutation(operation) {
    // hydration 可能在 import 的锁内被再次调用，必须可重入，否则会自锁。
    if (storeLockDepth > 0) {
      storeLockDepth += 1
      return Promise.resolve().then(operation).finally(() => { storeLockDepth -= 1 })
    }
    const run = storeQueue.then(async () => {
      storeLockDepth += 1
      try {
        return await operation()
      } finally {
        storeLockDepth -= 1
      }
    })
    storeQueue = run.catch(() => {})
    return run
  }

  // 面板端口由 DSH 动态分配（实测见过 2747），外部脚本没法猜。每个请求的 Host
  // 头都带着真实端口，顺手记进 endpoint.json，导入脚本下次直接读，不用试探。
  const endpointFile = path.join(dshHome(), 'workbuddy', 'endpoint.json')
  let notedPort = 0
  function notePort(request) {
    const match = String(request.headers?.host ?? '').match(/:(\d+)$/)
    const port = match ? Number(match[1]) : 0
    if (!port || port === notedPort) return
    notedPort = port
    try {
      fs.mkdirSync(path.dirname(endpointFile), { recursive: true })
      fs.writeFileSync(
        endpointFile,
        JSON.stringify({ host: '127.0.0.1', port, pid: process.pid, updatedAt: Date.now() }, null, 2),
        { encoding: 'utf8', mode: 0o644 },
      )
    } catch {
      // 记不下端口不影响功能，脚本仍会自动探测
    }
  }

  const register = (kind, routePath, handler) => {
    const spec = {
      kind,
      path: routePath,
      handler: async (request, response) => {
        const remote = remotePanel?.matchesHost(request) === true
        if (remote) {
          response.setHeader('Cache-Control', 'no-store')
          const rejection = await remotePanelRejection(request, routePath)
          if (rejection !== undefined) {
            const error = rejection === 401 ? 'DSH browser login required'
              : rejection === 405 ? 'method not allowed' : 'remote panel request refused'
            json(response, rejection, { ok: false, error })
            return
          }
        } else {
          if (!sameOrigin(request)) {
            json(response, 403, { ok: false, error: 'cross-site request refused' })
            return
          }
          notePort(request)
        }
        const panelToken = remote ? remotePanelToken : httpToken
        // 面板启动时通过带自定义头的同源请求换取本次加载（含热重载）的 token，重启/重载即失效；
        // 其他所有接口都必须带 bearer，防止跨站页面直接调写接口。
        if (routePath !== '/workbuddy/session' && !requestAuthorized(request, panelToken)) {
          json(response, 401, { ok: false, error: '本地面板鉴权失败' })
          return
        }
        try {
          await handler(request, response, panelToken)
        } catch (error) {
          logger.warn?.(`workbuddy: ${routePath} failed: ${redactSecret(error?.stack ?? error)}`)
          if (!response.headersSent) json(response, 500, { ok: false, error: redactSecret(error?.message ?? error) })
          else response.end()
        }
      },
    }
    routes.push(ctx.effect(() => ctx.webServer.register(spec)))
  }

  register('exact', '/workbuddy/session', async (request, response, panelToken) => {
    if (request.headers['x-dsh-workbuddy-panel'] !== '1') {
      json(response, 403, { ok: false, error: 'panel header required' })
      return
    }
    json(response, 200, { ok: true, token: panelToken })
  })

  register('exact', '/workbuddy/state', async (request, response) => {
    json(response, 200, await statePayload())
  })

  register('exact', '/workbuddy/jailbreak', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    if (typeof body.enabled === 'boolean') jailbreak.enabled = body.enabled
    if (typeof body.mode === 'string' && ['auto', 'always', 'shell'].includes(body.mode)) jailbreak.mode = body.mode
    if (typeof body.userTail === 'boolean') jailbreak.userTail = body.userTail
    persistJailbreak()
    json(response, 200, { ok: true, state: await statePayload() })
  })

  register('exact', '/workbuddy/catalog', (request, response) => {
    const catalog = currentCatalog()
    json(response, 200, { ok: true, source: catalog.source, path: catalog.path ?? null, count: catalog.models.length, models: catalog.models })
  })

  register('exact', '/workbuddy/import', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = await readBody(request)
    let payload = {}
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      json(response, 400, { ok: false, error: '请求体不是 JSON' })
      return
    }
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (text.trim() === '') {
      json(response, 400, { ok: false, error: '没有收到账号 JSON' })
      return
    }
    const replace = payload.replace === true
    const alsoTest = payload.test === true
    const catalog = currentCatalog()
    const candidates = collectAccountObjects(text)
    if (candidates.length === 0) {
      json(response, 400, { ok: false, error: '没解析出任何 JSON 对象，检查粘贴内容' })
      return
    }
    const normalizedCandidates = candidates.map((candidate, index) => normalizeAccount(candidate, index))
    // replace 是破坏性操作：任一候选无效就整次拒绝，绝不先清空原账号。
    if (replace && normalizedCandidates.some((item) => !item.ok)) {
      json(response, 400, {
        ok: false,
        error: 'replace 已取消：存在无效账号，原账号池未做任何修改',
        results: normalizedCandidates.map((item, index) => item.ok
          ? { ok: true, name: item.account.name }
          : { ok: false, name: `#${index + 1}`, error: item.reason }),
      })
      return
    }

    await ensureHydrated()
    await serializeStoreMutation(async () => {
      const store = readStore()
      const byRoute = replace ? new Map() : new Map(store.accounts.map((account) => [account.route, account]))
      const results = []
      for (const normalized of normalizedCandidates) {
        if (!normalized.ok) {
          results.push({ ok: false, name: normalized.account?.name ?? '无效账号', error: normalized.reason })
          continue
        }
        // 兼容旧版本按 token 派生的 route：同 uid + 企业 ID 已存在时沿用旧 route。
        const previous = byRoute.get(normalized.account.route) ?? store.accounts.find((item) => (
          item.uid && normalized.account.uid && item.uid === normalized.account.uid
          && (item.enterpriseId ?? null) === (normalized.account.enterpriseId ?? null)
        ))
        const account = {
          ...normalized.account,
          createdAt: previous?.createdAt ?? Date.now(),
          lastTest: previous?.lastTest ?? null,
          // 只继承"成功过"的余额快照。失败的快照（尤其是旧版本留下的
          // "baseURL 不被允许"）会一直挂在面板上，导入后必须丢掉。
          lastBalance: previous?.lastBalance?.ok === true ? previous.lastBalance : null,
        }
        try {
          const credentialRef = previous?.credentialRef ?? account.credentialRef
          account.credentialRef = credentialRef
          await services.credentials.set(credentialRef, account.token)
          tokenCache.set(account.route, account.token)
          credentialWarnings.delete(account.route)
          migratedRoutes.add(account.route)
          if (previous && previous.route !== account.route) {
            byRoute.delete(previous.route)
            balanceCache.delete(previous.route)
            account.route = previous.route
            tokenCache.delete(normalized.account.route)
            tokenCache.set(account.route, account.token)
            migratedRoutes.delete(normalized.account.route)
            migratedRoutes.add(account.route)
          }
          byRoute.set(account.route, account)
          if (alsoTest) account.lastTest = { ...(await testAccount(account, catalog)), at: Date.now() }
          account.lastBalance = await fetchBalance(account)
          balanceCache.set(account.route, { at: Date.now(), data: account.lastBalance })
          store.accounts = [...byRoute.values()]
          persistStore(store)
          const applied = await applyPool(catalog)
          results.push({
            ok: true,
            name: account.name,
            route: account.route,
            baseURL: account.baseURL,
            models: applied.models,
            accounts: applied.accounts,
            namespace: applied.namespace,
            lastTest: account.lastTest,
            balance: account.lastBalance,
          })
        } catch (error) {
          results.push({ ok: false, name: account.name, route: account.route, error: redactSecret(error?.message ?? error) })
        }
      }
      store.accounts = [...byRoute.values()]
      persistStore(store)
      if (replace) {
        for (const route of balanceCache.keys()) if (!byRoute.has(route)) balanceCache.delete(route)
      }
      json(response, 200, { ok: results.some((item) => item.ok), results, state: await statePayload() })
    })
  })

  register('exact', '/workbuddy/apply', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const catalog = currentCatalog()
    const store = readStore()
    try {
      const applied = await applyPool(catalog)
      json(response, 200, {
        ok: true,
        results: [{ ok: true, name: `池内 ${applied.accounts} 个账号`, route: POOL_ROUTE, models: applied.models, namespace: applied.namespace, url: applied.url, cleaned: applied.cleaned }],
        state: await statePayload(),
      })
    } catch (error) {
      json(response, 500, { ok: false, error: redactSecret(error?.message ?? error), store: store.accounts.length })
    }
  })

  register('exact', '/workbuddy/test', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    await ensureHydrated()
    await serializeStoreMutation(async () => {
      const store = readStore()
      const account = store.accounts.find((item) => item.route === body.route || item.id === body.id)
      if (account === undefined) {
        json(response, 404, { ok: false, error: '没有这个账号' })
        return
      }
      const token = tokenCache.get(account.route)
      if (token === undefined) {
        json(response, 409, { ok: false, error: '这个账号的凭据缺失，请重新导入 token' })
        return
      }
      const result = await testAccount(
        { ...account, token },
        currentCatalog(),
        { system: body.system, prompt: body.prompt, model: body.model },
      )
      account.lastTest = { ...result, at: Date.now() }
      persistStore(store)
      json(response, 200, { ok: result.ok, result, state: await statePayload() })
    })
  })

  register('exact', '/workbuddy/balance', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    await ensureHydrated()
    await serializeStoreMutation(async () => {
      const store = readStore()
      const targets = body.route === undefined || body.route === null
        ? store.accounts
        : store.accounts.filter((item) => item.route === body.route || item.id === body.id)
      if (targets.length === 0) {
        json(response, 404, { ok: false, error: '没有这个账号' })
        return
      }
      const results = []
      for (const account of targets) {
        const token = tokenCache.get(account.route)
        if (token === undefined) {
          results.push({ route: account.route, name: account.name, ok: false, balance: { ok: false, message: '凭据缺失，请重新导入 token' } })
          continue
        }
        const balance = await fetchBalance({ ...account, token })
        account.lastBalance = balance
        balanceCache.set(account.route, { at: Date.now(), data: balance })
        results.push({ route: account.route, name: account.name, ok: balance.ok, balance })
      }
      persistStore(store)
      json(response, 200, { ok: results.every((item) => item.ok), results, state: await statePayload() })
    })
  })

  register('exact', '/workbuddy/remove', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    await ensureHydrated()
    await serializeStoreMutation(async () => {
      const store = readStore()
      const account = store.accounts.find((item) => item.route === body.route || item.id === body.id)
      if (account === undefined) {
        json(response, 404, { ok: false, error: '没有这个账号' })
        return
      }
      await removeAccount(account)
      balanceCache.delete(account.route)
      store.accounts = store.accounts.filter((item) => item !== account)
      persistStore(store)
      let applied = null
      let applyError = null
      try {
        applied = await applyPool(currentCatalog())
      } catch (error) {
        applyError = redactSecret(error?.message ?? error)
      }
      json(response, 200, {
        ok: true,
        removed: account.route,
        accounts: applied?.accounts ?? store.accounts.length,
        models: applied?.models ?? null,
        applyError,
        state: await statePayload(),
      })
    })
  })

  register('exact', '/workbuddy/local', async (request, response) => {
    // 便利入口：本机 WorkBuddy 桌面端登录过的账号（凭据有时是加密的，那就给出说明）。
    const file = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')
    if (!fs.existsSync(file)) {
      json(response, 404, { ok: false, error: `没找到本机 WorkBuddy 登录信息：${file}` })
      return
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const normalized = normalizeAccount(parsed, 0)
      if (!normalized.ok) {
        json(response, 200, { ok: false, file, error: normalized.reason })
        return
      }
      await ensureHydrated()
      await serializeStoreMutation(async () => {
        const store = readStore()
        const previous = store.accounts.find((item) => item.route === normalized.account.route || (
          item.uid && normalized.account.uid && item.uid === normalized.account.uid
          && (item.enterpriseId ?? null) === (normalized.account.enterpriseId ?? null)
        ))
        const credentialRef = previous?.credentialRef ?? normalized.account.credentialRef
        normalized.account.credentialRef = credentialRef
        await services.credentials.set(credentialRef, normalized.account.token)
        tokenCache.set(normalized.account.route, normalized.account.token)
        credentialWarnings.delete(normalized.account.route)
        migratedRoutes.add(normalized.account.route)
        if (previous && previous.route !== normalized.account.route) {
          balanceCache.delete(previous.route)
          tokenCache.delete(normalized.account.route)
          migratedRoutes.delete(normalized.account.route)
          normalized.account.route = previous.route
          tokenCache.set(normalized.account.route, normalized.account.token)
          migratedRoutes.add(normalized.account.route)
        }
        normalized.account.createdAt = previous?.createdAt ?? normalized.account.createdAt
        normalized.account.lastTest = previous?.lastTest ?? null
        normalized.account.lastBalance = previous?.lastBalance?.ok === true ? previous.lastBalance : null
        store.accounts = [...store.accounts.filter((item) => item.route !== normalized.account.route), normalized.account]
        persistStore(store)
        const catalog = currentCatalog()
        const applied = await applyPool(catalog)
        json(response, 200, { ok: true, file, account: normalized.account.name, models: applied.models, accounts: applied.accounts, state: await statePayload() })
      })
    } catch (error) {
      json(response, 500, { ok: false, error: redactSecret(error?.message ?? error) })
    }
  })

  // 启动时把已存的账号重新挂上（DSH 重启后 provider 自动回来）。
  //
  // 两个服务不一定在插件 apply 的同一拍就绪：早期版本只在 queueMicrotask 里试一次，
  // 失败就只剩一条看不见的 warn，结果池子没起、provider 还挂着上次的死端口，
  // 模型选择器看起来"有模型但点不动"。现在改成"服务就绪即挂载 + 定时补挂 +
  // 结果落盘"，出问题能从 last-apply.json 直接看出卡在哪一步。
  const diagFile = path.join(dshHome(), 'workbuddy', 'last-apply.json')
  let booted = false
  let booting = null
  let bootTries = 0
  let bootState = null

  function recordBoot(state) {
    bootState = {
      at: Date.now(),
      settingsReady: services.settings !== undefined,
      credentialsReady: services.credentials !== undefined,
      tries: bootTries,
      ...state,
    }
    try {
      fs.mkdirSync(path.dirname(diagFile), { recursive: true })
      fs.writeFileSync(diagFile, JSON.stringify(bootState, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 诊断文件写不下不影响功能
    }
  }

  function boot(from) {
    if (booted || booting !== null) return booting
    bootTries += 1
    booting = applyPool(currentCatalog())
      .then((applied) => {
        booted = true
        recordBoot({ ok: true, from, accounts: applied.accounts, models: applied.models, url: applied.url })
        if (applied.accounts > 0) {
          logger.info?.(`workbuddy: 账号池已就绪（${applied.accounts} 个账号 · ${applied.models} 个模型 · ${applied.url}）`)
        }
      })
      .catch((error) => {
        const message = redactSecret(error?.message ?? error)
        recordBoot({ ok: false, from, message })
        logger.warn?.(`workbuddy: 恢复账号池失败（${message}）`)
      })
      .finally(() => {
        booting = null
      })
    return booting
  }

  queueMicrotask(() => boot('startup'))
  // settings / credentials 可能晚一拍注入，也可能首次还不可用：每 500ms 补一次，
  // 成功即停，最多 30 次（15 秒）后放弃并留档。
  const bootTicker = setInterval(() => {
    if (booted) {
      clearInterval(bootTicker)
      return
    }
    if (bootTries >= 30) {
      clearInterval(bootTicker)
      return
    }
    boot('ticker')
  }, 500)

  ctx.effect(() => () => {
    clearInterval(bootTicker)
    for (const dispose of routes) {
      try {
        dispose?.()
      } catch {
        // 卸载阶段的失败不影响其他插件
      }
    }
  }, 'workbuddy: routes')
}
