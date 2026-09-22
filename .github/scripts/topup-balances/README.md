# topup-balances

Keeps the operators and watchdogs of the Sepolia-based chains hosted by Matter Labs (stage
and testnet ecosystems, ZKsync OS and EraVM alike) funded. Runs from
`.github/workflows/topup-balances.yaml` every 6 hours and on demand. Tracked in
[PLA-1425](https://linear.app/matterlabs/issue/PLA-1425).

## What a run does

1. Loads the chain registry from Jarvis (`GET /api/chains/cache`).
2. Keeps the chains in scope, checked in this order:
   - state `normal`, not archived;
   - not a sandbox: not in an excluded ecosystem (`sandboxSepolia`) and none of slug, names
     or infra name matching the excluded pattern (`sandbox`), which catches `sandbox_101`,
     `concord_sandbox` and everything in the `zksync-os-sandboxes` cluster;
   - hosting type `iRaaS`, i.e. operated by Matter Labs;
   - known to Matter Labs' infrastructure: Jarvis has an `infraName` (cluster/namespace) for
     it, from metrics discovery or set manually; chains without one are skipped with a warning;
   - any stack by default. `ZKSYNC_OS_ONLY=true` narrows the scope to ZKsync OS chains (Jarvis
     derives `isZkSyncOs` from the chain's chain type manager on L1) plus the slugs listed in
     `INCLUDE_CHAINS`; in that mode a chain whose stack Jarvis could not determine is reported
     as an error and not touched.
   Every skipped chain is listed with the reason. All filters are configurable.
3. Keeps chains whose L1 diamond proxy lives on Sepolia and that are live: `getBridgehub()`
   must answer on the diamond proxy, and that Bridgehub must map the chain ID back to it.
   Mainnet chains drop out here because their contracts hold no code on Sepolia. Only
   contract-side errors (no code, unknown function, revert) mean "not on Sepolia"; RPC
   transport errors are reported and the chain is retried next run. A Bridgehub that maps
   the chain ID to a different diamond proxy than Jarvis lists is reported as an error,
   since the registry and the chain disagree. A chain is live when its L2 RPC returns a
   latest block younger than `MAX_L2_BLOCK_AGE_HOURS`; a chain that is not live is skipped
   with a warning, and a chain whose liveness cannot be verified (no or unreachable L2 RPC)
   is reported as an error and not touched.
4. Collects the funding targets of every chain:
   - the commit, prove and execute operators on the settlement layer, resolved with the same
     precedence as the Jarvis dashboard (sender of the last tx, service-discovered, manually
     configured, first validator);
   - the watchdog on L1 (it pays for its deposit flows there);
   - the watchdog on L2.
5. Reads the balances live: from the L1 RPC for L1 targets, from the chain's L2 RPC for L2
   targets. The Jarvis cache is never used as a balance source: a balance that cannot be
   read is reported as an error and not topped up, so a broken RPC or registry entry can
   never make the job fund a wallet repeatedly. Chains with an auth-gated L2 RPC
   (Prividium) therefore fail the watchdog L2 check until Jarvis lists a reachable RPC for
   them; use `SKIP_CHAINS` in the meantime.
6. Tops up every target below its minimum up to its target balance from the funder wallet:
   - L1 targets get a plain ETH transfer;
   - L2 targets get a `Bridgehub.requestL2TransactionDirect` deposit. The L2 gas cost is
     taken from `l2TransactionBaseCost` at a buffered gas price that is also pinned as the
     tx max fee, so the deposit can never be underfunded; the surplus is refunded on L2.
   Every check and every transaction (parameters, nonce, gas price, receipt, explorer link)
   is logged, so the job log is a complete audit trail. An address shared by several roles
   or chains is funded once (it is re-checked only when a later target applies a higher
   minimum). Nothing is sent while an earlier transaction of the funder is still pending,
   and a transaction that is not confirmed within `TX_TIMEOUT` stops all further sends of
   the run: queueing behind a stuck transaction could fund the same target twice. A top-up
   the funder cannot afford is reported, and larger top-ups are skipped for the rest of the
   run while smaller ones are still attempted.
7. Writes a markdown report to the job summary and, when anything needs attention, a Slack
   payload that the workflow posts to the dedicated channel. The run fails on: a reverted
   or failed transaction, a target below threshold that cannot be funded (for example a
   custom base token), a balance that could not be read, the funder ending below its
   minimum, or a Jarvis token that expires soon.

Only ETH-based targets can be funded. Custom-base-token chains still get their operators
funded on L1; their L2 watchdog is reported as an error when it is low.

`DRY_RUN=true` checks and reports everything but never signs a transaction, even when a
funder key is configured.

## Configuration

Everything comes from environment variables. Amounts are in ETH and may have decimals.

| Variable | Default | Meaning |
| --- | --- | --- |
| `L1_RPC_URL` | required | Sepolia JSON-RPC URL |
| `L1_CHAIN_ID` | `11155111` | Expected chain ID of the L1 RPC |
| `L1_EXPLORER_URL` | `https://sepolia.etherscan.io` | Explorer used for tx links |
| `FUNDER_PRIVATE_KEY` | required unless dry run | Key of the funding wallet |
| `FUNDER_ADDRESS` | derived from the key | Funding wallet, for dry runs without a key |
| `DRY_RUN` | `false` | Report what would be sent, send nothing |
| `JARVIS_API_URL` | `https://api.jarvis.matterhosted.dev` | Jarvis chains API |
| `JARVIS_API_TOKEN` | required | Bearer JWT with the `chains:read` scope |
| `JARVIS_PAYLOAD_FILE` | | Testing: read the registry from a file instead |
| `OPERATOR_MIN_ETH` / `OPERATOR_TARGET_ETH` | `5` / `10` | Operator thresholds |
| `WATCHDOG_L1_MIN_ETH` / `WATCHDOG_L1_TARGET_ETH` | `0.2` / `0.5` | Watchdog L1 thresholds |
| `WATCHDOG_L2_MIN_ETH` / `WATCHDOG_L2_TARGET_ETH` | `0.5` / `1.5` | Watchdog L2 thresholds |
| `FUNDER_MIN_ETH` | `20` | Fail when the funder ends the run below this (two operator top-ups) |
| `FUNDER_GAS_RESERVE_ETH` | `0.05` | ETH the funder keeps for L1 gas |
| `L2_GAS_LIMIT` | `10000000` | L2 gas limit of deposits |
| `L2_GAS_PER_PUBDATA` | `800` | L2 gas per pubdata byte of deposits |
| `GAS_PRICE_BUFFER_PERCENT` | `50` | Buffer over the L1 gas price, used as max fee |
| `CHAIN_TYPES` | `iRaaS` | Space-separated Jarvis hosting types in scope |
| `ZKSYNC_OS_ONLY` | `false` | `true` narrows the scope to ZKsync OS chains |
| `INCLUDE_CHAINS` | none | Space-separated slugs in scope regardless of stack when narrowed |
| `REQUIRE_INFRA_NAME` | `true` | Only chains with a Jarvis `infraName` (known to our infrastructure) |
| `SKIP_ECOSYSTEMS` | `sandboxSepolia` | Space-separated Jarvis ecosystems never touched |
| `SKIP_NAME_PATTERN` | `sandbox` | Case-insensitive regex; matching slug, names or infra name are never touched |
| `MAX_L2_BLOCK_AGE_HOURS` | `24` | A chain whose latest L2 block is older is not live and not funded; `0` disables |
| `ONLY_ECOSYSTEMS` | all | Space-separated Jarvis ecosystems to restrict to |
| `SKIP_CHAINS` | none | Space-separated Jarvis chain slugs to skip |
| `JARVIS_TOKEN_MIN_DAYS` | `7` | Fail when the Jarvis token expires sooner than this |
| `RPC_TIMEOUT` | `30` | Seconds per RPC call |
| `TX_TIMEOUT` | `300` | Seconds to wait for a transaction receipt |
| `SLACK_PAYLOAD_FILE` | | Where to write the Slack payload on failure |

A minimum of `0` disables that check. List and pattern settings that have a default
(`INCLUDE_CHAINS`, `SKIP_ECOSYSTEMS`, `SKIP_NAME_PATTERN`) are emptied by setting them to
`none`. Jarvis tokens are minted on the dashboard's API Access page and live 30 days, hence
the expiry check.

## Running locally

```sh
npm ci
# Dry run against Sepolia with a Jarvis token, no key needed
DRY_RUN=true FUNDER_ADDRESS=0x... L1_RPC_URL=https://... JARVIS_API_TOKEN=... npm start
# Real run against an Anvil fork of Sepolia, with a registry fixture
anvil --port 8546 --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111
FUNDER_PRIVATE_KEY=0x... L1_RPC_URL=http://127.0.0.1:8546 JARVIS_PAYLOAD_FILE=fixture.json npm start
```

## Development

```sh
npm run typecheck
npm test
```

The workflow runs both before every real run, so code that does not type-check or fails its
tests never touches the funder wallet. Source layout:

- `src/main.ts`: the run (chain selection, targets, thresholds, exit code)
- `src/jarvis.ts`: registry types, loading, operator resolution
- `src/chain.ts`: providers, Bridgehub ABI, the "is this chain on Sepolia" check
- `src/funding.ts`: L1 transfers and Bridgehub deposits with detailed logging
- `src/report.ts`: job summary and Slack payload
- `src/config.ts`: environment parsing and validation
- `src/targets.ts`: remembers handled (chain, address) pairs so shared addresses are funded once
