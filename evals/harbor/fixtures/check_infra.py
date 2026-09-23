"""Offline checks of infrastructure containment on Smithers Cloud.

    python3 fixtures/check_infra.py          # structural checks
    HARBOR_PYTHON=<harbor python> verify.sh  # plus the checks that need Harbor

What is pinned, and the failure each one stops:

  - A trial is healthy only when it was graded, or graded after a whitelisted
    agent outcome (AgentTimeoutError; NonZeroAgentExitCodeError whose output
    carries no SSH or gateway transport error). Everything else is infra:
    retried, never scored. The 2026-09-23 pass counted VerifierTimeoutError,
    CancelledError and `ssh: connect to host … port 22` exits as healthy.
  - An SSH client transport failure (exit 255 plus OpenSSH's own message) is a
    PlueError, never the agent's exit status; the agent's own exit 255 is.
  - The host ledger caps running workspaces (the plan's concurrent-sandbox
    limit) as well as vCPU slots, and a trial's agent workspace hands its slot
    to that trial's verifier workspace instead of the queue: 66 of 66 TB4
    tasks verify in a separate workspace, and queueing it behind fresh trials
    inside Harbor's build timer was every VerifierTimeoutError of that pass.
  - The separate verifier workspace is reserved before Harbor's build timer.
  - No plue failure escapes a trial: an environment the plue backend cannot
    hold (a GPU task) is constructed and fails at reserve() with
    PlueUnplaceable, where Harbor records it; the 06:02 and 06:45 crashes were
    that RuntimeError raised inside Trial.create, which kills the job. Any
    non-plue exception inside an environment method becomes a PlueError, and
    stop() never raises: a workspace it could not delete is logged as leaked.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import outcome  # noqa: E402
import plue_env  # noqa: E402


def result(exception: str | None = None, message: str = "", reward: float | None = None,
           finished: bool = True) -> dict:
    return {
        "finished_at": "2026-09-23T12:00:00Z" if finished else None,
        "exception_info": {"exception_type": exception, "exception_message": message} if exception else None,
        "verifier_result": {"rewards": {"reward": reward}} if reward is not None else None,
    }


SSH_CONNECT = ("Command failed (exit 255): ln -sf /tmp/codex-secrets/auth.json \"$CODEX_HOME/auth.json\"\n\n"
               "stdout: None\nstderr: ssh: connect to host ssh.jjhub.tech port 22: Operation timed out\n")
SSH_CLOSED = "Command failed (exit 255): codex exec …\nstderr: Connection to ssh.jjhub.tech closed by remote host.\r\n"
SSH_READ = ("Command failed (exit 255): codex exec …\nstderr: Read from remote host ssh.jjhub.tech: Operation timed out\r\n"
            "client_loop: send disconnect: Broken pipe\r\n")
AGENT_EXIT = "Command failed (exit 1): codex exec …\nstderr: error: model refused to continue\n"


def check_classification() -> None:
    cases = [
        (result(reward=1.0), "graded"),
        (result(reward=0.0), "graded"),
        (result("AgentTimeoutError", "Agent execution timed out after 28800 seconds", reward=0.0), "agent"),
        (result("NonZeroAgentExitCodeError", AGENT_EXIT, reward=0.0), "agent"),
        # The agent's own failure with no grade is not a score either.
        (result("NonZeroAgentExitCodeError", AGENT_EXIT), "infra"),
        (result("AgentTimeoutError", "timed out"), "infra"),
        (result("NonZeroAgentExitCodeError", SSH_CONNECT), "infra"),
        (result("NonZeroAgentExitCodeError", SSH_CLOSED, reward=0.0), "infra"),
        (result("NonZeroAgentExitCodeError", SSH_READ), "infra"),
        (result("VerifierTimeoutError", "Verifier execution timed out after 180.0 seconds"), "infra"),
        (result("CancelledError"), "infra"),
        (result("PlueError", "workspace not started"), "infra"),
        (result("EnvironmentStartTimeoutError", "Environment start timed out after 600.0 seconds"), "infra"),
        (result("AgentSetupTimeoutError"), "infra"),
        (result("ContainerUnreachable"), "infra"),
        (result("ModelRouteError"), "infra"),
        (result("RuntimeError", "anything unforeseen"), "infra"),
        # A grade next to an infrastructure exception is still infra.
        (result("PlueError", "delete failed", reward=1.0), "infra"),
        (result("PlueUnplaceable", "task asks for 8 vCPU"), "unplaceable"),
        (result(finished=False), "running"),
        ({}, "running"),
    ]
    for row, expected in cases:
        got = outcome.classify(row)
        assert got == expected, (expected, got, row)
    assert outcome.is_healthy("graded") and outcome.is_healthy("agent")
    assert not any(outcome.is_healthy(k) for k in ("infra", "unplaceable", "running"))
    # The retry filter Harbor needs: every infra exception type seen above.
    for name in ("VerifierTimeoutError", "CancelledError", "PlueError", "EnvironmentStartTimeoutError",
                 "AgentSetupTimeoutError", "ContainerUnreachable", "ModelRouteError",
                 # vba-userform-port, 2026-09-23: npm ECONNRESET through the egress
                 # proxy aborted test.sh before it wrote a reward.
                 "RewardFileNotFoundError", "RewardFileEmptyError", "VerifierOutputParseError",
                 "DownloadVerifierDirError", "AddTestsDirError"):
        assert name in outcome.INFRA_EXCEPTIONS, name
    assert "PlueUnplaceable" not in outcome.INFRA_EXCEPTIONS
    flags = outcome.retry_flags().split()
    assert flags[:2] == ["-r", "3"] and flags.count("--retry-include") == len(outcome.INFRA_EXCEPTIONS)
    assert outcome.ssh_transport_error(SSH_READ) and outcome.ssh_transport_error(SSH_CONNECT)
    assert outcome.ssh_transport_error(AGENT_EXIT) is None


def check_ledger() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "slots.json"
        ledger = plue_env.SlotLedger(path, capacity=6, max_holders=3)
        for key in ("a__env", "b__env", "c__env"):
            ledger.enqueue(key, 1)
            assert ledger.try_grant(key), key
        ledger.enqueue("d__env", 1)
        assert ledger.try_grant("d__env") is False, "3 workspaces is the plan's cap though 3 slots are free"

        # a's agent workspace ends; its verifier is next, not d.
        ledger.release("a__env", heir="a__verifier__")
        assert ledger.try_grant("d__env") is False, "the slot is held for a's verifier"
        ledger.enqueue("a__verifier__trial", 2)
        state = json.loads(path.read_text())
        assert state["waiters"][0]["key"] == "a__verifier__trial", "an heir queues first"
        assert ledger.try_grant("a__verifier__trial") is True, "the heir takes the slot at once"
        state = json.loads(path.read_text())
        assert set(state["holders"]) == {"a__verifier__trial", "b__env", "c__env"}, state["holders"]
        assert state["used"] == 4

        # An unclaimed handover expires instead of leaking the slot.
        ledger.release("b__env", heir="b__verifier__", ttl=0)
        assert ledger.try_grant("d__env") is True, "an expired handover frees the slot"

        # No cap: behaviour is the plain vCPU ledger.
        free = plue_env.SlotLedger(Path(directory) / "free.json", capacity=2)
        for key in ("x", "y"):
            free.enqueue(key, 1)
            assert free.try_grant(key)

    os.environ.update(PLUE_SLOTS="6", PLUE_MAX_WORKSPACES="3", PLUE_SLOT_LEDGER=str(Path(tempfile.gettempdir()) / "l.json"))
    try:
        assert plue_env.SlotLedger.from_environment().max_holders == 3
    finally:
        for name in ("PLUE_SLOTS", "PLUE_MAX_WORKSPACES", "PLUE_SLOT_LEDGER"):
            os.environ.pop(name, None)
    assert plue_env.heir_of("wal__gRv__env") == "wal__gRv__verifier__"
    assert plue_env.heir_of("wal__gRv__verifier__trial") is None


def fake_ops(cli: Path, workspace: str = "ws-1") -> "plue_env._PlueOps":
    os.environ["SMITHERS_CLI"] = str(cli)
    os.environ["PLUE_REPO"] = "acme/bench"
    ops = plue_env._PlueOps()
    ops._workspace_id = workspace
    ops.logger = logging.getLogger("check")
    ops.task_env_config = types.SimpleNamespace(workdir=None, cpus=2)
    ops.session_id = "t1__env"
    ops.environment_dir = "/nonexistent/environment"
    return ops


def check_transport_and_containment() -> None:
    with tempfile.TemporaryDirectory() as directory:
        cli = Path(directory) / "smithers"
        cli.write_text("#!/bin/sh\n"
                       "case \"$*\" in\n"
                       "  *connectfail*) printf '%s' '{\"data\":{\"stdout\":\"\",\"stderr\":\"ssh: connect to host ssh.jjhub.tech port 22: Operation timed out\\r\\n\",\"exit_code\":255}}'; exit 255;;\n"
                       "  *dropped*) printf '%s' '{\"data\":{\"stdout\":\"half\",\"stderr\":\"\",\"exit_code\":255}}'; printf 'Connection to ssh.jjhub.tech closed by remote host.\\r\\n' >&2; exit 255;;\n"
                       "  *own255*) printf '%s' '{\"data\":{\"stdout\":\"\",\"stderr\":\"fatal: bad object\\n\",\"exit_code\":255}}'; exit 255;;\n"
                       "  *notjson*) printf 'not json {'; exit 0;;\n"
                       "  *delete*) printf '%s' '{\"error\":{\"code\":\"UNKNOWN\",\"message\":\"502 bad gateway\"}}'; exit 1;;\n"
                       "  *) printf '%s' '{\"data\":{\"stdout\":\"ok\",\"stderr\":\"\",\"exit_code\":0}}';;\n"
                       "esac\n")
        cli.chmod(0o755)
        leaks = Path(directory) / "leaks.log"
        os.environ["PLUE_LEAK_LOG"] = str(leaks)
        try:
            ops = fake_ops(cli)
            for command in ("connectfail", "dropped"):
                try:
                    asyncio.run(ops._plue_exec(command))
                except plue_env.PlueError as error:
                    assert error.code == "ssh_transport", (command, error.code)
                else:
                    raise AssertionError(f"{command}: an SSH client transport failure is a PlueError")
            assert asyncio.run(ops._plue_exec("own255")) == ("", "fatal: bad object\n", 255), "the command's own 255 is its exit"
            try:
                asyncio.run(ops._plue_exec("notjson"))
            except plue_env.PlueError:
                pass
            else:
                raise AssertionError("an unreadable CLI reply is a PlueError, not a ValueError")

            # A CLI that cannot be spawned is a PlueError, not an OSError.
            missing = fake_ops(Path(directory) / "absent")
            try:
                asyncio.run(missing._plue_exec("true"))
            except plue_env.PlueError:
                pass
            else:
                raise AssertionError("a missing CLI is a PlueError")

            # stop() never raises; the undeleted workspace is logged, the slot freed.
            ledger_path = Path(directory) / "slots.json"
            os.environ.update(PLUE_SLOTS="6", PLUE_SLOT_LEDGER=str(ledger_path))
            ops = fake_ops(cli, workspace="ws-leak")
            ops._plue_ledger_key = "k1__env"
            ledger = plue_env.SlotLedger(ledger_path, 6)
            ledger.enqueue("k1__env", 1)
            assert ledger.try_grant("k1__env")
            plue_env._DELETE_BACKOFF_SEC = 0
            asyncio.run(ops._plue_stop())
            assert "ws-leak" in leaks.read_text()
            assert not json.loads(ledger_path.read_text())["holders"], "the slot is released"
            assert ops._workspace_id == ""
        finally:
            for name in ("SMITHERS_CLI", "PLUE_REPO", "PLUE_LEAK_LOG", "PLUE_SLOTS", "PLUE_SLOT_LEDGER"):
                os.environ.pop(name, None)


def check_image_tmp() -> None:
    """The guest's /tmp is the image's /tmp, as under Docker. The microsandbox
    guest init mounts a 512 MiB tmpfs over it, which hid layout-config-
    recreation2's /tmp/google_fonts_cache (1393 fonts) from its own oracle."""
    with tempfile.TemporaryDirectory() as directory:
        calls = Path(directory) / "calls"
        cli = Path(directory) / "smithers"
        cli.write_text("#!/bin/sh\n"
                       f"printf '%s\\n' \"$*\" >> {calls}\n"
                       "printf '%s' '{\"data\":{\"stdout\":\"\",\"stderr\":\"\",\"exit_code\":0}}'\n")
        cli.chmod(0o755)
        try:
            ops = fake_ops(cli)
            ops._plue_reserved = True
            ops._plue_copies, ops._plue_chmods = [], []
            asyncio.run(ops._plue_start())
        finally:
            for name in ("SMITHERS_CLI", "PLUE_REPO"):
                os.environ.pop(name, None)
        first = calls.read_text().splitlines()[0]
        assert "umount -l /tmp" in first and "mkdir -p /logs/agent" in first, first
        assert first.index("umount -l /tmp") < first.index("mkdir -p /logs/agent"), first
        assert len(calls.read_text().splitlines()) == 1, "one exec, no extra round trip"


