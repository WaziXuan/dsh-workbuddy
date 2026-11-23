/**
 * WorkBuddy 模型目录。
 *
 * 两路来源：
 *  1) 本机 WorkBuddy 客户端落盘的 product config（产品目录，含积分倍率、上下文、是否多模态）；
 *  2) 内置兜底目录（客户端没装 / 目录结构变了时仍能导入）。
 *
 * 只保留「能聊天 + 能调工具」的模型：补全类（codewise-*、completion-*）、
 * 图片/视频生成类、以及纯内部占位（wb-lite、default-1.x）都排除。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 内置兜底目录，来源 WorkBuddy 5.x 的 acc-product-config-v3。 */
export const FALLBACK_MODELS = [
  { id: 'fast-model', name: '快速', credits: 'x0.15', ctx: 300000, out: 48000, img: true },
  { id: 'balanced-model', name: '均衡', credits: 'x0.50', ctx: 300000, out: 48000, img: true },
  { id: 'deep-model', name: '极致', credits: 'x1.00', ctx: 300000, out: 48000, img: true },
  { id: 'hy4flash-free', name: 'Hy4 flash', credits: 'x0.00', ctx: 960000, out: 64000, img: true },
  { id: 'hy4flash', name: 'Hy4 flash', credits: 'x0.03', ctx: 960000, out: 64000, img: true },
  { id: 'hy4std', name: 'Hy4', credits: 'x0.29', ctx: 960000, out: 64000, img: true },
  { id: 'hy4-preview-x', name: 'Hy4 preview', credits: 'x0.29', ctx: 960000, out: 64000, img: true },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', credits: 'x0.11', ctx: 1000000, out: 128000, img: true },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', credits: 'x0.17', ctx: 1000000, out: 50000, img: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', credits: 'x0.51', ctx: 1000000, out: 128000, img: true },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2', credits: 'x0.29', ctx: 96000, out: 32000, img: true },
  { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.69', ctx: 1000000, out: 64000, img: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', credits: 'x0.08', ctx: 1000000, out: 131072, img: true },
  { id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.79', ctx: 1000000, out: 64000, img: true },
  { id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', credits: 'x0.95', ctx: 200000, out: 48000, img: true },
  { id: 'glm-4.6', name: 'GLM-4.6', credits: 'x0.23', ctx: 168000, out: 32000, img: false },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', credits: 'x0.97', ctx: 1000000, out: 32000, img: true },
  { id: 'kimi-k3-1', name: 'Kimi-K3', credits: 'x1.62', ctx: 1000000, out: 32000, img: true },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', credits: 'x0.77', ctx: 1000000, out: 64000, img: true },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', credits: 'x0.45', ctx: 256000, out: 32000, img: true },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', credits: 'x0.08', ctx: 1000000, out: 128000, img: true },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', credits: 'x0.26', ctx: 200000, out: 48000, img: true },
  { id: 'space-bunny', name: 'Space-Bunny', credits: 'x0.08', ctx: 1000000, out: 128000, img: true },
  { id: 'step-5-preview', name: 'Step-5-Preview', credits: 'x0.33', ctx: 1000000, out: 64000, img: true },
  { id: 'hunyuan-chat', name: 'Hunyuan-Turbos', credits: '', ctx: 128000, out: 8192, img: true },
]

/** 内置目录里哪些模型能关掉思考（破甲友好）；其余按"必思考"处理。 */
const FRIENDLY_FALLBACK = new Set([
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'glm-5.2',
  'glm-4.6',
  'kimi-k2.8-preview',
  'hunyuan-chat',
])

function fallbackCatalog() {
  return FALLBACK_MODELS.map((model) => {
    const friendly = FRIENDLY_FALLBACK.has(model.id)
    return { ...model, onlyReasoning: !friendly, canDisable: friendly, friendly }
  })
}

const EXCLUDED_ID = /^(codewise-|completion-|wb-lite$|default$|default-|auto$|hunyuan-3b$|hunyuan-7b|deepseek-v3-0324-taco)/
const EXCLUDED_TAG = /(text-to-image|image-to-image|text-to-video|image-to-video)/

