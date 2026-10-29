"""Offline checks of the stock Codex arm's network seal: no docker, no model.

    python3 fixtures/check_seal.py

What is pinned, and why each one matters:

  - `sealed` is true only when every attempt to reach a host outside the
    allowlist was refused: through the agent's own route, around the proxy by
    name, and around the proxy and DNS by address. One connection, a probe
    that could not run (no curl), a truncated or empty transcript all read
    `sealed: false`. In August an unsealed Codex arm fetched the upstream fix
    in 8 SWE-bench runs; a proof that fails open would hide the next one.
  - The probe is real: the script runs under `sh` with the system `curl`
    against a local proxy that refuses every CONNECT and against a closed
    local port, and curl's own exit codes are the ones the verdict reads.
  - The allowlist is exactly the two hosts the ChatGPT-subscription route
    needs, and under Pier `PooledCodex` hands the runner that list and nothing
    else (Pier's stock `codex` agent allows `api.openai.com` instead).
  - `PooledCodex.run` proves the seal before the CLI starts and writes
    `sealed` into `codex-account.json` and the trial's metadata; a web search
    in the CLI's transcript unseals the trial, because the model backend runs
    that search outside the task container.
"""

from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import accounts  # noqa: E402
import seal  # noqa: E402

SEALED = "\n".join([
    "seal-probe allowed https://chatgpt.com/ 0 403 200",
    "seal-probe allowed https://auth.openai.com/ 0 404 200",
    "seal-probe denied https://github.com/ 56 000 403",
    "seal-probe denied-direct https://github.com/ 6 000 000",
    "seal-probe denied-direct https://1.1.1.1/ 7 000 000",
])


def swap(transcript: str, attempt: str, line: str) -> str:
    kept = [row for row in transcript.splitlines() if not row.startswith(f"seal-probe {attempt} ")]
    assert len(kept) < len(transcript.splitlines()), attempt
    return "\n".join(kept + ([line] if line else []))


def check_verdict() -> None:
    proof = seal.verdict(SEALED)
    assert proof["sealed"] is True, proof
    assert proof["allowlist"] == ["auth.openai.com", "chatgpt.com"], proof
    assert [(a["kind"], a["url"], a["curl"]) for a in proof["attempts"]] == [
        ("allowed", "https://chatgpt.com/", 0), ("allowed", "https://auth.openai.com/", 0),
        ("denied", "https://github.com/", 56), ("denied-direct", "https://github.com/", 6),
        ("denied-direct", "https://1.1.1.1/", 7)], proof
    assert proof["attempts"][2]["proxy"] == 403, "the proxy's own refusal is on the record"
    assert proof["reachable"] is True, proof
    json.dumps(proof)

    # libcurl versions report a rejected CONNECT as either 7 or 56. The
    # proxy's 403 and the absence of a target response are the same proof.
    refused_connect = seal.verdict(SEALED.replace("github.com/ 56 000 403", "github.com/ 7 000 403"))
    assert refused_connect["sealed"] is True, refused_connect

    unsealed = {
        "the agent's route reached github": swap(SEALED, "denied https://github.com/", "seal-probe denied https://github.com/ 0 200 200"),
        "a direct connection by name": swap(SEALED, "denied-direct https://github.com/", "seal-probe denied-direct https://github.com/ 0 200 000"),
        "a direct connection by address": swap(SEALED, "denied-direct https://1.1.1.1/", "seal-probe denied-direct https://1.1.1.1/ 0 301 000"),
        "curl is not installed": "\n".join(f"seal-probe {kind} {url} 127 000 000" for kind, url in seal.ATTEMPTS),
        "curl could not start": swap(SEALED, "denied https://github.com/", "seal-probe denied https://github.com/ 2 000 000"),
        "a certificate failure is not a refusal": swap(SEALED, "denied https://github.com/", "seal-probe denied https://github.com/ 60 000 200"),
        "one denied attempt is missing": swap(SEALED, "denied-direct https://1.1.1.1/", ""),
        "an unreadable status": swap(SEALED, "denied https://github.com/", "seal-probe denied https://github.com/ refused 000 403"),
        "no output": "",
        "noise": "bash: line 1: seal-probe: command not found\n",
    }
    for why, transcript in unsealed.items():
        proof = seal.verdict(transcript)
        assert proof["sealed"] is False, (why, proof)
        assert proof["reason"], (why, proof)

    # Sealed is about refusal alone: a seat that cannot reach its own model is
    # a route fault the trial raises, not an open container.
    offline = seal.verdict(swap(SEALED, "allowed https://chatgpt.com/", "seal-probe allowed https://chatgpt.com/ 56 000 403"))
    assert offline["sealed"] is True and offline["reachable"] is False, offline

    # Harbor's docker egress control is a transparent proxy that reads the SNI
    # and cuts a handshake to a host off its allowlist: curl 35, nothing
    # received. Every Codex trial under it read unsealed (nyc-01
    # burn-swepro-hard51-codex, 2026-10-14; #3863).
    harbor = "\n".join([
        "seal-probe allowed https://chatgpt.com/ 0 403 000",
        "seal-probe allowed https://auth.openai.com/ 0 403 000",
        "seal-probe denied https://github.com/ 35 000 000",
        "seal-probe denied-direct https://github.com/ 35 000 000",
        "seal-probe denied-direct https://1.1.1.1/ 35 000 000",
    ])
    proof = seal.verdict(harbor)
    assert proof["sealed"] is True and proof["reachable"] is True, proof

    # A second, later line cannot overwrite a connection the first one made.
    replayed = seal.verdict("seal-probe denied https://github.com/ 0 200 200\n" + SEALED)
    assert replayed["sealed"] is False, replayed


