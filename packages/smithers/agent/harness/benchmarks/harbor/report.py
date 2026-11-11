#!/usr/bin/env python3
"""The publishable report of a paired Harbor run: the Smithers harness against
a tool-call baseline on the same tasks.

    python3 report.py <smithers-job> <baseline-job> <out-dir> [--min-tasks 50]

Reads two finished Harbor job directories and writes `<out-dir>/report.md`
and `<out-dir>/report.json`. Exits 0 when the run is publishable and 3 when
it is not; a refused report lists every reason and carries no pass rates.

A run is publishable only when all of these hold:

- Both jobs ran the same dataset and ref, model, environment and attempts,
  with no timeout or resource overrides. A job that names no environment ran
  the runner's default (`DEFAULT_ENVIRONMENT`); each of its trials must
  record that default.
- No current trial in either job is running or infrastructure (`outcome.py`):
  those are re-run, never scored. Run `requeue.py` and `harbor jobs resume`.
- Every trial ran the agent, model and environment its job names; every
  task is the same task in both arms (`task_checksum`); and every paired task
  has exactly the planned number of scored attempts in both arms.
- At least `--min-tasks` tasks are paired. A task either arm could not place
  (`PlueUnplaceable`) leaves both arms and is listed.
- Every scored trial reports input, cached and output tokens.
- No scored trial carries `requeues` in its metadata: harness revisions
  before #4798 re-ran a usage-limited attempt in the container the first
  attempt had changed and reported only the last attempt's tokens.
- Every scored trial is sealed: no mounts, no extra allowed hosts beyond the
  stock arm's model route (`seal.ALLOWED_HOSTS`), at least one command
  exited 0 in the task container, and for the Smithers arm the host-call
  audit (`audit_host_calls.py`) is `clean`. On a task that denies the agent
  network (`no-network` or `allowlist`), or whose network cannot be read,
  the stock arm's denied-connect seal must also hold. The report judges it
  again from the probe attempts the trial saved, by the current `seal.py`
  rules, and never trusts the stored `sealed`: missing or unreadable attempts,
  or a missing or non-zero count of web searches, unseal. It counts, per arm,
  the trials whose verdict differs from the stored one. On a public
  task such as Terminal-Bench 4.0 both arms' containers reach the internet by
  the suite's protocol, and the seal is not required.

The pass rate is the mean reward over every scored trial of the paired tasks.
Attempts per task are equal, so it is also the mean of the per-task means.
The report reads the two job directories and each trial's `task.toml` at
the task path its config records: running it twice over the same files writes
the same bytes.

Beside the scores, and in a refused report too, `comparison` says where each
arm's time and tokens went, per paired task and overall: model calls, seconds
per call, cache share, the wall clock split into model wait, commands, judge,
compaction and the rest, tokens by purpose, and the least-squares fit of call
seconds on thinking and written tokens, whole and by stage. It is read from
each scored trial's own record (`calls.py`) and changes no score.
"""
from __future__ import annotations

import json
import sys
import tomllib
from datetime import datetime
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import audit_host_calls  # noqa: E402
import calls  # noqa: E402
import outcome  # noqa: E402
from seal import ALLOWED_HOSTS as MODEL_ROUTE, MARK as PROBE_MARK, verdict as probe_verdict  # noqa: E402

MIN_TASKS = 50
ARMS = ("smithers", "baseline")
SMITHERS_AGENT = "packages.smithers.agent.harness.benchmarks.harbor.smithers_agent:SmithersAgent"
TOKENS = ("n_input_tokens", "n_cache_tokens", "n_output_tokens")
# The environment Harbor 0.23.0 and Pier 0.3.1 run when a job names none
# (`EnvironmentConfig.set_default_type`). Harbor then leaves `environment` out
# of the job's config.json; its trials record the default. check_report.py
# compares this with each installed runner's own default.
DEFAULT_ENVIRONMENT = "docker"
# Trial config fields that must stay at Harbor's defaults: each one changes
# what a task is allowed, so a run that set one is not the benchmark.
OVERRIDES = {
    "": ("timeout_multiplier", "agent_timeout_multiplier", "verifier_timeout_multiplier",
         "agent_setup_timeout_multiplier", "environment_build_timeout_multiplier"),
    "agent": ("override_timeout_sec", "override_setup_timeout_sec", "max_timeout_sec"),
    "environment": ("override_cpus", "override_memory_mb", "override_storage_mb", "override_gpus", "override_tpu"),
    "verifier": ("override_timeout_sec", "max_timeout_sec"),
}


