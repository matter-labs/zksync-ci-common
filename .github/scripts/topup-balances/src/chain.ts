/**
 * L1 access: JSON-RPC providers, the Bridgehub interface, and the on-chain check that
 * decides whether a Jarvis chain lives on this L1.
 */
import { Contract, FetchRequest, JsonRpcProvider, Network, ZeroAddress, isAddress, isError } from 'ethers';

import { withRetries } from './retry.ts';

/** A callable contract method as ethers types it (`contract.getFunction(name)`). */
type ContractMethod = ReturnType<Contract['getFunction']>;

/** Address the Bridgehub reports as base token of ETH-based chains. */
export const ETH_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000001';

export const BRIDGEHUB_ABI = [
  'function getZKChain(uint256 chainId) view returns (address)',
  // Pre-v26 name of getZKChain.
  'function getHyperchain(uint256 chainId) view returns (address)',
  'function settlementLayer(uint256 chainId) view returns (uint256)',
  'function baseToken(uint256 chainId) view returns (address)',
  'function l2TransactionBaseCost(uint256 chainId, uint256 gasPrice, uint256 l2GasLimit, uint256 l2GasPerPubdataByteLimit) view returns (uint256)',
  'function requestL2TransactionDirect((uint256 chainId, uint256 mintValue, address l2Contract, uint256 l2Value, bytes l2Calldata, uint256 l2GasLimit, uint256 l2GasPerPubdataByteLimit, bytes[] factoryDeps, address refundRecipient) request) payable returns (bytes32)',
] as const;

const DIAMOND_PROXY_ABI = ['function getBridgehub() view returns (address)'] as const;

/**
 * Typed view of the Bridgehub methods this job uses. ethers' `Contract` only knows the
 * ABI at runtime, so the call signatures are declared here for the type checker.
 */
export type Bridgehub = {
  getZKChain(chainId: bigint): Promise<string>;
  getHyperchain(chainId: bigint): Promise<string>;
  settlementLayer(chainId: bigint): Promise<bigint>;
  baseToken(chainId: bigint): Promise<string>;
  l2TransactionBaseCost(chainId: bigint, gasPrice: bigint, l2GasLimit: bigint, l2GasPerPubdataByteLimit: bigint): Promise<bigint>;
  requestL2TransactionDirect: ContractMethod;
} & Contract;

type DiamondProxy = { getBridgehub(): Promise<string> } & Contract;

export function bridgehubAt(address: string, provider: JsonRpcProvider): Bridgehub {
  return new Contract(address, BRIDGEHUB_ABI, provider) as Bridgehub;
}

/**
 * Provider with a request timeout, without network auto-detection, without ethers'
 * short-lived response cache (the run sends transactions back to back and must always see
 * the current nonce and balance) and without request batching (RPC providers differ in how
 * they answer batches, which shows up as "missing response for request").
 */
export function createProvider(url: string, chainId: bigint, timeoutMs: number): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  return new JsonRpcProvider(request, Network.from(chainId), {
    staticNetwork: true,
    cacheTimeout: -1,
    batchMaxCount: 1,
  });
}

/**
 * True for errors coming from the contract side of a call: no code at the address, unknown
 * function, revert. Transport errors (timeouts, HTTP errors, rate limits) say nothing about
 * the chain and must never be mistaken for "not deployed".
 */
export function isContractError(err: unknown): boolean {
  if (isError(err, 'CALL_EXCEPTION')) return true;
  // ethers also uses BAD_DATA for "missing response for request", which is the RPC endpoint
  // answering a batch or request in an unexpected shape (rate limits, proxies): a transport
  // problem, not a statement about the contract.
  return isError(err, 'BAD_DATA') && !/missing response/i.test(err.shortMessage);
}

/** `.catch` handler that turns contract errors into `undefined` and lets transport errors propagate. */
function undefinedIfContractError(err: unknown): undefined {
  if (isContractError(err)) return undefined;
  throw err;
}

