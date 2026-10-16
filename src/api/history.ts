import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type
import { findOverlappingGaps } from '../backfill/gaps'

/** Supported aggregation intervals → bucket width in seconds. */
export const HISTORY_INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '1h': 3600,
}

/** Maximum number of buckets a single request may return. */
export const MAX_HISTORY_POINTS = 10_000

export interface HistoryPoint {
  ts: string
  price: number
  volume: number
}

/**
 * Aggregates 1-minute price snapshots into `intervalSecs`-wide buckets.
 *
 * Each bucket reports the close price (the last snapshot whose ts falls in the
 * bucket) and the summed volume. Buckets are aligned to the Unix epoch so that
 * e.g. a 1h bucket always starts on the hour, independent of the query window.
 * With intervalSecs=60 this returns the raw snapshots unchanged.
 */
export async function queryHistory(
  pair: string,
  from: Date,
  to: Date,
  intervalSecs: number,
  network: NetworkName
): Promise<HistoryPoint[]> {
  const result = await pgPool.query(
    `SELECT
       to_timestamp(floor(EXTRACT(EPOCH FROM ts) / $1) * $1) AS bucket,
       (array_agg(price::float ORDER BY ts DESC))[1] AS price,
       SUM(volume::float) AS volume
     FROM price_snapshots
     WHERE pair = $2 AND network = $5
       AND ts >= $3
       AND ts <= $4
     GROUP BY floor(EXTRACT(EPOCH FROM ts) / $1)
     ORDER BY bucket ASC`,
    [intervalSecs, pair, from, to, network]
  )

  return result.rows.map(r => ({
    ts: new Date(r.bucket).toISOString(),
    price: Number(r.price),
    volume: Number(r.volume),
  }))
}

/**
 * GET /prices/history?pair=XLM/USDC&from=…&to=…&interval=1m|5m|1h
 *
 * Returns historical price snapshots for a pair over [from, to], optionally
 * aggregated into 5m or 1h buckets. Defaults to the last 24h at 1m resolution.
 *
 * The network is resolved by the network selector (`?network=` / `x-network`,
 * defaulting to this deployment's active network) and echoed in the response.
 *
 * Note: this path is NOT gated by x402. It used to be, by accident — the old
 * gate matched `req.url.startsWith('/price')`, which swept up `/prices/...`
 * along with `/pricing` and `/poolsize`. Since #190 the gate matches the routed
 * path at a segment boundary, so `/prices/history` is free. Adding it to
 * GATED_ROUTES in src/middleware/x402.ts is a deliberate decision, not a
 * side effect.
 */
export async function registerHistoryRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { pair?: string; from?: string; to?: string; interval?: string }
  }>('/prices/history', async (req, reply) => {
    const { pair } = req.query
    if (!pair) {
      return reply.status(400).send({ error: 'pair query parameter is required' })
    }

    const interval = req.query.interval ?? '1m'
    const intervalSecs = HISTORY_INTERVAL_SECONDS[interval]
    if (!intervalSecs) {
      return reply.status(400).send({
        error: `interval must be one of: ${Object.keys(HISTORY_INTERVAL_SECONDS).join(', ')}`,
      })
    }

    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const to = req.query.to ? new Date(req.query.to) : new Date()

    if (isNaN(from.getTime())) {
      return reply.status(400).send({ error: 'from must be a valid ISO 8601 date' })
    }
    if (isNaN(to.getTime())) {
      return reply.status(400).send({ error: 'to must be a valid ISO 8601 date' })
    }
    if (from.getTime() > to.getTime()) {
      return reply.status(400).send({ error: 'from must be before to' })
    }

    // Guard against unbounded scans: cap the number of buckets the window can produce.
    const spanSecs = (to.getTime() - from.getTime()) / 1000
    if (spanSecs / intervalSecs > MAX_HISTORY_POINTS) {
      return reply.status(400).send({
        error: `requested window is too large for interval=${interval} (max ${MAX_HISTORY_POINTS} points); narrow the range or use a coarser interval`,
      })
    }

    const network = req.network ?? activeNetwork
    const points = await queryHistory(pair, from, to, intervalSecs, network)
    const overlappingGaps = await findOverlappingGaps({
      network,
      pair,
      start: from,
      end: to,
    })

    const gapDeclaration = overlappingGaps.length > 0 ? { incomplete: true, gaps: overlappingGaps } : {}

    return {
      pair,
      network,
      interval,
      from: from.toISOString(),
      to: to.toISOString(),
      count: points.length,
      points,
      ...gapDeclaration,
    }
  })
}