function dataDir() {
  const home = process.env.WORKBUDDY_HOME?.trim() || process.env.CODEBUDDY_CONFIG_DIR?.trim()
  if (home) return home
  return path.join(os.homedir(), '.workbuddy')
}

/** 收集候选 product config 文件，深一点的目录也扫，但限制层数。 */
function candidateFiles(root, depth = 0, out = []) {
  if (depth > 5) return out
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) candidateFiles(full, depth + 1, out)
    else if (entry.name === 'wb-product-config.json' || /^acc-product-config-v3.*\.json$/.test(entry.name)) out.push(full)
  }
  return out
}

function pickModelArray(json) {
  const fromSnapshot = json?.['product-config-snapshot']?.data?.models
  if (Array.isArray(fromSnapshot)) return fromSnapshot
  const direct = json?.data?.models ?? json?.models
  if (Array.isArray(direct)) return direct
  return []
}

/** 把一条产品目录条目归一化成我们需要的字段；不适合聊天则返回 undefined。 */
export function normalizeEntry(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (id === '' || name === '') return undefined
  if (EXCLUDED_ID.test(id)) return undefined
  if (Array.isArray(entry.tags) && entry.tags.some((tag) => EXCLUDED_TAG.test(String(tag)))) return undefined
  if (entry.supportsToolCall === false) return undefined
  if (entry.disabled === true) return undefined
  const ctx = Number(entry.maxInputTokens ?? entry.maxAllowedSize ?? 0) || 0
  const out = Number(entry.maxOutputTokens ?? 0) || 0
  const img = entry.supportsImages === true && entry.disabledMultimodal !== true
  const credits = typeof entry.credits === 'string' ? entry.credits : ''
  // 必思考的模型在思考阶段更容易自我审视，能关掉思考的通常更服从破甲层。
  const onlyReasoning = entry.onlyReasoning === true
  const canDisable = entry.canDisableThinking === true || entry.reasoning?.canDisableThinking === true
  return { id, name, credits, ctx, out, img, onlyReasoning, canDisable, friendly: !onlyReasoning || canDisable }
}

/**
 * 读本机 WorkBuddy 的产品目录。找不到就返回兜底目录。
 *
 * 候选文件里，账号作用域的 `wb-product-config.json` 优先于安装目录下的
 * `acc-product-config-v3*.json` 基础目录：前者是当前账号能真正用的模型清单。
 * @returns {{ source: 'local' | 'fallback', path?: string, models: Array<object> }}
 */
export function loadCatalog() {
  const files = candidateFiles(dataDir())
  let best = { rank: -1, models: [], path: '' }
  for (const file of files) {
    let raw = []
    try {
      raw = pickModelArray(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch {
      continue
    }
    if (raw.length === 0) continue
    const models = []
    const seen = new Set()
    const seenNames = new Set()
    for (const entry of raw) {
      const model = normalizeEntry(entry)
      if (model === undefined || seen.has(model.id)) continue
      // 同一个显示名只留第一条（例如三个 Hy4 preview 变体只留一个）。
      if (seenNames.has(model.name)) continue
      seen.add(model.id)
      seenNames.add(model.name)
      models.push(model)
    }
    if (models.length === 0) continue
    const scoped = path.basename(file) === 'wb-product-config.json'
    const rank = (scoped ? 100000 : 0) + models.length
    if (rank > best.rank) best = { rank, models, path: file }
  }
  if (best.models.length === 0) return { source: 'fallback', models: fallbackCatalog() }
  return { source: 'local', path: best.path, models: best.models }
}

/** 只保留请求里点名的模型 id；只有空数组/未声明才表示全部。 */
export function selectModels(models, wanted) {
  if (!Array.isArray(wanted) || wanted.length === 0) return models
  const allow = new Set(wanted.map((id) => String(id)))
  return models.filter((model) => allow.has(model.id))
}
