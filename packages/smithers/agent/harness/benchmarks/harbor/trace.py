#!/usr/bin/env python3
"""What the agent did on every turn of a trial, read from the harness journal.

    python3 -B trace.py <trial-dir> [--full] [--html out.html] [--frame N]

`<trial-dir>` is a Harbor trial directory (its `agent/workspace/.flows` holds
the journal), the `agent/` directory itself, or any directory with a `.flows`.

For each frame it prints the model call (tokens in, cached, out, reasoning,
seconds), what the model wrote outside its cell, the cell's source, every flow
call the cell made (input, outcome, milliseconds, the head of its result), the
text the cell printed (what the next turn reads and re-pays), and how the
frame ended. Every other model call of the run (judge, supervisor, compaction,
`jev` readings the cell asked for) is listed on the frame it ran in.

The last section lists what a reader debugging efficiency looks for first:
frames that made one call, calls repeated with identical input, failed calls,
cells that threw or were asked again, and prints large enough to matter.
`--full` prints every text whole instead of its head; `--html` writes the same
report as one self-contained page.
"""

from __future__ import annotations

import html
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import calls  # noqa: E402

HEAD = 1200
RESULT_HEAD = 600
BIG_PRINT = 6000


CHILD = "control.child."


def flows_dir(target: Path) -> Path | None:
    for candidate in (target / ".flows", target / "workspace" / ".flows", target / "agent" / "workspace" / ".flows"):
        if candidate.is_dir():
            return candidate
    return None


def clip(text: str, limit: int, full: bool) -> str:
    if full or len(text) <= limit:
        return text
    half = limit // 2
    return f"{text[:half]}\n… [{len(text) - limit} chars omitted] …\n{text[-half:]}"


def one_line(value: Any, limit: int = 240) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    text = text.replace("\n", "\\n")
    return text if len(text) <= limit else f"{text[:limit]}… [{len(text)} chars]"


def result_text(value: Any) -> str:
    """A flow result as a person reads it: a shell result is its exit code and
    streams, anything else is JSON."""
    if isinstance(value, dict) and "exitCode" in value:
        parts = [f"exit {value.get('exitCode')}"]
        for stream in ("stdout", "stderr"):
            text = value.get(stream) or ""
            if text:
                dropped = value.get(f"{stream}DroppedBytes") or 0
                parts.append(f"{stream}{f' (dropped {dropped} bytes)' if dropped else ''}:\n{text.rstrip()}")
        if "mutated" in value:
            parts.append(f"mutated: {value['mutated']}")
        return "\n".join(parts)
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=1)


