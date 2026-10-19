import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'

const mockQuery = vi.fn()
vi.mock('../db', () => ({
  pgPool: {
    query: (...args: any[]) => mockQuery(...args),
  },
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
    },
  },
}))

import { buildApp } from '../app'

describe('GET /status contract & health separation (#273)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    mockQuery.mockReset()
    app = await buildApp()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns 200 with separate process and data health fields when healthy', async () => {
    const recentDate = new Date(Date.now() - 30 * 1000) // 30s ago
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          last_ledger: 123456,
          last_processed_at: recentDate,
        },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: '/status',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('healthy')
    expect(body.health).toBeDefined()
    expect(body.health.process).toBe('healthy')
    expect(body.health.data).toBe('healthy')
    expect(body.process.status).toBe('healthy')
    expect(typeof body.process.uptimeSeconds).toBe('number')
    expect(typeof body.process.memoryUsageMb).toBe('number')
    expect(body.data.isStale).toBe(false)
    expect(body.data.lastIndexedLedger).toBe(123456)
  })

  it('distinguishes process health from data health when data is stale', async () => {
    const staleDate = new Date(Date.now() - 600 * 1000) // 10 minutes ago (> 300s)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          last_ledger: 100000,
          last_processed_at: staleDate,
        },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: '/status',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('degraded')
    expect(body.health.process).toBe('healthy') // Process is still running fine
    expect(body.health.data).toBe('stale') // Data ingestion is stale
    expect(body.data.isStale).toBe(true)
    expect(body.data.ingestLagSeconds).toBeGreaterThan(300)
  })

  it('returns 503 with DATABASE_DOWN paging condition when database fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))

    const res = await app.inject({
      method: 'GET',
      url: '/status',
    })

    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.status).toBe('unhealthy')
    expect(body.pagingCondition).toBe('DATABASE_DOWN')
    expect(body.error).toContain('Connection terminated')
  })
})