def _load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _is_count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def overrides(config: dict) -> list[str]:
    """`section.field=value` for every override a trial config sets."""
    found = []
    for section, fields in OVERRIDES.items():
        values = (config.get(section) or {}) if section else config
        for name in fields:
            value = values.get(name)
            if value is None or (name == "timeout_multiplier" and value == 1.0):
                continue
            found.append(f"{section + '.' if section else ''}{name}={value}")
    return found


def agent_network(config: dict) -> str:
    """The network a trial's task gives its agent: `public`, `no-network`,
    `allowlist`, or `unknown` when the task's `task.toml` cannot be read.

    Harbor 0.23.0 and Pier 0.3.1 resolve it alike: `[agent] network_mode`,
    else `[environment] network_mode`, else the legacy `[environment]
    allow_internet` (absent: public). Both record the task directory as
    `task.path` in the trial's config; a registry or git task has no local
    path here. A Harbor task with steps denies network when any step does."""
    task = config.get("task") or {}
    if not task.get("path") or task.get("git_url") or task.get("name"):
        return "unknown"
    try:
        document = tomllib.loads((Path(task["path"]) / "task.toml").read_text())
    except (OSError, ValueError):
        return "unknown"
    environment = document.get("environment") or {}
    baseline = environment.get("network_mode") or ("no-network" if environment.get("allow_internet") is False else "public")
    agent = (document.get("agent") or {}).get("network_mode") or baseline
    phases = [(step.get("agent") or {}).get("network_mode") or agent for step in document.get("steps") or []] or [agent]
    denied = [str(mode) for mode in phases if mode != "public"]
    return denied[0] if denied else "public"


def stock_seal(trial: Path, result: dict) -> dict:
    """The stock arm's seal judged again from the probe attempts its trial
    saved (`seal` in `agent/codex-account.json` or the result's metadata), by
    the current `seal.py` rules: `{stored, sealed, reason}`. A verdict stored
    before a rule changed (curl 35, #3863) is not trusted; `stored` only says
    whether the two differ."""
    metadata = (result.get("agent_result") or {}).get("metadata") or {}
    record = _load(trial / "agent" / "codex-account.json")
    stored = metadata.get("sealed", record.get("sealed"))
    judged = {"stored": stored if isinstance(stored, bool) else None, "sealed": False}
    saved = metadata.get("seal") or record.get("seal")
    attempts = saved.get("attempts") if isinstance(saved, dict) else None
    if not attempts:
        return {**judged, "reason": "no saved seal attempts"}
    try:
        lines = [f"{PROBE_MARK} {a['kind']} {a['url']} {int(a['curl'])} {int(a['http'])} {int(a['proxy'])}"
                 for a in attempts]
    except (TypeError, KeyError, ValueError):
        return {**judged, "reason": "the saved seal attempts are unreadable"}
    proof = probe_verdict("\n".join(lines))
    reasons = [] if proof["sealed"] else [proof["reason"]]
    searches = saved.get("webSearches")
    if not _is_count(searches):
        reasons.append("no saved count of web searches")
    elif searches:
        reasons.append(f"the CLI ran {searches} web search(es) outside the task container")
    return {**judged, "sealed": not reasons, "reason": "; ".join(reasons) or None}


def seal(trial: Path, config: dict, result: dict, smithers: bool, network: str, proof: dict | None) -> list[str]:
    """Why a trial is not sealed to its task container; empty when it is."""
    agent, environment = config.get("agent") or {}, config.get("environment") or {}
    broken = []
    for where, hosts in (("agent", agent.get("extra_allowed_hosts")), ("environment", environment.get("extra_allowed_hosts"))):
        # The stock CLI runs in the container and must reach its model; the
        # Smithers arm calls its model from the host.
        extra = [host for host in hosts or [] if smithers or where != "agent" or host not in MODEL_ROUTE]
        if extra:
            broken.append(f"{where} extra_allowed_hosts {extra}")
    if environment.get("mounts"):
        broken.append(f"environment mounts {environment['mounts']}")
    reached = ((result.get("agent_result") or {}).get("metadata") or {}).get("container_commands")
    for name in ("smithers-run.json", "codex-account.json"):
        reached = reached or _load(trial / "agent" / name).get("containerCommands")
    if not isinstance(reached, dict) or not reached.get("succeeded"):
        broken.append("no command exited 0 in the task container")
    if smithers:
        audit = audit_host_calls.audit_trial(trial, {})
        if audit["verdict"] != "clean":
            # The audit cannot read a call the journal kept only a digest of.
            # Saying so here saves opening the journal to learn why the trial
            # is unsealed.
            unknown = audit.get("unknownTargets") or 0
            why = "" if not unknown else (f" (target unknown for {unknown} call{'' if unknown == 1 else 's'}: "
                                          f"the journal truncated {'its' if unknown == 1 else 'their'} input)")
            broken.append(f"host-call audit {audit['verdict']}{why}")
    elif network != "public" and proof is not None and not proof["sealed"]:
        policy = ("the task's agent network is unknown (no readable task.toml at its recorded path)"
                  if network == "unknown" else f"the task denies the agent network ({network})")
        broken.append(f"{policy} and the stock arm's seal does not hold: {proof['reason']}")
    return broken


