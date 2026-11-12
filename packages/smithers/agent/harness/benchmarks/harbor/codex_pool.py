"""Harbor's stock Codex CLI agent, drawing one Codex login per trial.

    harbor run … -a packages.smithers.agent.harness.benchmarks.harbor.codex_pool:PooledCodex -m openai/gpt-6.1-sol \
        --ak version=0.155.1

The CLI is asked for `accounts.DEFAULT_EFFORT` (`xhigh`), the effort
`SmithersAgent` runs at, unless the run passes `--ak reasoning_effort=<effort>`:
left alone, Harbor's agent sends no effort and Pier's sends `high`. The
trial's metadata carries the effort asked for (`reasoning_effort`) and the
effort every turn of the session ran at (`efforts`).

Harbor's `codex` agent takes one `auth.json` for the whole job
(`CODEX_FORCE_AUTH_JSON` / `CODEX_AUTH_JSON_PATH`). This subclass leases the
next account from `accounts.Pool` for each trial instead, records the label
(never the email) beside the trial's logs, and applies the same policy as
`SmithersAgent`: a usage limit takes the account out of rotation and raises
`SeatExhausted`, so the runner re-runs the trial in a fresh environment on the
next healthy account, and when none is left the pool pauses and then raises,
so a dry seat is never scored. A task that names no user in an image whose `USER` is not root runs
as that image's uid, so the runner chowns `auth.json` to the CLI's user
(`image_uid`). Everything else is Harbor's Codex agent unchanged.

Under Pier the same class is Pier's Codex agent, and the task container is
sealed to the ChatGPT-subscription route:

    pier run … --agent-import-path packages.smithers.agent.harness.benchmarks.harbor.codex_pool:PooledCodex -m openai/gpt-6.1-sol \
        --ak version=0.155.1 --ak 'config_toml=web_search = "disabled"'

`network_allowlist()` hands Pier `seal.ALLOWED_HOSTS` and nothing else, and
every trial runs the denied-connect probe of `seal.py` in the task container
before the CLI starts. The verdict is `sealed` in `codex-account.json` and in
the trial's metadata. A web search in the CLI's transcript also reads
`sealed: false`: the model backend runs it outside the container.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import shlex
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

# The Codex agent of the runner that loaded this module. Pier ships Harbor as a
# dependency, so in Pier's install both import. Pier's trial runner
# (`pier.trial.execution`, loaded with its CLI) asks the agent for
# `install_spec()` and `network_allowlist()`; only Pier's agent answers.
if "pier.trial.execution" in sys.modules:
    from pier.agents.installed.codex import Codex  # type: ignore[import-not-found]
    from pier.environments.base import BaseEnvironment  # type: ignore[import-not-found]
    from pier.models.agent.context import AgentContext  # type: ignore[import-not-found]
else:
    from harbor.agents.installed.codex import Codex
    from harbor.environments.base import BaseEnvironment
    from harbor.models.agent.context import AgentContext

from . import accounts, seal

ACCOUNT_FILE = "codex-account.json"


# `codex exec --json` events that carry the CLI's own failure. Every other event (`item.*` above all) carries
# the task's text: a command's output or the model's words, which may say "usage limit" about anything.
FAILURE_EVENTS = ("error", "turn.failed")


def usage_limit_in(output: str) -> str | None:
    """Read limits from plain transcript lines or parsed CLI failure events.
    Malformed JSON and task events cannot establish account exhaustion."""
    for line in output.splitlines():
        text = line.strip()
        if text.startswith("{"):
            try:
                event = json.loads(text)
            except ValueError:
                continue
            if not isinstance(event, dict) or event.get("type") not in FAILURE_EVENTS:
                continue
        if accounts.mentions_usage_limit(text):
            return text[:500]
    return None


def completed_items(output: str) -> list[dict]:
    """The items of the CLI's `item.completed` events, in order."""
    items = []
    for line in output.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        item = event.get("item") if isinstance(event, dict) else None
        if isinstance(item, dict) and event.get("type") == "item.completed":
            items.append(item)
    return items


def container_commands(output: str) -> dict[str, int]:
    """Codex `command_execution` items the CLI completed inside the task
    container, and how many exited 0. The CLI runs in the container, so every
    command it ran is a container command."""
    commands = [item for item in completed_items(output) if item.get("type") == "command_execution"]
    return {"attempted": len(commands), "succeeded": sum(1 for item in commands if item.get("exit_code") == 0)}


