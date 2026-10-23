import { JsonRpcProvider } from 'ethers';
import { BscTokenRegistry, STANDARD_BSC_TOKENS } from '@arb/venues-bsc';

async function main(): Promise<void> {
  const rpc = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org';
  const provider = new JsonRpcProvider(rpc, 56, { staticNetwork: true });
  const registry = new BscTokenRegistry(provider);
  let failed = 0;
  for (const token of Object.values(STANDARD_BSC_TOKENS)) {
    try {
      const info = await registry.inspect(token.contractAddress);
      const symbolMatches = info.symbol.toUpperCase() === token.symbol.toUpperCase();
      console.log(
        JSON.stringify({
          expected: token.symbol,
          address: token.contractAddress,
          onchainSymbol: info.symbol,
          decimals: info.decimals,
          symbolMatches,
        }),
      );
      if (!symbolMatches || info.decimals !== token.decimals) failed += 1;
    } catch (error) {
      failed += 1;
      console.error(`${token.symbol} verification failed: ${String(error)}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
