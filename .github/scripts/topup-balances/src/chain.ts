/**
 * L1 access: JSON-RPC providers, the Bridgehub interface, and the on-chain check that
 * decides whether a Jarvis chain lives on this L1.
 */
import { Contract, FetchRequest, JsonRpcProvider, Network, ZeroAddress, isAddress } from 'ethers';

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
 * Provider with a request timeout, without network auto-detection and without ethers'
 * short-lived response cache: the run sends transactions back to back and must always
 * see the current nonce and balance.
 */
export function createProvider(url: string, chainId: bigint, timeoutMs: number): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  return new JsonRpcProvider(request, Network.from(chainId), { staticNetwork: true, cacheTimeout: -1 });
}

/** One provider per RPC URL, all destroyed at the end of the run so the process can exit. */
export class ProviderPool {
  private readonly providers = new Map<string, JsonRpcProvider>();

  constructor(private readonly timeoutMs: number) {}

  get(url: string, chainId: bigint): JsonRpcProvider {
    let provider = this.providers.get(url);
    if (!provider) {
      provider = createProvider(url, chainId, this.timeoutMs);
      this.providers.set(url, provider);
    }
    return provider;
  }

  destroy(): void {
    for (const provider of this.providers.values()) provider.destroy();
    this.providers.clear();
  }
}

/** Balance of `address`, or undefined when the RPC cannot be reached (e.g. auth-gated Prividium RPCs). */
export async function readBalance(provider: JsonRpcProvider, address: string): Promise<bigint | undefined> {
  try {
    return await provider.getBalance(address);
  } catch {
    return undefined;
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
 */
export async function inspectChainOnL1(
  l1: JsonRpcProvider,
  l1ChainId: bigint,
  chainId: bigint,
  diamondProxy: string,
): Promise<L1Inspection> {
  const diamond = new Contract(diamondProxy, DIAMOND_PROXY_ABI, l1) as DiamondProxy;
  const bridgehubAddress = await diamond.getBridgehub().catch(() => undefined);
  if (!bridgehubAddress || !isAddress(bridgehubAddress) || bridgehubAddress === ZeroAddress) {
    return {
      onL1: false,
      suspicious: false,
      reason: `diamond proxy ${diamondProxy} is not deployed on chain ${l1ChainId}`,
    };
  }

  const bridgehub = bridgehubAt(bridgehubAddress, l1);
  const registered =
    (await bridgehub.getZKChain(chainId).catch(() => undefined)) ??
    (await bridgehub.getHyperchain(chainId).catch(() => undefined));
  if (!registered || registered.toLowerCase() !== diamondProxy.toLowerCase()) {
    return {
      onL1: false,
      suspicious: true,
      reason: `Bridgehub ${bridgehubAddress} maps chain ${chainId} to ${registered ?? 'nothing'}, not to ${diamondProxy}`,
    };
  }

  const settlementLayer = await bridgehub.settlementLayer(chainId).catch(() => l1ChainId);
  return { onL1: true, bridgehub, bridgehubAddress, settlementLayer };
}
