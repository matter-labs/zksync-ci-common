import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeError } from 'ethers';

import { errorMessage } from '../src/log.ts';

describe('errorMessage', () => {
  it('surfaces the JSON-RPC error a node returned instead of the ethers wrapper', () => {
    const err = makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: { message: 'Unauthorized', code: -32090 } });
    assert.equal(errorMessage(err), 'Unauthorized (RPC error -32090)');
  });

  it('prefers the short message of other ethers errors and falls back to message/String', () => {
    assert.equal(errorMessage(makeError('timeout (long details)', 'TIMEOUT', { operation: 'call', reason: 'timeout', request: {} as never })), 'timeout (long details)');
    assert.equal(errorMessage(new Error('boom')), 'boom');
    assert.equal(errorMessage('plain'), 'plain');
  });
});
