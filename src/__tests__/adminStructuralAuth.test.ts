import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { registerApiKeyAuth, registerAdminAuth } from '../api/auth'
import { registerAdminRoutes } from '../api/admin'
import { registerUsageRoutes } from '../api/usage'

describe('Issue #514: Structural admin authentication hook', () => {
  let app: FastifyInstance
  const validAdminToken = 'admin-secret-token-123'

  beforeEach(async () => {
    vi.stubEnv('ADMIN_TOKEN', validAdminToken)
    vi.stubEnv('REQUIRE_API_KEY', 'true')

    app = Fastify()
    await app.register(registerApiKeyAuth)
    await app.register(registerAdminAuth)
    await app.register(registerAdminRoutes)
    await app.register(registerUsageRoutes)

    app.get('/status', { config: { public: true, auth: 'none' } }, async () => ({ status: 'ok' }))
    app.get('/price/test', async () => ({ price: 100 }))

    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('rejects unauthenticated requests to /admin/keys with 401 admin_unauthorized', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      payload: { name: 'test-key' },
    })

    expect(res.statusCode).toBe(401)
    const body = res.json()
    expect(body.code).toBe('admin_unauthorized')
  })

  it('rejects requests with invalid X-Admin-Token to /admin/keys with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: {
        'x-admin-token': 'wrong-token',
      },
      payload: { name: 'test-key' },
    })

    expect(res.statusCode).toBe(401)
    const body = res.json()
    expect(body.code).toBe('admin_unauthorized')
  })

  it('rejects unauthenticated requests to /admin/usage with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/usage',
    })

    expect(res.statusCode).toBe(401)
    const body = res.json()
    expect(body.code).toBe('admin_unauthorized')
  })

  it('automatically protects dynamically registered /admin routes by default', async () => {
    // Dynamically register a new route under /admin with standard app.get
    const dynamicApp = Fastify()
    await dynamicApp.register(registerAdminAuth)
    dynamicApp.get('/admin/custom-diagnostic', async (_req, reply) => {
      return reply.send({ diagnostic: 'ok' })
    })
    await dynamicApp.ready()

    // Calling it without admin token should be rejected structurally by onRequest hook
    const unauthRes = await dynamicApp.inject({
      method: 'GET',
      url: '/admin/custom-diagnostic',
    })

    expect(unauthRes.statusCode).toBe(401)
    expect(unauthRes.json().code).toBe('admin_unauthorized')

    // Calling it with valid admin token should succeed
    const authRes = await dynamicApp.inject({
      method: 'GET',
      url: '/admin/custom-diagnostic',
      headers: {
        'x-admin-token': validAdminToken,
      },
    })

    expect(authRes.statusCode).toBe(200)
    expect(authRes.json()).toEqual({ diagnostic: 'ok' })
    await dynamicApp.close()
  })

  it('leaves genuinely public routes accessible without credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/status',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('allows access to admin routes when valid X-Admin-Token is supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/usage',
      headers: {
        'x-admin-token': validAdminToken,
      },
    })

    expect(res.statusCode).toBe(200)
  })
})
