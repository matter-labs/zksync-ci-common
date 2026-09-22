/**
 * Entry point: loads the Jarvis registry, checks every Sepolia-based chain and tops up
 * whatever is below its threshold. See README.md for the full description.
 */
import type { JsonRpcProvider } from 'ethers';

import { ProviderPool, createProvider, inspectChainOnL1, readBalance, type Bridgehub } from './chain.ts';
import { loadConfig, type Config, type Thresholds } from './config.ts';
import { eth } from './format.ts';
import { Funder, FundingError } from './funding.ts';
import {
  OPERATOR_ROLES,
  l2RpcUrlOf,
  loadRegistry,
  resolveOperator,
  selectChains,
  tokenDaysLeft,
  type JarvisChain,
  type JarvisRegistry,
} from './jarvis.ts';
import * as log from './log.ts';
import { Report, githubContext, type RowAction } from './report.ts';

/** One balance to keep above its threshold. */
interface Target {
  chain: string;
  label: string;
  address: string | undefined;
  /** Chain the balance lives on: the settlement layer for operators, L1 or the chain itself for the watchdog. */
  chainId: bigint;
  /** Live balance; undefined when it could not be read, which is an error and never a top-up. */
  balance: bigint | undefined;
  /** Where the balance was read from, for the log. */
  source: string;
  thresholds: Thresholds;
  /** L1 Bridgehub of the chain's ecosystem, used for L2 deposits. */
  bridgehub: Bridgehub;
}

class Run {
  /** Targets already handled, keyed by chain ID and address, so shared operators are funded once. */
  private readonly seen = new Map<string, string>();
  private readonly l1ChainId: bigint;
  private chainsChecked = 0;

  constructor(
    private readonly config: Config,
    private readonly report: Report,
    private readonly l1: JsonRpcProvider,
    private readonly providers: ProviderPool,
    private readonly funder: Funder,
    private readonly registry: JarvisRegistry,
  ) {
    this.l1ChainId = BigInt(config.l1ChainId);
  }

  async execute(): Promise<void> {
    const selection = selectChains(this.registry, this.config);
    for (const skipped of selection.skipped) log.info(`${skipped.chain}: skipped (${skipped.reason})`);
    for (const chain of selection.selected) await this.checkChain(chain);

    if (this.chainsChecked === 0) {
      this.report.error('No Sepolia-based chains found in the Jarvis registry; check the registry and filters');
    }
  }

  private async checkChain(chain: JarvisChain): Promise<void> {
    const data = this.registry.chainDataMap[chain.chain];
    const diamondProxy = data?.diamondProxy;
    if (!diamondProxy) {
      log.info(`${chain.chain}: skipped (no diamond proxy in Jarvis)`);
      return;
    }

    const chainId = BigInt(chain.chainId);
    const inspection = await inspectChainOnL1(this.l1, this.l1ChainId, chainId, diamondProxy);
    if (!inspection.onL1) {
      (inspection.suspicious ? log.warning : log.info)(`${chain.chain}: skipped (${inspection.reason})`);
      return;
    }
    this.chainsChecked += 1;

    const { bridgehub, bridgehubAddress, settlementLayer } = inspection;
    log.info();
    log.info(
      `=== ${chain.chain} (${chain.ecosystem}, chain ${chainId}): diamond proxy ${diamondProxy}, ` +
        `bridgehub ${bridgehubAddress}, settlement layer ${settlementLayer}`,
    );

    // Operators hold their balance on the settlement layer: L1, or a Gateway chain.
    // Balances are only ever read live; the Jarvis cache is never used, since a stale
    // cache could make the job fund the same wallet over and over.
    const settlesOnL1 = settlementLayer === this.l1ChainId;
    const settlementRpc = settlesOnL1
      ? this.config.l1RpcUrl
      : l2RpcUrlOf(this.registry, chain.ecosystem, settlementLayer);
    let settlementSource = 'L1 RPC';
    if (!settlesOnL1) {
      settlementSource = settlementRpc
        ? `settlement layer RPC ${settlementRpc}`
        : `no RPC in Jarvis for settlement layer ${settlementLayer}`;
    }
    for (const role of OPERATOR_ROLES) {
      const address = resolveOperator(role, chain, data);
      await this.ensure({
        chain: chain.chain,
        label: `${role} operator`,
        address,
        chainId: settlementLayer,
        balance:
          address && settlementRpc
            ? await readBalance(this.providers.get(settlementRpc, settlementLayer), address)
            : undefined,
        source: settlementSource,
        thresholds: this.config.operator,
        bridgehub,
      });
    }

    // The watchdog needs ETH on L1 (its deposit flows) and on L2 (transfers, withdrawals).
    const watchdog = chain.watchdogAddress;
    if (!watchdog) {
      log.info(`${chain.chain}: no watchdog address in Jarvis`);
      return;
    }
    await this.ensure({
      chain: chain.chain,
      label: 'watchdog L1',
      address: watchdog,
      chainId: this.l1ChainId,
      balance: await readBalance(this.l1, watchdog),
      source: 'L1 RPC',
      thresholds: this.config.watchdogL1,
      bridgehub,
    });

    const l2Rpc = chain.l2RpcUrl;
    await this.ensure({
      chain: chain.chain,
      label: 'watchdog L2',
      address: watchdog,
      chainId,
      balance: l2Rpc ? await readBalance(this.providers.get(l2Rpc, chainId), watchdog) : undefined,
      source: l2Rpc ? `L2 RPC ${l2Rpc}` : 'no L2 RPC in Jarvis',
      thresholds: this.config.watchdogL2,
      bridgehub,
    });
  }