def check_sidecars() -> None:
    """A task whose compose file adds services beside `main` cannot run on one
    plue workspace: sidecars need their own filesystems (freight-dispatch-
    shift's event feed hides future records from the agent) and container
    networking plue workspaces do not have. It is unplaceable, never a 0."""
    with tempfile.TemporaryDirectory() as directory:
        env_dir = Path(directory)
        assert plue_env.compose_sidecars(env_dir) == []
        (env_dir / "docker-compose.yaml").write_text(
            "services:\n  main:\n    environment:\n    - A=1\n"
            "  event-feed:\n    image: x\n  kafka:\n    image: y\n")
        assert plue_env.compose_sidecars(env_dir) == ["event-feed", "kafka"]
        (env_dir / "docker-compose.yaml").write_text("services:\n  main:\n    cap_add: [SYS_PTRACE]\n")
        assert plue_env.compose_sidecars(env_dir) == []
        (env_dir / "docker-compose.yaml").write_text("services:\n  main:\n  loadgen:\n    image: z\n")
        ops = plue_env._PlueOps()
        ops.environment_dir = str(env_dir)
        ops.task_env_config = types.SimpleNamespace(docker_image="img")
        try:
            ops._validate_definition()
        except plue_env.PlueUnplaceable as error:
            assert error.code == "sidecars" and "loadgen" in str(error), error
        else:
            raise AssertionError("a task with sidecars is unplaceable on plue")