def agent_minutes(result: dict) -> float | None:
    """Minutes the runner timed the agent for: `agent_execution` in `result.json`."""
    stamps = result.get("agent_execution") or {}
    try:
        started, finished = (datetime.fromisoformat(str(stamps[name]).replace("Z", "+00:00"))
                             for name in ("started_at", "finished_at"))
    except (KeyError, ValueError):
        return None
    return (finished - started).total_seconds() / 60


def read_trials(job: Path, smithers: bool) -> list[dict]:
    rows = []
    for trial in sorted(job.iterdir()) if job.is_dir() else []:
        if not trial.is_dir() or not (trial / "config.json").is_file():
            continue
        result = _load(trial / "result.json")
        config = result.get("config") or _load(trial / "config.json")
        kind = outcome.classify(result)
        agent_result = result.get("agent_result") or {}
        tokens = {name: agent_result.get(name) for name in TOKENS}
        network = agent_network(config)
        healthy = outcome.is_healthy(kind)
        proof = stock_seal(trial, result) if healthy and not smithers else None
        rows.append({
            "trial": trial.name,
            "task": result.get("task_name") or audit_host_calls.task_name(trial),
            "checksum": result.get("task_checksum"),
            "kind": kind,
            "exception": (result.get("exception_info") or {}).get("exception_type"),
            "reward": ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward"),
            "tokens": tokens,
            "overrides": overrides(config),
            "identity": {"agent": agent_identity(config.get("agent") or {}),
                         "model": (config.get("agent") or {}).get("model_name"),
                         "kwargs": (config.get("agent") or {}).get("kwargs") or {},
                         "environment": environment_identity(config.get("environment") or {})},
            "network": network,
            "seal": seal(trial, config, result, smithers, network, proof) if healthy else [],
            # The stored verdict differs from the one judged again.
            "sealChanged": proof is not None and proof["stored"] is not None and proof["stored"] != proof["sealed"],
            "dir": trial,
            "minutes": agent_minutes(result),
            "startedAt": result.get("started_at"),
            "finishedAt": result.get("finished_at"),
            "harnessRevision": (agent_result.get("metadata") or {}).get("harness_revision"),
            "requeues": (agent_result.get("metadata") or {}).get("requeues"),
            "trajectory": f"{trial.name}/agent/trajectory.json" if (trial / "agent" / "trajectory.json").is_file() else None,
        })
    return rows


def agent_identity(agent: dict) -> str | None:
    """The class Harbor loads: `import_path` wins over `name`."""
    return agent.get("import_path") or agent.get("name")


def environment_identity(environment: dict) -> str | None:
    return environment.get("import_path") or environment.get("type")


def describe(job: Path) -> dict:
    config = _load(job / "config.json")
    agents = config.get("agents") or [{}]
    datasets = config.get("datasets") or [{}]
    dataset = datasets[0]
    environment = config.get("environment") or {}
    return {
        "job": job.name,
        "agent": agent_identity(agents[0]),
        "model": agents[0].get("model_name"),
        "kwargs": agents[0].get("kwargs") or {},
        "agents": len(agents),
        "dataset": f"{dataset.get('name') or dataset.get('path')}@{dataset.get('ref') or dataset.get('version')}",
        # Every field, so a version, path or filter difference also separates the arms.
        "datasetSpec": json.dumps(dataset, sort_keys=True),
        "datasets": len(datasets),
        "environment": environment_identity(environment) or DEFAULT_ENVIRONMENT,
        "environmentSpec": json.dumps(environment, sort_keys=True),
        "attempts": config.get("n_attempts", 1),
    }