  /** Records the target in the report and tops it up when it is below its minimum. */
  private async ensure(target: Target): Promise<void> {
    const { chain, label, address, chainId, balance, thresholds } = target;
    if (thresholds.min === 0n) return;

    const prefix = `${chain}/${label}:`;
    const row = (action: RowAction, details: string): void => {
      this.report.rows.push({ chain, label, address: address ?? '?', chainId, balance, min: thresholds.min, action, details });
    };

    if (!address) {
      log.info(`${prefix} no address, skipped`);
      row('skipped', 'no address');
      return;
    }

    const key = `${chainId}:${address.toLowerCase()}`;
    const seenAs = this.seen.get(key);
    if (seenAs) {
      log.info(`${prefix} ${address} on chain ${chainId} already checked as ${seenAs}, skipped`);
      row('skipped', `same as ${seenAs}`);
      return;
    }
    this.seen.set(key, `${chain}/${label}`);

    if (balance === undefined) {
      this.report.error(
        `${chain}/${label}: could not read the balance of ${address} on chain ${chainId} (${target.source}); not topping up`,
      );
      row('error', 'balance unavailable');
      return;
    }

    if (balance >= thresholds.min) {
      log.info(`${prefix} ${address} on chain ${chainId} has ${eth(balance)} ETH (${target.source}), min ${eth(thresholds.min)} ETH, ok`);
      row('ok', '');
      return;
    }

    const amount = thresholds.target - balance;
    log.info(
      `${prefix} ${address} on chain ${chainId} has ${eth(balance)} ETH (${target.source}), BELOW min ${eth(thresholds.min)} ETH; ` +
        `topping up by ${eth(amount)} ETH to reach ${eth(thresholds.target)} ETH`,
    );
    if (this.funder.exhausted) {
      log.info('  -> skipped, the funder is exhausted');
      row('error', 'funder exhausted');
      return;
    }

    try {
      const result =
        chainId === this.l1ChainId
          ? await this.funder.transferL1(address, amount)
          : await this.funder.depositL2(target.bridgehub, chainId, address, amount);
      this.report.actions.push(`${chain}/${label}: ${result.action}`);
      row('topped up', result.details);
    } catch (err) {
      if (!(err instanceof FundingError)) throw err;
      this.report.error(err.message);
      row('error', this.funder.exhausted ? 'funder exhausted' : err.message);
    }
  }
}