def fold(events: list[dict[str, Any]]) -> dict[str, Any]:
    """The journal as frames. A frame opens at `turn-opened` and closes at
    `turn-closed`; a model call that the frame re-asked is another attempt."""
    frames: list[dict[str, Any]] = []
    frame: dict[str, Any] | None = None
    pending: dict[str, dict[str, Any]] = {}
    children: dict[str, list[dict[str, Any]]] = {}
    run: dict[str, Any] = {"status": None, "resolved": None, "cause": None, "armed": None, "task": None}

    def current() -> dict[str, Any]:
        nonlocal frame
        if frame is None:
            frame = {"index": len(frames), "attempts": [], "cells": [], "calls": [], "prints": [], "notes": [],
                     "side": [], "end": None, "time": None, "opened": None}
            frames.append(frame)
        return frame

    for event in events:
        kind = event["type"]
        payload = event["payload"] if isinstance(event["payload"], dict) else {}
        if kind.startswith(CHILD):
            # A markdown child's records carry the caller's call they answer.
            call_id = str((payload.get("child") or {}).get("callId"))
            children.setdefault(call_id, []).append({**event, "type": "control.agent." + kind[len(CHILD):]})
            continue
        if kind == "control.agent.discipline-armed":
            run["armed"] = {key: payload.get(key) for key in
                            ("maxFrames", "calls", "callMs", "modelCallMs", "readOnlyCap", "repeatCap", "judged")}
        elif kind == "control.agent.turn-opened":
            frame = None
            current()["opened"] = payload.get("at")
        elif kind == "control.agent.model-requested":
            if payload.get("purpose", "frame") != "frame":
                continue
            target = current()
            if payload.get("frame") is not None:
                target["index"] = payload["frame"]
            messages = payload.get("messages") or []
            target["attempts"].append({
                "attempt": payload.get("attempt"), "at": payload.get("at"),
                "requestChars": sum(len(m.get("text") or "") for m in messages if isinstance(m, dict)),
                "messages": messages, "effort": (payload.get("params") or {}).get("reasoningEffort"),
                "prefixCount": payload.get("prefixCount"),
            })
        elif kind == "control.agent.model-settled":
            if payload.get("purpose", "frame") != "frame":
                current()["side"].append({"purpose": payload.get("purpose"), "ms": payload.get("durationMillis"),
                                          "usage": payload.get("usage"), "costUsd": payload.get("costUsd")})
                continue
            target = current()
            if target["attempts"]:
                target["attempts"][-1].update({
                    "ms": payload.get("durationMillis"), "usage": payload.get("usage") or {},
                    "output": payload.get("output") or {}, "text": payload.get("text") or "",
                    "stages": payload.get("stages") or {}, "finish": payload.get("finishReason"),
                })
        elif kind == "control.agent.model-retried":
            current()["notes"].append(f"model retried: {payload.get('code')} (attempt {payload.get('attempt')})")
        elif kind == "control.agent.cell-produced":
            current()["cells"].append(payload.get("text") or "")
        elif kind == "control.agent.cell-rejected":
            current()["notes"].append(f"cell rejected: {one_line(payload.get('reason') or payload)}")
        elif kind == "control.agent.cell-call-started":
            call = {"flow": payload.get("flowName"), "input": payload.get("input"), "at": payload.get("at"),
                    "outcome": "unsettled", "ms": None, "value": None, "error": None}
            pending[str(payload.get("callId"))] = call
            current()["calls"].append(call)
        elif kind == "control.agent.cell-call-settled":
            call = pending.get(str(payload.get("callId")))
            if call is not None:
                call.update({"outcome": payload.get("outcome"), "ms": payload.get("durationMillis"),
                             "value": payload.get("value"), "error": payload.get("error") or payload.get("failure")})
        elif kind == "control.agent.cell-printed":
            current()["prints"].append(payload.get("text") or "")
        elif kind == "control.agent.cell-settled":
            outcome = payload.get("outcome") or {}
            target = current()
            target["end"] = outcome
            target["work"] = payload.get("work")
        elif kind == "control.agent.turn-closed":
            target = current()
            target["time"] = payload.get("time")
            target["closed"] = {"outcome": payload.get("outcome"), "stopReason": payload.get("stopReason")}
        elif kind == "control.agent.supervisor-settled":
            current()["side"].append({"purpose": "supervisor", "ms": payload.get("latencyMs"),
                                      "costUsd": payload.get("costUsd"), "crossed": payload.get("crossed")})
        elif kind == "control.agent.resolved":
            run["resolved"] = payload.get("text")
        elif kind == "control.run.completed":
            run["status"] = "completed"
        elif kind == "control.run.failed":
            run["status"] = "failed"
            run["cause"] = payload.get("cause")
        elif kind.startswith("control.agent.") and kind.rsplit(".", 1)[-1] in (
                "completion-held", "demand-issued", "nudged", "compaction-settled", "justified", "steered"):
            current()["notes"].append(f"{kind.rsplit('.', 1)[-1]}: {one_line(payload, 400)}")
    for call_id, records in children.items():
        child = fold(records)
        call = pending.get(call_id)
        if call is not None:
            call["child"] = child
        else:
            run.setdefault("orphans", []).append(child)
    return {"frames": frames, "run": run}


def totals(frames: list[dict[str, Any]]) -> dict[str, int]:
    """What a run's own frames spent. A child's frames are counted by `children_of`."""
    out = {"in": 0, "cached": 0, "out": 0, "think": 0, "modelMs": 0, "cellMs": 0, "calls": 0, "frames": len(frames)}
    for frame in frames:
        for attempt in frame["attempts"]:
            a, b, c, d = usage_of(attempt)
            out["in"] += a
            out["cached"] += b
            out["out"] += c
            out["think"] += d
            out["modelMs"] += int(attempt.get("ms") or 0)
        out["cellMs"] += int((frame.get("time") or {}).get("cellMs") or 0)
        out["calls"] += len(frame["calls"])
    return out


def children_of(read: dict[str, Any]) -> list[dict[str, Any]]:
    """Every child run a trace holds: the ones its calls started, then any whose call was not journaled."""
    found = [call["child"] for frame in read["frames"] for call in frame["calls"] if call.get("child")]
    return found + list(read["run"].get("orphans") or [])


def usage_of(attempt: dict[str, Any]) -> tuple[int, int, int, int]:
    usage = attempt.get("usage") or {}
    output = attempt.get("output") or {}
    return (int(usage.get("inputTokens") or 0), int(usage.get("cachedInputTokens") or 0),
            int(usage.get("outputTokens") or 0), int(output.get("thinking") or usage.get("reasoningTokens") or 0))


