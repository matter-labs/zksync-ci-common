#!/usr/bin/env bash
#
# Keep operator and watchdog balances of Sepolia-based ZK chains above thresholds.
#
# Flow:
#   1. Fetch the chain registry from Jarvis (GET /api/chains/cache).
#   2. Keep chains in state "normal" whose L1 diamond proxy lives on the configured
#      L1 (Sepolia): `diamondProxy.getBridgehub()` must answer and the Bridgehub must
#      map the chain ID back to that diamond proxy. Mainnet chains are filtered out
#      by this check (their contracts have no code on Sepolia).
#   3. For every chain, collect funding targets:
#        - commit/prove/execute operators on the settlement layer (Jarvis precedence:
#          last_* -> service_* -> manual_* -> first validator),
#        - the watchdog on L1,
#        - the watchdog on L2.
#   4. Read live balances (L1 RPC for L1 targets, chain L2 RPC for L2 targets, with a
#      fallback to the Jarvis cache when an L2 RPC is unreachable, e.g. Prividium).
#   5. Top up every target below its minimum up to its target balance:
#        - L1 targets: plain ETH transfer,
#        - L2 targets: Bridgehub.requestL2TransactionDirect deposit; the L2 gas cost is
#          taken from Bridgehub.l2TransactionBaseCost at a buffered gas price which is
#          also pinned as the tx max fee, so the deposit can never be underfunded.
#      Every check and every transaction (parameters, nonce, gas price, receipt) is
#      logged, so the job log is a complete audit trail.
#   6. Write a markdown report to $GITHUB_STEP_SUMMARY, write a Slack payload to
#      $SLACK_PAYLOAD_FILE when something went wrong, and exit non-zero if anything
#      needed attention (failed tx, target that cannot be funded, low funder balance,
#      Jarvis token about to expire).
#
# Only ETH-based targets can be funded. A target with a non-ETH base token that is
# below its minimum is reported as an error so that somebody gets notified.
#
# Environment (see .github/workflows/topup-balances.yaml for the CI wiring):
#   JARVIS_API_URL          Jarvis chains API base URL (default: https://api.jarvis.matterhosted.dev)
#   JARVIS_API_TOKEN        Bearer JWT with the chains:read scope (minted on the Jarvis API Access page)
#   JARVIS_PAYLOAD_FILE     Testing only: read the registry payload from this file instead of the API
#   L1_RPC_URL              Sepolia JSON-RPC URL
#   L1_CHAIN_ID             Expected L1 chain ID (default: 11155111)
#   L1_EXPLORER_URL         Block explorer used for tx links (default: https://sepolia.etherscan.io)
#   FUNDER_PRIVATE_KEY      Private key of the funding wallet (required unless DRY_RUN=true)
#   FUNDER_ADDRESS          Funding wallet address; derived from the key when not set
#   DRY_RUN                 "true" to only report what would be sent (default: false)
#   OPERATOR_MIN_ETH / OPERATOR_TARGET_ETH          operator thresholds (default: 5 / 10)
#   WATCHDOG_L1_MIN_ETH / WATCHDOG_L1_TARGET_ETH    watchdog L1 thresholds (default: 0.2 / 0.5)
#   WATCHDOG_L2_MIN_ETH / WATCHDOG_L2_TARGET_ETH    watchdog L2 thresholds (default: 0.5 / 1.5)
#                           A minimum of 0 disables that check.
#   FUNDER_MIN_ETH          Fail when the funder ends the run below this (default: 5)
#   FUNDER_GAS_RESERVE_ETH  ETH the funder must keep for L1 gas (default: 0.05)
#   L2_GAS_LIMIT            L2 gas limit of deposit txs (default: 10000000)
#   L2_GAS_PER_PUBDATA      L2 gas per pubdata byte of deposit txs (default: 800)
#   GAS_PRICE_BUFFER_PERCENT  Buffer over the current L1 gas price used as max fee (default: 50)
#   ONLY_ECOSYSTEMS         Space-separated Jarvis ecosystem names to restrict to (default: all)
#   SKIP_CHAINS             Space-separated Jarvis chain slugs to skip (default: none)
#   JARVIS_TOKEN_MIN_DAYS   Fail when the Jarvis token expires sooner than this (default: 7)
#   RPC_TIMEOUT             Seconds to wait for a single RPC call (default: 30)
#   SLACK_PAYLOAD_FILE      Where to write the Slack Block Kit payload on failure (default: none)
#
# Never run this script with `set -x`: the private key is passed to cast on the command line.

set -euo pipefail

