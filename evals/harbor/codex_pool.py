"""Harbor's stock Codex CLI agent, drawing one Codex login per trial.

    harbor run … -a evals.harbor.codex_pool:PooledCodex -m openai/gpt-6-sol \
        --ak version=0.155.1 --ak reasoning_effort=max

Harbor's `codex` agent takes one `auth.json` for the whole job
(`CODEX_FORCE_AUTH_JSON` / `CODEX_AUTH_JSON_PATH`). This subclass leases the
next account from `accounts.Pool` for each trial instead, records the label
(never the email) beside the trial's logs, and after the run takes the account
out of rotation when the CLI's output reports a usage limit. Everything else
is Harbor's Codex agent unchanged.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from harbor.agents.installed.codex import Codex
from harbor.models.agent.context import AgentContext

from . import accounts

ACCOUNT_FILE = "codex-account.json"


class PooledCodex(Codex):
    def __init__(self, logs_dir: Path, model_name: str | None = None, **kwargs: Any) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self._pool = accounts.Pool.from_environment()
        self._account: accounts.Account | None = None

    @staticmethod
    def name() -> str:
        return "codex"

    def _resolve_auth_json_path(self) -> Path | None:
        if self._account is None:
            self._account = self._pool.lease(trial=self.logs_dir.parent.name)
            (self.logs_dir / ACCOUNT_FILE).write_text(json.dumps({"account": self._account.label}, indent=2))
        return self._account.auth

    async def run(self, instruction: str, environment, context: AgentContext) -> None:
        try:
            await super().run(instruction, environment, context)
        finally:
            self._settle()
            if self._account is not None:
                context.metadata = {**(context.metadata or {}), "account": self._account.label}

    def _settle(self) -> None:
        """Take the account out of rotation when the CLI reported a usage limit."""
        if self._account is None:
            return
        record: dict[str, Any] = {"account": self._account.label}
        output = self.logs_dir / self._OUTPUT_FILENAME
        try:
            text = output.read_text(errors="replace")
        except OSError:
            text = ""
        if accounts.mentions_usage_limit(text):
            line = next((l for l in text.splitlines() if accounts.mentions_usage_limit(l)), "usage limit")
            self._pool.disable(self._account.label, line.strip())
            record["usageLimit"] = line.strip()[:500]
        (self.logs_dir / ACCOUNT_FILE).write_text(json.dumps(record, indent=2))
