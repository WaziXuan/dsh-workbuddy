/** 官方 WorkBuddy 网关域名与 URL 边界，guard 和账号白名单共用同一份判断。 */
const ALLOWED_HOST = /(^|\.)(copilot\.tencent\.com|workbuddy\.cn|tencentbuddy\.com)$/i

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