JARVIS_API_URL="${JARVIS_API_URL:-https://api.jarvis.matterhosted.dev}"
JARVIS_API_TOKEN="${JARVIS_API_TOKEN:-}"
JARVIS_PAYLOAD_FILE="${JARVIS_PAYLOAD_FILE:-}"
L1_RPC_URL="${L1_RPC_URL:?L1_RPC_URL is required}"
L1_CHAIN_ID="${L1_CHAIN_ID:-11155111}"
L1_EXPLORER_URL="${L1_EXPLORER_URL:-https://sepolia.etherscan.io}"
FUNDER_PRIVATE_KEY="${FUNDER_PRIVATE_KEY:-}"
FUNDER_ADDRESS="${FUNDER_ADDRESS:-}"
DRY_RUN="${DRY_RUN:-false}"
OPERATOR_MIN_ETH="${OPERATOR_MIN_ETH:-5}"
OPERATOR_TARGET_ETH="${OPERATOR_TARGET_ETH:-10}"
WATCHDOG_L1_MIN_ETH="${WATCHDOG_L1_MIN_ETH:-0.2}"
WATCHDOG_L1_TARGET_ETH="${WATCHDOG_L1_TARGET_ETH:-0.5}"
WATCHDOG_L2_MIN_ETH="${WATCHDOG_L2_MIN_ETH:-0.5}"
WATCHDOG_L2_TARGET_ETH="${WATCHDOG_L2_TARGET_ETH:-1.5}"
FUNDER_MIN_ETH="${FUNDER_MIN_ETH:-5}"
FUNDER_GAS_RESERVE_ETH="${FUNDER_GAS_RESERVE_ETH:-0.05}"
L2_GAS_LIMIT="${L2_GAS_LIMIT:-10000000}"
L2_GAS_PER_PUBDATA="${L2_GAS_PER_PUBDATA:-800}"
GAS_PRICE_BUFFER_PERCENT="${GAS_PRICE_BUFFER_PERCENT:-50}"
ONLY_ECOSYSTEMS="${ONLY_ECOSYSTEMS:-}"
SKIP_CHAINS="${SKIP_CHAINS:-}"
JARVIS_TOKEN_MIN_DAYS="${JARVIS_TOKEN_MIN_DAYS:-7}"
RPC_TIMEOUT="${RPC_TIMEOUT:-30}"
SLACK_PAYLOAD_FILE="${SLACK_PAYLOAD_FILE:-}"

ETH_TOKEN_ADDRESS="0x0000000000000000000000000000000000000001"
REQUEST_SIG="requestL2TransactionDirect((uint256,uint256,address,uint256,bytes,uint256,uint256,bytes[],address))"

export BC_LINE_LENGTH=0

WORKDIR="$(mktemp -d)"
PAYLOAD="${WORKDIR}/jarvis.json"

ERRORS=()          # problems that make the run fail
ACTIONS=()         # transactions sent (or that would be sent in dry-run), for the report and Slack
REPORT_ROWS=()
declare -A SEEN_TARGETS=()
FUNDER_EXHAUSTED=false
FUND_RESULT=""     # set by fund_l1/fund_l2: report details (success or failure reason)
FUND_ACTION=""     # set by fund_l1/fund_l2 on success: one-line description of the transaction
TX_HASH=""         # set by send_tx
FUNDER_FINAL=""    # funder balance at the end of the run
JARVIS_TOKEN_DAYS_LEFT=""

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

log()  { echo "$*"; }
warn() { echo "::warning::$*" >&2; }
err()  { echo "::error::$*" >&2; ERRORS+=("$*"); }
die()  { err "$*"; exit 1; }

is_true() { [[ "${1,,}" == "true" || "$1" == "1" ]]; }

to_wei()   { cast to-wei "$1" ether; }
# Human-readable ETH / gwei (display only).
fmt_eth()  { cast from-wei "$1" | awk '{ printf "%.4f", $1 }'; }
fmt_gwei() { cast from-wei "$1" gwei | awk '{ printf "%.3f", $1 }'; }
fmt_fee()  { cast from-wei "$1" | awk '{ printf "%.6f", $1 }'; }
hex_to_dec() { [[ -n "$1" ]] && cast to-dec "$1" 2>/dev/null || echo "?"; }
# Integer arithmetic on wei values (arbitrary precision).
calc()     { echo "$*" | bc; }
lt()       { [[ "$(calc "$1 < $2")" == "1" ]]; }

lower()   { echo "${1,,}"; }
is_addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }
tx_url()  { echo "${L1_EXPLORER_URL%/}/tx/$1"; }

# cast call against the L1 RPC; prints the first token of the decoded value.
l1_call() {
  local to="$1" sig="$2"
  shift 2
  timeout "${RPC_TIMEOUT}" cast call -r "${L1_RPC_URL}" "${to}" "${sig}" "$@" 2>/dev/null | awk 'NR==1 { print $1 }'
}

balance_at() {
  local rpc="$1" addr="$2"
  timeout "${RPC_TIMEOUT}" cast balance -r "${rpc}" "${addr}" 2>/dev/null
}

in_list() {
  local needle="$1" item
  shift
  for item in "$@"; do
    [[ "${item}" == "${needle}" ]] && return 0
  done
  return 1
}

# report <chain> <target> <address> <chain id> <balance wei|-> <min wei|-> <action> <details>
report() {
  local bal="$5" min="$6"
  [[ "${bal}" != "-" ]] && bal="$(fmt_eth "${bal}")"
  [[ "${min}" != "-" ]] && min="$(fmt_eth "${min}")"
  REPORT_ROWS+=("| $1 | $2 | \`$3\` | $4 | ${bal} | ${min} | $7 | $8 |")
}

