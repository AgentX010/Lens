import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHash, timingSafeEqual } from 'crypto'
import fp from 'fastify-plugin'
import { prisma } from '../db'
import { config } from '../config'
import { api_key_auth_failures_total, api_key_cache_lookups_total } from '../metrics'

type ApiKeyAuthFailureReason = 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired'

/**
 * Metadata for an authenticated API key, attached to each request as
 * `req.apiKey` once the key has been validated.
 */
export interface ApiKeyContext {
  id: string
  label: string
  ratePerMin: number
  ratePerDay: number
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyContext
  }
  interface FastifyContextConfig {
    /** When true, the API-key auth hook skips this route (e.g. health, admin). */
    public?: boolean
  }
}

/** SHA-256 hex digest of a plaintext API key. We only ever store/compare hashes. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** Extracts the bearer token from an Authorization header, or null. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

// ── In-process API-key lookup cache (Issue #495) ────────────────────────────
//
// Authentication runs in an `onRequest` hook, so without a cache every request
// — including ones served entirely from the Redis price cache — pays a Postgres
// round-trip before any work begins, and the API cannot even accept traffic
// when the shared connection pool is slow or exhausted. We cache the lookup,
// keyed by the key hash, for a short TTL (`config.cache.apiKeyTtl` seconds).
//
// Correctness of the sharp edges:
//   • Revocation. The revoke route (admin.ts) calls `invalidateApiKey(hash)`,
//     so a key revoked on THIS instance stops working immediately. A key
//     revoked on another instance keeps working here until its cache entry
//     expires — a worst case of exactly `config.cache.apiKeyTtl` seconds. The
//     test "a revoked key stops working" pins this contract.
//   • Expiry. We store the key's own `expiresAt` and re-check it on every hit
//     (see `evaluate`), so the TTL never extends a key past its expiry.
//   • Negative lookups are cached too. Otherwise an invalid key is a free way
//     to make the API hit Postgres as fast as a client can send requests.
//   • The cache is size-bounded (`MAX_CACHE_ENTRIES`) so a flood of distinct
//     invalid keys cannot grow the negative cache without limit; the oldest
//     entry is evicted once the cap is reached.

/** What we remember about a hash, enough to re-derive the auth result. */
type CachedKey =
  | { found: false }
  | { found: true; revoked: boolean; expiresAt: Date | null; context: ApiKeyContext }

interface CacheEntry {
  /** Epoch ms after which this entry is stale and must be re-read from Postgres. */
  staleAt: number
  value: CachedKey
}

const MAX_CACHE_ENTRIES = 10_000
const apiKeyCache = new Map<string, CacheEntry>()

/** Turns a remembered lookup into an auth result, re-checking expiry at `now`. */
function evaluate(
  value: CachedKey,
  now: number,
): { context: ApiKeyContext | null; failureReason?: ApiKeyAuthFailureReason } {
  if (!value.found) return { context: null, failureReason: 'unknown' }
  if (value.revoked) return { context: null, failureReason: 'revoked' }
  if (value.expiresAt && value.expiresAt.getTime() <= now) {
    return { context: null, failureReason: 'expired' }
  }
  return { context: value.context }
}

function cacheSet(hash: string, value: CachedKey, now: number): void {
  // Re-insert so the Map's insertion order tracks recency, then evict the
  // oldest entries while we are over the cap.
  apiKeyCache.delete(hash)
  apiKeyCache.set(hash, { staleAt: now + config.cache.apiKeyTtl * 1000, value })
  while (apiKeyCache.size > MAX_CACHE_ENTRIES) {
    const oldest = apiKeyCache.keys().next().value
    if (oldest === undefined) break
    apiKeyCache.delete(oldest)
  }
}

/**
 * Drops a key's cached lookup so the next request re-reads it from Postgres.
 * Called on revoke to make revocation effectively immediate on this instance.
 */
export function invalidateApiKey(hash: string): void {
  apiKeyCache.delete(hash)
}

/** Clears the entire lookup cache. Intended for tests. */
export function clearApiKeyCache(): void {
  apiKeyCache.clear()
}

/**
 * Looks up an API key by its plaintext value, returning the key context only
 * when the key exists and has not been revoked or expired.
 */
