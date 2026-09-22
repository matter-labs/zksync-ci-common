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
#   6. Write a markdown report to $GITHUB_STEP_SUMMARY and exit non-zero if anything
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
#   GAS_PRICE_BUFFER_PERCENT  Buffer over the current L1 gas price used for deposits (default: 50)
#   ONLY_ECOSYSTEMS         Space-separated Jarvis ecosystem names to restrict to (default: all)
#   SKIP_CHAINS             Space-separated Jarvis chain slugs to skip (default: none)
#   JARVIS_TOKEN_MIN_DAYS   Fail when the Jarvis token expires sooner than this (default: 7)
#   RPC_TIMEOUT             Seconds to wait for a single RPC call (default: 30)
#
# Never run this script with `set -x`: the private key is passed to cast on the command line.

set -euo pipefail

JARVIS_API_URL="${JARVIS_API_URL:-https://api.jarvis.matterhosted.dev}"
JARVIS_API_TOKEN="${JARVIS_API_TOKEN:-}"
JARVIS_PAYLOAD_FILE="${JARVIS_PAYLOAD_FILE:-}"
L1_RPC_URL="${L1_RPC_URL:?L1_RPC_URL is required}"
L1_CHAIN_ID="${L1_CHAIN_ID:-11155111}"
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

ETH_TOKEN_ADDRESS="0x0000000000000000000000000000000000000001"
REQUEST_SIG="requestL2TransactionDirect((uint256,uint256,address,uint256,bytes,uint256,uint256,bytes[],address))"

export BC_LINE_LENGTH=0

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
PAYLOAD="${WORKDIR}/jarvis.json"

ERRORS=()
REPORT_ROWS=()
declare -A SEEN_TARGETS=()
FUNDER_EXHAUSTED=false
FUND_RESULT=""   # set by fund_l1/fund_l2: details for the report (success or failure reason)
TX_HASH=""       # set by send_tx

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

log()  { echo "$*"; }
warn() { echo "::warning::$*" >&2; }
err()  { echo "::error::$*" >&2; ERRORS+=("$*"); }
die()  { echo "::error::$*" >&2; exit 1; }

is_true() { [[ "${1,,}" == "true" || "$1" == "1" ]]; }

to_wei()   { cast to-wei "$1" ether; }
# Human-readable ETH with 4 decimals (display only).
fmt_eth()  { cast from-wei "$1" | awk '{ printf "%.4f", $1 }'; }
# Integer arithmetic on wei values (arbitrary precision).
calc()     { echo "$*" | bc; }
lt()       { [[ "$(calc "$1 < $2")" == "1" ]]; }

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

lower() { echo "${1,,}"; }

is_addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }

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

log "Funder:            ${FUNDER_ADDRESS}"
log "L1 chain ID:       ${L1_CHAIN_ID}"
log "Dry run:           ${DRY_RUN}"
log "Operator:          min ${OPERATOR_MIN_ETH} ETH, target ${OPERATOR_TARGET_ETH} ETH"
log "Watchdog L1:       min ${WATCHDOG_L1_MIN_ETH} ETH, target ${WATCHDOG_L1_TARGET_ETH} ETH"
log "Watchdog L2:       min ${WATCHDOG_L2_MIN_ETH} ETH, target ${WATCHDOG_L2_TARGET_ETH} ETH"
[[ -n "${ONLY_ECOSYSTEMS}" ]] && log "Only ecosystems:   ${ONLY_ECOSYSTEMS}"
[[ -n "${SKIP_CHAINS}" ]] && log "Skip chains:       ${SKIP_CHAINS}"

# ----------------------------------------------------------------------------
# Jarvis registry
# ----------------------------------------------------------------------------

JARVIS_TOKEN_DAYS_LEFT=""

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

# Ensures the funder can spend <wei> plus the gas reserve. Sets FUNDER_EXHAUSTED on failure.
funder_can_spend() {
  local need="$1" have
  have="$(funder_balance)" || { err "Failed to read the funder balance"; return 1; }
  if lt "${have}" "$(calc "${need} + ${FUNDER_GAS_RESERVE_WEI}")"; then
    FUNDER_EXHAUSTED=true
    err "Funder ${FUNDER_ADDRESS} holds $(fmt_eth "${have}") ETH, cannot spend $(fmt_eth "${need}") ETH; skipping remaining top-ups"
    return 1
  fi
}

# Records a funding failure: logs it, adds it to ERRORS and to the report details.
fund_failed() { err "$1"; FUND_RESULT="$1"; return 1; }

