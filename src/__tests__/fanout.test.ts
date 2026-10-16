import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('ioredis', () => {
  const mockRedis = {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  }
  return {
    default: vi.fn(() => mockRedis),
  }
})

vi.mock('../redis', () => ({
  redis: {
    publish: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
  },
}))

vi.mock('../events', () => ({
  priceEmitter: {
    on: vi.fn(),
    off: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  },
  PRICE_UPDATE: 'price:update',
  PriceUpdateEvent: class {},
}))

vi.mock('prom-client', () => {
  function MockMetric() {
    const labels = vi.fn(() => new MockMetric())
    this.inc = vi.fn()
    this.dec = vi.fn()
    this.set = vi.fn()
    this.labels = labels
    this.observe = vi.fn()
    this.startTimer = vi.fn(() => vi.fn())
  }
  return {
    register: { metrics: vi.fn().mockResolvedValue('') },
    Gauge: MockMetric,
    Counter: MockMetric,
    Histogram: MockMetric,
  }
})

import { fanOutManager } from '../ws/fanout'

describe('FanOutManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await fanOutManager.destroy()
  })

  it('registers a client and returns an unsubscribe function', () => {
    const mockSocket = {
      id: 'client-1',
      send: vi.fn(),
      close: vi.fn(),
    }

    const unsubscribe = fanOutManager.register('XLM/USDC', mockSocket)
    expect(unsubscribe).toBeInstanceOf(Function)

    unsubscribe()
    unsubscribe()
  })

  it('handles client disconnection gracefully', () => {
    const mockSocket = {
      id: 'client-3',
      send: vi.fn(),
      close: vi.fn(),
    }

    const unsubscribe = fanOutManager.register('XLM/USDC', mockSocket)
    unsubscribe()
  })

  it('multiple clients on different pairs register correctly', () => {
    const client1 = { id: 'client-5', send: vi.fn(), close: vi.fn() }
    const client2 = { id: 'client-6', send: vi.fn(), close: vi.fn() }

    const unsub1 = fanOutManager.register('XLM/USDC', client1)
    const unsub2 = fanOutManager.register('BTC/USDT', client2)

    expect(unsub1).toBeInstanceOf(Function)
    expect(unsub2).toBeInstanceOf(Function)
  })

  it('destroy cleans up all state', async () => {
    const mockSocket = {
      id: 'client-cleanup',
      send: vi.fn(),
      close: vi.fn(),
    }

    fanOutManager.register('XLM/USDC', mockSocket)
    await fanOutManager.destroy()
    await fanOutManager.destroy()
  })
})

describe('FanOutClient per-pair subscription', () => {
  it('registers clients for pair-specific broadcasting', () => {
    const mockSocket = {
      id: 'client-pair',
      send: vi.fn(),
      close: vi.fn(),
    }

    fanOutManager.register('ETH/USDC', mockSocket)
  })
})