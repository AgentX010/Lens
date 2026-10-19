import 'dotenv/config';
import { BazaarMcpServer } from '../../src/mcp/server';
import { createLensPriceQueries } from '../../src/mcp/priceQueries';
import { setupMcpPayment } from '../../src/mcp/paymentConfig';
import { activeNetwork } from '../../src/config';

async function main() {
  const testnetKey = process.env.MCP_AGENT_SECRET_KEY_TESTNET;
  const mainnetKey = process.env.MCP_AGENT_SECRET_KEY_MAINNET;
  const enableMainnet =
    process.env.MCP_ENABLE_MAINNET === 'true' ||
    process.env.MCP_ALLOW_MAINNET === 'true' ||
    process.argv.includes('--allow-mainnet');

  const { fetchWithPayment, activeNetworks, warnings, info } = setupMcpPayment({
    testnetKey,
    mainnetKey,
    enableMainnet,
    maxPrice: process.env.MCP_MAX_PAYMENT_PRICE || '$1.00',
  });

  // paid_call spends from the keys above, so the hosts it may pay for are the
  // operator's decision. Unset means no host is payable at all (#404).
  const paidCallAllowlist = (process.env.MCP_PAID_CALL_ALLOWED_HOSTS || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

  const server = new BazaarMcpServer({
    fetchWithPayment,
    paidCallAllowlist,
    // Lens's own aggregated prices, read from the same Postgres the API serves.
    priceQueries: createLensPriceQueries(),
  });

  console.error('[mcp-server] Starting Bazaar MCP server on stdio...');

  for (const item of info) {
    console.error(`[mcp-server] ${item}`);
  }

  for (const warning of warnings) {
    console.error(`[mcp-server] ${warning}`);
  }

  if (activeNetworks.length > 0) {
    console.error(`[mcp-server] Agent configured for: ${activeNetworks.join(', ')}`);
  } else {
    console.error('[mcp-server] Running without payment keys. Only read-only operations are permitted.');
  }

  console.error(`[mcp-server] lens_get_price serves aggregated prices on ${activeNetwork}`);
  console.error(
    paidCallAllowlist.length > 0
      ? `[mcp-server] paid_call may pay these allow-listed origins: ${paidCallAllowlist.join(', ')}`
      : '[mcp-server] paid_call allow-list is empty: every paid call will be refused. Set MCP_PAID_CALL_ALLOWED_HOSTS to allow hosts.'
  );

  await server.run();
}

main().catch(err => {
  console.error('[mcp-server] Fatal error:', err);
  process.exit(1);
});
