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
    // ethers errors carry the useful part in `shortMessage`.
    const short = (err as { shortMessage?: string }).shortMessage;
    return short ?? err.message;
  }
  return String(err);
}
