import type { FastifyInstance } from 'fastify'
import { parseDiscoveryFilters, queryDiscoveryResources } from '../bazaar/catalog'

/**
 * Registers GET /discovery/resources — the Bazaar catalog-browsing endpoint
 * from the x402 `bazaar` extension (specs/extensions/bazaar.md in
 * x402-foundation/x402). Public and un-gated: discovery has to work before a
 * client has any payment method configured, the same reasoning that keeps
 * GET /supported un-gated (see routes/facilitator.ts).
 */
export async function registerDiscoveryRoutes(app: FastifyInstance) {
  app.get('/discovery/resources', { config: { public: true } }, async (req) => {
    const filters = parseDiscoveryFilters(req.query as Record<string, unknown>)
    return queryDiscoveryResources(filters)
  })
}
