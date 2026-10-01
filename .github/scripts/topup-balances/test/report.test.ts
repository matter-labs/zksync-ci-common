import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEther } from 'ethers';

import { Report, escapeMrkdwn, githubContext } from '../src/report.ts';

describe('Report', () => {
  it('renders the rows, transactions and errors as markdown', () => {
    const report = new Report(false);
    report.funderAddress = '0xfunder';
    report.funderBalance = parseEther('12.5');
    report.rows.push({
      chain: 'demo',
      label: 'commit operator',
      address: '0xop',
      chainId: 11155111n,
      balance: parseEther('3'),
      min: parseEther('5'),
      action: 'topped up',
      details: 'sent 7.0000 ETH',
    });
    report.rows.push({ chain: 'demo', label: 'prove operator', address: '?', chainId: 11155111n, min: parseEther('5'), action: 'skipped', details: 'no address' });
    report.actions.push('demo/commit operator: transferred 7.0000 ETH');
    report.error('something broke');

    const markdown = report.markdown();
    assert.match(markdown, /Funder `0xfunder`: 12\.5000 ETH/);
    assert.match(markdown, /\| demo \| commit operator \| `0xop` \| 11155111 \| 3\.0000 \| 5\.0000 \| topped up \| sent 7\.0000 ETH \|/);
    assert.match(markdown, /\| demo \| prove operator \| `\?` \| 11155111 \| - \| 5\.0000 \| skipped \| no address \|/);
    assert.match(markdown, /### Transactions\n\n- demo\/commit operator: transferred 7\.0000 ETH/);
    assert.match(markdown, /### Errors\n\n- something broke/);
    assert.equal(report.failed, true);
  });

  it('builds a Slack payload with escaped problems, transactions and a log link', () => {
    const report = new Report(true);
    report.error('balance 0.25 ETH < 0.5 ETH & falling');
    report.actions.push('demo/watchdog L2: dry run: would deposit 1 ETH');

    const payload = report.slackPayload({ repository: 'org/repo', workflow: 'wf', runUrl: 'https://run' });
    const blocks = payload['blocks'] as { type: string; text?: { text: string }; elements?: { url: string }[] }[];
    assert.equal(payload['text'], '🚨 Sepolia balance top-up needs attention (dry run)');
    assert.equal(blocks[0]?.type, 'header');
    assert.match(blocks[2]?.text?.text ?? '', /\*Problems:\*\n• balance 0\.25 ETH &lt; 0\.5 ETH &amp; falling/);
    assert.match(blocks[3]?.text?.text ?? '', /Transactions sent in this run/);
    assert.equal(blocks[4]?.elements?.[0]?.url, 'https://run');
  });

  it('explains an early exit without recorded problems', () => {
    const payload = new Report(false).slackPayload({});
    const blocks = payload['blocks'] as { text?: { text: string } }[];
    assert.match(blocks[2]?.text?.text ?? '', /exited with an error before reporting any problem/);
    assert.equal(blocks.length, 3);
  });
});

describe('helpers', () => {
  it('escapes Slack mrkdwn control characters', () => {
    assert.equal(escapeMrkdwn('a < b > c & d'), 'a &lt; b &gt; c &amp; d');
  });

  it('derives the run URL from the GitHub environment', () => {
    const ctx = githubContext({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7', GITHUB_WORKFLOW: 'w' });
    assert.deepEqual(ctx, { repository: 'o/r', workflow: 'w', runUrl: 'https://github.com/o/r/actions/runs/7' });
    assert.equal(githubContext({}).runUrl, undefined);
  });
});
