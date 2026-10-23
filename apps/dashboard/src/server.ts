import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ArbitrageRepository, openDatabase } from '@arb/storage';

export interface DashboardServerOptions {
  databasePath?: string;
  logger?: boolean;
}

export async function buildServer(options: DashboardServerOptions = {}): Promise<FastifyInstance> {
  const db = openDatabase(options.databasePath ?? 'data/arbitrage.sqlite');
  const repo = new ArbitrageRepository(db);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 32 * 1024 });
  await app.register(fastifyStatic, {
    root: resolve(process.cwd(), 'apps/dashboard/public'),
    prefix: '/',
    wildcard: false,
  });

  app.get('/health', async () => ({
    status: 'ok',
    timestamp: Date.now(),
    kill_switch: repo.getSetting('kill_switch') !== 'false',
    live_enabled: repo.getSetting('live_enabled') === 'true',
  }));

  app.get('/api/summary', async () => ({
    opportunity_counts: repo.opportunityCounts(),
    paper_trades: repo.paperTradeSummary(),
    recovery: repo.recoveryCounts(),
    rollout_metrics: repo.rolloutMetrics(),
    kill_switch: repo.getSetting('kill_switch') !== 'false',
    live_enabled: repo.getSetting('live_enabled') === 'true',
  }));

  app.get('/api/metrics', async () => repo.rolloutMetrics());

  app.get<{ Querystring: { limit?: string; valid?: string } }>(
    '/api/opportunities',
    async (request) => {
      const limit = Number(request.query.limit ?? 50);
      return repo.listOpportunities({
        limit: Number.isFinite(limit) ? limit : 50,
        validOnly: request.query.valid === '1' || request.query.valid === 'true',
      });
    },
  );

  app.get<{ Querystring: { limit?: string } }>('/api/episodes', async (request) => {
    const limit = Number(request.query.limit ?? 50);
    return repo.listEpisodes(Number.isFinite(limit) ? limit : 50);
  });

  app.get('/api/venues', async () => repo.latestHealth());
  app.get('/api/inventory', async () => repo.latestInventory(100));
  app.get('/api/risk-events', async () => repo.listRiskEvents(100));
  app.get('/api/audit', async () => repo.listAuditLogs(100));

  app.post<{ Body: { active: boolean; reason?: string } }>(
    '/api/kill-switch',
    async (request, reply) => {
      if (typeof request.body?.active !== 'boolean') {
        return reply.code(400).send({ error: 'active boolean is required' });
      }
      const active = request.body.active;
      repo.setSetting('kill_switch', String(active));
      repo.recordAudit('operator', active ? 'kill_switch_on' : 'kill_switch_off', {
        reason: request.body.reason ?? '',
      });
      repo.recordRiskEvent(
        active ? 'critical' : 'info',
        'manual_kill_switch',
        active ? 'kill switch enabled manually' : 'kill switch disabled manually',
      );
      return { active };
    },
  );

  app.addHook('onClose', async () => repo.close());
  return app;
}
