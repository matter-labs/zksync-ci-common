/**
 * Sends the top-up transactions from the funder wallet, logging every detail of them
 * (parameters, nonce, gas price, receipt) so the job log is a complete audit trail.
 */
import {
  JsonRpcProvider,
  Wallet,
  type TransactionReceipt,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';

import { ETH_TOKEN_ADDRESS, type Bridgehub } from './chain.ts';
import type { Config } from './config.ts';
import { eth, gwei } from './format.ts';
import * as log from './log.ts';

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

export class Funder {
  readonly address: string;
  /** Set once a top-up could not be afforded; the remaining top-ups are then skipped. */
  exhausted = false;
  /** Absent in dry-run mode without a key. */
  private readonly wallet?: Wallet;

  constructor(
    private readonly l1: JsonRpcProvider,
    private readonly config: Config,
  ) {
    if (config.funderPrivateKey) {
      this.wallet = new Wallet(config.funderPrivateKey, l1);
      this.address = this.wallet.address;
    } else if (config.funderAddress) {
      this.address = config.funderAddress;
    } else {
      throw new FundingError('Neither FUNDER_PRIVATE_KEY nor FUNDER_ADDRESS is set');
    }
  }

  balance(): Promise<bigint> {
    return this.l1.getBalance(this.address);
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

    const receipt = await this.send(`L1 transfer of ${eth(amount)} ETH`, { to, value: amount, ...fees });
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

    const baseToken = await bridgehub.baseToken(chainId).catch(() => 'unknown');
    if (baseToken.toLowerCase() !== ETH_TOKEN_ADDRESS) {
      throw new FundingError(
        `Chain ${chainId} uses base token ${baseToken}; only ETH-based chains can be topped up ` +
          `(address ${to} needs ${eth(amount)} of base token)`,
      );
    }

    const fees = await this.fees();
    const { l2GasLimit, l2GasPerPubdata } = this.config;
    const baseCost = await bridgehub
      .l2TransactionBaseCost(chainId, fees.maxFeePerGas, l2GasLimit, l2GasPerPubdata)
      .catch((err: unknown) => {
        throw new FundingError(`Failed to compute l2TransactionBaseCost for chain ${chainId}: ${log.errorMessage(err)}`);
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
      `deposit of ${eth(amount)} ETH to chain ${chainId}`,
      { ...tx, ...fees },
      `requestL2TransactionDirect(${chainId}, ${mintValue}, ${to}, ${amount}, 0x, ${l2GasLimit}, ${l2GasPerPubdata}, [], ${to})`,
    );
    return {
      details: `deposited ${eth(amount)} ETH (mintValue ${eth(mintValue)} ETH), tx ${this.txMarkdown(receipt.hash)}`,
      action: `deposited ${eth(amount)} ETH to ${to} on chain ${chainId} (mintValue ${eth(mintValue)} ETH), ${this.txUrl(receipt.hash)}`,
    };
  }

  /** Fails (and marks the funder exhausted) when it cannot spend `amount` plus the gas reserve. */
  private async assertCanSpend(amount: bigint): Promise<void> {
    const have = await this.balance();
    if (have < amount + this.config.funderGasReserve) {
      this.exhausted = true;
      throw new FundingError(
        `Funder ${this.address} holds ${eth(have)} ETH, cannot spend ${eth(amount)} ETH; skipping remaining top-ups`,
      );
    }
    log.info(`     funder balance ${eth(have)} ETH, ok to spend ${eth(amount)} ETH`);
  }

  /** Current L1 gas price plus the configured buffer, pinned as the max fee of the next tx. */
  private async fees(): Promise<Fees> {
    const feeData = await this.l1.getFeeData().catch((err: unknown) => {
      throw new FundingError(`Failed to fetch the L1 gas price: ${log.errorMessage(err)}`);
    });
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (gasPrice === null) throw new FundingError('The L1 RPC returned no gas price');

    const maxFeePerGas = (gasPrice * (100n + this.config.gasPriceBufferPercent)) / 100n;
    const suggestedTip = feeData.maxPriorityFeePerGas ?? 0n;
    const maxPriorityFeePerGas = suggestedTip < maxFeePerGas ? suggestedTip : maxFeePerGas;
    log.info(
      `     L1 gas price ${gwei(gasPrice)} gwei, max fee for this tx ${gwei(maxFeePerGas)} gwei ` +
        `(+${this.config.gasPriceBufferPercent}%), priority fee ${gwei(maxPriorityFeePerGas)} gwei`,
    );
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  /** Signs, broadcasts and waits for a transaction, logging every step. */
  private async send(what: string, request: TransactionRequest, call?: string): Promise<TransactionReceipt> {
    const wallet = this.wallet;
    if (!wallet) throw new FundingError('No funder key available');

    const nonce = await wallet.getNonce('pending');
    const value = BigInt(request.value ?? 0);
    log.info(`  -> sending ${what}`);
    log.info(
      `     from ${this.address} (nonce ${nonce}) to ${String(request.to)}, value ${eth(value)} ETH (${value} wei), ` +
        `max fee ${gwei(BigInt(request.maxFeePerGas ?? 0))} gwei`,
    );
    if (call) log.info(`     call ${call}`);

    let response: TransactionResponse;
    try {
      response = await wallet.sendTransaction({ ...request, nonce });
    } catch (err) {
      throw new FundingError(`${what}: sending failed: ${log.errorMessage(err)}`);
    }
    log.info(`     broadcast ${response.hash}, waiting for confirmation`);

    let receipt: TransactionReceipt | null;
    try {
      receipt = await response.wait(1, this.config.txTimeoutMs);
    } catch (err) {
      throw new FundingError(`${what}: tx ${response.hash} failed: ${log.errorMessage(err)}, ${this.txUrl(response.hash)}`);
    }
    if (!receipt) {
      throw new FundingError(
        `${what}: tx ${response.hash} was not confirmed within ${this.config.txTimeoutMs / 1000}s, ${this.txUrl(response.hash)}`,
      );
    }
    if (receipt.status !== 1) {
      throw new FundingError(`${what}: transaction ${receipt.hash} reverted, ${this.txUrl(receipt.hash)}`);
    }

    log.info(
      `     confirmed in block ${receipt.blockNumber}: tx ${receipt.hash}, gas used ${receipt.gasUsed}, ` +
        `effective gas price ${gwei(receipt.gasPrice)} gwei, L1 fee ${eth(receipt.fee, 6)} ETH`,
    );
    log.info(`     ${this.txUrl(receipt.hash)}`);
    return receipt;
  }

  private txMarkdown(hash: string): string {
    return `[${hash.slice(0, 10)}…](${this.txUrl(hash)})`;
  }
}
