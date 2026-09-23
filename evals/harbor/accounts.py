"""Round-robin over logged-in Codex subscriptions, one account per trial, and
the line between an infrastructure failure and a model failure.

A benchmark spends more than one subscription's usage limit, so trials are
spread across every Codex login the host holds: `~/.codex/auth.json` (label
`default`) and `~/.smithers/accounts/codex-*/auth.json` (label = the directory
name). An account that hits its usage limit is taken out of the rotation with
the reset time the message names, and comes back once that time has passed.

An infrastructure failure is never a score. A trial whose seat ran dry is
re-run on the next healthy account (`SeatExhausted` carries what happened);
one that hit a route, gateway or provider fault raises `ModelRouteError` so
the runner records an exception instead of a reward; and when no healthy
account is left the pool PAUSES: `lease()` waits (`SMITHERS_CODEX_POOL_WAIT_SEC`,
default six hours) for a reset or a new login before it raises `NoSeatLeft`,
so a job blocks instead of burning tasks.

The rotation state is one JSON file shared by every runner process on the host
(`SMITHERS_CODEX_POOL_STATE`, default `~/.smithers/accounts/pool.json`),
updated under an exclusive `flock`, so two Harbor jobs (one per arm) draw from
the same wheel. New `codex-*` directories are picked up on the next lease.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

STATE_VARIABLE = "SMITHERS_CODEX_POOL_STATE"
WAIT_VARIABLE = "SMITHERS_CODEX_POOL_WAIT_SEC"
DEFAULT_LABEL = "default"
DEFAULT_WAIT_SEC = 6 * 3600
POLL_SEC = 60
USAGE_LIMIT_SIGNAL = (
    "usage_limit_reached",
    "usage limit",
    "usage_not_included",
    "hit your usage limit",
    "reached your usage limit",
    "quota_exceeded",
    "insufficient_quota",
)
# Harness failure causes that are the infrastructure's, not the model's:
# `<code>: <message>` where the code is a ModelErrorCode
# (`packages/smithers/agent/model/src/ModelError.ts`) or the harness's own.
SEAT_CODES = ("quota_exceeded",)
INFRA_CODES = ("authentication", "no_route", "provider_internal", "transport", "call_timeout", "completion_unjudged")
_RESET_RE = re.compile(r"(?:try again|resets?|available again)\s+(?:at|on|after)\s+([A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4},? \d{1,2}:\d{2}\s*[AP]M(?: [A-Z]{2,4})?)", re.I)
_RESET_ISO_RE = re.compile(r"(?:resets?_at|reset_at|try again after)\W+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)", re.I)


@dataclass(frozen=True)
class Account:
    label: str
    home: Path

    @property
    def auth(self) -> Path:
        return self.home / "auth.json"


class SeatExhausted(Exception):
    """The account serving a trial hit its usage limit; the trial's work is
    not the model's failure and must be re-run on another account."""

    def __init__(self, label: str, reason: str, reset_at: str | None = None):
        super().__init__(f"{label}: {reason}" + (f" (resets {reset_at})" if reset_at else ""))
        self.label = label
        self.reason = reason
        self.reset_at = reset_at


class ModelRouteError(Exception):
    """The route to the model failed (auth, gateway, provider, transport):
    an infrastructure fault the runner records as an exception, never a 0."""

    def __init__(self, cause: str):
        super().__init__(cause[:500])
        self.cause = cause


class ContainerUnreachable(Exception):
    """The agent never ran a command inside the task container with exit 0:
    the trial measured the transport, not the model. Retried, never scored."""


class NoSeatLeft(Exception):
    """Every account is out of rotation and the pause wait ran out."""


def discover(home: Path | None = None, accounts_dir: Path | None = None) -> list[Account]:
    """Every Codex login on the host, `default` first, then `codex-*` sorted."""
    home = home or Path.home()
    accounts_dir = accounts_dir or home / ".smithers" / "accounts"
    found: list[Account] = []
    default = Account(DEFAULT_LABEL, home / ".codex")
    if default.auth.is_file():
        found.append(default)
    if accounts_dir.is_dir():
        for entry in sorted(accounts_dir.iterdir()):
            if entry.name.startswith("codex-") and (entry / "auth.json").is_file():
                found.append(Account(entry.name, entry))
    return found


def mentions_usage_limit(text: str) -> bool:
    lowered = text.lower()
    return any(signal in lowered for signal in USAGE_LIMIT_SIGNAL)


