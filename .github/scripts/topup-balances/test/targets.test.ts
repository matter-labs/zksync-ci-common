import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SeenTargets } from '../src/targets.ts';

const ADDRESS = '0xAbCd000000000000000000000000000000000001';

describe('SeenTargets', () => {
  it('skips a repeated address on the same chain when the earlier minimum was at least as high', () => {
    const seen = new SeenTargets();
    assert.equal(seen.claim(1n, ADDRESS, 5n, 'a/prove operator'), undefined);
    assert.equal(seen.claim(1n, ADDRESS.toLowerCase(), 5n, 'a/execute operator'), 'a/prove operator');
    assert.equal(seen.claim(1n, ADDRESS, 1n, 'b/watchdog L1'), 'a/prove operator');
  });

  it('re-checks the address when a later target applies a higher minimum', () => {
    const seen = new SeenTargets();
    assert.equal(seen.claim(1n, ADDRESS, 1n, 'a/watchdog L1'), undefined);
    assert.equal(seen.claim(1n, ADDRESS, 5n, 'b/commit operator'), undefined);
    assert.equal(seen.claim(1n, ADDRESS, 5n, 'c/commit operator'), 'b/commit operator');
  });

  it('treats the same address on different chains as different targets', () => {
    const seen = new SeenTargets();
    assert.equal(seen.claim(1n, ADDRESS, 5n, 'a/watchdog L1'), undefined);
    assert.equal(seen.claim(2705n, ADDRESS, 5n, 'a/watchdog L2'), undefined);
  });
});
