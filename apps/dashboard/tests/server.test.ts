import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { buildServer } from '../src/server.js';

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

describe('local dashboard API', () => {
  it('keeps every element id referenced by app.js present in index.html', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const ids = new Set(
      Array.from(script.matchAll(/\$\('([a-z0-9-]+)'\)/g), (match) => match[1] as string),
    );
    expect(ids.size).toBeGreaterThan(0);
    const missing = Array.from(ids).filter((id) => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  it('serves read-only summaries and allows a local kill-switch toggle', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-dashboard-'));
    const databasePath = join(directory, 'test.sqlite');
    const app = await buildServer({ databasePath });
    servers.push(app);

    const db = openDatabase(databasePath);
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S' });
    repo.recordHealth(
      'gateio',
      {
        successRate: 1,
        medianLatencyMs: 100,
        p95LatencyMs: 200,
        rateLimitEvents: 0,
        staleDataEvents: 0,
        feedLatencyP95Ms: 0,
        crossedRate: 0,
        sequenceGapRate: 0,
        staleFeedRate: 0,
        reliabilityScore: 1,
        healthState: 'A',
        score: 100,
      },
      Date.now(),
    );
    repo.recordInventorySnapshot({
      venueId: 'gateio',
      accountId: 'default',
      asset: 'USDT',
      free: new Decimal(100),
      used: new Decimal(0),
      total: new Decimal(100),
      usdValue: new Decimal(100),
      capturedAt: Date.now(),
    });
    repo.recordBalance({
      venueId: 'gateio',
      accountId: 'default',
      currency: 'USDT',
      free: new Decimal(100),
      used: new Decimal(0),
      total: new Decimal(100),
      fetchedAt: Date.now(),
    });
    repo.recordRiskEvent('warning', 'dashboard_smoke', 'seeded risk event');
    repo.recordAudit('test', 'dashboard_smoke');
    repo.recordAudit('operator', 'dashboard_operator_action');
    const stored = repo.recordOpportunity({
      strategy: 'S1',
      opportunityKey: 'dashboard-smoke',
      instrumentKey: 'CAKE/USDT',
      direction: 'gateio->mexc',
      venueBuy: 'gateio',
      venueSell: 'mexc',
      instrumentBuy: 'CAKE/USDT',
      instrumentSell: 'CAKE/USDT',
      requestedNotional: new Decimal(30),
      grossSpread: new Decimal('0.5'),
      totalCost: new Decimal('0.1'),
      depthNetProfit: new Decimal('0.4'),
      conservativeNetProfit: new Decimal('0.3'),
      netProfitBps: new Decimal(100),
      dataAgeMs: 0,
      valid: true,
      rejectionReasons: [],
      sampledAt: Date.now(),
    });
    repo.recordPaperTrade({
      opportunityId: stored.id,
      requestedNotional: new Decimal(30),
      simulatedBaseAmount: new Decimal(12),
      buyPriceAverage: new Decimal('2.5'),
      sellPriceAverage: new Decimal('2.55'),
      fees: new Decimal('0.1'),
      gasCost: new Decimal(0),
      netProfit: new Decimal('0.3'),
      result: 'CLOSED',
      executedAt: Date.now(),
    });
    repo.close();

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('ok');

    const summary = await app.inject({ method: 'GET', url: '/api/summary' });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().opportunity_counts.total).toBe(1);
    expect(summary.json().recovery).toEqual({ openExecutions: 0, unresolvedLegs: 0 });
    expect(summary.json().rollout_metrics.costs.paperNetProfitUsd).toBe('0.3');

    const metrics = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({
      executions: {
        total: 0,
        fillRate: 0,
        firstLegPartialRate: 0,
        secondLegFailureRate: 0,
      },
      orders: { unknownOrderRate: 0, queryErrorRate: 0 },
      costs: { paperNetProfitUsd: '0.3', gasCostUsd: '0' },
      risk: { events24h: 1, operatorInterventions24h: 1 },
    });
    expect(metrics.json().generatedAt).toEqual(expect.any(Number));

    const episodes = await app.inject({ method: 'GET', url: '/api/episodes' });
    expect(episodes.statusCode).toBe(200);
    expect(episodes.json()).toHaveLength(1);
    expect(episodes.json()[0].sample_count).toBe(1);

    const inventory = await app.inject({ method: 'GET', url: '/api/inventory' });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()).toHaveLength(1);

    const account = await app.inject({ method: 'GET', url: '/api/account' });
    expect(account.statusCode).toBe(200);
    expect(account.json().balances).toHaveLength(1);
    expect(account.json().balances[0]).toMatchObject({
      venueId: 'gateio',
      asset: 'USDT',
      total: '100',
    });
    expect(account.json().recovery).toEqual({ openExecutions: 0, unresolvedLegs: 0 });

    const opportunities = await app.inject({ method: 'GET', url: '/api/opportunities' });
    expect(opportunities.statusCode).toBe(200);
    expect(opportunities.json()).toHaveLength(1);

    const venues = await app.inject({ method: 'GET', url: '/api/venues' });
    expect(venues.statusCode).toBe(200);
    expect(venues.json()[0].health_state).toBe('A');

    const risk = await app.inject({ method: 'GET', url: '/api/risk-events' });
    expect(risk.statusCode).toBe(200);
    expect(risk.json().some((event: { rule: string }) => event.rule === 'dashboard_smoke')).toBe(
      true,
    );

    const audit = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(audit.statusCode).toBe(200);
    expect(
      audit.json().some((event: { action: string }) => event.action === 'dashboard_smoke'),
    ).toBe(true);

    const kill = await app.inject({
      method: 'POST',
      url: '/api/kill-switch',
      payload: { active: true, reason: 'unit test' },
    });
    expect(kill.statusCode).toBe(200);
    expect(kill.json().active).toBe(true);
    const after = await app.inject({ method: 'GET', url: '/health' });
    expect(after.json().kill_switch).toBe(true);

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('ARB');
    expect(page.body).toContain('Rollout Diagnostics');
    expect(page.body).toContain('Account &amp; Positions');
  });
});
