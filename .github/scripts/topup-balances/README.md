# topup-balances

Keeps the operators and watchdogs of Sepolia-based ZK chains (stage and testnet ecosystems)
funded. Runs from `.github/workflows/topup-balances.yaml` every 6 hours and on demand.
Tracked in [PLA-1425](https://linear.app/matterlabs/issue/PLA-1425).

## What a run does

1. Loads the chain registry from Jarvis (`GET /api/chains/cache`).
2. Keeps chains in state `normal` whose L1 diamond proxy lives on Sepolia: `getBridgehub()`
   must answer on the diamond proxy, and that Bridgehub must map the chain ID back to it.
   Mainnet chains drop out here because their contracts hold no code on Sepolia.
3. Collects the funding targets of every chain:
   - the commit, prove and execute operators on the settlement layer, resolved with the same
     precedence as the Jarvis dashboard (sender of the last tx, service-discovered, manually
     configured, first validator);
   - the watchdog on L1 (it pays for its deposit flows there);
   - the watchdog on L2.
4. Reads live balances: L1 RPC for L1 targets, the chain's L2 RPC for L2 targets, falling
   back to the Jarvis cache when an L2 RPC is unreachable (auth-gated Prividium RPCs).
5. Tops up every target below its minimum up to its target balance from the funder wallet:
   - L1 targets get a plain ETH transfer;
   - L2 targets get a `Bridgehub.requestL2TransactionDirect` deposit. The L2 gas cost is
     taken from `l2TransactionBaseCost` at a buffered gas price that is also pinned as the
     tx max fee, so the deposit can never be underfunded; the surplus is refunded on L2.
   Every check and every transaction (parameters, nonce, gas price, receipt, explorer link)
   is logged, so the job log is a complete audit trail. An address shared by several roles
   or chains is funded once.
6. Writes a markdown report to the job summary and, when anything needs attention, a Slack
   payload that the workflow posts to the dedicated channel. The run fails on: a reverted
   or failed transaction, a target below threshold that cannot be funded (for example a
   custom base token), a balance that could not be read, the funder ending below its
   minimum, or a Jarvis token that expires soon.

Only ETH-based targets can be funded. Custom-base-token chains still get their operators
funded on L1; their L2 watchdog is reported as an error when it is low.

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
| `FUNDER_MIN_ETH` | `5` | Fail when the funder ends the run below this |
| `FUNDER_GAS_RESERVE_ETH` | `0.05` | ETH the funder keeps for L1 gas |
| `L2_GAS_LIMIT` | `10000000` | L2 gas limit of deposits |
| `L2_GAS_PER_PUBDATA` | `800` | L2 gas per pubdata byte of deposits |
| `GAS_PRICE_BUFFER_PERCENT` | `50` | Buffer over the L1 gas price, used as max fee |
| `ONLY_ECOSYSTEMS` | all | Space-separated Jarvis ecosystems to restrict to |
| `SKIP_CHAINS` | none | Space-separated Jarvis chain slugs to skip |
| `JARVIS_TOKEN_MIN_DAYS` | `7` | Fail when the Jarvis token expires sooner than this |
| `RPC_TIMEOUT` | `30` | Seconds per RPC call |
| `TX_TIMEOUT` | `300` | Seconds to wait for a transaction receipt |
| `SLACK_PAYLOAD_FILE` | | Where to write the Slack payload on failure |

A minimum of `0` disables that check. Jarvis tokens are minted on the dashboard's API Access
page and live 30 days, hence the expiry check.

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

The PR workflow `check-topup-balances.yaml` runs both. Source layout:

- `src/main.ts`: the run (chain selection, targets, thresholds, exit code)
- `src/jarvis.ts`: registry types, loading, operator resolution
- `src/chain.ts`: providers, Bridgehub ABI, the "is this chain on Sepolia" check
- `src/funding.ts`: L1 transfers and Bridgehub deposits with detailed logging
- `src/report.ts`: job summary and Slack payload
- `src/config.ts`: environment parsing and validation
