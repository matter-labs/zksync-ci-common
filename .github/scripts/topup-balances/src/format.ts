import { formatEther, formatUnits } from 'ethers';

/** ETH amount for display, 4 decimals by default (use 6 for fees). */
export function eth(wei: bigint, decimals = 4): string {
  return Number(formatEther(wei)).toFixed(decimals);
}

/** Gas price in gwei for display. */
export function gwei(wei: bigint): string {
  return Number(formatUnits(wei, 'gwei')).toFixed(3);
}
