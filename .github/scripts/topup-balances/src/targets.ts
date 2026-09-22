/**
 * Remembers which (chain, address) pairs a run has already handled, so an address shared
 * by several roles or chains is funded once, while still re-checking it when a later
 * target applies a higher minimum than the one it was checked against.
 */
export class SeenTargets {
  private readonly seen = new Map<string, { as: string; min: bigint }>();

  /**
   * Registers a target. Returns the name of the earlier target that already covers it
   * (same chain, same address, minimum at least as high), or undefined if it must be checked.
   */
  claim(chainId: bigint, address: string, min: bigint, as: string): string | undefined {
    const key = `${chainId}:${address.toLowerCase()}`;
    const earlier = this.seen.get(key);
    if (earlier && earlier.min >= min) return earlier.as;
    this.seen.set(key, { as, min });
    return undefined;
  }
}
