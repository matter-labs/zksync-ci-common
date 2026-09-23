import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Wallet } from 'ethers';

import { createProvider } from '../src/chain.ts';
import { loadConfig } from '../src/config.ts';
import { Funder } from '../src/funding.ts';

const KEY = `0x${'11'.repeat(32)}`;
const ADDRESS = new Wallet(KEY).address;
// Never contacted: the provider does not connect on construction.
const l1 = createProvider('http://127.0.0.1:1', 11155111n, 1_000);

describe('Funder', () => {
  it('never signs in dry-run mode, even when a key is configured', () => {
    const funder = new Funder(l1, loadConfig({ L1_RPC_URL: 'http://x', DRY_RUN: 'true', FUNDER_PRIVATE_KEY: KEY }));
    assert.equal(funder.sendsTransactions, false);
    assert.equal(funder.address, ADDRESS);
  });

  it('signs with the configured key outside dry-run mode', () => {
    const funder = new Funder(l1, loadConfig({ L1_RPC_URL: 'http://x', FUNDER_PRIVATE_KEY: KEY }));
    assert.equal(funder.sendsTransactions, true);
    assert.equal(funder.address, ADDRESS);
  });

  it('uses the configured address in dry-run mode without a key', () => {
    const funder = new Funder(l1, loadConfig({ L1_RPC_URL: 'http://x', DRY_RUN: 'true', FUNDER_ADDRESS: ADDRESS }));
    assert.equal(funder.sendsTransactions, false);
    assert.equal(funder.address, ADDRESS);
  });
});