# Slack Block Kit payload describing the problems of this run (used by the workflow
# to notify the dedicated channel). Written on every non-zero exit.
write_slack_payload() {
  local title run_url="" funder_text errors_text="" actions_text=""
  title="Sepolia balance top-up needs attention"
  is_true "${DRY_RUN}" && title="${title} (dry run)"
  if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
    run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  fi
  funder_text="\`${FUNDER_ADDRESS:-unknown}\`"
  [[ "${FUNDER_FINAL}" =~ ^[0-9]+$ ]] && funder_text="${funder_text}, $(fmt_eth "${FUNDER_FINAL}") ETH left"
  if [[ ${#ERRORS[@]} -gt 0 ]]; then
    errors_text="$(printf -- '• %s\n' "${ERRORS[@]}" | head -c 2800)"
  else
    errors_text="• The script exited with an error before reporting any problem; see the logs."
  fi
  if [[ ${#ACTIONS[@]} -gt 0 ]]; then
    actions_text="$(printf -- '• %s\n' "${ACTIONS[@]}" | head -c 2800)"
  fi
  jq -n \
    --arg title "${title}" \
    --arg repo "${GITHUB_REPOSITORY:-local}" \
    --arg workflow "${GITHUB_WORKFLOW:-topup-balances}" \
    --arg funder "${funder_text}" \
    --arg errors "${errors_text}" \
    --arg actions "${actions_text}" \
    --arg run_url "${run_url}" '
    def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
    {
      text: ("🚨 " + $title),
      blocks: (
        [
          { type: "header", text: { type: "plain_text", text: ("🚨 " + $title), emoji: true } },
          { type: "section", fields: [
              { type: "mrkdwn", text: ("*Repository:*\n`" + $repo + "`") },
              { type: "mrkdwn", text: ("*Workflow:*\n`" + $workflow + "`") },
              { type: "mrkdwn", text: ("*Funder:*\n" + $funder) }
          ] },
          { type: "section", text: { type: "mrkdwn", text: ("*Problems:*\n" + ($errors | esc)) } }
        ]
        + (if $actions != "" then
            [ { type: "section", text: { type: "mrkdwn", text: ("*Transactions sent in this run:*\n" + ($actions | esc)) } } ]
          else [] end)
        + (if $run_url != "" then
            [ { type: "actions", elements: [
                { type: "button", text: { type: "plain_text", text: "View workflow logs", emoji: true }, url: $run_url, style: "danger" }
            ] } ]
          else [] end)
      )
    }' > "${SLACK_PAYLOAD_FILE}"
}

on_exit() {
  local rc=$?
  if [[ ${rc} -ne 0 && -n "${SLACK_PAYLOAD_FILE}" ]]; then
    write_slack_payload || echo "::warning::Failed to write the Slack payload" >&2
  fi
  rm -rf "${WORKDIR}"
}
trap on_exit EXIT

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

for bin in cast jq curl bc timeout; do
  command -v "${bin}" >/dev/null 2>&1 || die "Missing required tool: ${bin}"
done

if ! is_true "${DRY_RUN}" && [[ -z "${FUNDER_PRIVATE_KEY}" ]]; then
  die "FUNDER_PRIVATE_KEY is required unless DRY_RUN=true"
fi
if [[ -n "${FUNDER_PRIVATE_KEY}" ]]; then
  FUNDER_ADDRESS="$(cast wallet address --private-key "${FUNDER_PRIVATE_KEY}")"
fi
[[ -n "${FUNDER_ADDRESS}" ]] || die "FUNDER_ADDRESS is required in dry-run mode when no key is given"

ACTUAL_CHAIN_ID="$(timeout "${RPC_TIMEOUT}" cast chain-id -r "${L1_RPC_URL}")" || die "L1 RPC is unreachable"
[[ "${ACTUAL_CHAIN_ID}" == "${L1_CHAIN_ID}" ]] || die "L1 RPC chain ID is ${ACTUAL_CHAIN_ID}, expected ${L1_CHAIN_ID}"

OPERATOR_MIN_WEI="$(to_wei "${OPERATOR_MIN_ETH}")"
OPERATOR_TARGET_WEI="$(to_wei "${OPERATOR_TARGET_ETH}")"
WATCHDOG_L1_MIN_WEI="$(to_wei "${WATCHDOG_L1_MIN_ETH}")"
WATCHDOG_L1_TARGET_WEI="$(to_wei "${WATCHDOG_L1_TARGET_ETH}")"
WATCHDOG_L2_MIN_WEI="$(to_wei "${WATCHDOG_L2_MIN_ETH}")"
WATCHDOG_L2_TARGET_WEI="$(to_wei "${WATCHDOG_L2_TARGET_ETH}")"
FUNDER_MIN_WEI="$(to_wei "${FUNDER_MIN_ETH}")"
FUNDER_GAS_RESERVE_WEI="$(to_wei "${FUNDER_GAS_RESERVE_ETH}")"

for pair in "OPERATOR:${OPERATOR_MIN_WEI}:${OPERATOR_TARGET_WEI}" \
            "WATCHDOG_L1:${WATCHDOG_L1_MIN_WEI}:${WATCHDOG_L1_TARGET_WEI}" \
            "WATCHDOG_L2:${WATCHDOG_L2_MIN_WEI}:${WATCHDOG_L2_TARGET_WEI}"; do
  IFS=: read -r name min target <<<"${pair}"
  if [[ "${min}" != "0" ]] && lt "${target}" "${min}"; then
    die "${name}_TARGET_ETH must be >= ${name}_MIN_ETH"
  fi
done

read -r -a ONLY_ECOSYSTEMS_ARR <<<"${ONLY_ECOSYSTEMS}"
read -r -a SKIP_CHAINS_ARR <<<"${SKIP_CHAINS}"

funder_start="$(balance_at "${L1_RPC_URL}" "${FUNDER_ADDRESS}")" || funder_start=""

log "Funder:            ${FUNDER_ADDRESS} ($( [[ "${funder_start}" =~ ^[0-9]+$ ]] && fmt_eth "${funder_start}" || echo "?") ETH)"
log "L1 RPC chain ID:   ${L1_CHAIN_ID}"
log "Dry run:           ${DRY_RUN}"
log "Operator:          min ${OPERATOR_MIN_ETH} ETH, target ${OPERATOR_TARGET_ETH} ETH"
log "Watchdog L1:       min ${WATCHDOG_L1_MIN_ETH} ETH, target ${WATCHDOG_L1_TARGET_ETH} ETH"
log "Watchdog L2:       min ${WATCHDOG_L2_MIN_ETH} ETH, target ${WATCHDOG_L2_TARGET_ETH} ETH"
log "Deposit params:    L2 gas limit ${L2_GAS_LIMIT}, gas per pubdata ${L2_GAS_PER_PUBDATA}, gas price buffer +${GAS_PRICE_BUFFER_PERCENT}%"
[[ -n "${ONLY_ECOSYSTEMS}" ]] && log "Only ecosystems:   ${ONLY_ECOSYSTEMS}"
[[ -n "${SKIP_CHAINS}" ]] && log "Skip chains:       ${SKIP_CHAINS}"

# ----------------------------------------------------------------------------
# Jarvis registry
# ----------------------------------------------------------------------------

if [[ -n "${JARVIS_PAYLOAD_FILE}" ]]; then
  log "Reading Jarvis payload from ${JARVIS_PAYLOAD_FILE}"
  cp "${JARVIS_PAYLOAD_FILE}" "${PAYLOAD}"
else
  [[ -n "${JARVIS_API_TOKEN}" ]] || die "JARVIS_API_TOKEN is required"

  # Token lifetime: tokens minted on the Jarvis API Access page live 30 days.
  jwt_payload="$(cut -d. -f2 <<<"${JARVIS_API_TOKEN}" | tr '_-' '/+')"
  case $(( ${#jwt_payload} % 4 )) in 2) jwt_payload+="==" ;; 3) jwt_payload+="=" ;; esac
  jwt_exp="$(base64 -d <<<"${jwt_payload}" 2>/dev/null | jq -r '.exp // empty' 2>/dev/null || true)"
  if [[ "${jwt_exp}" =~ ^[0-9]+$ ]]; then
    JARVIS_TOKEN_DAYS_LEFT=$(( (jwt_exp - $(date +%s)) / 86400 ))
    log "Jarvis token:      expires in ${JARVIS_TOKEN_DAYS_LEFT} day(s)"
  else
    warn "Could not decode the Jarvis token expiry"
  fi

  log "Fetching chain registry from ${JARVIS_API_URL%/}/api/chains/cache"
  http_code="$(curl -sS -o "${PAYLOAD}" -w '%{http_code}' --max-time 60 \
    -H "Authorization: Bearer ${JARVIS_API_TOKEN}" \
    "${JARVIS_API_URL%/}/api/chains/cache")" || die "Failed to reach Jarvis at ${JARVIS_API_URL}"
  if [[ "${http_code}" != "200" ]]; then
    die "Jarvis returned HTTP ${http_code}: $(head -c 300 "${PAYLOAD}")"
  fi
fi

jq -e '.chains | type == "array"' "${PAYLOAD}" >/dev/null || die "Unexpected Jarvis payload shape"
log "Jarvis chains:     $(jq '.chains | length' "${PAYLOAD}") total, $(jq '[.chains[] | select(.state == "normal")] | length' "${PAYLOAD}") in state normal"

# One row per candidate chain, fields separated by the ASCII unit separator (a tab
# would make bash collapse empty fields). Operator addresses follow the Jarvis precedence:
# last_<role> -> service_<role> -> service*OperatorAddress -> manual_<role> -> *OperatorAddress -> first validator.
CANDIDATES="${WORKDIR}/candidates.txt"
FS=$'\x1f'
jq -r '
  def pick($entries; $label):
    ($entries // []) | map(select(.labels | index($label))) | .[0].address;
  def resolve($c; $d; $role; $rolesKey; $svcField; $manField):
    ( pick($d.validatorRoles[$rolesKey]; "last_" + $role)
      // pick($d.validatorRoles[$rolesKey]; "service_" + $role)
      // $c[$svcField]
      // pick($d.validatorRoles[$rolesKey]; "manual_" + $role)
      // $c[$manField]
      // (($d.validatorRoles[$rolesKey] // [])[0].address)
      // "" );
  . as $root
  | .chains[]
  | select(.state == "normal" and (.archived != true))
  | . as $c
  | ($root.chainDataMap[$c.chain] // {}) as $d
  | [ $c.chain,
      $c.ecosystem,
      ($c.chainId | tostring),
      ($d.diamondProxy // ""),
      ($c.l2RpcUrl // ""),
      ($c.watchdogAddress // ""),
      ($d.watchdogBalance // $d.watchdogL2Balance // ""),
      resolve($c; $d; "commit";  "committers"; "serviceCommitOperatorAddress";  "commitOperatorAddress"),
      resolve($c; $d; "prove";   "provers";    "serviceProveOperatorAddress";   "proveOperatorAddress"),
      resolve($c; $d; "execute"; "executors";  "serviceExecuteOperatorAddress"; "executeOperatorAddress"),
      ($d.commitOperatorBalance // ""),
      ($d.proveOperatorBalance // ""),
      ($d.executeOperatorBalance // "")
    ] | join("\u001f")
' "${PAYLOAD}" > "${CANDIDATES}"

# L2 RPC of a chain (by ecosystem + chain ID), used for operators settling on a Gateway.
l2_rpc_of() {
  jq -r --arg eco "$1" --argjson id "$2" \
    '[.chains[] | select(.ecosystem == $eco and .chainId == $id) | .l2RpcUrl // ""] | .[0] // ""' "${PAYLOAD}"
}

# ----------------------------------------------------------------------------
# Funding primitives
# ----------------------------------------------------------------------------

funder_balance() { balance_at "${L1_RPC_URL}" "${FUNDER_ADDRESS}"; }

# Records a funding failure: logs it, adds it to ERRORS and to the report details.
fund_failed() { err "$1"; FUND_RESULT="$1"; return 1; }

# Ensures the funder can spend <wei> plus the gas reserve. Sets FUNDER_EXHAUSTED on failure.
funder_can_spend() {
  local need="$1" have
  have="$(funder_balance)" || { fund_failed "Failed to read the funder balance"; return 1; }
  if lt "${have}" "$(calc "${need} + ${FUNDER_GAS_RESERVE_WEI}")"; then
    FUNDER_EXHAUSTED=true
    fund_failed "Funder ${FUNDER_ADDRESS} holds $(fmt_eth "${have}") ETH, cannot spend $(fmt_eth "${need}") ETH; skipping remaining top-ups"
    return 1
  fi
  log "     funder balance $(fmt_eth "${have}") ETH, ok to spend $(fmt_eth "${need}") ETH"
}

# Current L1 gas price plus the configured buffer, used as the max fee of every tx.
# Sets GAS_PRICE and MAX_FEE.
GAS_PRICE=""
MAX_FEE=""
refresh_gas_price() {
  GAS_PRICE="$(timeout "${RPC_TIMEOUT}" cast gas-price -r "${L1_RPC_URL}" 2>/dev/null)" || { fund_failed "Failed to fetch the L1 gas price"; return 1; }
  MAX_FEE="$(calc "${GAS_PRICE} * (100 + ${GAS_PRICE_BUFFER_PERCENT}) / 100")"
  log "     L1 gas price $(fmt_gwei "${GAS_PRICE}") gwei, max fee for this tx $(fmt_gwei "${MAX_FEE}") gwei (+${GAS_PRICE_BUFFER_PERCENT}%)"
}

# send_tx <description> <max fee wei> <value wei> <to> [<sig> <args>]; sets TX_HASH.
send_tx() {
  local what="$1" max_fee="$2" value="$3" to="$4"
  shift 4
  local nonce receipt status block gas_used eff_price fee
  TX_HASH=""
  nonce="$(timeout "${RPC_TIMEOUT}" cast nonce -r "${L1_RPC_URL}" "${FUNDER_ADDRESS}" 2>/dev/null || echo "?")"
  log "  -> sending ${what}"
  log "     from ${FUNDER_ADDRESS} (nonce ${nonce}) to ${to}, value $(fmt_eth "${value}") ETH (${value} wei), max fee $(fmt_gwei "${max_fee}") gwei"
  [[ $# -ge 2 ]] && log "     call ${1%%(*}$2"
  if ! receipt="$(cast send --json -r "${L1_RPC_URL}" --private-key "${FUNDER_PRIVATE_KEY}" --timeout 300 \
                    --gas-price "${max_fee}" --value "${value}" "${to}" "$@" 2>&1)"; then
    fund_failed "${what}: cast send failed: $(tail -c 400 <<<"${receipt}")"
    return 1
  fi
  status="$(jq -r '.status // empty' <<<"${receipt}" 2>/dev/null || true)"
  TX_HASH="$(jq -r '.transactionHash // empty' <<<"${receipt}" 2>/dev/null || true)"
  block="$(hex_to_dec "$(jq -r '.blockNumber // empty' <<<"${receipt}" 2>/dev/null || true)")"
  gas_used="$(hex_to_dec "$(jq -r '.gasUsed // empty' <<<"${receipt}" 2>/dev/null || true)")"
  eff_price="$(hex_to_dec "$(jq -r '.effectiveGasPrice // empty' <<<"${receipt}" 2>/dev/null || true)")"
  if [[ "${status}" != "0x1" && "${status}" != "1" ]]; then
    fund_failed "${what}: transaction ${TX_HASH:-?} reverted (status ${status:-unknown}), $(tx_url "${TX_HASH:-}")"
    return 1
  fi
  if [[ "${gas_used}" =~ ^[0-9]+$ && "${eff_price}" =~ ^[0-9]+$ ]]; then
    fee="$(fmt_fee "$(calc "${gas_used} * ${eff_price}")") ETH"
    eff_price="$(fmt_gwei "${eff_price}") gwei"
  else
    fee="?"
  fi
  log "     confirmed in block ${block}: tx ${TX_HASH}, gas used ${gas_used}, effective gas price ${eff_price}, L1 fee ${fee}"
  log "     $(tx_url "${TX_HASH}")"
}

# fund_l1 <to> <amount wei>; sets FUND_RESULT and FUND_ACTION.
fund_l1() {
  local to="$1" amount="$2"
  FUND_RESULT=""
  FUND_ACTION=""
  funder_can_spend "${amount}" || { FUND_RESULT="funder exhausted"; return 1; }
  refresh_gas_price || return 1
  if is_true "${DRY_RUN}"; then
    FUND_RESULT="dry-run: would transfer $(fmt_eth "${amount}") ETH on L1 at max fee $(fmt_gwei "${MAX_FEE}") gwei"
    FUND_ACTION="dry run: would transfer $(fmt_eth "${amount}") ETH to ${to} on L1"
    log "  -> dry run: would send L1 transfer of $(fmt_eth "${amount}") ETH from ${FUNDER_ADDRESS} to ${to}"
    return 0
  fi
  send_tx "L1 transfer of $(fmt_eth "${amount}") ETH" "${MAX_FEE}" "${amount}" "${to}" || return 1
  FUND_RESULT="sent $(fmt_eth "${amount}") ETH, tx [${TX_HASH:0:10}…]($(tx_url "${TX_HASH}"))"
  FUND_ACTION="transferred $(fmt_eth "${amount}") ETH to ${to} on L1, $(tx_url "${TX_HASH}")"
}

# fund_l2 <bridgehub> <target chain id> <to> <amount wei>; sets FUND_RESULT and FUND_ACTION.
fund_l2() {
  local bridgehub="$1" chain_id="$2" to="$3" amount="$4"
  local base_token base_cost mint_value
  FUND_RESULT=""
  FUND_ACTION=""

  base_token="$(l1_call "${bridgehub}" "baseToken(uint256)(address)" "${chain_id}")" || true
  if [[ "$(lower "${base_token:-}")" != "${ETH_TOKEN_ADDRESS}" ]]; then
    fund_failed "Chain ${chain_id} uses base token ${base_token:-unknown}; only ETH-based chains can be topped up (address ${to} needs $(fmt_eth "${amount}") of base token)"
    return 1
  fi

  refresh_gas_price || return 1
  base_cost="$(l1_call "${bridgehub}" "l2TransactionBaseCost(uint256,uint256,uint256,uint256)(uint256)" \
    "${chain_id}" "${MAX_FEE}" "${L2_GAS_LIMIT}" "${L2_GAS_PER_PUBDATA}")" || true
  [[ "${base_cost}" =~ ^[0-9]+$ ]] || { fund_failed "Failed to compute l2TransactionBaseCost for chain ${chain_id}"; return 1; }
  mint_value="$(calc "${amount} + ${base_cost}")"
  log "     deposit via Bridgehub ${bridgehub} to chain ${chain_id}: l2Value $(fmt_eth "${amount}") ETH, L2 gas cost $(fmt_eth "${base_cost}") ETH" \
      "(limit ${L2_GAS_LIMIT}, ${L2_GAS_PER_PUBDATA} gas/pubdata byte, at $(fmt_gwei "${MAX_FEE}") gwei), mintValue $(fmt_eth "${mint_value}") ETH, refund recipient ${to}"

  funder_can_spend "${mint_value}" || { FUND_RESULT="funder exhausted"; return 1; }
  if is_true "${DRY_RUN}"; then
    FUND_RESULT="dry-run: would deposit $(fmt_eth "${amount}") ETH via ${bridgehub} (mintValue $(fmt_eth "${mint_value}") ETH incl. L2 gas)"
    FUND_ACTION="dry run: would deposit $(fmt_eth "${amount}") ETH to ${to} on chain ${chain_id}"
    log "  -> dry run: would send deposit of $(fmt_eth "${amount}") ETH from ${FUNDER_ADDRESS} to ${to} on chain ${chain_id}"
    return 0
  fi
  # The max fee is pinned to the gas price used for the base cost, so tx.gasprice on
  # L1 can never exceed it and mintValue always covers l2Value + L2 gas.
  send_tx "deposit of $(fmt_eth "${amount}") ETH to chain ${chain_id}" "${MAX_FEE}" "${mint_value}" "${bridgehub}" "${REQUEST_SIG}" \
    "(${chain_id},${mint_value},${to},${amount},0x,${L2_GAS_LIMIT},${L2_GAS_PER_PUBDATA},[],${to})" || return 1
  FUND_RESULT="deposited $(fmt_eth "${amount}") ETH (mintValue $(fmt_eth "${mint_value}") ETH), tx [${TX_HASH:0:10}…]($(tx_url "${TX_HASH}"))"
  FUND_ACTION="deposited $(fmt_eth "${amount}") ETH to ${to} on chain ${chain_id} (mintValue $(fmt_eth "${mint_value}") ETH), $(tx_url "${TX_HASH}")"
}

# ----------------------------------------------------------------------------
# Targets
# ----------------------------------------------------------------------------

# ensure_balance <chain> <label> <address> <target chain id> <balance wei|""> <balance source> <min wei> <target wei> <bridgehub>
ensure_balance() {
  local chain="$1" label="$2" addr="$3" target_chain="$4" balance="$5" source="$6" min="$7" target="$8" bridgehub="$9"
  local key need prefix

  [[ "${min}" == "0" ]] && return 0
  prefix="${chain}/${label}:"

  if ! is_addr "${addr}"; then
    log "${prefix} no address, skipped"
    report "${chain}" "${label}" "${addr:-?}" "${target_chain}" "-" "${min}" "skipped" "no address"
    return 0
  fi

  key="${target_chain}:$(lower "${addr}")"
  if [[ -n "${SEEN_TARGETS[${key}]:-}" ]]; then
    log "${prefix} ${addr} on chain ${target_chain} already checked as ${SEEN_TARGETS[${key}]}, skipped"
    report "${chain}" "${label}" "${addr}" "${target_chain}" "-" "${min}" "skipped" "same as ${SEEN_TARGETS[${key}]}"
    return 0
  fi
  SEEN_TARGETS["${key}"]="${chain}/${label}"

  if [[ ! "${balance}" =~ ^[0-9]+$ ]]; then
    err "${chain}/${label}: could not determine the balance of ${addr} on chain ${target_chain}"
    report "${chain}" "${label}" "${addr}" "${target_chain}" "-" "${min}" "error" "balance unavailable"
    return 0
  fi

  if ! lt "${balance}" "${min}"; then
    log "${prefix} ${addr} on chain ${target_chain} has $(fmt_eth "${balance}") ETH (${source}), min $(fmt_eth "${min}") ETH, ok"
    report "${chain}" "${label}" "${addr}" "${target_chain}" "${balance}" "${min}" "ok" ""
    return 0
  fi

  need="$(calc "${target} - ${balance}")"
  log "${prefix} ${addr} on chain ${target_chain} has $(fmt_eth "${balance}") ETH (${source}), BELOW min $(fmt_eth "${min}") ETH; topping up by $(fmt_eth "${need}") ETH to reach $(fmt_eth "${target}") ETH"

  if is_true "${FUNDER_EXHAUSTED}"; then
    log "  -> skipped, the funder is exhausted"
    report "${chain}" "${label}" "${addr}" "${target_chain}" "${balance}" "${min}" "error" "funder exhausted"
    return 0
  fi

  if [[ "${target_chain}" == "${L1_CHAIN_ID}" ]]; then
    fund_l1 "${addr}" "${need}" || { report "${chain}" "${label}" "${addr}" "${target_chain}" "${balance}" "${min}" "error" "${FUND_RESULT}"; return 0; }
  else
    fund_l2 "${bridgehub}" "${target_chain}" "${addr}" "${need}" || { report "${chain}" "${label}" "${addr}" "${target_chain}" "${balance}" "${min}" "error" "${FUND_RESULT}"; return 0; }
  fi
  ACTIONS+=("${chain}/${label}: ${FUND_ACTION}")
  report "${chain}" "${label}" "${addr}" "${target_chain}" "${balance}" "${min}" "topped up" "${FUND_RESULT}"
}

processed=0
while IFS="${FS}" read -r chain ecosystem chain_id diamond l2_rpc watchdog cached_wd_l2 \
                         op_commit op_prove op_execute cached_commit cached_prove cached_execute; do
  if [[ ${#ONLY_ECOSYSTEMS_ARR[@]} -gt 0 ]] && ! in_list "${ecosystem}" "${ONLY_ECOSYSTEMS_ARR[@]}"; then
    continue
  fi
  if [[ ${#SKIP_CHAINS_ARR[@]} -gt 0 ]] && in_list "${chain}" "${SKIP_CHAINS_ARR[@]}"; then
    log "${chain}: skipped (SKIP_CHAINS)"
    continue
  fi
  if ! is_addr "${diamond}"; then
    log "${chain}: skipped (no diamond proxy in Jarvis)"
    continue
  fi

  # Sepolia-based check: the diamond proxy must be a contract on this L1 that knows its Bridgehub,
  # and that Bridgehub must map the chain ID back to the same diamond proxy.
  bridgehub="$(l1_call "${diamond}" "getBridgehub()(address)")" || true
  if ! is_addr "${bridgehub:-}"; then
    log "${chain}: skipped (diamond proxy ${diamond} is not deployed on chain ${L1_CHAIN_ID})"
    continue
  fi
  registered="$(l1_call "${bridgehub}" "getZKChain(uint256)(address)" "${chain_id}")" || true
  if ! is_addr "${registered:-}"; then
    registered="$(l1_call "${bridgehub}" "getHyperchain(uint256)(address)" "${chain_id}")" || true
  fi
  if [[ "$(lower "${registered:-}")" != "$(lower "${diamond}")" ]]; then
    warn "${chain}: Bridgehub ${bridgehub} maps chain ${chain_id} to ${registered:-nothing}, not to ${diamond}; skipped"
    continue
  fi
  settlement_layer="$(l1_call "${bridgehub}" "settlementLayer(uint256)(uint256)" "${chain_id}")" || true
  [[ "${settlement_layer}" =~ ^[0-9]+$ ]] || settlement_layer="${L1_CHAIN_ID}"
  processed=$((processed + 1))
  log ""
  log "=== ${chain} (${ecosystem}, chain ${chain_id}): diamond proxy ${diamond}, bridgehub ${bridgehub}, settlement layer ${settlement_layer}"

  # Operators live on the settlement layer.
  if [[ "${settlement_layer}" == "${L1_CHAIN_ID}" ]]; then
    sl_rpc="${L1_RPC_URL}"
    sl_source="live L1 RPC"
  else
    sl_rpc="$(l2_rpc_of "${ecosystem}" "${settlement_layer}")"
    sl_source="live settlement layer RPC"
  fi
  for role_spec in "commit:${op_commit}:${cached_commit}" "prove:${op_prove}:${cached_prove}" "execute:${op_execute}:${cached_execute}"; do
    IFS=: read -r role op_addr cached_bal <<<"${role_spec}"
    bal=""
    source="${sl_source}"
    if is_addr "${op_addr}"; then
      if [[ -n "${sl_rpc}" ]]; then
        bal="$(balance_at "${sl_rpc}" "${op_addr}")" || bal=""
      fi
      if [[ ! "${bal}" =~ ^[0-9]+$ ]]; then
        bal="${cached_bal}"
        source="Jarvis cache"
      fi
    fi
    ensure_balance "${chain}" "${role} operator" "${op_addr}" "${settlement_layer}" "${bal}" "${source}" \
      "${OPERATOR_MIN_WEI}" "${OPERATOR_TARGET_WEI}" "${bridgehub}"
  done

  # Watchdog on L1 and L2.
  if is_addr "${watchdog}"; then
    bal="$(balance_at "${L1_RPC_URL}" "${watchdog}")" || bal=""
    ensure_balance "${chain}" "watchdog L1" "${watchdog}" "${L1_CHAIN_ID}" "${bal}" "live L1 RPC" \
      "${WATCHDOG_L1_MIN_WEI}" "${WATCHDOG_L1_TARGET_WEI}" "${bridgehub}"

    bal=""
    source="live L2 RPC"
    if [[ -n "${l2_rpc}" ]]; then
      bal="$(balance_at "${l2_rpc}" "${watchdog}")" || bal=""
    fi
    if [[ ! "${bal}" =~ ^[0-9]+$ ]]; then
      log "${chain}: L2 RPC ${l2_rpc:-<none>} unavailable, falling back to the Jarvis cached watchdog balance"
      bal="${cached_wd_l2}"
      source="Jarvis cache"
    fi
    ensure_balance "${chain}" "watchdog L2" "${watchdog}" "${chain_id}" "${bal}" "${source}" \
      "${WATCHDOG_L2_MIN_WEI}" "${WATCHDOG_L2_TARGET_WEI}" "${bridgehub}"
  else
    log "${chain}: no watchdog address in Jarvis"
  fi
done < "${CANDIDATES}"

log ""
[[ "${processed}" -gt 0 ]] || err "No Sepolia-based chains found in the Jarvis registry; check the registry and filters"

# ----------------------------------------------------------------------------
# Funder health and token lifetime (checked last so top-ups always run first)
# ----------------------------------------------------------------------------

FUNDER_FINAL="$(funder_balance)" || FUNDER_FINAL=""
if [[ "${FUNDER_FINAL}" =~ ^[0-9]+$ ]]; then
  if [[ "${funder_start}" =~ ^[0-9]+$ ]]; then
    log "Funder balance:    $(fmt_eth "${FUNDER_FINAL}") ETH (spent $(fmt_eth "$(calc "${funder_start} - ${FUNDER_FINAL}")") ETH in this run)"
  else
    log "Funder balance:    $(fmt_eth "${FUNDER_FINAL}") ETH"
  fi
  if lt "${FUNDER_FINAL}" "${FUNDER_MIN_WEI}"; then
    err "Funder ${FUNDER_ADDRESS} holds $(fmt_eth "${FUNDER_FINAL}") ETH, below the ${FUNDER_MIN_ETH} ETH minimum; please refill it"
  fi
else
  err "Failed to read the final funder balance"
fi

if [[ -n "${JARVIS_TOKEN_DAYS_LEFT}" ]] && (( JARVIS_TOKEN_DAYS_LEFT < JARVIS_TOKEN_MIN_DAYS )); then
  err "Jarvis API token expires in ${JARVIS_TOKEN_DAYS_LEFT} day(s); mint a new one on the Jarvis API Access page and update the JARVIS_API_TOKEN secret"
fi

# ----------------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------------

{
  echo "## Balance top-up report"
  echo
  echo "Funder \`${FUNDER_ADDRESS}\`: $( [[ "${FUNDER_FINAL}" =~ ^[0-9]+$ ]] && fmt_eth "${FUNDER_FINAL}" || echo "?" ) ETH"
  is_true "${DRY_RUN}" && echo "" && echo "**Dry run: no transactions were sent.**"
  [[ -n "${JARVIS_TOKEN_DAYS_LEFT}" ]] && echo "" && echo "Jarvis token expires in ${JARVIS_TOKEN_DAYS_LEFT} day(s)."
  echo
  echo "| Chain | Target | Address | Chain ID | Balance | Min | Action | Details |"
  echo "|---|---|---|---|---|---|---|---|"
  printf '%s\n' "${REPORT_ROWS[@]}"
  echo
  echo "Balances are in ETH, or in the chain's base token for L2 targets of custom-base-token chains."
  if [[ ${#ACTIONS[@]} -gt 0 ]]; then
    echo
    echo "### Transactions"
    echo
    printf -- '- %s\n' "${ACTIONS[@]}"
  fi
  if [[ ${#ERRORS[@]} -gt 0 ]]; then
    echo
    echo "### Errors"
    echo
    printf -- '- %s\n' "${ERRORS[@]}"
  fi
} > "${WORKDIR}/report.md"

cat "${WORKDIR}/report.md"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "${WORKDIR}/report.md" >> "${GITHUB_STEP_SUMMARY}"
fi

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo "::error::${#ERRORS[@]} problem(s) need attention"
  exit 1
fi
log "All balances are above their thresholds."