def reset_time_of(text: str) -> str | None:
    """The reset time a usage-limit message names, as ISO 8601 UTC, when it
    names one ("try again at Sep 27th, 2026 9:27 AM", "resets_at 2026-…")."""
    m = _RESET_ISO_RE.search(text)
    if m:
        try:
            return datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(timespec="minutes")
        except ValueError:
            return None
    m = _RESET_RE.search(text)
    if not m:
        return None
    raw = re.sub(r"(\d)(st|nd|rd|th)", r"\1", m.group(1)).replace(".", "").replace(",", "")
    raw = re.sub(r"(?<=[AP]M)\s+[A-Z]{2,4}$", "", raw, flags=re.I)  # a trailing zone name
    for fmt in ("%b %d %Y %I:%M %p", "%B %d %Y %I:%M %p"):
        try:
            # The CLI prints the local time of the host it ran on.
            local = datetime.strptime(raw, fmt).astimezone()
            return local.astimezone(timezone.utc).isoformat(timespec="minutes")
        except ValueError:
            continue
    return None


def classify_cause(cause: str | None) -> str | None:
    """`seat` for a usage limit, `infra` for a route/gateway/provider fault,
    None when the failure is the model's own (or there is none)."""
    if not cause:
        return None
    head = cause.strip().split("\n", 1)[0]
    code = head.split(":", 1)[0].strip().lower()
    if code in SEAT_CODES or mentions_usage_limit(head):
        return "seat"
    if code == "rate_limited":
        # A transient 429 the harness gave up on is still not the model's.
        return "infra"
    if code in INFRA_CODES:
        return "infra"
    return None


class Pool:
    """The shared wheel. `lease()` hands out the next healthy account, waiting
    while none is; `disable()` takes one out with a reason and a reset time."""

    def __init__(self, accounts: list[Account], state_path: Path, *, wait_sec: float = DEFAULT_WAIT_SEC,
                 clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep,
                 rediscover: Callable[[], list[Account]] | None = None):
        self.accounts = accounts
        self.state_path = state_path
        self.wait_sec = wait_sec
        self.clock = clock
        self.sleep = sleep
        self.rediscover = rediscover

    @classmethod
    def from_environment(cls, environ: dict[str, str] | None = None) -> "Pool":
        environ = os.environ if environ is None else environ
        state = Path(environ.get(STATE_VARIABLE) or Path.home() / ".smithers" / "accounts" / "pool.json")
        wait = float(environ.get(WAIT_VARIABLE) or DEFAULT_WAIT_SEC)
        return cls(discover(), state, wait_sec=wait, rediscover=discover)

    def _load(self) -> dict:
        try:
            return json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            return {}

    def _save(self, state: dict) -> None:
        self.state_path.write_text(json.dumps(state, indent=2))

    def _locked(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        lock = open(self.state_path.with_suffix(".lock"), "a+")
        fcntl.flock(lock, fcntl.LOCK_EX)
        return lock

    def _enabled(self, state: dict) -> list[Account]:
        """Accounts in rotation, after re-admitting those whose reset passed."""
        disabled = state.get("disabled", {})
        now = self.clock()
        for label, info in list(disabled.items()):
            reset = info.get("resetAt")
            if reset:
                try:
                    at = datetime.fromisoformat(reset).timestamp()
                except ValueError:
                    continue
                if at <= now:
                    state.setdefault("reenabled", []).append({"label": label, "at": now, "resetAt": reset})
                    del disabled[label]
        if self.rediscover is not None:
            self.accounts = self.rediscover()
        return [a for a in self.accounts if a.label not in disabled]

    def _try_lease(self, trial: str) -> Account | None:
        lock = self._locked()
        try:
            state = self._load()
            enabled = self._enabled(state)
            if not enabled:
                state["paused"] = {"since": state.get("paused", {}).get("since", self.clock()),
                                   "disabled": state.get("disabled", {})}
                self._save(state)
                return None
            state.pop("paused", None)
            cursor = int(state.get("cursor", 0))
            account = enabled[cursor % len(enabled)]
            state["cursor"] = cursor + 1
            leases = state.setdefault("leases", [])
            leases.append({"label": account.label, "trial": trial, "at": self.clock()})
            del leases[:-500]
            self._save(state)
            return account
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()

    def lease(self, trial: str = "") -> Account:
        """The next healthy account. With none left the pool is paused and
        this waits for a reset or a new login; after `wait_sec` it raises."""
        deadline = self.clock() + self.wait_sec
        while True:
            account = self._try_lease(trial)
            if account is not None:
                return account
            if self.clock() >= deadline:
                raise NoSeatLeft(f"no Codex account in rotation for {self.wait_sec:.0f}s: {self.disabled()}")
            self.sleep(POLL_SEC)

    def disable(self, label: str, reason: str, reset_at: str | None = None) -> None:
        lock = self._locked()
        try:
            state = self._load()
            state.setdefault("disabled", {})[label] = {"reason": reason[:500], "at": self.clock(), "resetAt": reset_at}
            self._save(state)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()

    def enable(self, label: str) -> None:
        lock = self._locked()
        try:
            state = self._load()
            state.get("disabled", {}).pop(label, None)
            self._save(state)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()

    def disabled(self) -> dict:
        return self._load().get("disabled", {})

    def paused(self) -> dict | None:
        return self._load().get("paused")
