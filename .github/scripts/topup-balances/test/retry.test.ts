import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeError } from 'ethers';

import { withRetries } from '../src/retry.ts';

describe('withRetries', () => {
  it('retries transport errors and returns the first success', async () => {
    let calls = 0;
    const result = await withRetries('probe', async () => {
      calls += 1;
      if (calls < 3) throw makeError('rate limited', 'SERVER_ERROR', { request: {} as never });
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('gives up after the last attempt', async () => {
    let calls = 0;
    await assert.rejects(
      withRetries('probe', async () => {
        calls += 1;
        throw new Error('down');
      }),
      /down/,
    );
    assert.equal(calls, 3);
  });

  it('does not retry contract-side errors', async () => {
    let calls = 0;
    await assert.rejects(
      withRetries('probe', async () => {
        calls += 1;
        throw makeError('no code', 'BAD_DATA', { value: '0x' });
      }),
      /no code/,
    );
    assert.equal(calls, 1);
  });
});