def side(rows: list[dict]) -> dict:
    """One arm's cost over `rows`, its scored trials: the runner's agent minutes
    and its token columns weighted as every earlier report weighted them, then
    what the trials' own records say call by call (`calls.breakdown`)."""
    minutes = [row["minutes"] for row in rows if row["minutes"] is not None]
    weights = [calls.weighted(*(value if _is_count(value) else None for value in (row["tokens"][name] for name in TOKENS)))
               for row in rows]
    known = [value for value in weights if value is not None]
    return {
        "agentMinutes": round(sum(minutes), 2) if minutes else None,
        "weightedTokens": round(sum(known)) if known else None,
        **calls.breakdown([row["read"] for row in rows]),
    }


def compare(by_task: dict[str, dict[str, list[dict]]], paired: list[str]) -> dict | None:
    """Where time and tokens went, for each paired task and over all of them."""
    if not paired:
        return None
    for task in paired:
        for arm in ARMS:
            for row in by_task[task][arm]:
                row["read"] = calls.read_trial(row["dir"])
    return {
        "weights": calls.WEIGHTS,
        "arms": {arm: side([row for task in paired for row in by_task[task][arm]]) for arm in ARMS},
        "tasks": [{"task": task, **{arm: side(by_task[task][arm]) for arm in ARMS}} for task in paired],
    }


def build(smithers_job: Path, baseline_job: Path, min_tasks: int = MIN_TASKS) -> dict:
    arms = {"smithers": describe(smithers_job), "baseline": describe(baseline_job)}
    trials = {"smithers": read_trials(smithers_job, True), "baseline": read_trials(baseline_job, False)}
    refusals: list[str] = []

    for arm, job in (("smithers", smithers_job), ("baseline", baseline_job)):
        if not (job / "config.json").is_file():
            refusals.append(f"{arm}: {job} is not a Harbor job directory")
        planned = _load(job / "result.json").get("n_total_trials")
        if planned != len(trials[arm]):
            refusals.append(f"{arm}: {len(trials[arm])} trials retained; the job planned {planned}")
        if arms[arm]["agents"] != 1 or arms[arm]["datasets"] != 1:
            refusals.append(f"{arm}: the job must run one agent on one dataset")
    if arms["smithers"]["agent"] != SMITHERS_AGENT:
        refusals.append(f"smithers: agent is {arms['smithers']['agent']}, not {SMITHERS_AGENT}")
    if arms["baseline"]["agent"] == SMITHERS_AGENT:
        refusals.append("baseline: agent is the Smithers harness")
    for field in ("datasetSpec", "model", "environmentSpec", "attempts"):
        if arms["smithers"][field] != arms["baseline"][field]:
            refusals.append(f"arms differ in {field}: {arms['smithers'][field]} vs {arms['baseline'][field]}")
    for arm in arms:
        for field in ("agent", "model", "environment"):
            if not arms[arm][field]:
                refusals.append(f"{arm}: the job names no {field}")

    for arm, rows in trials.items():
        for row in rows:
            if row["kind"] in ("running", "infra"):
                refusals.append(f"{arm}: {row['trial']} is {row['kind']} ({row['exception'] or 'no exception'}); "
                                "re-run it before publishing")
            if row["overrides"]:
                refusals.append(f"{arm}: {row['trial']} overrides {', '.join(row['overrides'])}")
            declared = {"agent": arms[arm]["agent"], "model": arms[arm]["model"], "kwargs": arms[arm]["kwargs"],
                        "environment": arms[arm]["environment"]}
            for field, value in row["identity"].items():
                if value != declared[field]:
                    refusals.append(f"{arm}: {row['trial']} ran {field} {value}, not the job's {declared[field]}")

    unplaceable = sorted({r["task"] for rows in trials.values() for r in rows if r["kind"] == "unplaceable"})
    scored = {arm: [r for r in rows if outcome.is_healthy(r["kind"]) and r["task"] not in unplaceable]
              for arm, rows in trials.items()}
    by_task: dict[str, dict[str, list[dict]]] = {}
    for arm, rows in scored.items():
        for row in rows:
            by_task.setdefault(row["task"], {"smithers": [], "baseline": []})[arm].append(row)

    paired = []
    for task in sorted(by_task):
        runs = by_task[task]
        counts = {arm: len(runs[arm]) for arm in runs}
        if 0 in counts.values():
            missing = [arm for arm, n in counts.items() if n == 0][0]
            refusals.append(f"{task}: no scored trial in the {missing} arm")
            continue
        if set(counts.values()) != {arms["smithers"]["attempts"]}:
            refusals.append(f"{task}: {counts['smithers']} scored attempts in smithers, {counts['baseline']} in baseline; "
                            f"{arms['smithers']['attempts']} planned")
            continue
        checksums = {r["checksum"] for arm in runs for r in runs[arm]}
        if len(checksums) != 1 or None in checksums:
            refusals.append(f"{task}: task checksums differ across trials: {sorted(map(str, checksums))}")
            continue
        paired.append(task)

    if len(paired) < min_tasks:
        refusals.append(f"{len(paired)} paired tasks; {min_tasks} required")
    for arm, rows in scored.items():
        for row in rows:
            missing = [name for name, value in row["tokens"].items() if not _is_count(value)]
            if missing:
                refusals.append(f"{arm}: {row['trial']} reports no {', '.join(missing)}")
            for reason in row["seal"]:
                refusals.append(f"{arm}: {row['trial']} is not sealed: {reason}")
            if row["requeues"]:
                refusals.append(f"{arm}: {row['trial']} was re-run in place after a usage limit; "
                                "re-run it in a fresh environment before publishing")

    results = {}
    for arm in ("smithers", "baseline"):
        rows = [r for r in scored[arm] if r["task"] in paired]
        rewards = [float(r["reward"]) for r in rows]
        totals = {name: sum(r["tokens"][name] for r in rows if _is_count(r["tokens"][name])) for name in TOKENS}
        results[arm] = {
            "trials": len(rows),
            "solved": sum(1 for value in rewards if value == 1.0),
            "passRate": round(sum(rewards) / len(rewards), 4) if rewards else None,
            "tokens": {"input": totals["n_input_tokens"], "cached": totals["n_cache_tokens"],
                       "output": totals["n_output_tokens"]},
            "harnessRevisions": sorted({r["harnessRevision"] for r in rows if r["harnessRevision"]}),
        }
    stamps = sorted(s for rows in trials.values() for r in rows for s in (r["startedAt"], r["finishedAt"]) if s)
    # The agent network of every task either arm ran, as its task.toml declares it.
    policies: dict[str, set[str]] = {}
    for rows in trials.values():
        for row in rows:
            policies.setdefault(row["task"], set()).add(row["network"])
    network: dict[str, int] = {}
    for modes in policies.values():
        network["/".join(sorted(modes))] = network.get("/".join(sorted(modes)), 0) + 1
    return {
        "publishable": not refusals,
        "refusals": refusals,
        "minTasks": min_tasks,
        "arms": arms,
        "pairedTasks": len(paired),
        "results": results if not refusals else None,
        "comparison": compare(by_task, paired),
        "unplaceable": unplaceable,
        "network": dict(sorted(network.items())),
        "sealVerdictsChanged": {arm: sum(1 for row in rows if row["sealChanged"]) for arm, rows in trials.items()},
        "window": {"from": stamps[0], "to": stamps[-1]} if stamps else None,
        "tasks": [
            {"task": task, **{arm: {"rewards": [r["reward"] for r in by_task[task][arm]],
                                    "trials": [r["trial"] for r in by_task[task][arm]],
                                    "trajectories": [r["trajectory"] for r in by_task[task][arm]]}
                              for arm in ("smithers", "baseline")}}
            for task in paired
        ],
    }