def findings(frames: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    seen: dict[str, int] = {}
    for frame in frames:
        index = frame["index"]
        if len(frame["attempts"]) > 1:
            out.append(f"frame {index}: asked {len(frame['attempts'])} times (a cell that did not parse or was rejected)")
        if len(frame["calls"]) == 1 and (frame.get("end") or {}).get("_tag") == "settled":
            transition = ((frame.get("end") or {}).get("transition") or {}).get("_tag")
            if transition == "continue":
                out.append(f"frame {index}: one call ({frame['calls'][0]['flow']}) and no completion; could it have batched?")
        if not frame["calls"] and frame["cells"] and ((frame.get("end") or {}).get("transition") or {}).get("_tag") == "continue":
            out.append(f"frame {index}: a cell that called nothing and did not finish")
        if (frame.get("end") or {}).get("_tag") not in (None, "settled"):
            out.append(f"frame {index}: cell ended {one_line(frame['end'], 300)}")
        for call in frame["calls"]:
            key = json.dumps([call["flow"], call["input"]], sort_keys=True)
            seen[key] = seen.get(key, 0) + 1
            if seen[key] == 2:
                out.append(f"frame {index}: repeats {call['flow']} {one_line(call['input'], 160)}")
            if call["outcome"] != "success":
                out.append(f"frame {index}: {call['flow']} {call['outcome']}: {one_line(call.get('error') or call.get('value'), 200)}")
            elif isinstance(call["value"], dict) and call["value"].get("exitCode") not in (None, 0):
                out.append(f"frame {index}: {call['flow']} exit {call['value']['exitCode']}: {one_line(call['input'], 160)}")
        printed = sum(len(text) for text in frame["prints"])
        if printed > BIG_PRINT:
            out.append(f"frame {index}: printed {printed} chars (about {printed // 4} tokens re-read every later turn)")
    return out


def child_lines(child: dict[str, Any], full: bool) -> list[str]:
    """A child run under the call that started it: one line per frame, or the whole trace with `--full`."""
    spent = totals(child["frames"])
    lines = [f"  child run: frames {spent['frames']}  input {spent['in']:,} (cached {spent['cached']:,})  "
             f"output {spent['out']:,}  model {spent['modelMs'] / 1000:.1f}s  flow calls {spent['calls']}"]
    if full:
        return lines + ["  | " + line for line in render(child, full=True).splitlines()[1:]]
    for frame in child["frames"]:
        a = sum(usage_of(attempt)[0] for attempt in frame["attempts"])
        c = sum(usage_of(attempt)[2] for attempt in frame["attempts"])
        end = frame.get("end") or {}
        tag = (end.get("transition") or {}).get("_tag") or end.get("_tag") or "?"
        flows = ", ".join(f"{call['flow']}{'' if call['outcome'] == 'success' else ' (' + str(call['outcome']) + ')'}"
                          for call in frame["calls"]) or "no calls"
        lines.append(f"    child frame {frame['index']}: in {a:,} out {c:,}; {flows}; end {tag}")
    return lines


def render(read: dict[str, Any], *, full: bool = False, only: int | None = None) -> str:
    frames, run = read["frames"], read["run"]
    lines: list[str] = []
    own = totals(frames)
    kids = [totals(child["frames"]) for child in children_of(read)]
    spent = {key: own[key] + sum(kid[key] for kid in kids) for key in own}
    uncached = spent["in"] - spent["cached"]
    lines.append("# Trace")
    lines.append("")
    lines.append(f"status {run['status']}  frames {len(frames)}  flow calls {own['calls']}")
    lines.append(f"tokens: input {spent['in']:,} (cached {spent['cached']:,}, uncached {uncached:,})  "
                 f"output {spent['out']:,} (reasoning {spent['think']:,})  "
                 f"weighted {uncached + 0.1 * spent['cached'] + 8 * spent['out']:,.0f}")
    if kids:
        lines.append(f"  of which {len(kids)} child run(s): frames {sum(kid['frames'] for kid in kids)}  "
                     f"input {sum(kid['in'] for kid in kids):,}  output {sum(kid['out'] for kid in kids):,}  "
                     f"flow calls {sum(kid['calls'] for kid in kids)}")
    lines.append(f"time: model {own['modelMs'] / 1000:.1f}s  cells {own['cellMs'] / 1000:.1f}s")
    if run["armed"]:
        lines.append(f"limits: {one_line(run['armed'])}")
    if run["cause"]:
        lines.append(f"cause: {str(run['cause']).splitlines()[0][:500]}")
    if run["resolved"] is not None:
        lines.append(f"answer: {one_line(run['resolved'], 600)}")
    lines.append("")
    lines.append("| frame | in | cached | out | think | model s | cell s | calls | printed | end |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for frame in frames:
        a = b = c = d = ms = 0
        for attempt in frame["attempts"]:
            x = usage_of(attempt)
            a, b, c, d = a + x[0], b + x[1], c + x[2], d + x[3]
            ms += int(attempt.get("ms") or 0)
        end = frame.get("end") or {}
        tag = (end.get("transition") or {}).get("_tag") or end.get("_tag") or "?"
        time = frame.get("time") or {}
        lines.append(f"| {frame['index']} | {a:,} | {b:,} | {c:,} | {d:,} | {ms / 1000:.1f} | "
                     f"{int(time.get('cellMs') or 0) / 1000:.1f} | {len(frame['calls'])} | "
                     f"{sum(len(t) for t in frame['prints']):,} | {tag} |")
    lines.append("")
    notes = findings(frames)
    lines.append("## Look here first")
    lines.append("")
    lines.extend([f"- {note}" for note in notes] or ["- nothing flagged"])
    lines.append("")
    for frame in frames:
        if only is not None and frame["index"] != only:
            continue
        lines.append(f"## Frame {frame['index']}")
        lines.append("")
        for attempt in frame["attempts"]:
            a, b, c, d = usage_of(attempt)
            stages = attempt.get("stages") or {}
            lines.append(f"model call (attempt {attempt.get('attempt')}): input {a:,} cached {b:,} output {c:,} "
                         f"reasoning {d:,}; {int(attempt.get('ms') or 0) / 1000:.1f}s "
                         f"(first output {int(stages.get('firstOutputMs') or 0) / 1000:.1f}s); "
                         f"request {attempt.get('requestChars'):,} chars; effort {attempt.get('effort')}")
            if frame["index"] == 0 or full:
                for message in attempt.get("messages") or []:
                    if isinstance(message, dict):
                        lines.append(f"  [{message.get('role')}] {len(message.get('text') or ''):,} chars: "
                                     f"{one_line(message.get('text') or '', 200 if not full else 10**9)}")
            else:
                tail = [m for m in (attempt.get("messages") or []) if isinstance(m, dict)][-1:]
                for message in tail:
                    lines.append("  last message the model read:")
                    lines.append("  ```")
                    lines.append(clip(message.get("text") or "", HEAD, full))
                    lines.append("  ```")
            text = attempt.get("text") or ""
            if text:
                lines.append("  model wrote:")
                lines.append("  ```")
                lines.append(clip(text, HEAD * 3, full))
                lines.append("  ```")
        for note in frame["notes"]:
            lines.append(f"note: {note}")
        for number, call in enumerate(frame["calls"]):
            lines.append(f"call {number}: {call['flow']} {one_line(call['input'], 400 if not full else 10**9)}")
            lines.append(f"  -> {call['outcome']} in {int(call['ms'] or 0)} ms")
            shown = result_text(call["value"]) if call["outcome"] == "success" else one_line(
                call.get("error") or call.get("value"), 2000)
            if shown:
                lines.append("  ```")
                lines.append(clip(shown, RESULT_HEAD, full))
                lines.append("  ```")
            if call.get("child"):
                lines.extend(child_lines(call["child"], full))
        for text in frame["prints"]:
            if text:
                lines.append(f"printed ({len(text):,} chars):")
                lines.append("  ```")
                lines.append(clip(text, HEAD, full))
                lines.append("  ```")
        for side in frame["side"]:
            lines.append(f"other model call: {one_line(side)}")
        end = frame.get("end") or {}
        lines.append(f"end: {one_line(end, 500)}  time: {one_line(frame.get('time') or {})}")
        lines.append("")
    return "\n".join(lines)


def page(text: str, title: str) -> str:
    return ("<!doctype html><meta charset=\"utf-8\"><title>" + html.escape(title) + "</title>"
            "<style>body{font:14px/1.5 ui-monospace,Menlo,monospace;margin:24px;max-width:1200px;"
            "background:#fff;color:#111}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}"
            "pre{white-space:pre-wrap;word-break:break-word}</style><pre>" + html.escape(text) + "</pre>")


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    if not args:
        sys.stderr.write(__doc__ or "")
        return 2
    full = "--full" in argv
    only = int(argv[argv.index("--frame") + 1]) if "--frame" in argv else None
    out = argv[argv.index("--html") + 1] if "--html" in argv else None
    args = [a for a in args if a not in {out, str(only)}]
    target = Path(args[0])
    directory = flows_dir(target)
    journal = calls.journal_path(directory) if directory is not None else None
    if journal is None:
        sys.stderr.write(f"trace: no harness journal under {target}\n")
        return 1
    text = render(fold(calls.read_journal(journal)), full=full, only=only)
    if out is not None:
        Path(out).write_text(page(text, f"trace {target.name}"), encoding="utf-8")
        print(out)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
