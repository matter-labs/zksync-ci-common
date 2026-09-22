/**
 * Entry point: loads the Jarvis registry, checks every Sepolia-based chain and tops up
 * whatever is below its threshold. See README.md for the full description.
 */
import type { JsonRpcProvider } from 'ethers';

import { ProviderPool, createProvider, inspectChainOnL1, type Bridgehub } from './chain.ts';
import { isDryRun, loadConfig, type Config, type Thresholds } from './config.ts';
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
import { SeenTargets } from './targets.ts';

/** A balance read attempt: `balance` is undefined when it could not be read, and `source` then says why. */
interface BalanceRead {
  balance?: bigint;
  source: string;
}

/** One balance to keep above its threshold. */
interface Target extends BalanceRead {
  chain: string;
  label: string;
  address: string | undefined;
  /** Chain the balance lives on: the settlement layer for operators, L1 or the chain itself for the watchdog. */
  chainId: bigint;
  thresholds: Thresholds;
  /** L1 Bridgehub of the chain's ecosystem, used for L2 deposits. */
  bridgehub: Bridgehub;
}

class Run {
  private readonly seen = new SeenTargets();
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
    for (const skipped of selection.skipped) {
      if (skipped.level === 'error') this.report.error(`${skipped.chain}: ${skipped.reason}`);
      else log.info(`${skipped.chain}: skipped (${skipped.reason})`);
    }

    for (const chain of selection.selected) {
      try {
        await this.checkChain(chain);
      } catch (err) {
        // Transport errors while inspecting the chain on L1: report and continue with the next one.
        this.report.error(`${chain.chain}: could not check the chain on L1: ${log.errorMessage(err)}`);
      }
    }

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
      if (inspection.suspicious) {
        // The registry and the chain disagree; somebody has to look at the registry entry.
        this.report.error(`${chain.chain}: ${inspection.reason}; check the Jarvis registry`);
      } else {
        log.info(`${chain.chain}: skipped (${inspection.reason})`);
      }
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
    const settlementRpc = settlesOnL1 ? undefined : l2RpcUrlOf(this.registry, chain.ecosystem, settlementLayer);
    for (const role of OPERATOR_ROLES) {
      const address = resolveOperator(role, chain, data);
      const read = settlesOnL1
        ? await this.l1Balance(address)
        : await this.l2Balance(settlementRpc, settlementLayer, address, 'settlement layer');
      await this.ensure({
        ...read,
        chain: chain.chain,
        label: `${role} operator`,
        address,
        chainId: settlementLayer,
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
      ...(await this.l1Balance(watchdog)),
      chain: chain.chain,
      label: 'watchdog L1',
      address: watchdog,
      chainId: this.l1ChainId,
      thresholds: this.config.watchdogL1,
      bridgehub,
    });
    await this.ensure({
      ...(await this.l2Balance(chain.l2RpcUrl, chainId, watchdog, 'L2')),
      chain: chain.chain,
      label: 'watchdog L2',
      address: watchdog,
      chainId,
      thresholds: this.config.watchdogL2,
      bridgehub,
    });
  }

  private async l1Balance(address: string | undefined): Promise<BalanceRead> {
    if (!address) return { source: 'L1 RPC' };
    try {
      return { balance: await this.l1.getBalance(address), source: 'L1 RPC' };
    } catch (err) {
      return { source: `L1 RPC: ${log.errorMessage(err)}` };
    }
  }

  private async l2Balance(
    url: string | undefined,
    chainId: bigint,
    address: string | undefined,
    what: string,
  ): Promise<BalanceRead> {
    if (!address) return { source: `${what} RPC` };
    if (!url) return { source: `no ${what} RPC for chain ${chainId} in Jarvis` };
    try {
      const provider = await this.providers.get(url, chainId);
      return { balance: await provider.getBalance(address), source: `${what} RPC ${url}` };
    } catch (err) {
      return { source: `${what} RPC ${url}: ${log.errorMessage(err)}` };
    }
  }

  /** Records the target in the report and tops it up when it is below its minimum. */
  private async ensure(target: Target): Promise<void> {
    const { chain, label, address, chainId, balance, thresholds } = target;
    if (thresholds.min === 0n) return;

    const name = `${chain}/${label}`;
    const row = (action: RowAction, details: string): void => {
      this.report.rows.push({ chain, label, address: address ?? '?', chainId, balance, min: thresholds.min, action, details });
    };

    if (!address) {
      log.info(`${name}: no address, skipped`);
      row('skipped', 'no address');
      return;
    }

    const coveredBy = this.seen.claim(chainId, address, thresholds.min, name);
    if (coveredBy) {
      log.info(`${name}: ${address} on chain ${chainId} already checked as ${coveredBy}, skipped`);
      row('skipped', `same as ${coveredBy}`);
      return;
    }

    if (balance === undefined) {
      this.report.error(`${name}: could not read the balance of ${address} on chain ${chainId} (${target.source}); not topping up`);
      row('error', 'balance unavailable');
      return;
    }

    if (balance >= thresholds.min) {
      log.info(`${name}: ${address} on chain ${chainId} has ${eth(balance)} ETH (${target.source}), min ${eth(thresholds.min)} ETH, ok`);
      row('ok', '');
      return;
    }

    const amount = thresholds.target - balance;
    log.info(
      `${name}: ${address} on chain ${chainId} has ${eth(balance)} ETH (${target.source}), BELOW min ${eth(thresholds.min)} ETH; ` +
        `topping up by ${eth(amount)} ETH to reach ${eth(thresholds.target)} ETH`,
    );
    if (this.funder.haltReason) {
      log.info(`  -> skipped: ${this.funder.haltReason}`);
      row('error', 'skipped, funder halted');
      return;
    }
    if (this.funder.unaffordable !== undefined && amount >= this.funder.unaffordable) {
      log.info(`  -> skipped, the funder could not afford ${eth(this.funder.unaffordable)} ETH earlier in this run`);
      row('error', 'funder exhausted');
      return;
    }

    try {
      const result =
        chainId === this.l1ChainId
          ? await this.funder.transferL1(address, amount)
          : await this.funder.depositL2(target.bridgehub, chainId, address, amount);
      this.report.actions.push(`${name}: ${result.action}`);
      row('topped up', result.details);
    } catch (err) {
      // Anything that went wrong for this target is reported; the run continues with the next one.
      const message = err instanceof FundingError ? err.message : log.errorMessage(err);
      this.report.error(`${name}: ${message}`);
      row('error', message);
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
  log.info(`Dry run:           ${config.dryRun}${funder.sendsTransactions ? '' : ' (no transaction will be signed)'}`);
  log.info(`Operator:          min ${eth(config.operator.min)} ETH, target ${eth(config.operator.target)} ETH`);
  log.info(`Watchdog L1:       min ${eth(config.watchdogL1.min)} ETH, target ${eth(config.watchdogL1.target)} ETH`);
  log.info(`Watchdog L2:       min ${eth(config.watchdogL2.min)} ETH, target ${eth(config.watchdogL2.target)} ETH`);
  log.info(
    `Deposit params:    L2 gas limit ${config.l2GasLimit}, gas per pubdata ${config.l2GasPerPubdata}, ` +
      `gas price buffer +${config.gasPriceBufferPercent}%`,
  );
  log.info(`Scope:             hosting type ${config.chainTypes.join(' ')}, ${config.zksyncOsOnly ? 'ZKsync OS chains only' : 'all stacks'}`);
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
  const report = new Report(isDryRun(env));

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
    await providers?.destroy();
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
