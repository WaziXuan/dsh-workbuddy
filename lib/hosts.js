/** 官方 WorkBuddy 网关域名与 URL 边界，guard 和账号白名单共用同一份判断。 */
const ALLOWED_HOST = /(^|\.)(copilot\.tencent\.com|workbuddy\.cn|tencentbuddy\.com|workbuddy\.ai|codebuddy\.ai|codebuddy\.cn)$/i

export function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

export function isOfficialWorkBuddyHost(hostname) {
  return ALLOWED_HOST.test(String(hostname).toLowerCase())
}

export function isAllowedBaseURL(value) {
  // 没写端点表示"用默认的 https://copilot.tencent.com/v2"，等价于放行；
  // 否则历史账号记录里缺 baseURL 字段（undefined 序列化时被丢掉）会被误判成非法。
  if (value === undefined || value === null || value === '') return true
  try {
    const parsed = new URL(String(value))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (parsed.username !== '' || parsed.password !== '') return false
    const host = parsed.hostname.toLowerCase()
    if (isLoopbackHostname(host)) return true
    if (parsed.protocol !== 'https:') return false
    if (parsed.port !== '' && parsed.port !== '443') return false
    return ALLOWED_HOST.test(host)
  } catch {
    return false
  }
}

/**
 * 端点对应的 Origin（`scheme://host[:port]`）。
 *
 * 国际版网关（www.workbuddy.ai 等）会校验 Origin / Referer，缺了就被当成跨站
 * 调用直接拒；国内网关不校验。所以池子只在"非默认端点"上补这两个头。
 *
 * @returns {string|null} 解析失败或非 http(s) 时返回 null
 */
export function originOfBaseURL(value) {
  if (value === undefined || value === null || value === '') return null
  try {
    const parsed = new URL(String(value))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}