def check_trial_containment() -> None:
    """Harbor's Trial constructor refuses a task whose artifacts name a
    compose sidecar on a provider without compose (payments-pipeline-fix:
    `kafka`). That raise is in Trial.create, outside the trial, and ended the
    2026-09-23 10:3x oracle gate. It is deferred to _prepare()."""
    class Trial:
        def __init__(self):
            self.prepared = False
            self._validate_artifact_configuration()
            self._validate_network_policy_modes()

        def _validate_artifact_configuration(self):
            raise ValueError("Task references compose sidecar services ['kafka'] ...")

        def _validate_network_policy_modes(self):
            pass

        async def _prepare(self):
            self.prepared = True

    try:
        Trial()
    except ValueError:
        pass
    else:
        raise AssertionError("the control: the unpatched constructor raises")
    plue_env.install_trial_containment(Trial)
    plue_env.install_trial_containment(Trial)  # idempotent
    trial = Trial()
    try:
        asyncio.run(trial._prepare())
    except plue_env.PlueUnplaceable as error:
        assert "kafka" in str(error) and error.code == "unsupported", error
    else:
        raise AssertionError("the deferred refusal is raised inside the trial")
    assert not trial.prepared

    class Fine(Trial):
        def _validate_artifact_configuration(self):
            pass
    plue_env.install_trial_containment(Fine)
    fine = Fine()
    asyncio.run(fine._prepare())
    assert fine.prepared