async function run(config: Config, report: Report, l1: JsonRpcProvider, providers: ProviderPool): Promise<void> {
  const funder = new Funder(l1, config);
  report.funderAddress = funder.address;

  const actualChainId = BigInt(await l1.send('eth_chainId', []));
  if (actualChainId !== BigInt(config.l1ChainId)) {
    throw new Error(`L1 RPC chain ID is ${actualChainId}, expected ${config.l1ChainId}`);
  }

  const startBalance = await funder.balance();
  log.info(`Funder:            ${funder.address} (${eth(startBalance)} ETH)`);
  log.info(`L1 RPC chain ID:   ${config.l1ChainId}`);
  log.info(`Dry run:           ${config.dryRun}`);
  log.info(`Operator:          min ${eth(config.operator.min)} ETH, target ${eth(config.operator.target)} ETH`);
  log.info(`Watchdog L1:       min ${eth(config.watchdogL1.min)} ETH, target ${eth(config.watchdogL1.target)} ETH`);
  log.info(`Watchdog L2:       min ${eth(config.watchdogL2.min)} ETH, target ${eth(config.watchdogL2.target)} ETH`);
  log.info(
    `Deposit params:    L2 gas limit ${config.l2GasLimit}, gas per pubdata ${config.l2GasPerPubdata}, ` +
      `gas price buffer +${config.gasPriceBufferPercent}%`,
  );
  if (config.onlyEcosystems.length > 0) log.info(`Only ecosystems:   ${config.onlyEcosystems.join(' ')}`);
  if (config.skipChains.length > 0) log.info(`Skip chains:       ${config.skipChains.join(' ')}`);

  if (config.jarvisPayloadFile) {
    log.info(`Reading Jarvis payload from ${config.jarvisPayloadFile}`);
  } else {
    if (!config.jarvisApiToken) throw new Error('JARVIS_API_TOKEN is required');
    // Tokens minted on the Jarvis API Access page live 30 days.
    report.tokenDaysLeft = tokenDaysLeft(config.jarvisApiToken);
    if (report.tokenDaysLeft === undefined) log.warning('Could not decode the Jarvis token expiry');
    else log.info(`Jarvis token:      expires in ${report.tokenDaysLeft} day(s)`);
    log.info(`Fetching chain registry from ${config.jarvisApiUrl}/api/chains/cache`);
  }
  const registry = await loadRegistry(config);
  const normal = registry.chains.filter((chain) => chain.state === 'normal').length;
  log.info(`Jarvis chains:     ${registry.chains.length} total, ${normal} in state normal`);

  await new Run(config, report, l1, providers, funder, registry).execute();

  // Funder health and token lifetime are checked last, so the top-ups always run first.
  log.info();
  const finalBalance = await funder.balance();
  report.funderBalance = finalBalance;
  log.info(`Funder balance:    ${eth(finalBalance)} ETH (spent ${eth(startBalance - finalBalance)} ETH in this run)`);
  if (finalBalance < config.funderMin) {
    report.error(
      `Funder ${funder.address} holds ${eth(finalBalance)} ETH, below the ${eth(config.funderMin)} ETH minimum; please refill it`,
    );
  }
  if (report.tokenDaysLeft !== undefined && report.tokenDaysLeft < config.jarvisTokenMinDays) {
    report.error(
      `Jarvis API token expires in ${report.tokenDaysLeft} day(s); mint a new one on the Jarvis API Access page ` +
        'and update the JARVIS_API_TOKEN secret',
    );
  }
}

async function main(): Promise<number> {
  const env = process.env;
  const report = new Report(['true', '1'].includes((env['DRY_RUN'] ?? '').trim().toLowerCase()));

  let l1: JsonRpcProvider | undefined;
  let providers: ProviderPool | undefined;
  try {
    const config = loadConfig(env);
    l1 = createProvider(config.l1RpcUrl, BigInt(config.l1ChainId), config.rpcTimeoutMs);
    providers = new ProviderPool(config.rpcTimeoutMs);
    await run(config, report, l1, providers);
  } catch (err) {
    // Configuration, Jarvis or L1 RPC failures: the run cannot continue, but it still reports.
    report.error(log.errorMessage(err));
  } finally {
    providers?.destroy();
    l1?.destroy();
  }

  await report.writeSummary(env['GITHUB_STEP_SUMMARY']);
  if (report.failed) {
    if (env['SLACK_PAYLOAD_FILE']) await report.writeSlackPayload(env['SLACK_PAYLOAD_FILE'], githubContext(env));
    log.error(`${report.errors.length} problem(s) need attention`);
    return 1;
  }
  log.info('All balances are above their thresholds.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log.error(`Unexpected failure: ${log.errorMessage(err)}`);
    process.exit(1);
  },
);