class Proxy:
    """A local proxy: refuses every CONNECT with 403, answers a plain request 200."""

    def __init__(self) -> None:
        self.server = socket.create_server(("127.0.0.1", 0))
        self.port = self.server.getsockname()[1]
        self.requests: list[str] = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            with connection:
                connection.settimeout(5)
                data = b""
                try:
                    while b"\r\n\r\n" not in data:
                        chunk = connection.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                except OSError:
                    continue
                line = data.split(b"\r\n", 1)[0].decode(errors="replace")
                self.requests.append(line)
                status = "403 Forbidden" if line.startswith("CONNECT ") else "200 OK"
                try:
                    connection.sendall(f"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
                except OSError:
                    pass

    def close(self) -> None:
        self.server.close()


class Cut:
    """A local TLS port that accepts, reads the ClientHello and hangs up, as
    Harbor's egress proxy does to a host off its allowlist."""

    def __init__(self) -> None:
        self.server = socket.create_server(("127.0.0.1", 0))
        self.port = self.server.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            with connection:
                connection.settimeout(5)
                try:
                    connection.recv(4096)
                except OSError:
                    pass

    def close(self) -> None:
        self.server.close()


def closed_port() -> int:
    with socket.create_server(("127.0.0.1", 0)) as server:
        return server.getsockname()[1]


def run_script(attempts: tuple, proxy: Proxy) -> str:
    environment = {"PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
                   "HTTPS_PROXY": f"http://agent:token@127.0.0.1:{proxy.port}",
                   "https_proxy": f"http://agent:token@127.0.0.1:{proxy.port}"}
    # dash (Debian's /bin/sh) exits 2 on `set -o pipefail`, so try it in a subshell first.
    done = subprocess.run(["sh", "-c", "(set -o pipefail) 2>/dev/null && set -o pipefail; " + seal.script(attempts)],
                          capture_output=True, text=True, env=environment, timeout=120)
    assert done.returncode == 0, (done.returncode, done.stderr)
    return done.stdout


def check_real_probe() -> str:
    if shutil.which("curl") is None:
        return "real curl probe skipped (no curl)"
    proxy = Proxy()
    try:
        refused = (("allowed", f"http://127.0.0.1:{proxy.port}/"),
                   ("denied", "https://denied.invalid/"),
                   ("denied-direct", f"https://127.0.0.1:{closed_port()}/"))
        transcript = run_script(refused, proxy)
        proof = seal.verdict(transcript, refused)
        assert proof["sealed"] is True, (proof, transcript)
        by_kind = {attempt["kind"]: attempt for attempt in proof["attempts"]}
        assert by_kind["denied"]["curl"] in (7, 56), proof
        assert (by_kind["denied"]["http"], by_kind["denied"]["proxy"]) == (0, 403), proof
        assert by_kind["denied-direct"]["curl"] == 7, proof
        assert proof["reachable"] is True, proof
        connects = [line for line in proxy.requests if line.startswith("CONNECT ")]
        assert connects == ["CONNECT denied.invalid:443 HTTP/1.1"], \
            f"the direct attempt goes around the proxy: {proxy.requests}"

        # The same script on an open route: the denied host answers.
        opened = (("denied", "https://denied.invalid/"),
                  ("denied-direct", f"http://127.0.0.1:{proxy.port}/"))
        proof = seal.verdict(run_script(opened, proxy), opened)
        assert proof["sealed"] is False, proof
        assert "connected" in proof["reason"], proof

        # A handshake cut after the ClientHello is a refusal.
        cut = Cut()
        try:
            hung_up = (("denied-direct", f"https://127.0.0.1:{cut.port}/"),)
            proof = seal.verdict(run_script(hung_up, proxy), hung_up)
        finally:
            cut.close()
        assert [a["curl"] for a in proof["attempts"]] == [35], proof
        assert proof["sealed"] is True, proof
    finally:
        proxy.close()

    # No curl on PATH: the probe says so and nothing is proven.
    with tempfile.TemporaryDirectory() as empty:
        done = subprocess.run(["sh", "-c", seal.script()], capture_output=True, text=True,
                              env={"PATH": empty}, executable=shutil.which("sh"), timeout=60)
    proof = seal.verdict(done.stdout)
    assert proof["sealed"] is False and all(a["curl"] == 127 for a in proof["attempts"]), proof
    return "real curl probe refused and opened as expected"


def check_pooled_codex() -> str:
    sys.path.insert(0, str(HERE.parents[6]))
    try:
        import pier  # noqa: F401
    except ImportError:
        pass
    else:  # Pier's CLI loads its trial runner before it imports the agent
        import pier.trial.execution  # noqa: F401
    try:
        from packages.smithers.agent.harness.benchmarks.harbor import codex_pool
    except ImportError:
        return "harbor not importable; PooledCodex seal not checked"
    import asyncio
    import types

    framework = codex_pool.Codex.__module__.split(".")[0]
    context_module = __import__(f"{framework}.models.agent.context", fromlist=["AgentContext"])

    def trial(directory: str, probe: str, transcript: str) -> tuple[dict, dict, list[str]]:
        logs = Path(directory) / "agent"
        logs.mkdir()
        (logs / "codex.txt").write_text(transcript)
        home = Path(directory) / "seat"
        home.mkdir()
        (home / "auth.json").write_text("{}")
        seat = accounts.Account("codex-2", home)
        pooled = codex_pool.PooledCodex(logs_dir=logs, model_name="openai/gpt-6-sol")
        pooled._pool = types.SimpleNamespace(lease=lambda trial="": seat)
        pooled._account = seat
        order: list[str] = []

        async def execute(command, **kwargs):
            order.append("uid" if command == "id -u" else "probe" if "seal-probe" in command else "other")
            return types.SimpleNamespace(return_code=0, stdout=probe, stderr=None)

        async def ran(self, instruction, environment, context):
            order.append("cli")

        environment = types.SimpleNamespace(
            capabilities=types.SimpleNamespace(mounted=True), default_user=None,
            exec=execute, agent_process_env=lambda env: env)
        original = codex_pool.Codex.run
        codex_pool.Codex.run = ran
        try:
            context = context_module.AgentContext()
            asyncio.run(pooled.run("fix it", environment, context))
        finally:
            codex_pool.Codex.run = original
        # What `populate_context_post_run` folds into the trial's result.
        return json.loads((logs / "codex-account.json").read_text()), pooled._metadata, order

    command = '{"type":"item.completed","item":{"type":"command_execution","exit_code":0}}\n'
    search = '{"type":"item.completed","item":{"type":"web_search","query":"abs-lang module cache fix"}}\n'
    with tempfile.TemporaryDirectory() as directory:
        record, metadata, order = trial(directory, SEALED, command)
    assert record["sealed"] is True and metadata["sealed"] is True, (record, metadata)
    assert record["seal"]["allowlist"] == ["auth.openai.com", "chatgpt.com"], record
    assert record["seal"]["webSearches"] == 0, record
    assert order[:3] == ["uid", "probe", "cli"], f"the seal is proven before the CLI starts: {order}"
    assert record["account"] == "codex-2" and record["containerCommands"] == {"attempted": 1, "succeeded": 1}, record

    with tempfile.TemporaryDirectory() as directory:
        record, metadata, _ = trial(directory, SEALED.replace("github.com/ 56 000 403", "github.com/ 0 200 200"), command)
    assert record["sealed"] is False and metadata["sealed"] is False, (record, metadata)

    with tempfile.TemporaryDirectory() as directory:
        record, metadata, _ = trial(directory, SEALED, command + search)
    assert record["sealed"] is False and metadata["sealed"] is False, "a web search leaves the container's seal"
    assert record["seal"]["webSearches"] == 1 and "web search" in record["seal"]["reason"], record

    assert codex_pool.web_searches(command + search + search.replace("item.completed", "item.started")) == 1

    if framework != "pier":
        return f"PooledCodex records the seal under {framework} (pier not importable; allowlist not checked)"
    from pier.agents.installed.codex import Codex as PierCodex
    with tempfile.TemporaryDirectory() as directory:
        pooled = codex_pool.PooledCodex(logs_dir=Path(directory), model_name="openai/gpt-6-sol")
        stock = PierCodex(logs_dir=Path(directory), model_name="openai/gpt-6-sol")
    assert isinstance(pooled, PierCodex), "Pier's runner needs Pier's Codex: install_spec and network_allowlist"
    assert pooled.network_allowlist().domains == ["auth.openai.com", "chatgpt.com"], pooled.network_allowlist()
    assert stock.network_allowlist().domains == ["api.openai.com"], "Pier's default allowlist moved; re-read the seal"
    assert pooled.install_spec().agent_name == "codex", "Pier installs the stock CLI at image build"
    return "PooledCodex records the seal and hands Pier the ChatGPT allowlist"


if __name__ == "__main__":
    check_verdict()
    probe = check_real_probe()
    pooled = check_pooled_codex()
    print(f"check_seal.py: the denied-connect verdict fails closed; {probe}; {pooled}.")