# send_tx <description> <cast send args...>; sets TX_HASH on success.
send_tx() {
  local what="$1" receipt status
  shift
  TX_HASH=""
  if ! receipt="$(cast send --json -r "${L1_RPC_URL}" --private-key "${FUNDER_PRIVATE_KEY}" --timeout 300 "$@" 2>&1)"; then
    fund_failed "${what}: cast send failed: $(tail -c 400 <<<"${receipt}")"
    return 1
  fi
  status="$(jq -r '.status // empty' <<<"${receipt}" 2>/dev/null || true)"
  TX_HASH="$(jq -r '.transactionHash // empty' <<<"${receipt}" 2>/dev/null || true)"
  if [[ "${status}" != "0x1" && "${status}" != "1" ]]; then
    fund_failed "${what}: transaction ${TX_HASH:-?} reverted (status ${status:-unknown})"
    return 1
  fi
}

# fund_l1 <to> <amount wei>; sets FUND_RESULT.
fund_l1() {
  local to="$1" amount="$2"
  FUND_RESULT=""
  funder_can_spend "${amount}" || { FUND_RESULT="funder exhausted"; return 1; }
  if is_true "${DRY_RUN}"; then
    FUND_RESULT="dry-run: would transfer $(fmt_eth "${amount}") ETH on L1"
    return 0
  fi
  send_tx "L1 transfer of $(fmt_eth "${amount}") ETH to ${to}" --value "${amount}" "${to}" || return 1
  FUND_RESULT="sent $(fmt_eth "${amount}") ETH, tx ${TX_HASH}"
}

# fund_l2 <bridgehub> <target chain id> <to> <amount wei>; sets FUND_RESULT.
fund_l2() {
  local bridgehub="$1" chain_id="$2" to="$3" amount="$4"
  local base_token gas_price buffered_gas_price base_cost mint_value
  FUND_RESULT=""

  base_token="$(l1_call "${bridgehub}" "baseToken(uint256)(address)" "${chain_id}")" || true
  if [[ "$(lower "${base_token:-}")" != "${ETH_TOKEN_ADDRESS}" ]]; then
    fund_failed "Chain ${chain_id} uses base token ${base_token:-unknown}; only ETH-based chains can be topped up (address ${to} needs $(fmt_eth "${amount}") of base token)"
    return 1
  fi

  gas_price="$(timeout "${RPC_TIMEOUT}" cast gas-price -r "${L1_RPC_URL}")" || { fund_failed "Failed to fetch the L1 gas price"; return 1; }
  buffered_gas_price="$(calc "${gas_price} * (100 + ${GAS_PRICE_BUFFER_PERCENT}) / 100")"
  base_cost="$(l1_call "${bridgehub}" "l2TransactionBaseCost(uint256,uint256,uint256,uint256)(uint256)" \
    "${chain_id}" "${buffered_gas_price}" "${L2_GAS_LIMIT}" "${L2_GAS_PER_PUBDATA}")" || true
  [[ "${base_cost}" =~ ^[0-9]+$ ]] || { fund_failed "Failed to compute l2TransactionBaseCost for chain ${chain_id}"; return 1; }
  mint_value="$(calc "${amount} + ${base_cost}")"

  funder_can_spend "${mint_value}" || { FUND_RESULT="funder exhausted"; return 1; }
  if is_true "${DRY_RUN}"; then
    FUND_RESULT="dry-run: would deposit $(fmt_eth "${amount}") ETH via ${bridgehub} (mintValue $(fmt_eth "${mint_value}") ETH incl. L2 gas)"
    return 0
  fi
  # The max fee is pinned to the gas price used for the base cost, so tx.gasprice on
  # L1 can never exceed it and mintValue always covers l2Value + L2 gas.
  send_tx "Deposit of $(fmt_eth "${amount}") ETH to ${to} on chain ${chain_id}" \
    --gas-price "${buffered_gas_price}" --value "${mint_value}" "${bridgehub}" "${REQUEST_SIG}" \
    "(${chain_id},${mint_value},${to},${amount},0x,${L2_GAS_LIMIT},${L2_GAS_PER_PUBDATA},[],${to})" || return 1
  FUND_RESULT="deposited $(fmt_eth "${amount}") ETH (mintValue $(fmt_eth "${mint_value}") ETH), tx ${TX_HASH}"
}

# ----------------------------------------------------------------------------
# Targets
# ----------------------------------------------------------------------------

