"""Harbor's stock Codex CLI agent, drawing one Codex login per trial.

    harbor run … -a evals.harbor.codex_pool:PooledCodex -m openai/gpt-6-sol \
        --ak version=0.155.1 --ak reasoning_effort=max

Harbor's `codex` agent takes one `auth.json` for the whole job
(`CODEX_FORCE_AUTH_JSON` / `CODEX_AUTH_JSON_PATH`). This subclass leases the
next account from `accounts.Pool` for each trial instead, records the label
(never the email) beside the trial's logs, and applies the same policy as
`SmithersAgent`: a usage limit takes the account out of rotation and re-runs
the trial whole on the next healthy account (every re-run in `requeue.log`),
and when none is left the pool pauses and then raises, so a dry seat is never
scored. Everything else is Harbor's Codex agent unchanged.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from . import accounts

ACCOUNT_FILE = "codex-account.json"


def usage_limit_in(output: str) -> str | None:
    """The usage-limit line in the CLI's output, if any."""
    for line in output.splitlines():
        if accounts.mentions_usage_limit(line):
            return line.strip()[:500]
    return None


class PooledCodex(Codex):
    def __init__(self, logs_dir: Path, model_name: str | None = None, **kwargs: Any) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self._pool = accounts.Pool.from_environment()
        self._account: accounts.Account | None = None
        self._requeues: list[dict[str, Any]] = []

    @staticmethod
    def name() -> str:
        return "codex"

    async def setup(self, environment: BaseEnvironment) -> None:
        # Waits here while the pool is paused, before the CLI is installed.
        self._account = await asyncio.to_thread(self._pool.lease, self.logs_dir.parent.name)
        self._write_account()
        await super().setup(environment)

    def _write_account(self, **extra: Any) -> None:
        (self.logs_dir / ACCOUNT_FILE).write_text(json.dumps(
            {"account": self._account.label if self._account else None, "requeues": self._requeues, **extra}, indent=2))

    def _resolve_auth_json_path(self) -> Path | None:
        if self._account is None:
            raise RuntimeError("PooledCodex.run before setup: no account leased")
        return self._account.auth

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        attempt = 0
        while True:
            attempt += 1
            failure: BaseException | None = None
            try:
                await super().run(instruction, environment, context)
            except Exception as error:  # a dry seat may surface as a failed command
                failure = error
            output = self.logs_dir / self._OUTPUT_FILENAME
            try:
                text = output.read_text(errors="replace")
            except OSError:
                text = ""
            limit = usage_limit_in(text) or (usage_limit_in(str(failure)) if failure else None)
            if limit is None:
                if failure is not None:
                    raise failure
                break
            assert self._account is not None
            reset_at = accounts.reset_time_of(text)
            previous = self._account.label
            self._pool.disable(previous, limit, reset_at)
            if output.is_file():
                shutil.move(str(output), str(self.logs_dir / f"codex-attempt-{attempt}.txt"))
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            with (self.logs_dir / "requeue.log").open("a", encoding="utf-8") as log:
                log.write(f"{now} attempt {attempt} on {previous} ended in a usage limit (resets {reset_at or 'unknown'}): {limit}\n")
            self._account = await asyncio.to_thread(self._pool.lease, self.logs_dir.parent.name)
            self._requeues.append({"attempt": attempt, "from": previous, "to": self._account.label,
                                   "cause": limit, "resetAt": reset_at})
            self._write_account()
            with (self.logs_dir / "requeue.log").open("a", encoding="utf-8") as log:
                log.write(f"{now} requeued as attempt {attempt + 1} on {self._account.label}\n")
        self._write_account(attempt=attempt)
        context.metadata = {**(context.metadata or {}), "account": self._account.label if self._account else None,
                            "attempt": attempt, "requeues": self._requeues}