def web_searches(output: str) -> int:
    """Web searches the CLI completed. The model backend runs them, so they
    reach the internet whatever the task container's network is."""
    return sum(1 for item in completed_items(output) if item.get("type") == "web_search")


async def image_uid(environment: BaseEnvironment) -> int | None:
    """The uid the task image runs commands as, when the trial names no user
    and that uid is not root; None otherwise.

    Harbor and Pier upload `auth.json` as root with mode 0600 and chown it
    only when `default_user` is set. A task that names no `[agent] user` in
    an image whose `USER` is not root (TB4 rs-archive-clone: `agent`,
    risk-scorer-replay: `nobody`) leaves the CLI unable to read it, so it
    falls back to api.openai.com and fails authentication (#3862)."""
    if getattr(environment, "default_user", None) is not None:
        return None
    try:
        result = await environment.exec(command="id -u", timeout_sec=60)
    except Exception:  # no answer: leave the run as Harbor would run it
        return None
    uid = (getattr(result, "stdout", None) or "").strip()
    if getattr(result, "return_code", None) != 0 or not uid.isdigit() or int(uid) == 0:
        return None
    return int(uid)


@contextlib.contextmanager
def default_user(environment: BaseEnvironment, user: int | None) -> Iterator[None]:
    """Run as `user` for the block, when there is one. The save and restore
    of Harbor 0.23.0's `with_default_user`, which Pier 0.3.1 lacks."""
    if user is None:
        yield
        return
    previous = environment.default_user
    environment.default_user = user
    try:
        yield
    finally:
        environment.default_user = previous