/**
 * One provider per RPC URL and chain ID, each checked once to really serve that chain
 * (a copy-pasted RPC URL in the registry would otherwise return another chain's
 * balances). All providers are destroyed at the end of the run so the process can exit.
 */
export class ProviderPool {
  private readonly providers = new Map<string, Promise<JsonRpcProvider>>();

  constructor(private readonly timeoutMs: number) {}

  /** Rejects when the RPC is unreachable or serves another chain. */
  get(url: string, chainId: bigint): Promise<JsonRpcProvider> {
    const key = `${chainId}:${url}`;
    let provider = this.providers.get(key);
    if (!provider) {
      provider = this.connect(url, chainId);
      this.providers.set(key, provider);
    }
    return provider;
  }

  private async connect(url: string, chainId: bigint): Promise<JsonRpcProvider> {
    const provider = createProvider(url, chainId, this.timeoutMs);
    try {
      const actual = BigInt(await withRetries(`eth_chainId on ${url}`, () => provider.send('eth_chainId', [])));
      if (actual !== chainId) throw new Error(`RPC ${url} serves chain ${actual}, expected ${chainId}`);
      return provider;
    } catch (err) {
      provider.destroy();
      throw err;
    }
  }

  async destroy(): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.then(
        (p) => p.destroy(),
        () => undefined,
      );
    }
    this.providers.clear();
  }
}

export type L1Inspection =
  | { onL1: true; bridgehub: Bridgehub; bridgehubAddress: string; settlementLayer: bigint }
  | { onL1: false; reason: string; suspicious: boolean };

/**
 * Checks that a Jarvis chain is deployed on this L1: its diamond proxy must be a contract
 * here that knows its Bridgehub, and that Bridgehub must map the chain ID back to the same
 * diamond proxy. Chains of other L1s (mainnet) fail the first step because their addresses
 * hold no code on Sepolia. A chain that passes the first step but not the second is flagged
 * as suspicious, since the registry and the chain disagree.
 *
 * Transport errors are thrown, never interpreted: the caller reports them and moves on.
 */
export async function inspectChainOnL1(
  l1: JsonRpcProvider,
  l1ChainId: bigint,
  chainId: bigint,
  diamondProxy: string,
): Promise<L1Inspection> {
  const diamond = new Contract(diamondProxy, DIAMOND_PROXY_ABI, l1) as DiamondProxy;
  const bridgehubAddress = await withRetries('getBridgehub()', () => diamond.getBridgehub()).catch(undefinedIfContractError);
  if (!bridgehubAddress || !isAddress(bridgehubAddress) || bridgehubAddress === ZeroAddress) {
    return {
      onL1: false,
      suspicious: false,
      reason: `diamond proxy ${diamondProxy} is not deployed on chain ${l1ChainId}`,
    };
  }

  const bridgehub = bridgehubAt(bridgehubAddress, l1);
  const registered =
    (await withRetries('getZKChain()', () => bridgehub.getZKChain(chainId)).catch(undefinedIfContractError)) ??
    (await withRetries('getHyperchain()', () => bridgehub.getHyperchain(chainId)).catch(undefinedIfContractError));
  if (!registered || registered.toLowerCase() !== diamondProxy.toLowerCase()) {
    return {
      onL1: false,
      suspicious: true,
      reason: `Bridgehub ${bridgehubAddress} maps chain ${chainId} to ${registered ?? 'nothing'}, not to ${diamondProxy}`,
    };
  }

  // Pre-v26 Bridgehubs have no settlementLayer(): everything they know settles on L1.
  const settlementLayer = await withRetries('settlementLayer()', () => bridgehub.settlementLayer(chainId)).catch((err: unknown) => {
    if (isContractError(err)) return l1ChainId;
    throw err;
  });
  return { onL1: true, bridgehub, bridgehubAddress, settlementLayer };
}