def _percent(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _figure(value: Any, form: str = ",.0f", unit: str = "") -> str:
    return "n/a" if value is None else f"{value:{form}}{unit}"


def _scaled(value: Any, scale: float, form: str, unit: str = "") -> str:
    return "n/a" if value is None else f"{value / scale:{form}}{unit}"


# Each row of the comparison: its label, and how to read it off one side.
MEASURES = (
    ("Model calls", lambda side: _figure(side["modelCalls"])),
    ("Seconds per call", lambda side: _figure(side["secondsPerCall"], ",.1f")),
    ("Wait before a reply: median, least", lambda side: "n/a" if side["wait"] is None else
     f"{side['wait']['medianMs'] / 1000:,.1f} s, {side['wait']['leastMs'] / 1000:,.1f} s ({side['wait']['stage']})"),
    ("Cache share", lambda side: _scaled(side["cacheShare"], 0.01, ".1f", "%")),
    ("Thinking tokens", lambda side: _figure(side["thinkingTokens"])),
    ("Written tokens", lambda side: _figure(side["writtenTokens"])),
    ("Weighted tokens", lambda side: _scaled(side["weightedTokens"], 1e6, ",.2f", "M")),
    ("Agent minutes", lambda side: _figure(side["agentMinutes"], ",.1f")),
    ("Model wait", lambda side: _scaled(side["time"]["modelMs"], 1000, ",.1f", " s")),
    ("Commands", lambda side: _scaled(side["time"]["commandsMs"], 1000, ",.1f", " s")),
    ("Judge", lambda side: _scaled(side["time"]["judgeMs"], 1000, ",.1f", " s")),
    ("Compaction", lambda side: _scaled(side["time"]["compactionMs"], 1000, ",.1f", " s")),
    ("Other", lambda side: _scaled(side["time"]["otherMs"], 1000, ",.1f", " s")),
    ("Compactions", lambda side: _figure(side["compactions"])),
    ("Judge readings", lambda side: _figure(side["judgeReadings"])),
)
FIT = (
    ("Calls fitted", "calls", ",.0f"),
    ("Fixed seconds per call", "fixedSeconds", ",.1f"),
    ("Milliseconds per thinking token", "msPerThinkingToken", ",.1f"),
    ("Milliseconds per written token", "msPerWrittenToken", ",.1f"),
    ("R squared", "r2", ".2f"),
)
# The stage fit: its label, where it sits in `stageFit`, and how to print it.
STAGE_FIT = (
    ("Stage fit: calls", ("calls",), 1, ",.0f"),
    ("Stage fit: mean seconds to headers", ("meanHeadersMs",), 1000, ",.1f"),
    ("Stage fit: headers to first output, fixed seconds", ("thinking", "fixedMs"), 1000, ",.1f"),
    ("Stage fit: milliseconds per thinking token", ("thinking", "msPerThinkingToken"), 1, ",.1f"),
    ("Stage fit: R squared, thinking", ("thinking", "r2"), 1, ".2f"),
    ("Stage fit: first to last output, fixed seconds", ("written", "fixedMs"), 1000, ",.1f"),
    ("Stage fit: milliseconds per written token", ("written", "msPerWrittenToken"), 1, ",.1f"),
    ("Stage fit: R squared, written", ("written", "r2"), 1, ".2f"),
)
PER_TASK = ("Model calls", "Seconds per call", "Cache share", "Agent minutes", "Weighted tokens", "Model wait",
            "Commands", "Judge", "Compaction", "Other")


def _staged(side: dict, path: tuple[str, ...], scale: float, form: str) -> str:
    """One number of a side's stage fit, `n/a` where it has none."""
    value: Any = side.get("stageFit")
    for key in path:
        value = value.get(key) if isinstance(value, dict) else None
    return _scaled(value, scale, form)


def _caveats(arm: str, side: dict) -> list[str]:
    """What a reader must know before trusting one side's rows."""
    found = []
    if side["splitTrials"] != side["trials"]:
        found.append(f"- {arm}: the time split is recorded for {side['splitTrials']} of {side['trials']} trials.")
    time = side["time"]
    if time["recordedMs"]:
        found.append(f"- {arm}: {time['recordedMs'] / 1000:,.1f} s of the {time['spanMs'] / 1000:,.1f} s span is the "
                     "frames' own clocks" + (f"; from event times: {', '.join(time['derived'])}." if time["derived"] else "."))
    elif time["derived"]:
        found.append(f"- {arm}: the time split is from event times.")
    if side["stageFit"] is None:
        found.append(f"- {arm}: {calls.stage_fit_line(side)}.")
    if side["cellWork"]:
        found.append(f"- {arm}: model calls by what their cell did: " + ", ".join(
            f"{kind} {held['calls']:,} ({held['durationMs'] / 1000:,.1f} s)" for kind, held in side["cellWork"].items()) + ".")
    for purpose, total in side["byPurpose"].items():
        if total["unsplitTokens"]:
            found.append(f"- {arm}: {total['unsplitTokens']:,} {purpose} tokens are recorded as a sum, with no input, "
                         "cached or output count.")
        if total["tokenless"]:
            found.append(f"- {arm}: {total['tokenless']} {purpose} calls report no tokens and are in no total.")
    if side["ledgerTokens"] is not None and side["ledgerTokens"] != side["allPurposes"]["totalTokens"]:
        found.append(f"- {arm}: the runs' ledgers hold {side['ledgerTokens']:,} tokens and the rows "
                     f"{side['allPurposes']['totalTokens']:,}.")
    for purpose, entry in (side["ledgerByPurpose"] or {}).items():
        listed = side["byPurpose"].get(purpose, {}).get("totalTokens", 0)
        if entry["tokens"] != listed:
            found.append(f"- {arm}: the ledgers hold {entry['tokens']:,} {purpose} tokens and the rows {listed:,}.")
    if side["unlistedInputTokens"]:
        found.append(f"- {arm}: {side['unlistedInputTokens']:,} input tokens are in a trajectory total and in no row.")
    found += [f"- {arm}: {line}." for line in calls.stage_lines(side["stageMedians"])]
    session = side.get("session")
    if session:
        found.append(f"- {arm}: Codex CLI {', '.join(session['cliVersions']) or 'unrecorded'}; effort "
                     f"{', '.join(session['efforts']) or 'unrecorded'}; summary {', '.join(session['summaries']) or 'unrecorded'}.")
    return found


def render_comparison(report: dict) -> list[str]:
    comparison = report.get("comparison")
    if not comparison:
        return []
    arms = comparison["arms"]
    weights = comparison["weights"]
    lines = ["## Where time and tokens went", "", "| | Smithers | Baseline |", "| --- | --- | --- |"]
    lines += [f"| {label} | {read(arms['smithers'])} | {read(arms['baseline'])} |" for label, read in MEASURES]
    lines += [f"| {label} | {_figure((arms['smithers']['fit'] or {}).get(key), form)} | "
              f"{_figure((arms['baseline']['fit'] or {}).get(key), form)} |" for label, key, form in FIT]
    lines += [f"| {label} | {_staged(arms['smithers'], *where)} | {_staged(arms['baseline'], *where)} |"
              for label, *where in STAGE_FIT]
    lines += ["",
              f"- Model calls, seconds per call, cache share and the fit count each agent's own calls. Weighted tokens are "
              f"uncached input + {weights['cached']:g} x cached input + {weights['output']:g} x output of those calls.",
              "- The wait is from a call's start to the stage named: the wire's first stream event, the first event the "
              "harness saw, or the first item of the reply in the Codex log. That item is a message's start or a "
              "reasoning block's end, so it bounds the wait from above and the least is the closest reading.",
              "- The five times split each record's span and count a second once: a judge reading that ran under a "
              "model call is model wait. Where the harness timed a frame itself, Commands is the time its cell ran and "
              "Judge is what the loop waited on.",
              "- The fit is call seconds = fixed + thinking tokens x a + written tokens x b, by least squares.",
              "- The stage fit splits a call on the wire's own times: the mean wait for the response headers, then "
              "headers to first output = fixed + thinking tokens x a, then first to last output = fixed + written "
              "tokens x b."]
    lines += [line for arm, name in (("smithers", "Smithers"), ("baseline", "Baseline")) for line in _caveats(name, arms[arm])]
    lines += ["", "### Tokens by purpose", "", "Total is the rows; Ledger and Cost USD are the run's own usage ledger.", "",
              "| Arm | Purpose | Calls | Input | Cached | Output | Total | Ledger | Cost USD | Seconds |",
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for arm, name in (("smithers", "Smithers"), ("baseline", "Baseline")):
        ledger = arms[arm]["ledgerByPurpose"] or {}
        for purpose, total in arms[arm]["byPurpose"].items():
            entry = ledger.get(purpose) or {}
            lines.append(f"| {name} | {purpose} | {total['calls']:,} | {_figure(total['inputTokens'])} | "
                         f"{_figure(total['cachedTokens'])} | {_figure(total['outputTokens'])} | {total['totalTokens']:,} | "
                         f"{_figure(entry.get('tokens'))} | {_figure(entry.get('costUsd'), ',.6f')} | "
                         f"{total['durationMs'] / 1000:,.1f} |")
    measures = dict(MEASURES)
    lines += ["", "### Per task", "", "Smithers / baseline.", "", "| Task | " + " | ".join(PER_TASK) + " |",
              "| --- |" + " --- |" * len(PER_TASK)]
    for row in comparison["tasks"]:
        lines.append(f"| {row['task']} | " + " | ".join(
            f"{measures[label](row['smithers'])} / {measures[label](row['baseline'])}" for label in PER_TASK) + " |")
    lines += ["", "### Fit per task", "", "Smithers / baseline.", "", "| Task | " + " | ".join(label for label, _, _ in FIT) + " |",
              "| --- |" + " --- |" * len(FIT)]
    for row in comparison["tasks"]:
        lines.append(f"| {row['task']} | " + " | ".join(
            f"{_figure((row['smithers']['fit'] or {}).get(key), form)} / {_figure((row['baseline']['fit'] or {}).get(key), form)}"
            for _, key, form in FIT) + " |")
    if any(row["smithers"]["stageFit"] for row in comparison["tasks"]):
        lines += ["", "### Stage fit per task", "", f"Smithers. Baseline: {calls.stage_fit_line(arms['baseline'])}.", "",
                  "| Task | " + " | ".join(label.removeprefix("Stage fit: ").capitalize() for label, *_ in STAGE_FIT) + " |",
                  "| --- |" + " --- |" * len(STAGE_FIT)]
        for row in comparison["tasks"]:
            lines.append(f"| {row['task']} | " + " | ".join(_staged(row["smithers"], *where) for _, *where in STAGE_FIT) + " |")
    return lines + [""]


def _network(network: dict[str, int]) -> str:
    """`no-network (51 tasks), public (2 tasks)`."""
    return ", ".join(f"{mode} ({count} task{'' if count == 1 else 's'})" for mode, count in network.items()) or "no tasks"


def render(report: dict) -> str:
    arms = report["arms"]
    lines = [f"# {arms['smithers']['dataset']}: Smithers vs {arms['baseline']['agent']}", "",
             f"Agent network: {_network(report['network'])}.", ""]
    changed = report["sealVerdictsChanged"]
    if any(changed.values()):
        lines += ["Seal verdicts judged again from the saved attempts differ from the stored ones: "
                  f"{', '.join(f'{arm} {count}' for arm, count in changed.items())}.", ""]
    if not report["publishable"]:
        lines += ["**Not publishable.**", ""] + [f"- {reason}" for reason in report["refusals"]] + [""]
        return "\n".join(lines + render_comparison(report))
    lines += ["| Arm | Pass rate | Solved | Input tokens | Cached tokens | Output tokens |",
              "| --- | --- | --- | --- | --- | --- |"]
    for arm in ("smithers", "baseline"):
        result = report["results"][arm]
        tokens = result["tokens"]
        lines.append(f"| {arms[arm]['agent']} | {_percent(result['passRate'])} | {result['solved']} of {result['trials']} | "
                     f"{tokens['input']:,} | {tokens['cached']:,} | {tokens['output']:,} |")
    window = report["window"] or {}
    lines += ["", "## Method", "",
              f"- {report['pairedTasks']} paired tasks; attempts per task: {arms['smithers']['attempts']}.",
              f"- Model `{arms['smithers']['model']}`; environment `{arms['smithers']['environment']}`.",
              f"- Smithers `{arms['smithers']['agent']}` {json.dumps(arms['smithers']['kwargs'], sort_keys=True)}, "
              f"revisions {', '.join(report['results']['smithers']['harnessRevisions']) or 'unrecorded'}.",
              f"- Baseline `{arms['baseline']['agent']}` {json.dumps(arms['baseline']['kwargs'], sort_keys=True)}.",
              f"- Ran {window.get('from')} to {window.get('to')}.",
              "- Every scored trial ran its commands in the task container with no mounts and no extra allowed host "
              "but the stock arm's model route; the Smithers arm's host-call audit is clean for every trial.",
              "- On a task that denies the agent network the stock arm's denied-connect seal held; on a public task "
              "both arms' containers reach the internet, as the suite allows.",
              "- Pass rate is the mean verifier reward over every scored trial. Tokens are each agent's own count.",
              "", "## Limitations", ""]
    if report["unplaceable"]:
        lines.append(f"- {len(report['unplaceable'])} tasks could not be placed and are excluded from both arms: "
                     f"{', '.join(report['unplaceable'])}.")
    lines += ["- Infrastructure failures were re-run, not scored.",
              "- Subscription seats: token counts, no dollar cost.",
              "", "## Tasks", "", "| Task | Smithers | Baseline |", "| --- | --- | --- |"]
    for row in report["tasks"]:
        lines.append(f"| {row['task']} | {' '.join(str(r) for r in row['smithers']['rewards'])} | "
                     f"{' '.join(str(r) for r in row['baseline']['rewards'])} |")
    return "\n".join(lines + [""] + render_comparison(report))


def main(argv: list[str]) -> int:
    min_tasks = MIN_TASKS
    if "--min-tasks" in argv:
        at = argv.index("--min-tasks")
        min_tasks = int(argv[at + 1])
        argv = argv[:at] + argv[at + 2:]
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 64
    smithers_job, baseline_job, out = (Path(a) for a in argv)
    report = build(smithers_job, baseline_job, min_tasks)
    text = render(report)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    (out / "report.md").write_text(text)
    print(text, end="")
    return 0 if report["publishable"] else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
