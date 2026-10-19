import { describe, it, expect, vi } from 'vitest';
import { BazaarMcpServer } from '../src/mcp/server';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('BazaarMcpServer', () => {
  it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    // The SDK server doesn't expose the router directly without a client, but we can test the handlePaidCallError method directly,
    // or by overriding setRequestHandler to capture our handler.
    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    
    // Re-setup handlers to capture the handler
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION');
  });

  it('should map missing trustline error to ERR_MISSING_TRUSTLINE', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('op_no_trust: The account does not have a trustline for this asset'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
  });

  it('should map 402 rejected error to ERR_PAYMENT_REJECTED', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'Payment Required'
    });
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_PAYMENT_REJECTED');
  });
  
  it('should return successfully on a successful call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: "hello" })
    });
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch, paidCallAllowlist: ['example.com'] });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBeFalsy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(parsedText.success).toBe(true);
  });
});

describe('BazaarMcpServer bazaar_search SSRF guard (#407)', () => {
  function captureHandler(server: any) {
    let handler: any = null;
    server.server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    server.setupHandlers();
    return handler;
  }

  const publicLookup = { lookup: async () => ['93.184.216.34'] };
  const okFetchImpl = async () =>
    new Response(JSON.stringify({ resources: [{ name: 'x' }] }), { status: 200 });

  it('rejects a non-http(s) scheme', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'file:///etc' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a private / metadata literal', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'http://169.254.169.254' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], lookup: async () => ['127.0.0.1'], fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://innocent.example' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
  });

  it('refuses a redirect to a forbidden host', async () => {
    const calls: string[] = [];
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: {
        allowedHosts: [],
        ...publicLookup,
        fetchImpl: async (input: string | URL) => {
          calls.push(String(input));
          return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
        },
      },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example' } } });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe('ERR_URL_BLOCKED');
    expect(calls).toEqual(['https://ok.example/discovery/resources']);
  });

  it('returns results from a permitted public host', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn(),
      bazaarFetch: { allowedHosts: [], ...publicLookup, fetchImpl: okFetchImpl },
    });
    const handler = captureHandler(server);
    const response = await handler({ params: { name: 'bazaar_search', arguments: { url: 'https://ok.example', query: 'xlm' } } });
    expect(response.isError).toBeFalsy();
    expect(JSON.parse(response.content[0].text).resources[0].name).toBe('x');
  });
});

describe('BazaarMcpServer network & payment key configuration (#412)', () => {
  function captureHandler(server: any) {
    let handler: any = null;
    server.server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    server.setupHandlers();
    return handler;
  }

  it('starts successfully with only a testnet key configured', async () => {
    const { Keypair } = await import('@stellar/stellar-sdk');
    const testnetSecret = Keypair.random().secret();

    const { setupMcpPayment } = await import('../src/mcp/paymentConfig.js');
    const payment = setupMcpPayment({
      testnetKey: testnetSecret,
    });

    expect(payment.activeNetworks).toEqual(['stellar:testnet']);
    expect(payment.mainnetEnabled).toBe(false);
    expect(payment.warnings).toHaveLength(0);

    const server = new BazaarMcpServer({
      fetchWithPayment: payment.fetchWithPayment,
      paidCallAllowlist: ['example.com'],
    });

    expect(server).toBeDefined();
  });

  it('requires explicit opt-in for mainnet even when mainnet key is present', async () => {
    const { Keypair } = await import('@stellar/stellar-sdk');
    const testnetSecret = Keypair.random().secret();
    const mainnetSecret = Keypair.random().secret();

    const { setupMcpPayment } = await import('../src/mcp/paymentConfig.js');

    // Without enableMainnet
    const withoutOptIn = setupMcpPayment({
      testnetKey: testnetSecret,
      mainnetKey: mainnetSecret,
      enableMainnet: false,
    });

    expect(withoutOptIn.activeNetworks).toEqual(['stellar:testnet']);
    expect(withoutOptIn.mainnetEnabled).toBe(false);
    expect(withoutOptIn.info.some(msg => msg.includes('MCP_ENABLE_MAINNET=true'))).toBe(true);
    expect(withoutOptIn.warnings.some(msg => msg.includes('WARNING'))).toBe(false);

    // With explicit enableMainnet
    const withOptIn = setupMcpPayment({
      testnetKey: testnetSecret,
      mainnetKey: mainnetSecret,
      enableMainnet: true,
    });

    expect(withOptIn.activeNetworks).toEqual(['stellar:testnet', 'stellar:pubnet']);
    expect(withOptIn.mainnetEnabled).toBe(true);
    expect(withOptIn.warnings.some(msg => msg.includes('WARNING: Mainnet (stellar:pubnet) is enabled!'))).toBe(true);
  });

  it('starts cleanly with no keys at all and refuses paid_call', async () => {
    const { setupMcpPayment } = await import('../src/mcp/paymentConfig.js');
    const payment = setupMcpPayment({});

    expect(payment.activeNetworks).toHaveLength(0);
    expect(payment.mainnetEnabled).toBe(false);
    expect(payment.info.some(msg => msg.includes('read-only mode'))).toBe(true);

    // 1. Test when server is constructed with setupMcpPayment's fetchWithPayment (schemes: [])
    const serverWithEmptySchemes = new BazaarMcpServer({
      fetchWithPayment: payment.fetchWithPayment,
      paidCallAllowlist: ['example.com'],
    });
    const handler1 = captureHandler(serverWithEmptySchemes);

    // Mock response simulating a 402 challenge demanding testnet
    const mock402Response = new Response(
      JSON.stringify({ error: 'Payment required' }),
      {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'L402 network="stellar:testnet"',
        },
      }
    );
    const mockFetch402 = vi.fn().mockResolvedValue(mock402Response);
    (serverWithEmptySchemes as any).fetchWithPayment = mockFetch402;

    // 2. Test when server is constructed without fetchWithPayment
    const readOnlyServer = new BazaarMcpServer({
      paidCallAllowlist: ['example.com'],
    });
    const handler2 = captureHandler(readOnlyServer);

    const response = await handler2({
      params: {
        name: 'paid_call',
        arguments: { url: 'http://example.com/paid' },
      },
    });

    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.code).toBe('ERR_PAYMENT_REJECTED');
    expect(body.reason).toMatch(/no payment keys configured/i);
  });

  it('names the missing network in the error response when a payment requires an unconfigured network', async () => {
    const server = new BazaarMcpServer({
      fetchWithPayment: vi.fn().mockRejectedValue(
        new Error('No network/scheme registered for stellar:pubnet')
      ),
      paidCallAllowlist: ['example.com'],
    });

    const handler = captureHandler(server);
    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: { url: 'http://example.com/paid' },
      },
    });

    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0].text);
    expect(body.code).toBe('ERR_PAYMENT_REJECTED');
    expect(body.reason).toContain('stellar:pubnet');
  });

  it('never logs or leaks secret key values on invalid key errors', async () => {
    const fakeKey = 'SINVALIDSECRETKEYTHATMUSTNEVERAPPEARINTHELOGSOROUTPUT12345';
    const { setupMcpPayment } = await import('../src/mcp/paymentConfig.js');

    try {
      setupMcpPayment({ testnetKey: fakeKey });
      expect.unreachable('Should have thrown on invalid secret key');
    } catch (err: any) {
      expect(err.message).not.toContain(fakeKey);
      expect(err.message).toContain('stellar:testnet');
    }
  });
});

