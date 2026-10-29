import type { ArbitrageRepository } from '@arb/storage';
import type { AccountStatusSnapshot, CexAdapter } from '@arb/venues-cex';
import { credentialFingerprint, type StoredCredential } from './secret-store.js';

export interface AccountStatusConfig {
  enabled: boolean;
  refreshMs: number;
  staleMs: number;
  requireIpWhitelist: boolean;
  allowSharedTradeWithdrawalKey: boolean;
  blockOnIpWhitelistChange: boolean;
  blockOnAccountIdChange: boolean;
  blockOnAccountModeChange: boolean;
}

export type AccountPermissionHealth = 'PASS' | 'WARN' | 'BLOCK';

export interface AccountPermissionVenueReport {
  venueId: string;
  declared: {
    role: 'trade';
    withdrawalPermission: boolean;
    ipWhitelistVerified: boolean | null;
    credentialFingerprint: string;
    sharedWithdrawalKey: boolean;
  };
  observed: AccountStatusSnapshot | null;
  health: AccountPermissionHealth;
  reasons: string[];
}

export interface AccountPermissionReport {
  capturedAt: number;
  health: AccountPermissionHealth;
  reasons: string[];
  venues: AccountPermissionVenueReport[];
  baselineUpdated: boolean;
}

export interface AccountPermissionVenue {
  adapter: CexAdapter;
  credentials: StoredCredential;
}

export interface EvaluateAccountPermissionsOptions {
  repository?: ArbitrageRepository;
  credentials: readonly StoredCredential[];
  venues: Readonly<Record<string, AccountPermissionVenue>>;
  requiredPairs: readonly string[];
  config: AccountStatusConfig;
  now?: number;
  persistBaseline?: boolean;
}

interface BaselineVenue {
  credentialFingerprint: string;
  accountIdHash?: string;
  ipWhitelistDigest?: string;
  pairWhitelistDigest?: string;
  accountMode?: string;
}

interface AccountStatusBaseline {
  version: 1;
  updatedAt: number;
  venues: Record<string, BaselineVenue>;
}

const BASELINE_SETTING = 'account_status_baseline_v1';

