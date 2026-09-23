/**
 * Minimal logger. Warnings and errors use GitHub Actions annotation syntax so they
 * show up in the job summary; everything else is a plain line in the log.
 */

export function info(message = ''): void {
  console.log(message);
}

export function warning(message: string): void {
  console.log(`::warning::${message}`);
}

export function error(message: string): void {
  console.log(`::error::${message}`);
}

/** Human-readable message of any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const details = err as Error & { shortMessage?: string; error?: { message?: unknown; code?: unknown } };
    // A JSON-RPC error returned by the node: ethers wraps it (often as "could not coalesce
    // error"), but the node's own message ("Unauthorized", "execution reverted") is what matters.
    if (details.error && typeof details.error.message === 'string') {
      const code = details.error.code === undefined ? '' : ` (RPC error ${String(details.error.code)})`;
      return `${details.error.message}${code}`;
    }
    // Other ethers errors carry the useful part in `shortMessage`.
    return details.shortMessage ?? err.message;
  }
  return String(err);
}
