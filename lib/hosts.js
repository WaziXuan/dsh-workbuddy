/** 官方 WorkBuddy 网关域名与 URL 边界，guard 和账号白名单共用同一份判断。 */
const ALLOWED_HOST = /(^|\.)(copilot\.tencent\.com|workbuddy\.cn|tencentbuddy\.com)$/i

export function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

export function isAllowedBaseURL(value) {
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

export function isWorkBuddyChatURL(value) {
  try {
    const parsed = new URL(String(value))
    if (!/\/chat\/completions\/?$/i.test(parsed.pathname)) return false
    if (parsed.username !== '' || parsed.password !== '') return false
    const host = parsed.hostname.toLowerCase()
    if (isLoopbackHostname(host)) return true
    return parsed.protocol === 'https:' && ALLOWED_HOST.test(host)
  } catch {
    return false
  }
}