function stronger(
  left: AccountPermissionHealth,
  right: AccountPermissionHealth,
): AccountPermissionHealth {
  const rank = { PASS: 0, WARN: 1, BLOCK: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function readBaseline(
  repository: ArbitrageRepository | undefined,
): AccountStatusBaseline | undefined {
  if (!repository) return undefined;
  const raw = repository.getSetting(BASELINE_SETTING);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<AccountStatusBaseline>;
    if (parsed.version !== 1 || !parsed.venues || typeof parsed.venues !== 'object') {
      return undefined;
    }
    return parsed as AccountStatusBaseline;
  } catch {
    return undefined;
  }
}

function expectedVenueIds(venues: Readonly<Record<string, AccountPermissionVenue>>): string[] {
  return Object.keys(venues).sort();
}

export async function evaluateAccountPermissions(
  options: EvaluateAccountPermissionsOptions,
): Promise<AccountPermissionReport> {
  const now = options.now ?? Date.now();
  const withdrawals = options.credentials.filter((record) => record.role === 'withdrawal');
  const previous = readBaseline(options.repository);
  const nextBaseline: AccountStatusBaseline = {
    version: 1,
    updatedAt: now,
    venues: {},
  };
  const reports: AccountPermissionVenueReport[] = [];
  let health: AccountPermissionHealth = 'PASS';
  const globalReasons: string[] = [];

  for (const venueId of expectedVenueIds(options.venues)) {
    const venue = options.venues[venueId]!;
    const trade = venue.credentials;
    const fingerprint = credentialFingerprint(trade);
    const sharedWithdrawalKey = withdrawals.some(
      (record) => record.venueId === venueId && credentialFingerprint(record) === fingerprint,
    );
    const venueReasons: string[] = [];
    let venueHealth: AccountPermissionHealth = 'PASS';
    const block = (reason: string): void => {
      venueReasons.push(reason);
      venueHealth = 'BLOCK';
    };
    const warn = (reason: string): void => {
      venueReasons.push(reason);
      venueHealth = stronger(venueHealth, 'WARN');
    };

    if (sharedWithdrawalKey) {
      if (options.config.allowSharedTradeWithdrawalKey) warn('shared_trade_withdrawal_key');
      else block('shared_trade_withdrawal_key_not_allowed');
    }

    let observed: AccountStatusSnapshot | null = null;
    try {
      if (typeof venue.adapter.fetchAccountStatus !== 'function') {
        warn('account_status_unsupported');
      } else {
        observed = await venue.adapter.fetchAccountStatus(
          { requiredPairs: options.requiredPairs },
          trade,
        );
      }
    } catch (error) {
      block(
        `account_status_query_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (observed) {
      if (!observed.authenticated) block('authentication_not_confirmed');
      if (observed.errors.length > 0) {
        for (const error of observed.errors) block(`account_status_error:${error}`);
      }
      const capabilities = observed.capabilities;
      for (const [name, value] of Object.entries(capabilities)) {
        if (value === 'observed_denied') block(`${name}_permission_denied`);
        else if (value === 'unknown' || value === 'unsupported')
          warn(`${name}_permission_unverified`);
      }

      const ip = observed.ipWhitelist;
      if (ip?.supported) {
        if (trade.ipWhitelistVerified === true) {
          if (ip.present !== true || (ip.count ?? 0) === 0) {
            if (options.config.requireIpWhitelist) block('ip_whitelist_declared_but_empty');
            else warn('ip_whitelist_empty');
          } else if (ip.currentIpAccepted !== true) {
            block('ip_whitelist_current_request_not_accepted');
          }
        } else {
          warn('ip_whitelist_not_attested');
        }
      } else if (trade.ipWhitelistVerified === true) {
        warn('ip_whitelist_unsupported');
      }

      if (
        observed.pairWhitelist?.supported &&
        observed.pairWhitelist.requiredPairsAllowed === false
      ) {
        block('required_pair_not_whitelisted');
      }

      const previousVenue = previous?.venues[venueId];
      if (previousVenue) {
        if (previousVenue.credentialFingerprint !== fingerprint) {
          block('credential_fingerprint_changed');
        }
        if (
          options.config.blockOnAccountIdChange &&
          previousVenue.accountIdHash &&
          observed.accountIdHash &&
          previousVenue.accountIdHash !== observed.accountIdHash
        ) {
          block('account_id_changed');
        }
        if (
          options.config.blockOnIpWhitelistChange &&
          previousVenue.ipWhitelistDigest &&
          ip?.digest &&
          previousVenue.ipWhitelistDigest !== ip.digest
        ) {
          block('ip_whitelist_changed');
        }
        if (
          options.config.blockOnAccountModeChange &&
          previousVenue.accountMode &&
          observed.accountMode &&
          previousVenue.accountMode !== observed.accountMode
        ) {
          block('account_mode_changed');
        }
        if (
          previousVenue.pairWhitelistDigest &&
          observed.pairWhitelist?.digest &&
          previousVenue.pairWhitelistDigest !== observed.pairWhitelist.digest
        ) {
          block('pair_whitelist_changed');
        }
      }

      nextBaseline.venues[venueId] = {
        credentialFingerprint: fingerprint,
        ...(observed.accountIdHash ? { accountIdHash: observed.accountIdHash } : {}),
        ...(ip?.digest ? { ipWhitelistDigest: ip.digest } : {}),
        ...(observed.pairWhitelist?.digest
          ? { pairWhitelistDigest: observed.pairWhitelist.digest }
          : {}),
        ...(observed.accountMode ? { accountMode: observed.accountMode } : {}),
      };
    }

    health = stronger(health, venueHealth);
    reports.push({
      venueId,
      declared: {
        role: 'trade',
        withdrawalPermission: trade.withdrawalPermission,
        ipWhitelistVerified: trade.ipWhitelistVerified ?? null,
        credentialFingerprint: fingerprint,
        sharedWithdrawalKey,
      },
      observed,
      health: venueHealth,
      reasons: unique(venueReasons),
    });
  }

  if (reports.length === 0) {
    health = 'BLOCK';
    globalReasons.push('no_trade_credentials_available');
  }
  for (const report of reports) {
    for (const reason of report.reasons) globalReasons.push(`${report.venueId}:${reason}`);
  }

  let baselineUpdated = false;
  if (options.repository && options.persistBaseline !== false && health !== 'BLOCK') {
    options.repository.setSetting(BASELINE_SETTING, JSON.stringify(nextBaseline), now);
    baselineUpdated = true;
  }
  return {
    capturedAt: now,
    health,
    reasons: unique(globalReasons),
    venues: reports,
    baselineUpdated,
  };
}
