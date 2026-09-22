/**
 * Access to the Jarvis chain registry (zk-chains-registry, `GET /api/chains/cache`).
 *
 * The types below are the subset of `@zk-jarvis/shared` types this job relies on.
 * `chains[]` is the directory, `chainDataMap[slug]` the live state; join them by slug.
 */
import { readFile } from 'node:fs/promises';
import { isAddress } from 'ethers';

import type { Config } from './config.ts';

export interface ValidatorRoleEntry {
  address: string;
  /** e.g. `last_commit`, `service_prove`, `manual_execute` */
  labels: string[];
}

export interface ValidatorRoles {
  committers?: ValidatorRoleEntry[];
  provers?: ValidatorRoleEntry[];
  executors?: ValidatorRoleEntry[];
}

export interface JarvisChain {
  /** Slug, join key into `chainDataMap`. */
  chain: string;
  ecosystem: string;
  chainId: number;
  /** `normal`, `unknown`, `unknown_inactive`, `archived` or `planned`. */
  state?: string;
  archived?: boolean;
  l2RpcUrl?: string;
  watchdogAddress?: string;
  commitOperatorAddress?: string;
  proveOperatorAddress?: string;
  executeOperatorAddress?: string;
  serviceCommitOperatorAddress?: string;
  serviceProveOperatorAddress?: string;
  serviceExecuteOperatorAddress?: string;
}

export interface JarvisChainData {
  /** L1 diamond proxy of the chain. */
  diamondProxy?: string;
  validatorRoles?: ValidatorRoles;
}

export interface JarvisRegistry {
  chains: JarvisChain[];
  chainDataMap: Record<string, JarvisChainData>;
}

export type OperatorRole = 'commit' | 'prove' | 'execute';
export const OPERATOR_ROLES: readonly OperatorRole[] = ['commit', 'prove', 'execute'];

type AddressField = keyof Pick<
  JarvisChain,
  | 'commitOperatorAddress'
  | 'proveOperatorAddress'
  | 'executeOperatorAddress'
  | 'serviceCommitOperatorAddress'
  | 'serviceProveOperatorAddress'
  | 'serviceExecuteOperatorAddress'
>;
const ROLE_FIELDS: Record<OperatorRole, { validators: keyof ValidatorRoles; service: AddressField; manual: AddressField }> = {
  commit: { validators: 'committers', service: 'serviceCommitOperatorAddress', manual: 'commitOperatorAddress' },
  prove: { validators: 'provers', service: 'serviceProveOperatorAddress', manual: 'proveOperatorAddress' },
  execute: { validators: 'executors', service: 'serviceExecuteOperatorAddress', manual: 'executeOperatorAddress' },
};

/**
 * Operator address for a role, with the same precedence the Jarvis dashboard uses:
 * sender of the last tx -> service-discovered -> manually configured -> first validator.
 */
export function resolveOperator(
  role: OperatorRole,
  chain: JarvisChain,
  data: JarvisChainData | undefined,
): string | undefined {
  const fields = ROLE_FIELDS[role];
  const validators = data?.validatorRoles?.[fields.validators] ?? [];
  const labelled = (label: string): string | undefined =>
    validators.find((entry) => entry.labels?.includes(label))?.address;

  const candidate =
    labelled(`last_${role}`) ??
    labelled(`service_${role}`) ??
    chain[fields.service] ??
    labelled(`manual_${role}`) ??
    chain[fields.manual] ??
    validators[0]?.address;

  return candidate && isAddress(candidate) ? candidate : undefined;
}

export interface ChainSelection {
  selected: JarvisChain[];
  skipped: { chain: string; reason: string }[];
}

/** Chains worth checking: deployed and labelled (`normal`), minus the configured filters. */
export function selectChains(
  registry: JarvisRegistry,
  filters: Pick<Config, 'onlyEcosystems' | 'skipChains'>,
): ChainSelection {
  const selection: ChainSelection = { selected: [], skipped: [] };
  for (const chain of registry.chains) {
    if (chain.state !== 'normal' || chain.archived === true) continue;
    if (filters.onlyEcosystems.length > 0 && !filters.onlyEcosystems.includes(chain.ecosystem)) continue;
    if (filters.skipChains.includes(chain.chain)) {
      selection.skipped.push({ chain: chain.chain, reason: 'SKIP_CHAINS' });
      continue;
    }
    selection.selected.push(chain);
  }
  return selection;
}

/** L2 RPC URL of a chain in an ecosystem, used to read balances on a Gateway settlement layer. */
export function l2RpcUrlOf(registry: JarvisRegistry, ecosystem: string, chainId: bigint): string | undefined {
  return registry.chains.find((chain) => chain.ecosystem === ecosystem && BigInt(chain.chainId) === chainId)
    ?.l2RpcUrl;
}

/** Whole days until the bearer JWT expires, or undefined when it cannot be decoded. */
export function tokenDaysLeft(token: string, now: number = Date.now()): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp = (claims as { exp?: unknown }).exp;
    if (typeof exp !== 'number') return undefined;
    return Math.floor((exp * 1000 - now) / 86_400_000);
  } catch {
    return undefined;
  }
}

/** Loads the registry from the API, or from `JARVIS_PAYLOAD_FILE` when testing. */
export async function loadRegistry(config: Config): Promise<JarvisRegistry> {
  if (config.jarvisPayloadFile) {
    return parseRegistry(await readFile(config.jarvisPayloadFile, 'utf8'));
  }
  if (!config.jarvisApiToken) throw new Error('JARVIS_API_TOKEN is required');

  const url = `${config.jarvisApiUrl}/api/chains/cache`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.jarvisApiToken}` },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Jarvis returned HTTP ${response.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return parseRegistry(body);
}

function parseRegistry(json: string): JarvisRegistry {
  const data = JSON.parse(json) as Partial<JarvisRegistry>;
  if (!Array.isArray(data.chains)) throw new Error('Unexpected Jarvis payload shape: `chains` is not an array');
  return { chains: data.chains, chainDataMap: data.chainDataMap ?? {} };
}
