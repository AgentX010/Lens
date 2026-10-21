import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { admin_auth_failures_total } from '../metrics'
import { hashApiKey, isAdminAuthorized } from './auth'

/** Generates a new opaque API key with a recognizable `lens_` prefix. */
export function generateApiKey(): string {
  return `lens_${randomBytes(24).toString('hex')}`
}

interface CreateKeyBody {
  label?: string
  expiresAt?: string
  ratePerMin?: number
  ratePerDay?: number
  monthlyQuotaCents?: number
  dailyQuotaCents?: number
  overagePolicy?: 'block' | 'charge_402' | 'allow_overage'
}

interface ListKeysQuery {
  limit?: string
  offset?: string
  revoked?: string
}

const MAX_KEY_PAGE_SIZE = 100

function parsePageValue(value: string | undefined, fallback: number, maximum: number): number | null {
  if (value === undefined) return fallback
  if (!/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null
}

/**
 * Registers admin-only endpoints for minting and revoking API keys.
 *
 * - `POST /admin/keys`   — mint a new key (returns the plaintext key ONCE).
 * - `DELETE /admin/keys/:id` — revoke an existing key.
 *
 * All routes are marked `config.public = true` so the API-key auth hook skips
 * them; they enforce their own `ADMIN_TOKEN` check instead.
 */
export async function registerAdminRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListKeysQuery }>(
    '/admin/keys',
    { config: { public: true } },
    async (req: FastifyRequest<{ Querystring: ListKeysQuery }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const limit = parsePageValue(req.query.limit, 50, MAX_KEY_PAGE_SIZE)
      const offset = parsePageValue(req.query.offset, 0, Number.MAX_SAFE_INTEGER)
      const revoked = req.query.revoked ?? 'false'
      if (limit === null || limit < 1 || offset === null || !['true', 'false'].includes(revoked)) {
        return reply.status(400).send({
          error: 'Invalid pagination or revoked filter. Use limit (1-100), offset (0 or greater), and revoked=true|false.',
        })
      }

      const where = revoked === 'true' ? { revokedAt: { not: null } } : { revokedAt: null }
      const [records, total] = await Promise.all([
        prisma.apiKey.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
          // Never select the stored hash; it is not needed to manage a key.
          select: {
            id: true,
            label: true,
            ratePerMin: true,
            ratePerDay: true,
            monthlyQuotaCents: true,
            dailyQuotaCents: true,
            overagePolicy: true,
            createdAt: true,
            revokedAt: true,
            expiresAt: true,
          },
        }),
        prisma.apiKey.count({ where }),
      ])

      return reply.send({
        keys: records.map(record => ({
          id: record.id,
          label: record.label,
          ratePerMin: record.ratePerMin,
          ratePerDay: record.ratePerDay,
          monthlyQuotaCents: record.monthlyQuotaCents,
          dailyQuotaCents: record.dailyQuotaCents,
          overagePolicy: record.overagePolicy,
          createdAt: record.createdAt,
          revokedAt: record.revokedAt,
          expiresAt: record.expiresAt,
        })),
        pagination: { limit, offset, total },
      })
    },
  )

  app.post<{ Body: CreateKeyBody }>(
    '/admin/keys',
    { config: { public: true } },
    async (req: FastifyRequest<{ Body: CreateKeyBody }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const { label, expiresAt, ratePerMin, ratePerDay, monthlyQuotaCents, dailyQuotaCents, overagePolicy } = req.body ?? {}
      if (!label || typeof label !== 'string' || label.trim().length === 0) {
        return reply.status(400).send({ error: 'label is required' })
      }
      if (expiresAt !== undefined && typeof expiresAt !== 'string') {
        return reply.status(400).send({ error: 'expiresAt must be a valid future date' })
      }
      const expiration = expiresAt === undefined ? undefined : new Date(expiresAt)
      if (expiration && (!Number.isFinite(expiration.getTime()) || expiration <= new Date())) {
        return reply.status(400).send({ error: 'expiresAt must be a valid future date' })
      }

      // Generate the key, store only its hash, and return the plaintext once.
      const plaintext = generateApiKey()
      const record = await prisma.apiKey.create({
        data: {
          hash: hashApiKey(plaintext),
          label: label.trim(),
          ...(expiration ? { expiresAt: expiration } : {}),
          ...(ratePerMin !== undefined ? { ratePerMin } : {}),
          ...(ratePerDay !== undefined ? { ratePerDay } : {}),
          ...(monthlyQuotaCents !== undefined ? { monthlyQuotaCents } : {}),
          ...(dailyQuotaCents !== undefined ? { dailyQuotaCents } : {}),
          ...(overagePolicy !== undefined ? { overagePolicy } : {}),
        },
      })

      return reply.status(201).send({
        id: record.id,
        label: record.label,
        expiresAt: record.expiresAt,
        ratePerMin: record.ratePerMin,
        ratePerDay: record.ratePerDay,
        monthlyQuotaCents: record.monthlyQuotaCents,
        dailyQuotaCents: record.dailyQuotaCents,
        overagePolicy: record.overagePolicy,
        key: plaintext,
        createdAt: record.createdAt,
      })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/admin/keys/:id',
    { config: { public: true } },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const { id } = req.params
      const existing = await prisma.apiKey.findUnique({ where: { id } })
      if (!existing) {
        return reply.status(404).send({ error: 'API key not found' })
      }
      if (existing.revokedAt) {
        return reply.status(200).send({ id, revoked: true, alreadyRevoked: true })
      }

      await prisma.apiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      })

      return reply.status(200).send({ id, revoked: true })
    },
  )
}
