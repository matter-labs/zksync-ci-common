/**
 * Sends the top-up transactions from the funder wallet, logging every detail of them
 * (parameters, nonce, gas price, receipt) so the job log is a complete audit trail.
 */
import {
  JsonRpcProvider,
  Wallet,
  isError,
  type TransactionReceipt,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';

import { ETH_TOKEN_ADDRESS, type Bridgehub } from './chain.ts';
import type { Config } from './config.ts';
import { eth, gwei } from './format.ts';
import * as log from './log.ts';
import { withRetries } from './retry.ts';

/** A top-up that could not be done. The message is reported and makes the run fail. */
export class FundingError extends Error {}

export interface FundingResult {
  /** Markdown for the report table. */
  details: string;
  /** Plain-text line for the transaction list and the Slack message. */
  action: string;
}

interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** 0.1 gwei: lowest priority fee the job offers. */
const MIN_PRIORITY_FEE_WEI = 100_000_000n;

export class Funder {
  readonly address: string;
  /**
   * Smallest amount the funder could not afford in this run. Larger top-ups are skipped
   * without trying; smaller ones are still attempted.
   */
  unaffordable?: bigint;
  /** Set when no further transaction may be sent this run (a transaction is stuck pending). */
  haltReason?: string;
  /** Signing wallet. Absent in dry-run mode, whether or not a key was given. */
  private readonly wallet?: Wallet;

  constructor(
    private readonly l1: JsonRpcProvider,
    private readonly config: Config,
  ) {
    if (config.funderPrivateKey) {
      const wallet = new Wallet(config.funderPrivateKey);
      this.address = wallet.address;
      if (!config.dryRun) this.wallet = wallet.connect(l1);
    } else if (config.funderAddress) {
      this.address = config.funderAddress;
    } else {
      throw new FundingError('Neither FUNDER_PRIVATE_KEY nor FUNDER_ADDRESS is set');
    }
  }

  /** False in dry-run mode: balances are checked, nothing is signed. */
  get sendsTransactions(): boolean {
    return this.wallet !== undefined;
  }

  balance(): Promise<bigint> {
    return withRetries('funder balance', () => this.l1.getBalance(this.address));
  }

  txUrl(hash: string): string {
    return `${this.config.l1ExplorerUrl}/tx/${hash}`;
  }

  /** Plain ETH transfer on L1. */
  async transferL1(to: string, amount: bigint): Promise<FundingResult> {
    await this.assertCanSpend(amount);
    const fees = await this.fees();

    if (!this.wallet) {
      log.info(`  -> dry run: would send an L1 transfer of ${eth(amount)} ETH from ${this.address} to ${to}`);
      return {
        details: `dry-run: would transfer ${eth(amount)} ETH on L1 at max fee ${gwei(fees.maxFeePerGas)} gwei`,
        action: `dry run: would transfer ${eth(amount)} ETH to ${to} on L1`,
      };
    }

    const receipt = await this.send(this.wallet, `L1 transfer of ${eth(amount)} ETH`, { to, value: amount, ...fees });
    return {
      details: `sent ${eth(amount)} ETH, tx ${this.txMarkdown(receipt.hash)}`,
      action: `transferred ${eth(amount)} ETH to ${to} on L1, ${this.txUrl(receipt.hash)}`,
    };
  }

  /**
   * Deposit through `Bridgehub.requestL2TransactionDirect`. The L2 gas cost comes from
   * `l2TransactionBaseCost` at the max fee of the tx, so `tx.gasprice` can never exceed
   * the price the cost was computed with and `mintValue` always covers `l2Value` plus L2
   * gas. Any surplus is refunded to the recipient on L2.
   */
  async depositL2(bridgehub: Bridgehub, chainId: bigint, to: string, amount: bigint): Promise<FundingResult> {
    const bridgehubAddress = await bridgehub.getAddress();

    const baseToken = await withRetries('baseToken()', () => bridgehub.baseToken(chainId)).catch(() => 'unknown');
    if (baseToken.toLowerCase() !== ETH_TOKEN_ADDRESS) {
      throw new FundingError(
        `chain ${chainId} uses base token ${baseToken}; only ETH-based chains can be topped up ` +
          `(address ${to} needs ${eth(amount)} of base token)`,
      );
    }

    const fees = await this.fees();
    const { l2GasLimit, l2GasPerPubdata } = this.config;
    const baseCost = await withRetries('l2TransactionBaseCost()', () =>
      bridgehub.l2TransactionBaseCost(chainId, fees.maxFeePerGas, l2GasLimit, l2GasPerPubdata),
    ).catch((err: unknown) => {
        throw new FundingError(`failed to compute l2TransactionBaseCost for chain ${chainId}: ${log.errorMessage(err)}`);
      });
    const mintValue = amount + baseCost;
    log.info(
      `     deposit via Bridgehub ${bridgehubAddress} to chain ${chainId}: l2Value ${eth(amount)} ETH, ` +
        `L2 gas cost ${eth(baseCost)} ETH (limit ${l2GasLimit}, ${l2GasPerPubdata} gas/pubdata byte, ` +
        `at ${gwei(fees.maxFeePerGas)} gwei), mintValue ${eth(mintValue)} ETH, refund recipient ${to}`,
    );

    await this.assertCanSpend(mintValue);

    if (!this.wallet) {
      log.info(`  -> dry run: would send a deposit of ${eth(amount)} ETH from ${this.address} to ${to} on chain ${chainId}`);
      return {
        details: `dry-run: would deposit ${eth(amount)} ETH via ${bridgehubAddress} (mintValue ${eth(mintValue)} ETH incl. L2 gas)`,
        action: `dry run: would deposit ${eth(amount)} ETH to ${to} on chain ${chainId}`,
      };
    }

    const request = {
      chainId,
      mintValue,
      l2Contract: to,
      l2Value: amount,
      l2Calldata: '0x',
      l2GasLimit,
      l2GasPerPubdataByteLimit: l2GasPerPubdata,
      factoryDeps: [],
      refundRecipient: to,
    };
    const tx = await bridgehub.requestL2TransactionDirect.populateTransaction(request, { value: mintValue });
    const receipt = await this.send(
      this.wallet,
      `deposit of ${eth(amount)} ETH to chain ${chainId}`,
      { ...tx, ...fees },
      `requestL2TransactionDirect(${chainId}, ${mintValue}, ${to}, ${amount}, 0x, ${l2GasLimit}, ${l2GasPerPubdata}, [], ${to})`,
    );
    return {
      details: `deposited ${eth(amount)} ETH (mintValue ${eth(mintValue)} ETH), tx ${this.txMarkdown(receipt.hash)}`,
      action: `deposited ${eth(amount)} ETH to ${to} on chain ${chainId} (mintValue ${eth(mintValue)} ETH), ${this.txUrl(receipt.hash)}`,
    };
  }

  /** Fails when the funder cannot spend `amount` plus the gas reserve, remembering the amount. */
  private async assertCanSpend(amount: bigint): Promise<void> {
    const have = await this.balance();
    if (have < amount + this.config.funderGasReserve) {
      if (this.unaffordable === undefined || amount < this.unaffordable) this.unaffordable = amount;
      throw new FundingError(
        `funder ${this.address} holds ${eth(have)} ETH, cannot spend ${eth(amount)} ETH; ` +
          'larger top-ups are skipped for the rest of this run',
      );
    }
    log.info(`     funder balance ${eth(have)} ETH, ok to spend ${eth(amount)} ETH`);
  }

  /**
   * Current L1 gas price plus the configured buffer, pinned as the max fee of the next tx.
   * Asks the node directly (eth_gasPrice, eth_maxPriorityFeePerGas) rather than through
   * ethers' getFeeData, which bundles several calls and depends on how the RPC provider
   * answers batches.
   */
  private async fees(): Promise<Fees> {
    const gasPrice = BigInt(
      await withRetries('eth_gasPrice', () => this.l1.send('eth_gasPrice', [])).catch((err: unknown) => {
        throw new FundingError(`failed to fetch the L1 gas price: ${log.errorMessage(err)}`);
      }),
    );
    // Not every RPC supports eth_maxPriorityFeePerGas; fall back to a 1 gwei tip. Some
    // suggest near-zero tips on Sepolia, which risks slow inclusion, so the tip is floored
    // at 0.1 gwei; the max fee caps what is actually paid.
    const suggestedTip = BigInt(
      await withRetries('eth_maxPriorityFeePerGas', () => this.l1.send('eth_maxPriorityFeePerGas', [])).catch(
        () => 1_000_000_000n,
      ),
    );
    const tip = suggestedTip > MIN_PRIORITY_FEE_WEI ? suggestedTip : MIN_PRIORITY_FEE_WEI;

    const maxFeePerGas = (gasPrice * (100n + this.config.gasPriceBufferPercent)) / 100n;
    const maxPriorityFeePerGas = tip < maxFeePerGas ? tip : maxFeePerGas;
    log.info(
      `     L1 gas price ${gwei(gasPrice)} gwei, max fee for this tx ${gwei(maxFeePerGas)} gwei ` +
        `(+${this.config.gasPriceBufferPercent}%), priority fee ${gwei(maxPriorityFeePerGas)} gwei`,
    );
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  /**
   * Signs, broadcasts and waits for a transaction, logging every step. Refuses to send
   * while an earlier transaction of the funder is still pending: queueing behind it could
   * fund the same target twice once both land.
   */
  private async send(
    wallet: Wallet,
    what: string,
    request: TransactionRequest,
    call?: string,
  ): Promise<TransactionReceipt> {
    if (this.haltReason) throw new FundingError(`${what}: not sent, ${this.haltReason}`);

    const [confirmedNonce, pendingNonce] = await Promise.all([
      this.l1.getTransactionCount(this.address, 'latest'),
      this.l1.getTransactionCount(this.address, 'pending'),
    ]);
    if (pendingNonce > confirmedNonce) {
      this.haltReason =
        `${pendingNonce - confirmedNonce} transaction(s) of the funder are still pending (nonce ${confirmedNonce}); ` +
        'no transactions are sent until they confirm or drop';
      throw new FundingError(`${what}: not sent, ${this.haltReason}`);
    }

    const value = BigInt(request.value ?? 0);
    log.info(`  -> sending ${what}`);
    log.info(
      `     from ${this.address} (nonce ${confirmedNonce}) to ${String(request.to)}, value ${eth(value)} ETH (${value} wei), ` +
        `max fee ${gwei(BigInt(request.maxFeePerGas ?? 0))} gwei`,
    );
    if (call) log.info(`     call ${call}`);

    let response: TransactionResponse;
    try {
      response = await wallet.sendTransaction({ ...request, nonce: confirmedNonce });
    } catch (err) {
      throw new FundingError(`${what}: sending failed: ${log.errorMessage(err)}`);
    }
    const url = this.txUrl(response.hash);
    log.info(`     broadcast ${response.hash}, waiting for confirmation`);

    let receipt: TransactionReceipt | null;
    try {
      receipt = await response.wait(1, this.config.txTimeoutMs);
    } catch (err) {
      if (isError(err, 'TIMEOUT')) {
        const seconds = this.config.txTimeoutMs / 1000;
        this.haltReason = `transaction ${response.hash} was still pending after ${seconds}s`;
        throw new FundingError(
          `${what}: tx ${response.hash} was not confirmed within ${seconds}s and may still land; ` +
            `no further transactions are sent this run, ${url}`,
        );
      }
      if (isError(err, 'CALL_EXCEPTION')) throw new FundingError(`${what}: transaction ${response.hash} reverted, ${url}`);
      throw new FundingError(`${what}: waiting for tx ${response.hash} failed: ${log.errorMessage(err)}, ${url}`);
    }
    if (!receipt || receipt.status !== 1) {
      throw new FundingError(`${what}: transaction ${response.hash} reverted, ${url}`);
    }

    log.info(
      `     confirmed in block ${receipt.blockNumber}: tx ${receipt.hash}, gas used ${receipt.gasUsed}, ` +
        `effective gas price ${gwei(receipt.gasPrice)} gwei, L1 fee ${eth(receipt.fee, 6)} ETH`,
    );
    log.info(`     ${url}`);
    return receipt;
  }

  private txMarkdown(hash: string): string {
    return `[${hash.slice(0, 10)}…](${this.txUrl(hash)})`;
  }
}
