import { buildServer } from './server.js';

async function main(): Promise<void> {
  const host = process.env.ARB_API_HOST ?? '127.0.0.1';
  const port = Number(process.env.ARB_API_PORT ?? 8787);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('dashboard must bind to localhost; remote exposure is not supported');
  }
  const app = await buildServer({
    databasePath: process.env.ARB_DATABASE_PATH ?? 'data/arbitrage.sqlite',
    logger: true,
  });
  await app.listen({ host, port });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
