/**
 * Retries for read-only RPC calls. Public RPC endpoints rate-limit and hiccup; a transient
 * failure must not turn into a false "balance unavailable" or a Slack alert. Transactions
 * are never retried through this helper: re-sending is what causes double funding.
 */
import { isContractError } from './chain.ts';
import * as log from './log.ts';

const ATTEMPTS = 3;
const FIRST_DELAY_MS = 1_000;

/**
 * Runs `call`, retrying transport errors with exponential backoff. Contract-side errors
 * (no code, revert, bad data) are deterministic and are thrown immediately.
 */
export async function withRetries<T>(what: string, call: () => Promise<T>): Promise<T> {
  let delayMs = FIRST_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= ATTEMPTS || isContractError(err)) throw err;
      log.info(`     ${what} failed (${log.errorMessage(err)}), retrying in ${delayMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
}
