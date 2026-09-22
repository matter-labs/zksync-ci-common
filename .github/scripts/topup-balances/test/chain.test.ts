import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeError } from 'ethers';

import { isContractError } from '../src/chain.ts';

describe('isContractError', () => {
  it('recognises errors coming from the contract side of a call', () => {
    assert.equal(isContractError(makeError('could not decode result data', 'BAD_DATA', { value: '0x' })), true);
    assert.equal(isContractError(makeError('execution reverted', 'CALL_EXCEPTION', {
      action: 'call', data: null, reason: null, transaction: { to: null, from: undefined, data: '0x' }, invocation: null, revert: null,
    })), true);
  });

  it('does not mistake transport errors for missing contracts', () => {
    assert.equal(isContractError(makeError('timeout', 'TIMEOUT', { operation: 'call', reason: 'timeout', request: {} as never })), false);
    assert.equal(isContractError(makeError('network', 'NETWORK_ERROR', { event: 'noNetwork' })), false);
    assert.equal(isContractError(makeError('server', 'SERVER_ERROR', { request: {} as never })), false);
    assert.equal(isContractError(new Error('boom')), false);
  });
});
