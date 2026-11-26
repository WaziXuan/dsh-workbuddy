import { createPublicKey, verify } from 'node:crypto'

const JWT_PART = /^[A-Za-z0-9_-]+$/
const KEY_TTL_MS = 10 * 60 * 1000
const KEY_RETRY_MS = 30 * 1000
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function parsePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

function parseAssertion(assertion, issuer, audience) {
  if (typeof assertion !== 'string' || assertion.length > 8192) return null
  const parts = assertion.split('.')
  if (parts.length !== 3 || parts.some((part) => !JWT_PART.test(part))) return null
  try {
    const header = parsePart(parts[0])
    const claims = parsePart(parts[1])
    const now = Math.floor(Date.now() / 1000)
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (
      header.alg !== 'RS256' || typeof header.kid !== 'string' ||
      !JWT_PART.test(header.kid) || header.kid.length > 128 ||
      claims.iss !== issuer || !audiences.includes(audience) ||
      typeof claims.sub !== 'string' || !claims.sub ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now))
    ) return null
    return { kid: header.kid, signed: parts[0] + '.' + parts[1], signature: parts[2] }
  } catch {
    return null
  }
}

function validateConfig(config) {
  if (config === null || typeof config !== 'object') throw new Error('remotePanel must be an object')
  const { origin, issuer, audience } = config
  if (typeof origin !== 'string') throw new Error('remotePanel.origin must be an HTTPS origin')
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin || url.port) {
    throw new Error('remotePanel.origin must be an HTTPS origin on the default port')
  }
  if (typeof issuer !== 'string' || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)) {
    throw new Error('remotePanel.issuer must be a Cloudflare Access team origin')
  }
  if (typeof audience !== 'string' || !/^[a-f0-9]{64}$/.test(audience)) {
    throw new Error('remotePanel.audience must be the Cloudflare Access application audience')
  }
  return { origin, host: url.host, issuer, audience }
}

export function createRemotePanel(config) {
  if (config === undefined) return null
  const { origin, host, issuer, audience } = validateConfig(config)
  let keys = new Map()
  let expiresAt = 0
  let refreshAfter = 0
  let refreshInProgress = null

  async function loadKeys() {
    const response = await fetch(issuer + '/cdn-cgi/access/certs', {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error('Cloudflare Access keys unavailable')
    const { keys: candidates } = await response.json()
    if (!Array.isArray(candidates)) throw new Error('Invalid Cloudflare Access keys')
    const next = new Map()
    for (const jwk of candidates) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' ||
          (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
          (jwk.use !== undefined && jwk.use !== 'sig')) continue
      const key = createPublicKey({ key: jwk, format: 'jwk' })
      if (key.asymmetricKeyDetails?.modulusLength >= 2048) next.set(jwk.kid, key)
    }
    if (next.size === 0) throw new Error('No Cloudflare Access signing keys')
    keys = next
    expiresAt = Date.now() + KEY_TTL_MS
  }

  async function resolveKey(kid) {
    const now = Date.now()
    if (now < expiresAt && keys.has(kid)) return keys.get(kid)
    if (refreshInProgress === null && now >= refreshAfter) {
      refreshAfter = now + KEY_RETRY_MS
      refreshInProgress = loadKeys().catch(() => {}).finally(() => { refreshInProgress = null })
    }
    if (refreshInProgress !== null) await refreshInProgress
    if (Date.now() < expiresAt) return keys.get(kid)
  }

  return {
    matchesHost: (request) => request.headers.host === host,
    trustedRequest(request) {
      if (!LOOPBACK_ADDRESSES.has(request.socket?.remoteAddress)) return false
      const site = request.headers['sec-fetch-site']
      const sentOrigin = request.headers.origin
      if (site !== undefined && site !== 'same-origin') return false
      if (sentOrigin !== undefined) return sentOrigin === origin
      return request.method === 'GET' && site === 'same-origin'
    },
    async verifyAccess(request) {
      const input = parseAssertion(request.headers['cf-access-jwt-assertion'], issuer, audience)
      if (input === null) return false
      try {
        const key = await resolveKey(input.kid)
        return key !== undefined && verify('RSA-SHA256', Buffer.from(input.signed), key,
          Buffer.from(input.signature, 'base64url'))
      } catch {
        return false
      }
    },
  }
}