def session_efforts(sessions: Path) -> list[str]:
    """The reasoning effort each turn of the Codex session ran at: the
    distinct `effort` of the rollouts' `turn_context` events, first seen first."""
    efforts: list[str] = []
    for rollout in sorted(sessions.glob("**/rollout-*.jsonl")):
        try:
            lines = rollout.read_text(errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            if '"turn_context"' not in line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            payload = event.get("payload") if isinstance(event, dict) and event.get("type") == "turn_context" else None
            effort = payload.get("effort") if isinstance(payload, dict) else None
            if isinstance(effort, str) and effort not in efforts:
                efforts.append(effort)
    return efforts


class PooledCodex(Codex):
    def __init__(self, logs_dir: Path, model_name: str | None = None, **kwargs: Any) -> None:
        # Both arms run at one effort unless the run names another.
        self._effort = kwargs.setdefault("reasoning_effort", accounts.DEFAULT_EFFORT)
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self._pool = accounts.Pool.from_environment()
        self._account: accounts.Account | None = None
        self._metadata: dict[str, Any] = {}
        self._seal: dict[str, Any] = {}

    @staticmethod
    def name() -> str:
        return "codex"

    async def setup(self, environment: BaseEnvironment) -> None:
        # Waits here while the pool is paused, before the CLI is installed.
        self._account = await asyncio.to_thread(self._pool.lease, self.logs_dir.parent.name)
        self._write_account()
        await super().setup(environment)

    async def ensure_system_dependencies(self, environment: BaseEnvironment, dependencies: tuple[str, ...]) -> None:
        """Harbor: ask the package manager only for the dependencies whose
        commands the image lacks. Harbor installs every one of them when any
        is missing, and Debian's npm cannot install beside an image's own
        Node.js (SWE-bench Pro V2 openlibrary ships NodeSource's): apt-get
        exits 100 and the trial dies in setup. An unknown or always-installed
        dependency goes to Harbor as is. Pier installs at image build and
        never calls this."""
        missing = []
        for dependency in dependencies:
            spec = self.SYSTEM_PACKAGES.get(dependency)
            if spec is not None and spec.commands and not spec.always_install:
                check = " && ".join(f"command -v {shlex.quote(command)} >/dev/null 2>&1" for command in spec.commands)
                if (await environment.exec(command=check, user="root")).return_code == 0:
                    continue
            missing.append(dependency)
        await super().ensure_system_dependencies(environment, tuple(missing))

    def network_allowlist(self):
        """Pier: every host the task container may reach, through Pier's
        egress proxy. Pier's own default is `api.openai.com`, the API-key route."""
        try:
            from pier.models.agent.network import NetworkAllowlist  # type: ignore[import-not-found]
        except ImportError:
            return None
        return NetworkAllowlist(domains=list(seal.ALLOWED_HOSTS))

    def _write_account(self, **extra: Any) -> None:
        proof = {"sealed": self._seal["sealed"], "seal": self._seal} if self._seal else {}
        (self.logs_dir / ACCOUNT_FILE).write_text(json.dumps(
            {"account": self._account.label if self._account else None, "reasoningEffort": self._effort,
             **proof, **extra},
            indent=2))

    async def _prove_seal(self, environment: BaseEnvironment) -> dict[str, Any]:
        """Run the denied-connect probe in the task container, as the agent
        user and with the environment the CLI's own commands get."""
        try:
            result = await self.exec_as_agent(environment, command=seal.script(), timeout_sec=300)
        except Exception as error:  # no proof is an open seal, never a pass
            return {**seal.verdict(""), "reason": f"the probe did not run: {str(error)[:300]}"}
        return seal.verdict(getattr(result, "stdout", None) or "")

    def _resolve_auth_json_path(self) -> Path | None:
        if self._account is None:
            raise RuntimeError("PooledCodex.run before setup: no account leased")
        return self._account.auth

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        # As the image's own user, so the runner chowns `auth.json` to it.
        with default_user(environment, await image_uid(environment)):
            await self._run_pooled(instruction, environment, context)

    async def _run_pooled(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        self._seal = {**await self._prove_seal(environment), "webSearches": 0}
        self._write_account()
        # One attempt per trial: a usage limit is never re-run in this task
        # container, which the attempt already changed. The account leaves
        # rotation and `SeatExhausted` (infra) makes the runner re-run the
        # trial in a fresh environment.
        failure: BaseException | None = None
        try:
            await super().run(instruction, environment, context)
        except Exception as error:  # a dry seat may surface as a failed command
            failure = error
        output = self.logs_dir / self._OUTPUT_FILENAME
        await self._fetch_output(environment, output)
        try:
            text = output.read_text(errors="replace")
        except OSError:
            text = ""
        self._record_output(text, failure)

    def _record_output(self, text: str, failure: BaseException | None) -> None:
        """Record transcript evidence before propagating the trial's outcome."""
        self._seal["webSearches"] += web_searches(text)
        # Harbor's exception embeds a truncated head/tail of task output,
        # which can splice a command's words into a non-JSON line.
        limit = usage_limit_in(text)
        reached = container_commands(text)
        if self._seal["webSearches"]:
            searched = f"the CLI ran {self._seal['webSearches']} web search(es) outside the task container"
            self._seal.update(sealed=False, reason="; ".join(filter(None, [self._seal.get("reason"), searched])))
        reset_at = accounts.reset_time_of(text) if limit is not None else None
        self._write_account(containerCommands=reached,
                            **({"usageLimit": limit, "resetAt": reset_at} if limit is not None else {}))
        # Kept off the context until Harbor has filled it: Harbor reads the
        # session's token usage only into an empty context.
        self._metadata = {"account": self._account.label if self._account else None,
                          "container_commands": reached, "sealed": self._seal["sealed"], "seal": self._seal}
        if limit is not None:
            assert self._account is not None
            self._pool.disable(self._account.label, limit, reset_at)
            raise accounts.SeatExhausted(self._account.label, limit, reset_at)
        if failure is not None:
            raise failure
        if reached["succeeded"] == 0:
            raise accounts.ContainerUnreachable(
                f"codex ran no command with exit 0 in the task container ({reached['attempted']} attempted)")

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Harbor's usage and trajectory from the Codex session, then the pool's
        record. Harbor calls this after `run`, raised or not, only while the
        context is still empty."""
        super().populate_context_post_run(context)
        # Asked for, then what each turn of the session really ran at.
        context.metadata = {**(context.metadata or {}), **self._metadata, "reasoning_effort": self._effort,
                            "efforts": session_efforts(self.logs_dir / "sessions")}

    async def _fetch_output(self, environment: BaseEnvironment, output: Path) -> None:
        """On an environment that does not mount the logs directory (plue),
        the CLI's output is still in the container when `run` returns; the
        runner copies it only afterwards. Fetch it now so the usage-limit
        check and the container gate read what the CLI printed."""
        capabilities = getattr(environment, "capabilities", None)
        if getattr(capabilities, "mounted", True):
            return
        try:
            await environment.download_file(f"/logs/agent/{self._OUTPUT_FILENAME}", output)
        except Exception:  # absent when the CLI never started; the gate then sees nothing
            pass