def check_requeue_and_health() -> None:
    import health
    import requeue
    from datetime import datetime, timedelta, timezone
    recent = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    with tempfile.TemporaryDirectory() as directory:
        job = Path(directory) / "tb4-X"
        job.mkdir()
        trials = {
            "graded__a": result(reward=1.0),
            "agent__b": result("AgentTimeoutError", "timed out", reward=0.0),
            "ssh__c": result("NonZeroAgentExitCodeError", SSH_CLOSED),
            "verify__d": result("VerifierTimeoutError", "Verifier execution timed out"),
            "gpu__e": result("PlueUnplaceable", "GPU"),
            "killed__f": result(finished=False),
        }
        for name, data in trials.items():
            (job / name).mkdir()
            (job / name / "config.json").write_text("{}")
            if data.get("finished_at"):
                data["finished_at"] = recent
            (job / name / "result.json").write_text(json.dumps(data))
        out = Path(directory) / "health.md"
        assert health.main([directory, str(out), "tb4-X"]) == 3, "2 infra of 5 finished in the hour trips"
        assert "TRIPPED" in out.read_text()
        moved = requeue.requeue(job)
        assert sorted(moved) == ["killed__f", "ssh__c", "verify__d"], moved
        assert sorted(t.name for t in job.iterdir()) == ["agent__b", "gpu__e", "graded__a"]
        assert (Path(directory) / "tb4-X.infra" / "ssh__c" / "result.json").is_file(), "evidence is kept"
        assert health.main([directory, str(out), "tb4-X"]) == 0, "graded, agent and unplaceable never trip"
    assert requeue.workspace_name("ks-solver-cpp__VA7miqc__verifier__trial") == "ks-solver-cpp-va7miqc-verifier-trial"
    assert requeue.workspace_name("ks-solver-cpp__VA7miqc__env") == plue_env._sanitize_name("ks-solver-cpp__VA7miqc__env")


