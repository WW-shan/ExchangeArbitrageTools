import { describe, expect, it } from 'vitest';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { applyVenueCommand, parseVenueArgs } from '../src/venue-cli.js';

function setup(): ArbitrageRepository {
  const repository = new ArbitrageRepository(openDatabase(':memory:'));
  repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S' });
  return repository;
}

describe('audited venue execution switch', () => {
  it('parses status, enable, disable and help arguments', () => {
    expect(parseVenueArgs([])).toEqual({ action: 'status', help: false });
    expect(parseVenueArgs(['--status'])).toEqual({ action: 'status', help: false });
    expect(parseVenueArgs(['--enable', 'GateIO'])).toEqual({
      action: 'enable',
      venueId: 'gateio',
      help: false,
    });
    expect(parseVenueArgs(['--disable', 'mexc'])).toEqual({
      action: 'disable',
      venueId: 'mexc',
      help: false,
    });
    expect(parseVenueArgs(['--help']).help).toBe(true);
    expect(() => parseVenueArgs(['--enable'])).toThrow('requires a venue id');
    expect(() => parseVenueArgs(['--bogus'])).toThrow('unknown argument');
  });

  it('enables and disables a registered venue and records an operator audit entry', () => {
    const repository = setup();
    expect(
      applyVenueCommand(repository, { action: 'enable', venueId: 'gateio', help: false }),
    ).toMatchObject({ action: 'enable', venueId: 'gateio', changed: true });
    expect(repository.venueExecutionEnabled('gateio')).toBe(true);
    expect(
      repository
        .listAuditLogs(10)
        .some((row) => row.actor === 'operator' && row.action === 'venue_execution_enabled'),
    ).toBe(true);

    expect(
      applyVenueCommand(repository, { action: 'disable', venueId: 'gateio', help: false }),
    ).toMatchObject({ action: 'disable', venueId: 'gateio', changed: true });
    expect(repository.venueExecutionEnabled('gateio')).toBe(false);
    const status = applyVenueCommand(repository, { action: 'status', help: false });
    expect(status.venues?.find((venue) => venue.id === 'gateio')?.executionEnabled).toBe(false);
    repository.close();
  });

  it('rejects unsupported or not-yet-registered venues', () => {
    const repository = setup();
    expect(() =>
      applyVenueCommand(repository, { action: 'enable', venueId: 'not-a-venue', help: false }),
    ).toThrow('unsupported CEX venue');
    expect(() =>
      applyVenueCommand(repository, { action: 'enable', venueId: 'binance', help: false }),
    ).toThrow('venue is not registered yet');
    repository.close();
  });
});
