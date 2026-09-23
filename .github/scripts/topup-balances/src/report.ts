/**
 * Collects the outcome of a run and renders it as a markdown job summary and as a
 * Slack Block Kit payload for the failure notification.
 */
import { appendFile, writeFile } from 'node:fs/promises';

import { eth } from './format.ts';
import * as log from './log.ts';

export type RowAction = 'ok' | 'topped up' | 'skipped' | 'error';

export interface ReportRow {
  chain: string;
  label: string;
  address: string;
  chainId: bigint;
  balance?: bigint;
  min: bigint;
  action: RowAction;
  details: string;
}

export interface GitHubContext {
  repository?: string;
  workflow?: string;
  runUrl?: string;
}

export function githubContext(env: NodeJS.ProcessEnv = process.env): GitHubContext {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_WORKFLOW } = env;
  const runUrl =
    GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : undefined;
  return { repository: GITHUB_REPOSITORY, workflow: GITHUB_WORKFLOW, runUrl };
}

/** Slack mrkdwn treats `&`, `<` and `>` specially (links, mentions). */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class Report {
  readonly rows: ReportRow[] = [];
  /** Transactions sent, or that would have been sent in a dry run. */
  readonly actions: string[] = [];
  /** Problems that make the run fail. */
  readonly errors: string[] = [];
  funderAddress = 'unknown';
  funderBalance?: bigint;
  tokenDaysLeft?: number;

  constructor(readonly dryRun: boolean) {}

  /** Logs a problem as a GitHub error annotation and records it for the summary and Slack. */
  error(message: string): void {
    log.error(message);
    this.errors.push(message);
  }

  get failed(): boolean {
    return this.errors.length > 0;
  }

  markdown(): string {
    const funderBalance = this.funderBalance === undefined ? '?' : eth(this.funderBalance);
    const lines = ['## Balance top-up report', '', `Funder \`${this.funderAddress}\`: ${funderBalance} ETH`];
    if (this.dryRun) lines.push('', '**Dry run: no transactions were sent.**');
    if (this.tokenDaysLeft !== undefined) lines.push('', `Jarvis token expires in ${this.tokenDaysLeft} day(s).`);

    lines.push(
      '',
      '| Chain | Target | Address | Chain ID | Balance | Min | Action | Details |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const row of this.rows) {
      const balance = row.balance === undefined ? '-' : eth(row.balance);
      lines.push(
        `| ${row.chain} | ${row.label} | \`${row.address}\` | ${row.chainId} | ${balance} | ${eth(row.min)} | ${row.action} | ${row.details} |`,
      );
    }
    lines.push('', "Balances are in ETH, or in the chain's base token for L2 targets of custom-base-token chains.");

    if (this.actions.length > 0) lines.push('', '### Transactions', '', ...this.actions.map((a) => `- ${a}`));
    if (this.errors.length > 0) lines.push('', '### Errors', '', ...this.errors.map((e) => `- ${e}`));
    return `${lines.join('\n')}\n`;
  }

  slackPayload(ctx: GitHubContext): Record<string, unknown> {
    const title = `🚨 Sepolia balance top-up needs attention${this.dryRun ? ' (dry run)' : ''}`;
    const funder =
      `\`${this.funderAddress}\`` + (this.funderBalance === undefined ? '' : `, ${eth(this.funderBalance)} ETH left`);
    const problems =
      this.errors.length > 0 ? this.errors : ['The job exited with an error before reporting any problem; see the logs.'];

    const blocks: unknown[] = [
      { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Repository:*\n\`${ctx.repository ?? 'local'}\`` },
          { type: 'mrkdwn', text: `*Workflow:*\n\`${ctx.workflow ?? 'topup-balances'}\`` },
          { type: 'mrkdwn', text: `*Funder:*\n${funder}` },
        ],
      },
      { type: 'section', text: { type: 'mrkdwn', text: `*Problems:*\n${bullets(problems)}` } },
    ];
    if (this.actions.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Transactions sent in this run:*\n${bullets(this.actions)}` },
      });
    }
    if (ctx.runUrl) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View workflow logs', emoji: true },
            url: ctx.runUrl,
            style: 'danger',
          },
        ],
      });
    }
    return { text: title, blocks };
  }

  /** Prints the markdown report and appends it to the GitHub job summary when available. */
  async writeSummary(file: string | undefined): Promise<void> {
    const markdown = this.markdown();
    log.info(markdown);
    if (file) await appendFile(file, markdown);
  }

  async writeSlackPayload(file: string, ctx: GitHubContext): Promise<void> {
    await writeFile(file, JSON.stringify(this.slackPayload(ctx), null, 2));
  }
}

/** Bullet list for a Slack section, kept under Slack's 3000-character limit. */
function bullets(items: string[]): string {
  const text = items.map((item) => `• ${escapeMrkdwn(item)}`).join('\n');
  return text.length > 2800 ? `${text.slice(0, 2800)}…` : text;
}