def check_with_harbor() -> str:
    try:
        import harbor  # noqa: F401
    except ImportError:
        return "Harbor-backed checks skipped (set HARBOR_PYTHON)"
    from harbor.models.task.config import EnvironmentConfig
    from harbor.models.trial.paths import TrialPaths

    env_cls = plue_env.PlueEnvironment
    with tempfile.TemporaryDirectory() as directory:
        env_dir = Path(directory) / "environment"
        env_dir.mkdir()
        (env_dir / "Dockerfile").write_text("FROM ubuntu:24.04\n")
        paths = TrialPaths(Path(directory) / "trial")
        make = lambda session, config: env_cls(  # noqa: E731
            environment_dir=env_dir, environment_name="gpu-task", session_id=session,
            trial_paths=paths, task_env_config=config, logger=logging.getLogger("check"))

        # The control: without the deferral, Harbor's check raises inside the
        # constructor, which is Trial.create, which ends the job.
        from harbor.environments.base import BaseEnvironment
        undeferred = type("Undeferred", (plue_env._PlueOps, BaseEnvironment), {
            "type": staticmethod(lambda: "plue"), "capabilities": env_cls.capabilities,
            "start": env_cls.start, "stop": env_cls.stop, "exec": env_cls.exec,
            "upload_file": env_cls.upload_file, "upload_dir": env_cls.upload_dir,
            "download_file": env_cls.download_file, "download_dir": env_cls.download_dir,
            "_plue_network": env_cls._plue_network})
        try:
            undeferred(environment_dir=env_dir, environment_name="gpu-task", session_id="gpu__y__env",
                       trial_paths=paths, task_env_config=EnvironmentConfig(docker_image="ubuntu:24.04", gpus=1),
                       logger=logging.getLogger("check"))
        except RuntimeError as error:
            assert "GPU" in str(error), error
        else:
            raise AssertionError("the control: Harbor's constructor refuses a GPU task")

        env = make("gpu__x__env", EnvironmentConfig(docker_image="ubuntu:24.04", gpus=1, cpus=4))
        try:
            asyncio.run(env.reserve())
        except plue_env.PlueUnplaceable as error:
            assert "GPU" in str(error), error
        else:
            raise AssertionError("a GPU task fails at reserve(), inside the trial")
        try:
            asyncio.run(env.start(force_build=False))
        except plue_env.PlueUnplaceable:
            pass
        else:
            raise AssertionError("start() refuses the same way")
        asyncio.run(env.stop(delete=True))  # nothing to delete, never raises

        bad = env_dir.parent / "bad"
        bad.mkdir()
        (bad / "Dockerfile").write_text("FROM a AS b\nFROM c\n")
        broken = env_cls(environment_dir=bad, environment_name="bad", session_id="bad__x__env",
                         trial_paths=paths, task_env_config=EnvironmentConfig(), logger=logging.getLogger("check"))
        try:
            asyncio.run(broken.reserve())
        except plue_env.PlueImageError:
            pass
        else:
            raise AssertionError("an image plue cannot run fails at reserve()")

    # The separate verifier environment is reserved before the build timer.
    from harbor.trial.trial import Trial
    assert getattr(Trial._separate_verifier_env, "_plue_untimed_reserve", False), \
        "importing PlueEnvironment patches the verifier environment start"
    import harbor.trial.trial as trial_module

    class SlowEnv:
        def __init__(self):
            self.order = []
            self.os = None

        async def reserve(self):
            await asyncio.sleep(0.3)
            self.order.append("reserve")

        async def start(self, force_build=False):
            self.order.append("start")

        async def stop(self, delete=True):
            self.order.append("stop")

    created = []

    def create_environment_from_config(**kwargs):
        env = SlowEnv()
        created.append((kwargs, env))
        return env

    fake = types.SimpleNamespace(
        config=types.SimpleNamespace(environment=types.SimpleNamespace(model_copy=lambda update: "runtime", delete=True)),
        task=types.SimpleNamespace(short_name="t"),
        paths="paths", _id="id", logger=logging.getLogger("check"),
        _environment_build_timeout_sec=0.05,
        _verifier_env_build_context=lambda step_cfg: "tests",
        _separate_verifier_session_id=lambda key: f"t__x__verifier__{key}",
        _verifier_env_mounts=lambda env_config: [],
        _validate_separate_verifier_env_policies=lambda env, plan: None,
    )
    plan = types.SimpleNamespace(verifier_env_baseline="baseline", verifier_phase="phase")
    original_factory = trial_module.EnvironmentFactory.create_environment_from_config
    trial_module.EnvironmentFactory.create_environment_from_config = staticmethod(create_environment_from_config)
    try:
        async def enter():
            async with Trial._separate_verifier_env(fake, "env-config", key="trial", plan=plan) as env:
                return env
        env = asyncio.run(enter())
        assert env.order == ["reserve", "start", "stop"], env.order
        assert created[0][0]["session_id"] == "t__x__verifier__trial"
    finally:
        trial_module.EnvironmentFactory.create_environment_from_config = original_factory
    return "Harbor-backed checks ran (harbor importable)"


if __name__ == "__main__":
    check_classification()
    check_ledger()
    check_transport_and_containment()
    check_image_tmp()
    check_sidecars()
    check_trial_containment()
    check_requeue_and_health()
    harbor_note = check_with_harbor()
    print(f"check_infra.py: classification, ledger cap and verifier handover, SSH transport, image /tmp, sidecars, "
          f"containment, requeue and health hold; {harbor_note}.")