# ensure_balance <chain> <label> <address> <target chain id> <balance wei|""> <min wei> <target wei> <bridgehub>
ensure_balance() {
  local chain="$1" label="$2" addr="$3" target_chain="$4" balance="$5" min="$6" target="$7" bridgehub="$8"
  local key need

  [[ "${min}" == "0" ]] && return 0

  if ! is_addr "${addr}"; then
    report "${chain}" "${label}" "${addr:-?}" "${target_chain}" "-" "${min}" "skipped" "no address"
    return 0
  fi

  key="${target_chain}:$(lower "${addr}")"
  if [[ -n "${SEEN_TARGETS[${key}]:-}" ]]; then
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
    report "${chain}" "${label}" "${addr}" "${target_chain}" "${balance}" "${min}" "ok" ""
    return 0
  fi

  need="$(calc "${target} - ${balance}")"
  log "${chain}/${label}: ${addr} on chain ${target_chain} has $(fmt_eth "${balance}") ETH < $(fmt_eth "${min}") ETH, topping up by $(fmt_eth "${need}") ETH"

  if is_true "${FUNDER_EXHAUSTED}"; then
    report "${chain}" "${label}" "${addr}" "${target_chain}" "${balance}" "${min}" "error" "funder exhausted"
    return 0
  fi

  if [[ "${target_chain}" == "${L1_CHAIN_ID}" ]]; then
    fund_l1 "${addr}" "${need}" || { report "${chain}" "${label}" "${addr}" "${target_chain}" "${balance}" "${min}" "error" "${FUND_RESULT}"; return 0; }
  else
    fund_l2 "${bridgehub}" "${target_chain}" "${addr}" "${need}" || { report "${chain}" "${label}" "${addr}" "${target_chain}" "${balance}" "${min}" "error" "${FUND_RESULT}"; return 0; }
  fi
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
  log "${chain} (${ecosystem}, chain ${chain_id}): bridgehub ${bridgehub}, settlement layer ${settlement_layer}"

  # Operators live on the settlement layer.
  if [[ "${settlement_layer}" == "${L1_CHAIN_ID}" ]]; then
    sl_rpc="${L1_RPC_URL}"
  else
    sl_rpc="$(l2_rpc_of "${ecosystem}" "${settlement_layer}")"
  fi
  for role_spec in "commit:${op_commit}:${cached_commit}" "prove:${op_prove}:${cached_prove}" "execute:${op_execute}:${cached_execute}"; do
    IFS=: read -r role op_addr cached_bal <<<"${role_spec}"
    bal=""
    if is_addr "${op_addr}"; then
      if [[ -n "${sl_rpc}" ]]; then
        bal="$(balance_at "${sl_rpc}" "${op_addr}")" || bal=""
      fi
      [[ "${bal}" =~ ^[0-9]+$ ]] || bal="${cached_bal}"
    fi
    ensure_balance "${chain}" "${role} operator" "${op_addr}" "${settlement_layer}" "${bal}" \
      "${OPERATOR_MIN_WEI}" "${OPERATOR_TARGET_WEI}" "${bridgehub}"
  done

  # Watchdog on L1 and L2.
  if is_addr "${watchdog}"; then
    bal="$(balance_at "${L1_RPC_URL}" "${watchdog}")" || bal=""
    ensure_balance "${chain}" "watchdog L1" "${watchdog}" "${L1_CHAIN_ID}" "${bal}" \
      "${WATCHDOG_L1_MIN_WEI}" "${WATCHDOG_L1_TARGET_WEI}" "${bridgehub}"

    bal=""
    if [[ -n "${l2_rpc}" ]]; then
      bal="$(balance_at "${l2_rpc}" "${watchdog}")" || bal=""
    fi
    if [[ ! "${bal}" =~ ^[0-9]+$ ]]; then
      [[ -n "${cached_wd_l2}" ]] && log "${chain}: L2 RPC unavailable, using the Jarvis cached watchdog balance"
      bal="${cached_wd_l2}"
    fi
    ensure_balance "${chain}" "watchdog L2" "${watchdog}" "${chain_id}" "${bal}" \
      "${WATCHDOG_L2_MIN_WEI}" "${WATCHDOG_L2_TARGET_WEI}" "${bridgehub}"
  else
    log "${chain}: no watchdog address in Jarvis"
  fi
done < "${CANDIDATES}"

[[ "${processed}" -gt 0 ]] || err "No Sepolia-based chains found in the Jarvis registry; check the registry and filters"

# ----------------------------------------------------------------------------
# Funder health and token lifetime (checked last so top-ups always run first)
# ----------------------------------------------------------------------------

funder_final="$(funder_balance)" || funder_final=""
if [[ "${funder_final}" =~ ^[0-9]+$ ]]; then
  log "Funder balance:    $(fmt_eth "${funder_final}") ETH"
  if lt "${funder_final}" "${FUNDER_MIN_WEI}"; then
    err "Funder ${FUNDER_ADDRESS} holds $(fmt_eth "${funder_final}") ETH, below the ${FUNDER_MIN_ETH} ETH minimum; please refill it"
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
  echo "Funder \`${FUNDER_ADDRESS}\`: $( [[ "${funder_final}" =~ ^[0-9]+$ ]] && fmt_eth "${funder_final}" || echo "?" ) ETH"
  is_true "${DRY_RUN}" && echo "" && echo "**Dry run: no transactions were sent.**"
  [[ -n "${JARVIS_TOKEN_DAYS_LEFT}" ]] && echo "" && echo "Jarvis token expires in ${JARVIS_TOKEN_DAYS_LEFT} day(s)."
  echo
  echo "| Chain | Target | Address | Chain ID | Balance | Min | Action | Details |"
  echo "|---|---|---|---|---|---|---|---|"
  printf '%s\n' "${REPORT_ROWS[@]}"
  echo
  echo "Balances are in ETH, or in the chain's base token for L2 targets of custom-base-token chains."
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
