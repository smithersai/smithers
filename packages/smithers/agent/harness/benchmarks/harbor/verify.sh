#!/bin/bash
# Verifies the Harbor adapter without docker, a model, or a runner install.
#
#   pnpm exec smthrs test //packages/smithers/agent/harness/benchmarks/harbor:offline
#
# `fixtures/check_infra.py` pins crash containment, the infra classification,
# the slot ledger and the verifier handover. `fixtures/check_agent.py` pins the prompt, the environment the CLI is given,
# the worker flow, the CLI's one `up` process and its cancellation, the journal fold, the trajectory and the names. `fixtures/check_budget.py`
# pins the run's time budget to the task's own agent timeout, and its effort.
# `fixtures/check_calls.py` pins that every model call is a row, that totals by
# purpose sum to the run's ledger, the time split, the Codex session fold and
# the fit. Set HARBOR_PYTHON to the
# interpreter of a Harbor install to also validate the trajectory against
# Harbor's own ATIF model; without it the check is structural and says so.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"
PY="${HARBOR_PYTHON:-python3}"
"$PY" "$S/fixtures/check_agent.py"
"$PY" "$S/fixtures/check_codex_pool.py"
"$PY" "$S/fixtures/check_harbor_exec.py"
"$PY" "$S/fixtures/check_calls.py"
"$PY" "$S/fixtures/check_budget.py"
"$PY" "$S/fixtures/check_infra.py"
"$PY" "$S/fixtures/check_ownership.py"
"$PY" "$S/fixtures/check_tb4_resources.py"
"$PY" "$S/fixtures/check_health.py"
"$PY" "$S/fixtures/check_report.py"
"$PY" "$S/fixtures/check_seal.py"
