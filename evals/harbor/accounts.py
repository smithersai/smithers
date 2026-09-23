"""Round-robin over logged-in Codex subscriptions, one account per trial.

A benchmark spends more than one subscription's usage limit, so trials are
spread across every Codex login the host holds: `~/.codex/auth.json` (label
`default`) and `~/.smithers/accounts/codex-*/auth.json` (label = the directory
name). An account that hits its usage limit is taken out of the rotation and
the reason is recorded; nothing is retried on another account, so a trial that
lost its seat stays a recorded failure rather than a faked result.

The rotation state is one JSON file shared by every runner process on the host
(`SMITHERS_CODEX_POOL_STATE`, default `~/.smithers/accounts/pool.json`),
updated under an exclusive `flock`, so two Harbor jobs (one per arm) draw from
the same wheel. New `codex-*` directories are picked up on the next lease.
"""

from __future__ import annotations

import fcntl
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

STATE_VARIABLE = "SMITHERS_CODEX_POOL_STATE"
DEFAULT_LABEL = "default"
USAGE_LIMIT_SIGNAL = (
    "usage_limit_reached",
    "usage limit",
    "usage_not_included",
    "hit your usage limit",
    "reached your usage limit",
    "quota_exceeded",
    "insufficient_quota",
)


@dataclass(frozen=True)
class Account:
    label: str
    home: Path

    @property
    def auth(self) -> Path:
        return self.home / "auth.json"


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


class Pool:
    """The shared wheel. `lease()` hands out the next enabled account;
    `disable()` takes one out with a reason."""

    def __init__(self, accounts: list[Account], state_path: Path):
        self.accounts = accounts
        self.state_path = state_path

    @classmethod
    def from_environment(cls, environ: dict[str, str] | None = None) -> "Pool":
        environ = os.environ if environ is None else environ
        state = Path(environ.get(STATE_VARIABLE) or Path.home() / ".smithers" / "accounts" / "pool.json")
        return cls(discover(), state)

    def _load(self) -> dict:
        try:
            return json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            return {}

    def _locked(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        lock = open(self.state_path.with_suffix(".lock"), "a+")
        fcntl.flock(lock, fcntl.LOCK_EX)
        return lock

    def lease(self, trial: str = "") -> Account:
        """The next enabled account in rotation. Raises when none is left."""
        lock = self._locked()
        try:
            state = self._load()
            disabled = state.get("disabled", {})
            enabled = [a for a in self.accounts if a.label not in disabled]
            if not enabled:
                raise RuntimeError(f"no Codex account left in rotation: disabled={disabled}")
            cursor = int(state.get("cursor", 0))
            account = enabled[cursor % len(enabled)]
            state["cursor"] = cursor + 1
            leases = state.setdefault("leases", [])
            leases.append({"label": account.label, "trial": trial, "at": time.time()})
            del leases[:-500]
            self.state_path.write_text(json.dumps(state, indent=2))
            return account
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()

    def disable(self, label: str, reason: str) -> None:
        lock = self._locked()
        try:
            state = self._load()
            state.setdefault("disabled", {})[label] = {"reason": reason[:500], "at": time.time()}
            self.state_path.write_text(json.dumps(state, indent=2))
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()

    def disabled(self) -> dict:
        return self._load().get("disabled", {})
