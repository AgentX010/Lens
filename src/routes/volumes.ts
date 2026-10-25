import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork, type NetworkName } from '../config'
import { apiError } from '../errors'

// Supported windows → lookback in hours.
const WINDOW_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
} as const

type VolumeWindow = keyof typeof WINDOW_HOURS

const WINDOWS = Object.keys(WINDOW_HOURS) as VolumeWindow[]

/**
 * Register the aggregated cross-venue volume endpoint.
 *
 * GET /volumes/:asset?window=24h|7d|30d&network=testnet|mainnet
 *
 * Sums traded volume for `asset` across every pair it appears in and across all
 * venues (SDEX, AMM, Soroswap, Aquarius, …) over the requested window. Volume is
 * measured in the asset's own units: when it is the base asset of a pair we count
 * `base_volume`, when it is the counter asset we count `counter_volume`.
 *
 * Venues are classified as either primary markets (e.g. SDEX, AMM, Soroswap) or
 * aggregators (e.g. Aquarius) that route trades through underlying primary venues.
 * To prevent double-counting of trades, the response reports labelled net totals
 * (summed across primary venues) and gross totals (including aggregators), alongside
 * a per-venue breakdown.
 *
 * Only one network's rows are summed: testnet and mainnet volume added together
 * is not a volume of anything. `network` defaults to this process's own network,
 * an unrecognised value is a 400, and the network answered for is echoed back.
 */
export async function registerVolumeRoutes(app: FastifyInstance) {
  app.get<{
    Params: { asset: string }
    Querystring: { window?: string; network?: string }
  }>('/volumes/:asset', { config: { scope: 'read:prices' } }, async (req, reply) => {
    const { asset } = req.params

    if (!(window in WINDOW_HOURS)) {
      return reply
        .status(400)
        .send(apiError('bad_window', `window must be one of: ${WINDOWS.join(', ')}`))
    }
  })
}

    const requested = req.query.network
    if (requested !== undefined && requested !== 'testnet' && requested !== 'mainnet') {
      return reply.status(400).send(apiError('bad_network', 'network must be one of: testnet, mainnet'))
    }
    const network: NetworkName = req.network
      ?? (requested ? requested as NetworkName : activeNetwork)

export type VolumesResult = Awaited<ReturnType<typeof computeVolumes>>

/**
 * The aggregation behind `GET /volumes/:asset`, shared with the GraphQL
 * `volumes` query so the two cannot drift. See {@link registerVolumeRoutes}
 * for what the numbers mean.
 *
 * `requestNetwork` is the network the request-level selector already resolved
 * (`req.network` on REST); when given it wins over `networkParam`, exactly as
 * the route has always behaved. Throws {@link VolumesInputError} for a bad
 * `window` or `network`; any other error is an internal failure.
 */
export async function computeVolumes(
  asset: string,
  windowParam: string | undefined,
  networkParam: unknown,
  requestNetwork?: NetworkName,
) {
  const window = windowParam ?? '24h'

  if (!(window in WINDOW_HOURS)) {
    throw new VolumesInputError('window', `window must be one of: ${WINDOWS.join(', ')}`)
  }

  const rawRequested: unknown = networkParam
  const requested = typeof rawRequested === 'string' ? rawRequested.trim().toLowerCase() : rawRequested
  if (requested !== undefined && requested !== '' && requested !== 'testnet' && requested !== 'mainnet') {
    throw new VolumesInputError('network', 'network must be one of: testnet, mainnet')
  }
  const network: NetworkName = requestNetwork
    ?? (requested ? requested as NetworkName : activeNetwork)

      return {
        asset,
        network,
        window,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        // Labelled net and gross totals to eliminate aggregator double-counting.
        totals: {
          net: netVolume,
          gross: grossVolume,
        },
        netVolume,
        grossVolume,
        // Backward-compatible alias for net volume.
        totalVolume: netVolume,
        // Per-venue breakdown that the totals are summed from.
        byVenue,
        venues: row.venues ?? [],
        tradeCount: netTradeCount,
        netTradeCount,
        grossTradeCount,
        medianTradeSize: row.median_trade_size == null ? null : Number(row.median_trade_size),
        topTradeVolumeShare: row.top_trade_volume_share == null ? null : Number(row.top_trade_volume_share),
        volumeConcentration: row.volume_concentration == null ? null : Number(row.volume_concentration),
        concentrationMeasure: 'hhi',
        status,
        provenance: {
          venues: row.venues ?? [],
          sampleCount: grossTradeCount,
          observedSampleCount,
          latestTradeAt,
          dataAgeSeconds,
        },
      }
    } catch (err) {
      return reply
        .status(500)
        .send(apiError('upstream_unavailable', `Volume aggregation failed: ${(err as Error).message}`))
    }
  })
}
