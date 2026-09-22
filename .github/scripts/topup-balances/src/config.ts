import { parseEther } from 'ethers';

/** Balance thresholds in wei. A `min` of 0 disables the check. */
export interface Thresholds {
  /** Balances below this are topped up. */
  min: bigint;
  /** Balance to reach when topping up. */
  target: bigint;
}

export interface Config {
  jarvisApiUrl: string;
  jarvisApiToken: string;
  /** Testing only: read the registry from this file instead of the API. */
  jarvisPayloadFile?: string;
  l1RpcUrl: string;
  l1ChainId: number;
  l1ExplorerUrl: string;
  /** Required unless `dryRun` is set. */
  funderPrivateKey?: string;
  /** Derived from the key when one is given. */
  funderAddress?: string;
  dryRun: boolean;
  operator: Thresholds;
  watchdogL1: Thresholds;
  watchdogL2: Thresholds;
  /** The run fails when the funder ends below this. */
  funderMin: bigint;
  /** ETH the funder must keep for L1 gas. */
  funderGasReserve: bigint;
  l2GasLimit: bigint;
  l2GasPerPubdata: bigint;
  /** Buffer over the current L1 gas price, used as the max fee of every tx. */
  gasPriceBufferPercent: bigint;
  /** Jarvis ecosystem names to restrict to; empty means all. */
  onlyEcosystems: string[];
  /** Jarvis chain slugs to skip. */
  skipChains: string[];
  /** The run fails when the Jarvis token expires sooner than this. */
  jarvisTokenMinDays: number;
  rpcTimeoutMs: number;
  txTimeoutMs: number;
}

export class ConfigError extends Error {}

const DEFAULTS: Record<string, string> = {
  JARVIS_API_URL: 'https://api.jarvis.matterhosted.dev',
  L1_CHAIN_ID: '11155111',
  L1_EXPLORER_URL: 'https://sepolia.etherscan.io',
  OPERATOR_MIN_ETH: '5',
  OPERATOR_TARGET_ETH: '10',
  WATCHDOG_L1_MIN_ETH: '0.2',
  WATCHDOG_L1_TARGET_ETH: '0.5',
  WATCHDOG_L2_MIN_ETH: '0.5',
  WATCHDOG_L2_TARGET_ETH: '1.5',
  FUNDER_MIN_ETH: '20',
  FUNDER_GAS_RESERVE_ETH: '0.05',
  L2_GAS_LIMIT: '10000000',
  L2_GAS_PER_PUBDATA: '800',
  GAS_PRICE_BUFFER_PERCENT: '50',
  JARVIS_TOKEN_MIN_DAYS: '7',
  RPC_TIMEOUT: '30',
  TX_TIMEOUT: '300',
};

/** DRY_RUN=true (or 1): check balances and report, never sign a transaction. */
export function isDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['true', '1'].includes((env['DRY_RUN'] ?? '').trim().toLowerCase());
}

/** Reads the configuration from environment variables (documented in README.md). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string): string => (env[name] ?? '').trim() || (DEFAULTS[name] ?? '');
  const optional = (name: string): string | undefined => get(name) || undefined;
  const list = (name: string): string[] => get(name).split(/\s+/).filter(Boolean);

  const eth = (name: string): bigint => {
    const raw = get(name);
    try {
      return parseEther(raw);
    } catch {
      throw new ConfigError(`${name} must be an ETH amount, got "${raw}"`);
    }
  };
  const integer = (name: string): bigint => {
    const raw = get(name);
    if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative integer, got "${raw}"`);
    return BigInt(raw);
  };
  const thresholds = (minVar: string, targetVar: string): Thresholds => {
    const result = { min: eth(minVar), target: eth(targetVar) };
    if (result.min > 0n && result.target < result.min) {
      throw new ConfigError(`${targetVar} must be >= ${minVar}`);
    }
    return result;
  };

  const l1RpcUrl = get('L1_RPC_URL');
  if (!l1RpcUrl) throw new ConfigError('L1_RPC_URL is required');

  const dryRun = isDryRun(env);
  const funderPrivateKey = optional('FUNDER_PRIVATE_KEY');
  const funderAddress = optional('FUNDER_ADDRESS');
  if (!dryRun && !funderPrivateKey) throw new ConfigError('FUNDER_PRIVATE_KEY is required unless DRY_RUN=true');
  if (!funderPrivateKey && !funderAddress) {
    throw new ConfigError('FUNDER_ADDRESS is required in dry-run mode when no key is given');
  }

  return {
    jarvisApiUrl: get('JARVIS_API_URL').replace(/\/+$/, ''),
    jarvisApiToken: get('JARVIS_API_TOKEN'),
    jarvisPayloadFile: optional('JARVIS_PAYLOAD_FILE'),
    l1RpcUrl,
    l1ChainId: Number(integer('L1_CHAIN_ID')),
    l1ExplorerUrl: get('L1_EXPLORER_URL').replace(/\/+$/, ''),
    funderPrivateKey,
    funderAddress,
    dryRun,
    operator: thresholds('OPERATOR_MIN_ETH', 'OPERATOR_TARGET_ETH'),
    watchdogL1: thresholds('WATCHDOG_L1_MIN_ETH', 'WATCHDOG_L1_TARGET_ETH'),
    watchdogL2: thresholds('WATCHDOG_L2_MIN_ETH', 'WATCHDOG_L2_TARGET_ETH'),
    funderMin: eth('FUNDER_MIN_ETH'),
    funderGasReserve: eth('FUNDER_GAS_RESERVE_ETH'),
    l2GasLimit: integer('L2_GAS_LIMIT'),
    l2GasPerPubdata: integer('L2_GAS_PER_PUBDATA'),
    gasPriceBufferPercent: integer('GAS_PRICE_BUFFER_PERCENT'),
    onlyEcosystems: list('ONLY_ECOSYSTEMS'),
    skipChains: list('SKIP_CHAINS'),
    jarvisTokenMinDays: Number(integer('JARVIS_TOKEN_MIN_DAYS')),
    rpcTimeoutMs: Number(integer('RPC_TIMEOUT')) * 1000,
    txTimeoutMs: Number(integer('TX_TIMEOUT')) * 1000,
  };
}
