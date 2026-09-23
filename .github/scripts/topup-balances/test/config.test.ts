import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEther } from 'ethers';

import { ConfigError, loadConfig } from '../src/config.ts';

const BASE = { L1_RPC_URL: 'http://localhost:8545', FUNDER_PRIVATE_KEY: `0x${'11'.repeat(32)}` };

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(BASE);
    assert.equal(config.l1ChainId, 11155111);
    assert.deepEqual(config.operator, { min: parseEther('5'), target: parseEther('10') });
    assert.deepEqual(config.watchdogL2, { min: parseEther('0.5'), target: parseEther('1.5') });
    assert.equal(config.gasPriceBufferPercent, 50n);
    assert.equal(config.funderMin, parseEther('20'));
    assert.equal(config.rpcTimeoutMs, 30_000);
    assert.equal(config.dryRun, false);
    assert.deepEqual(config.onlyEcosystems, []);
    assert.deepEqual(config.chainTypes, ['iRaaS']);
    assert.equal(config.zksyncOsOnly, false);
    assert.deepEqual(config.includeChains, []);
    assert.equal(config.requireInfraName, true);
    assert.deepEqual(config.skipEcosystems, ['sandboxSepolia']);
    assert.equal(config.skipNamePattern?.test('Sandbox 101'), true);
    assert.equal(config.maxL2BlockAgeMs, 24 * 3_600_000);
  });

  it('parses overrides and lists', () => {
    const config = loadConfig({ ...BASE, OPERATOR_MIN_ETH: '0.25', OPERATOR_TARGET_ETH: '1', ONLY_ECOSYSTEMS: ' stage  testnet2 ' });
    assert.deepEqual(config.operator, { min: parseEther('0.25'), target: parseEther('1') });
    assert.deepEqual(config.onlyEcosystems, ['stage', 'testnet2']);
    const widened = loadConfig({ ...BASE, CHAIN_TYPES: 'iRaaS eRaaS', ZKSYNC_OS_ONLY: 'true', INCLUDE_CHAINS: 'era_testnet_legacy' });
    assert.deepEqual(widened.chainTypes, ['iRaaS', 'eRaaS']);
    assert.equal(widened.zksyncOsOnly, true);
    assert.deepEqual(widened.includeChains, ['era_testnet_legacy']);
  });

  it('rejects a target below the minimum', () => {
    assert.throws(
      () => loadConfig({ ...BASE, WATCHDOG_L1_MIN_ETH: '1', WATCHDOG_L1_TARGET_ETH: '0.5' }),
      (err: unknown) => err instanceof ConfigError && /WATCHDOG_L1_TARGET_ETH/.test(err.message),
    );
  });

  it('requires a key unless dry-run, and an address in dry-run without a key', () => {
    assert.throws(() => loadConfig({ L1_RPC_URL: 'http://x' }), ConfigError);
    assert.throws(() => loadConfig({ L1_RPC_URL: 'http://x', DRY_RUN: 'true' }), ConfigError);
    const config = loadConfig({ L1_RPC_URL: 'http://x', DRY_RUN: 'true', FUNDER_ADDRESS: '0xabc' });
    assert.equal(config.dryRun, true);
    assert.equal(config.funderPrivateKey, undefined);
  });

  it('rejects malformed amounts and patterns', () => {
    assert.throws(() => loadConfig({ ...BASE, FUNDER_MIN_ETH: 'five' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE, L2_GAS_LIMIT: '1e7' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE, SKIP_NAME_PATTERN: '(' }), ConfigError);
  });

  it('lets "none" empty a list or pattern that has a default', () => {
    const config = loadConfig({ ...BASE, SKIP_NAME_PATTERN: 'none', SKIP_ECOSYSTEMS: 'None', INCLUDE_CHAINS: 'none' });
    assert.equal(config.skipNamePattern, undefined);
    assert.deepEqual(config.skipEcosystems, []);
    assert.deepEqual(config.includeChains, []);
  });
});
