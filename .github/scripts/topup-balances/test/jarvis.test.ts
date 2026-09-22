import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  l2RpcUrlOf,
  resolveOperator,
  selectChains,
  tokenDaysLeft,
  type JarvisChain,
  type JarvisChainData,
  type JarvisRegistry,
} from '../src/jarvis.ts';

const LAST = '0x1111111111111111111111111111111111111111';
const SERVICE_LABEL = '0x2222222222222222222222222222222222222222';
const SERVICE_FIELD = '0x3333333333333333333333333333333333333333';
const MANUAL_LABEL = '0x4444444444444444444444444444444444444444';
const MANUAL_FIELD = '0x5555555555555555555555555555555555555555';
const FIRST = '0x6666666666666666666666666666666666666666';

const chain: JarvisChain = {
  chain: 'demo',
  ecosystem: 'stage',
  chainId: 2705,
  state: 'normal',
  serviceCommitOperatorAddress: SERVICE_FIELD,
  commitOperatorAddress: MANUAL_FIELD,
};

describe('resolveOperator', () => {
  it('follows the Jarvis precedence: last tx sender, service label, service field, manual label, config field, first validator', () => {
    const data: JarvisChainData = {
      validatorRoles: {
        committers: [
          { address: FIRST, labels: [] },
          { address: MANUAL_LABEL, labels: ['manual_commit'] },
          { address: SERVICE_LABEL, labels: ['service_commit'] },
          { address: LAST, labels: ['manual_commit', 'last_commit'] },
        ],
      },
    };
    assert.equal(resolveOperator('commit', chain, data), LAST);

    data.validatorRoles!.committers = data.validatorRoles!.committers!.filter((e) => e.address !== LAST);
    assert.equal(resolveOperator('commit', chain, data), SERVICE_LABEL);

    data.validatorRoles!.committers = data.validatorRoles!.committers!.filter((e) => e.address !== SERVICE_LABEL);
    assert.equal(resolveOperator('commit', chain, data), SERVICE_FIELD);

    const noServiceField = { ...chain, serviceCommitOperatorAddress: undefined };
    assert.equal(resolveOperator('commit', noServiceField, data), MANUAL_LABEL);

    data.validatorRoles!.committers = data.validatorRoles!.committers!.filter((e) => e.address !== MANUAL_LABEL);
    assert.equal(resolveOperator('commit', noServiceField, data), MANUAL_FIELD);

    const noFields = { ...noServiceField, commitOperatorAddress: undefined };
    assert.equal(resolveOperator('commit', noFields, data), FIRST);
  });

  it('uses the role-specific validator list and fields', () => {
    const data: JarvisChainData = {
      validatorRoles: { executors: [{ address: LAST, labels: ['last_execute'] }] },
    };
    assert.equal(resolveOperator('execute', chain, data), LAST);
    assert.equal(resolveOperator('prove', { ...chain, proveOperatorAddress: MANUAL_FIELD }, data), MANUAL_FIELD);
  });

  it('returns undefined without any usable address', () => {
    assert.equal(resolveOperator('prove', chain, undefined), undefined);
    const invalid = { ...chain, serviceCommitOperatorAddress: undefined, commitOperatorAddress: 'not-an-address' };
    assert.equal(resolveOperator('commit', invalid, undefined), undefined);
  });
});

describe('selectChains', () => {
  const registry: JarvisRegistry = {
    chains: [
      { chain: 'a', ecosystem: 'stage', chainId: 1, state: 'normal' },
      { chain: 'b', ecosystem: 'testnet2', chainId: 2, state: 'normal' },
      { chain: 'c', ecosystem: 'stage', chainId: 3, state: 'archived', archived: true },
      { chain: 'd', ecosystem: 'stage', chainId: 4, state: 'planned' },
      { chain: 'e', ecosystem: 'stage', chainId: 5, state: 'unknown_inactive' },
    ],
    chainDataMap: {},
  };

  it('keeps only chains in state normal', () => {
    const { selected, skipped } = selectChains(registry, { onlyEcosystems: [], skipChains: [] });
    assert.deepEqual(selected.map((c) => c.chain), ['a', 'b']);
    assert.deepEqual(skipped, []);
  });

  it('applies the ecosystem and chain filters', () => {
    const { selected, skipped } = selectChains(registry, { onlyEcosystems: ['stage'], skipChains: ['a'] });
    assert.deepEqual(selected, []);
    assert.deepEqual(skipped, [{ chain: 'a', reason: 'SKIP_CHAINS' }]);
  });

  it('finds the L2 RPC of a chain by ecosystem and chain ID', () => {
    const withRpc: JarvisRegistry = {
      chains: [{ chain: 'gw', ecosystem: 'stage', chainId: 123, l2RpcUrl: 'https://gw.example' }],
      chainDataMap: {},
    };
    assert.equal(l2RpcUrlOf(withRpc, 'stage', 123n), 'https://gw.example');
    assert.equal(l2RpcUrlOf(withRpc, 'testnet', 123n), undefined);
  });
});

describe('tokenDaysLeft', () => {
  const jwt = (claims: object): string =>
    `eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

  it('computes whole days until expiry', () => {
    const now = 1_700_000_000_000;
    assert.equal(tokenDaysLeft(jwt({ exp: now / 1000 + 10 * 86_400 }), now), 10);
    assert.equal(tokenDaysLeft(jwt({ exp: now / 1000 - 86_400 }), now), -1);
  });

  it('returns undefined for tokens it cannot decode', () => {
    assert.equal(tokenDaysLeft('garbage'), undefined);
    assert.equal(tokenDaysLeft(jwt({ scope: 'chains:read' })), undefined);
  });
});