export async function lookupApiKey(plaintext: string): Promise<ApiKeyContext | null> {
  return (await lookupApiKeyResult(plaintext)).context
}

async function lookupApiKeyResult(
  plaintext: string,
): Promise<{ context: ApiKeyContext | null; failureReason?: ApiKeyAuthFailureReason }> {
  const hash = hashApiKey(plaintext)
  const now = Date.now()

  const cached = apiKeyCache.get(hash)
  if (cached && cached.staleAt > now) {
    api_key_cache_lookups_total.inc({ result: 'hit' })
    return evaluate(cached.value, now)
  }

  api_key_cache_lookups_total.inc({ result: 'miss' })
  const record = await prisma.apiKey.findUnique({ where: { hash } })
  const value: CachedKey = record
    ? {
        found: true,
        revoked: Boolean(record.revokedAt),
        expiresAt: record.expiresAt ?? null,
        context: {
          id: record.id,
          label: record.label,
          ratePerMin: record.ratePerMin,
          ratePerDay: record.ratePerDay,
        },
      }
    : { found: false }
  cacheSet(hash, value, now)
  return evaluate(value, now)
}

/**
 * Guards admin routes with a shared secret supplied via the `ADMIN_TOKEN`
 * env var, sent as `X-Admin-Token` (or `Authorization: Bearer <token>`).
 * Returns true if the caller is authorized.
 *
 * This is the single implementation used by every admin route (keys and
 * usage), so the two surfaces cannot drift apart.
 */
export function isAdminAuthorized(req: FastifyRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) return false
  const supplied =
    (req.headers['x-admin-token'] as string | undefined) ??
    req.headers['authorization']?.replace(/^Bearer\s+/i, '')
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(adminToken)
  // Constant-time comparison (timingSafeEqual requires equal-length buffers).
  // The length guard is not itself a meaningful leak for a high-entropy token.
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Fastify plugin that authenticates requests via `Authorization: Bearer <key>`.
 *
 * A request without a valid, non-revoked, unexpired key gets 401. Valid requests have
 * their key metadata attached to `req.apiKey` so downstream rate limiting can
 * read per-key quotas.
 *
 * Runs as an `onRequest` hook (and must be registered BEFORE @fastify/rate-limit)
 * so that `req.apiKey` is populated before the rate limiter — which also runs in
 * `onRequest` — evaluates its per-key `max`/`keyGenerator`.
 *
 * Routes can opt out of auth (e.g. health/metrics) by setting
 * `config.public = true` on the route definition.
 */
async function apiKeyAuthPlugin(app: FastifyInstance) {
  app.decorateRequest('apiKey', undefined)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Allow routes to mark themselves public (no auth required).
    const routeConfig = (req.routeOptions?.config ?? {}) as { public?: boolean }
    if (routeConfig.public) return

    const authorization = req.headers['authorization']
    const token = extractBearer(authorization)
    if (authorization !== undefined && !token) {
      api_key_auth_failures_total.inc({ reason: 'malformed' })
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'malformed',
        message: 'Malformed Authorization header.',
      })
    }

    if (authorization === undefined) {
      api_key_auth_failures_total.inc({ reason: 'missing' })
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'missing',
        message: 'Missing API key. Provide an Authorization header.',
      })
    }

    if (!token) {
      api_key_auth_failures_total.inc({ reason: 'malformed' })
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'malformed',
        message: 'Missing API key. Provide an Authorization: Bearer <key> header.',
      })
    }

    const result = await lookupApiKeyResult(token)
    const keyContext = result.context
    if (!keyContext) {
      const reason = result.failureReason ?? 'unknown'
      api_key_auth_failures_total.inc({ reason })
      return reply.status(401).send({
        error: 'Unauthorized',
        code: reason,
        message: reason === 'revoked'
          ? 'Revoked API key. Request a replacement key.'
          : reason === 'expired'
            ? 'Expired API key. Request a replacement key.'
            : 'Unknown API key.',
      })
    }

    req.apiKey = keyContext
  })
}

export const registerApiKeyAuth = fp(apiKeyAuthPlugin, { name: 'api-key-auth' })
