#!/usr/bin/env python3
"""Every model call of a trial as one row, the same row for both arms.

    python3 packages/smithers/agent/harness/benchmarks/harbor/calls.py <trial-dir>... [--json]

A trial's time and tokens are its model calls and what ran between them. This
module folds what a trial directory holds into one row per call, the totals
by purpose, where the wall clock went, and how call time scales with tokens.
`smithers_agent.py` writes the rows into the trial's trajectory; `report.py`
compares the two arms with them. It reads, in this order:

    agent/sessions/**/rollout-*.jsonl   the Codex CLI's session log
    agent/workspace/.flows/control.db   the harness journal, where it is kept
    agent/trajectory.json               the journal as the adapter folded it
                                        (`extra.calls`), where it is not
    agent/trajectory.json               its steps alone: the agent's own calls

A row:

    purpose          frame       the agent's own call
                     compaction  a compaction summary call
                     judge       a supervisor reading
                     marks       a compaction-marks reading
                     claim       a completion check
                     relevance   the reading that picks context before frame 0
                     reading     an evaluator reading the agent's own cell asked for
    start, end       ISO-8601, UTC
    durationMs       whole milliseconds
    inputTokens, cachedTokens, outputTokens
    thinkingTokens, writtenTokens
                     output split into reasoning and everything else
    totalTokens      input + output, or the ledger's spend for a call the
                     journal settles without a usage record
    settled          false when the record holds no settle for the call
    stages           when the harness saw the call's stream reach each stage,
                     in milliseconds from the call's start, when recorded
    timing           the same for the wire, when recorded
    retried          what each failed try was and how long it ran
    work             what the reply's cell amounted to: its kind and calls
    costUsd          the call's cost as the journal priced it
    derived          the fields computed from event times, the ledger or
                     other counts instead of read off the record

Every Codex request is a `frame` row: the CLI has no judge. Its `timing` is
`firstItemMs`, when the log shows the reply's first item: a message's start or
a reasoning block's end. It is an upper bound on the wait before the first
token, and a tight one only for a reply that opens with a message.

The time split sums to the record's span, first event to last. Where the
harness timed a frame itself (`turn-closed.time`), the frame's parts are taken
as recorded: its model calls, its compaction, its cell, and what the loop
waited on the judge. Outside those frames, and in a journal or a session log
that timed none, a second is counted once, for the first of these that was
running: the agent's own model call, a compaction call, a command, a judge
reading. `time.derived` names the parts that hold any such time. A judge
reading that ran beside a model call costs nothing either way; its latency is
in the totals by purpose.
"""
from __future__ import annotations

import json
import sqlite3
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

PURPOSES = ("frame", "compaction", "judge", "marks", "claim", "relevance", "reading")
# The harness's own judge readings. `reading` is a command the agent's cell ran.
READINGS = ("judge", "marks", "claim", "relevance")
# The Codex subscription's meter, as measured on 25k local turns: one percent
# of a week is the same count of these whatever the mix (`weighted`).
WEIGHTS = {"uncached": 1.0, "cached": 0.1, "output": 8.0}
FIT_MINIMUM = 4
USAGE_EVENT = "flows.agent.usage.v1"
SETTLED_READINGS = {
    "control.agent.supervisor-settled": "judge",
    "control.agent.claim-demanded": "claim",
    "control.agent.relevance-settled": "relevance",
}
# A decision's classifier names its reading. Those three are also summed on
# the event above, which carries the usage; counting both would double it.
CLASSIFIERS = {"compaction": "marks", "supervisor": "judge", "completion": "claim", "relevance": "relevance"}
SUMMED_ELSEWHERE = ("supervisor/", "completion/", "relevance/")
TOOL_OUTPUTS = ("custom_tool_call_output", "function_call_output")
REPLY_ITEMS = ("reasoning", "custom_tool_call", "function_call")
JOURNAL_FILES = ("control.db", "engine.db")
SPLIT = ("modelMs", "compactionMs", "commandsMs", "judgeMs")
# A frame's own clock, as `turn-closed.time` names its parts, beside ours.
FRAME_PARTS = {"modelMs": "modelMs", "compactionMs": "compactionMs", "cellMs": "commandsMs", "judgeMs": "judgeMs"}
UNLABELLED = "unlabelled"
STAGE_FIT_MINIMUM = 3


AGENT = "control.agent."
CHILD = "control.child."


def scoped(event: dict[str, Any]) -> tuple[str, str | None]:
    """An event's type as the agent's own, and whose run it is.

    A markdown child's records are `control.child.*`, each payload carrying
    `child: {callId, flow, scope}` (`AgentSession.childTracer`). They read as
    the `control.agent.*` record of the same name, scoped to the child's
    session; the run's own records, and every other record, have scope None.
    Call ids are unique within one scope only."""
    kind = event["type"]
    if not kind.startswith(CHILD):
        return kind, None
    payload = event["payload"] if isinstance(event["payload"], dict) else {}
    child = payload.get("child") if isinstance(payload.get("child"), dict) else {}
    return AGENT + kind[len(CHILD):], str(child.get("scope"))


def _count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def _cost(value: Any) -> float | None:
    return None if isinstance(value, bool) or not isinstance(value, (int, float)) else float(value)


def iso(millis: int | None) -> str | None:
    if millis is None:
        return None
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _millis(stamp: Any) -> int | None:
    if not isinstance(stamp, str):
        return None
    try:
        return round(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def weighted(input_tokens: int | None, cached_tokens: int | None, output_tokens: int | None) -> float | None:
    """Uncached input, a tenth of cached input and eight times output."""
    if input_tokens is None or output_tokens is None:
        return None
    cached = cached_tokens or 0
    return round(WEIGHTS["uncached"] * (input_tokens - cached) + WEIGHTS["cached"] * cached
                 + WEIGHTS["output"] * output_tokens, 1)


def journal_path(flows_dir: Path) -> Path | None:
    """The database under `.flows/` that holds the agent's control events.

    rc.1 writes them to `control.db`; the SWE-bench rig's archived journals
    are `engine.db`. Whichever file carries a `control.agent.*` row is the
    journal; a file that exists but carries none is not it.
    """
    for name in JOURNAL_FILES:
        candidate = flows_dir / name
        if not candidate.is_file():
            continue
        try:
            connection = sqlite3.connect(f"file:{candidate}?mode=ro", uri=True)
            try:
                row = connection.execute(
                    "select 1 from flows_journal_events where event_type like 'control.agent.%' limit 1"
                ).fetchone()
            finally:
                connection.close()
        except sqlite3.Error:
            continue
        if row is not None:
            return candidate
    return None


def read_journal(path: Path) -> list[dict[str, Any]]:
    """Every event of the run's journal, in sequence, payloads decoded."""
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "select seq, emitted_at_ms, event_type, payload_json from flows_journal_events order by seq"
        ).fetchall()
    finally:
        connection.close()
    events = []
    for seq, emitted_at_ms, event_type, payload_json in rows:
        try:
            payload = json.loads(payload_json)
        except ValueError:
            payload = {}
        events.append({"seq": seq, "at": emitted_at_ms, "type": event_type, "payload": payload if isinstance(payload, dict) else {}})
    return events


def _row(purpose: str, start: int | None, end: int | None, duration: int | None, counters: Any = None, *,
         split: Any = None, derived: Iterable[str] = (), settled: bool = True, **fields: Any) -> dict[str, Any]:
    """One call. `counters` is a usage record in the harness's names; `split`
    is the harness's own `output` record, read when it is there. Without one
    the written tokens are output minus reasoning, and say so in `derived`."""
    counters = counters if isinstance(counters, dict) else {}
    split = split if isinstance(split, dict) else {}
    given, output = _count(counters.get("inputTokens")), _count(counters.get("outputTokens"))
    thinking, written = _count(counters.get("reasoningTokens")), _count(split.get("written"))
    thinking = _count(split.get("thinking")) if thinking is None else thinking
    derived = set(derived)
    if written is None and output is not None and thinking is not None:
        written = output - thinking
        derived.add("writtenTokens")
    return {
        "purpose": purpose,
        "start": iso(start),
        "end": iso(end),
        "durationMs": duration,
        "inputTokens": given,
        "cachedTokens": _count(counters.get("cachedInputTokens")),
        "outputTokens": output,
        "thinkingTokens": thinking,
        "writtenTokens": written,
        "totalTokens": given + output if given is not None and output is not None else None,
        "settled": settled,
        **{name: value for name, value in fields.items() if value is not None},
        "derived": sorted(derived),
    }


def _zero() -> dict[str, Any]:
    return {"calls": 0, "unsettled": 0, "tokenless": 0, "inputTokens": None, "cachedTokens": None,
            "outputTokens": None, "thinkingTokens": None, "writtenTokens": None, "totalTokens": 0,
            "unsplitTokens": 0, "durationMs": 0}


def totals(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Calls, tokens and time by purpose, and their sum over every purpose.

    A split count (`inputTokens` and the four beside it) is the sum over the
    rows that have one and null when none does. `totalTokens` also holds the
    calls known only as a sum, which `unsplitTokens` counts; `tokenless`
    counts the calls no total includes.
    """
    by_purpose: dict[str, dict[str, Any]] = {}
    everything = _zero()
    for row in rows:
        for total in (by_purpose.setdefault(row["purpose"], _zero()), everything):
            total["calls"] += 1
            total["unsettled"] += 0 if row.get("settled", True) else 1
            total["durationMs"] += row.get("durationMs") or 0
            for name in ("inputTokens", "cachedTokens", "outputTokens", "thinkingTokens", "writtenTokens"):
                if row.get(name) is not None:
                    total[name] = (total[name] or 0) + row[name]
            if row.get("totalTokens") is None:
                total["tokenless"] += 1
                continue
            total["totalTokens"] += row["totalTokens"]
            if row.get("inputTokens") is None:
                total["unsplitTokens"] += row["totalTokens"]
    known = [purpose for purpose in PURPOSES if purpose in by_purpose]
    ordered = {purpose: by_purpose[purpose] for purpose in known + sorted(set(by_purpose) - set(known))}
    return {"byPurpose": ordered, "allPurposes": everything}


def _union(intervals: Iterable[tuple[int, int]]) -> list[list[int]]:
    merged: list[list[int]] = []
    for start, end in sorted(interval for interval in intervals if interval[1] > interval[0]):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def _split(first: int, last: int, layers: list[list[tuple[int, int]]],
           frames: Iterable[tuple[int, int, dict[str, int]]] = ()) -> dict[str, Any]:
    """Where `first..last` went: `SPLIT`'s four parts and `otherMs`.

    `frames` are the frames whose own clock the journal recorded, each its
    start, its end and its parts. Their time is taken as recorded. `layers`
    are the intervals read off event times, one list per part, and count only
    outside every recorded frame, a second once, earlier parts first.
    `derived` names the parts that hold any such time and `recordedMs` is what
    the frames' clocks cover.
    """
    frames = list(frames)
    time: dict[str, Any] = {"spanMs": last - first}
    taken = _union((max(start, first), min(end, last)) for start, end, _ in frames)
    derived = []
    for name, intervals in zip(SPLIT, layers):
        clipped = [(max(start, first), min(end, last)) for start, end in intervals]
        grown = _union([*map(tuple, taken), *clipped])
        outside = sum(end - start for start, end in grown) - sum(end - start for start, end in taken)
        time[name] = outside + sum(parts.get(name, 0) for _, _, parts in frames)
        if outside:
            derived.append(name)
        taken = grown
    time["otherMs"] = time["spanMs"] - sum(time[name] for name in SPLIT)
    if time["spanMs"] > sum(end - start for start, end in taken):
        derived.append("otherMs")
    time["recordedMs"] = sum(end - start for start, end, _ in frames)
    time["derived"] = sorted(derived)
    return time


def _folded(calls: list[tuple[int, dict[str, Any]]], time: dict[str, Any] | None, ledger: int | None,
            entries: int = 0, labelled: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    rows = [row for _, row in sorted(calls, key=lambda entry: entry[0])]
    return {"calls": rows, **totals(rows), "ledgerTokens": ledger, "ledgerEntries": entries,
            "ledgerByPurpose": _by_purpose(labelled), "time": time}


def _by_purpose(labelled: dict[str, dict[str, Any]] | None) -> dict[str, dict[str, Any]] | None:
    """The ledger's spend under each purpose it names, `PURPOSES` first; None
    for a ledger that names none."""
    if not labelled or set(labelled) == {UNLABELLED}:
        return None
    known = [purpose for purpose in PURPOSES if purpose in labelled]
    return {purpose: {"tokens": labelled[purpose]["tokens"],
                      "costUsd": None if labelled[purpose]["costUsd"] is None else round(labelled[purpose]["costUsd"], 9)}
            for purpose in known + sorted(set(labelled) - set(known))}


def _record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def fold_journal(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Folds the harness journal into call rows, totals and the time split.

    A trail event's payload names the time it happened (`at`); the journal
    row's own time is when its batch was flushed, and is used only for an
    event without one. `ledgerTokens` is every `flows.agent.usage.v1` spend,
    the ones the engine wraps included: the run's own total, which the rows
    must sum to. `compactions` is one record per compaction, whether or not
    it made a summary call.

    What the journal records is read, and `derived` names what is not:

        model-settled       purpose, frame, attempt, reask, stages, tries,
                            output, timing, servedTier, costUsd
        model-retried       code, delayMillis, elapsedMs, httpStatus
        compaction-settled  summaryCall, causes, context, removed, durationMillis
        a judge reading     timing, costUsd, triggers, compact, compactSuppressed
        cell-settled        work, on the row of the reply whose cell it was
        cell-call-settled   durationMillis
        turn-closed         time, the frame's own clock
        the usage ledger    purpose, frame, parts

    A journal from before them gives the same rows from the request's keys,
    the times between events and the ledger's spend. A judge reading's
    purpose follows from the event that settled it, in either journal; the
    ledger names the same purposes and `ledgerByPurpose` totals them.
    """
    calls: list[tuple[int, dict[str, Any]]] = []
    compactions: list[dict[str, Any]] = []
    layers: dict[str, list[tuple[int, int]]] = {name: [] for name in SPLIT}
    frames: list[tuple[int, int, dict[str, int]]] = []
    opened: dict[str, Any] | None = None
    seat_row: dict[str, Any] | None = None
    started: dict[str, int] = {}
    anonymous: list[int] = []
    ledger: int | None = None
    entries = 0
    labelled: dict[str, dict[str, Any]] = {}
    first = last = None

    def charge(purpose: Any, spent: int | None, cost: float | None) -> None:
        if spent is None:
            return
        held = labelled.setdefault(purpose if isinstance(purpose, str) else UNLABELLED, {"tokens": 0, "costUsd": None})
        held["tokens"] += spent
        if cost is not None:
            held["costUsd"] = (held["costUsd"] or 0.0) + cost

    def add(row: dict[str, Any], start: int, end: int) -> dict[str, Any]:
        purpose = row["purpose"]
        layer = "modelMs" if purpose == "frame" else "compactionMs" if purpose == "compaction" else \
            "judgeMs" if purpose in READINGS else None
        if layer is not None:
            layers[layer].append((start, end))
        calls.append((start, row))
        return row

    def unasked(purpose: str) -> dict[str, Any]:
        """A settle with no request before it: an older journal's, or a fragment's."""
        return {"purpose": purpose, "derived": {"purpose", "start"}, "start": None, "frame": None, "attempt": None,
                "model": None, "reask": None, "retried": [], "spent": None}

    def settle(call: dict[str, Any], record: dict[str, Any], at: int, ends_at_record: bool) -> dict[str, Any]:
        """The row of a call its record settles: a `model-settled` payload,
        which ends the call, or a compaction's `summaryCall`, which is
        written when the whole compaction ends."""
        duration, derived = _count(record.get("durationMillis")), set(call["derived"])
        start = call["start"] if call["start"] is not None else at - (duration or 0)
        if duration is None:
            duration = at - start
            derived.add("durationMs")
        end = at if ends_at_record else min(at, start + duration)
        purpose = record.get("purpose")
        if isinstance(purpose, str):
            derived.discard("purpose")
        frame, attempt = _count(record.get("frame")), _count(record.get("attempt"))
        return add(_row(
            purpose if isinstance(purpose, str) else call["purpose"], start, end, duration, record.get("usage"),
            split=record.get("output"), derived=derived, frame=call["frame"] if frame is None else frame,
            attempt=call["attempt"] if attempt is None else attempt, model=call["model"],
            reask=record.get("reask") or call["reask"], **retried(call), tries=_count(record.get("tries")),
            stages=_record(record.get("stages")), timing=_record(record.get("timing")),
            servedTier=record.get("servedTier"), costUsd=_cost(record.get("costUsd"))), start, end)

    def retried(call: dict[str, Any]) -> dict[str, Any]:
        """A call's retry notices: how many, and what each failed try was."""
        return {"retries": len(call["retried"]) or None, "retried": call["retried"] or None}

    def unsettled(call: dict[str, Any], end: int, derived: set[str]) -> dict[str, Any]:
        row = _row(call["purpose"], call["start"], end, end - call["start"], settled=False,
                   derived={*call["derived"], *derived, "durationMs"}, frame=call["frame"], attempt=call["attempt"],
                   model=call["model"], reask=call["reask"], **retried(call))
        if call["spent"] is not None:
            row["totalTokens"] = call["spent"]
            row["derived"] = sorted({*row["derived"], "totalTokens"})
        return add(row, call["start"], end)

    for event in events:
        kind, payload = event["type"], event["payload"]
        at = _count(payload.get("at"))
        at = event["at"] if at is None else at
        first = at if first is None else min(first, at)
        last = at if last is None else max(last, at)
        if kind == "control.engine.event" and payload.get("eventType") == USAGE_EVENT:
            kind, payload = USAGE_EVENT, _record(payload.get("payload")) or {}
        if kind == USAGE_EVENT:
            spent = _count(payload.get("spent"))
            if spent is not None:
                ledger = (ledger or 0) + spent
                entries += 1
                # One charge for readings of more than one purpose says each one's share.
                parts = [part for part in payload.get("parts") or [] if isinstance(part, dict)] \
                    if isinstance(payload.get("parts"), list) else []
                for part in parts or [payload]:
                    charge(part.get("purpose"), _count(part.get("spent")), _cost(part.get("costUsd")))
                # The spend of a call in flight: labelled so, or in a ledger
                # from before labels, the one charge whose key names no boundary.
                own = payload.get("purpose") == opened["purpose"] if opened is not None and "purpose" in payload else \
                    "/" not in str(payload.get("stepKey"))
                if opened is not None and own:
                    opened["spent"] = spent
        elif kind == "control.agent.model-requested":
            if opened is not None:
                seat_row = unsettled(opened, at, {"end"})
            purpose = payload.get("purpose")
            opened = {"purpose": purpose if isinstance(purpose, str) else "frame",
                      "derived": set() if isinstance(purpose, str) else {"purpose"}, "start": at,
                      "frame": _count(payload.get("frame")), "attempt": _count(payload.get("attempt")),
                      "model": payload.get("modelId"), "reask": payload.get("reask"), "retried": [], "spent": None}
        elif kind == "control.agent.model-retried":
            if opened is not None:
                opened["retried"].append({name: payload[name] for name in ("code", "delayMillis", "elapsedMs", "httpStatus")
                                          if isinstance(payload.get(name), (str, int, float))
                                          and not isinstance(payload.get(name), bool)})
        elif kind == "control.agent.model-settled":
            seat_row, opened = settle(opened or unasked("frame"), payload, at, True), None
        elif kind == "control.agent.compaction-settled":
            call = opened if opened is not None and opened["purpose"] == "compaction" else None
            opened = None if call is not None else opened
            summary, whole = _record(payload.get("summaryCall")), _count(payload.get("durationMillis"))
            record = {"at": iso(at), "frame": _count(payload.get("frame")) if call is None else call["frame"],
                      "durationMs": whole, "summaryCall": summary is not None or call is not None, "derived": []}
            if summary is not None:
                settle(call or unasked("compaction"), summary, at, False)
            elif call is not None:
                unsettled(call, at, set())
            if whole is None and call is not None:
                # No duration was recorded: the time from the summary call's request is the least it took.
                record["durationMs"], record["derived"] = at - call["start"], ["durationMs"]
            if record["durationMs"] is not None:
                layers["compactionMs"].append((at - record["durationMs"], at))
            for name, shape in (("causes", list), ("marks", dict), ("context", dict), ("removed", int)):
                if isinstance(payload.get(name), shape) and not isinstance(payload.get(name), bool):
                    record[name] = payload[name]
            compactions.append(record)
        elif kind == "control.agent.cell-rejected-in-frame":
            if seat_row is not None:
                seat_row["rejected"] = str(payload.get("code"))
        elif kind in SETTLED_READINGS or kind == "control.agent.decision-settled":
            counters, classifier = payload.get("usage"), payload.get("classifier")
            mapped = SETTLED_READINGS.get(kind)
            if mapped is None:
                if not isinstance(counters, dict) or str(classifier).startswith(SUMMED_ELSEWHERE):
                    continue
                mapped = CLASSIFIERS.get(str(classifier).split("/", 1)[0], "judge")
            purpose, latency = payload.get("purpose"), _count(payload.get("latencyMs"))
            add(_row(purpose if isinstance(purpose, str) else mapped, at - (latency or 0), at, latency, counters,
                     derived=() if isinstance(purpose, str) else ("purpose",), frame=_count(payload.get("frame")),
                     model=counters.get("modelId") if isinstance(counters, dict) else None,
                     classifier=classifier if isinstance(classifier, str) else None,
                     timing=_record(payload.get("timing")), costUsd=_cost(payload.get("costUsd")),
                     triggers=payload.get("triggers") if isinstance(payload.get("triggers"), list) else None,
                     compact=payload.get("compact") if isinstance(payload.get("compact"), list) else None,
                     compactSuppressed=payload.get("compactSuppressed") if isinstance(payload.get("compactSuppressed"), str)
                     else None), at - (latency or 0), at)
        elif kind == "control.agent.cell-call-started":
            if payload.get("callId") is None:
                anonymous.append(at)
            else:
                started[str(payload["callId"])] = at
        elif kind == "control.agent.cell-call-settled":
            begun = started.pop(str(payload["callId"]), None) if payload.get("callId") is not None else \
                anonymous.pop(0) if anonymous else None
            took = _count(payload.get("durationMillis"))
            if took is not None or begun is not None:
                layers["commandsMs"].append((at - took if took is not None else begun, at))
            value = payload.get("value")
            counters = value.get("usage") if isinstance(value, dict) else None
            if isinstance(counters, dict):
                latency, derived = _count(value.get("latencyMs")), {"purpose"}
                latency = took if latency is None else latency
                if latency is None and begun is not None:
                    latency = at - begun
                    derived.add("durationMs")
                add(_row("reading", at - (latency or 0), at, latency, counters, derived=derived,
                         model=counters.get("modelId"), flow=payload.get("flowName")), at - (latency or 0), at)
        elif kind == "control.agent.cell-settled":
            # What the reply's cell amounted to. A reply rejected in its
            # frame has no cell of its own: the frame asks again, and the cell
            # that settles is the next reply's.
            work = _record(payload.get("work"))
            if work is not None and seat_row is not None and seat_row["purpose"] == "frame" and "work" not in seat_row \
                    and ("rejected" not in seat_row or work.get("kind") == "rejected"):
                seat_row["work"] = work
        elif kind == "control.agent.turn-closed":
            clock = _record(payload.get("time"))
            wall = _count(clock.get("wallMs")) if clock is not None else None
            if wall is not None:
                frames.append((at - wall, at, {ours: _count(clock.get(theirs)) or 0 for theirs, ours in FRAME_PARTS.items()}))
    if first is None:
        return {**_folded([], None, ledger, entries, labelled), "compactions": []}
    if opened is not None:
        unsettled(opened, last, {"end"})
    layers["commandsMs"] += [(begun, last) for begun in [*started.values(), *anonymous]]
    time = _split(first, last, [layers[name] for name in SPLIT], frames)
    return {**_folded(calls, time, ledger, entries, labelled), "compactions": compactions}


def fold_session(lines: Iterable[str]) -> dict[str, Any]:
    """Folds a Codex CLI session log into the same rows.

    A request starts at the previous tool output, or the user's message, and
    ends at its `token_usage_record`, whose `usage` is the request's own. The
    time from that record to the last tool output before the next request is
    the commands. `session_meta` carries account and user ids; only the CLI
    version is taken from it.
    """
    session: dict[str, Any] = {"cliVersion": None, "models": [], "efforts": [], "summaries": [], "compactions": 0}
    calls: list[tuple[int, dict[str, Any]]] = []
    model: list[tuple[int, int]] = []
    commands: list[tuple[int, int]] = []
    start = replied = first_item = first = last = None
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        at = _millis(event.get("timestamp")) if isinstance(event, dict) else None
        if at is None:
            continue
        first, last = at if first is None else first, at
        kind = event.get("type")
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        inner = payload.get("type")
        if kind == "session_meta":
            session["cliVersion"] = payload.get("cli_version") or session["cliVersion"]
        elif kind == "turn_context":
            for name, field in (("models", "model"), ("efforts", "effort"), ("summaries", "summary")):
                if isinstance(payload.get(field), str) and payload[field] not in session[name]:
                    session[name].append(payload[field])
        elif kind == "compacted":
            session["compactions"] += 1
        elif kind == "response_item" and (inner in TOOL_OUTPUTS or (inner == "message" and payload.get("role") == "user")):
            if inner in TOOL_OUTPUTS and replied is not None:
                commands.append((replied, at))
            start, first_item = at, None
        elif kind == "response_item" and (inner in REPLY_ITEMS
                                          or (inner == "message" and payload.get("role") == "assistant")):
            first_item = at if first_item is None else min(first_item, at)
        elif kind == "event_msg" and inner == "item_completed":
            item = payload.get("item") if isinstance(payload.get("item"), dict) else {}
            begun = _count(payload.get("started_at_ms"))
            if item.get("type") in ("AgentMessage", "Reasoning") and begun is not None and (start is None or begun >= start):
                first_item = begun if first_item is None else min(first_item, begun)
        elif kind == "token_usage_record" and isinstance(payload.get("usage"), dict):
            used = payload["usage"]
            begun = first if start is None else start
            calls.append((begun, _row(
                "frame", begun, at, at - begun,
                {"inputTokens": used.get("input_tokens"), "cachedInputTokens": used.get("cached_input_tokens"),
                 "outputTokens": used.get("output_tokens"), "reasoningTokens": used.get("reasoning_output_tokens")},
                derived={"durationMs", "start", *(("timing",) if first_item is not None else ())},
                model=session["models"][-1] if session["models"] else None,
                timing={"firstItemMs": first_item - begun} if first_item is not None else None)))
            model.append((begun, at))
            start, replied, first_item = at, at, None
    time = _split(first, last, [model, [], commands, []]) if first is not None else None
    return {**_folded(calls, time, None), "session": session}


def _fold_steps(document: dict[str, Any]) -> dict[str, Any]:
    """The agent's own calls from ATIF steps: all a trajectory written before
    the rows holds. Nothing here says what ran between the calls."""
    calls = []
    for index, step in enumerate(document.get("steps") or []):
        metrics = step.get("metrics") if isinstance(step, dict) else None
        if not isinstance(metrics, dict):
            continue
        extra = metrics.get("extra") if isinstance(metrics.get("extra"), dict) else {}
        start, duration = _millis(step.get("timestamp")), _count(extra.get("duration_millis"))
        end = start + duration if start is not None and duration is not None else None
        calls.append((index, _row(
            str(extra.get("purpose") or "frame"), start, end, duration,
            {"inputTokens": metrics.get("prompt_tokens"), "cachedInputTokens": metrics.get("cached_tokens"),
             "outputTokens": metrics.get("completion_tokens"),
             "reasoningTokens": extra.get("reasoning_tokens", extra.get("reasoning_output_tokens"))},
            derived=() if extra.get("purpose") else ("purpose",))))
    folded = _folded(calls, None, None)
    timed = [row["durationMs"] for row in folded["calls"] if row["durationMs"] is not None]
    if timed:
        folded["time"] = {"spanMs": None, "modelMs": sum(timed), "compactionMs": None, "commandsMs": None,
                          "judgeMs": None, "otherMs": None, "recordedMs": None, "derived": []}
    # One step per frame dropped a frame's earlier replies from the steps and
    # kept them in the totals: the difference is the input no row lists.
    total = _count((document.get("final_metrics") or {}).get("total_prompt_tokens"))
    listed = sum(row["inputTokens"] or 0 for row in folded["calls"])
    if total is not None and folded["calls"] and total > listed:
        folded["unlistedInputTokens"] = total - listed
    return folded


def read_trial(trial: Path) -> dict[str, Any]:
    """The call rows of one trial directory, from the best record it holds;
    `source` names which: `session`, `trajectory`, `journal`, `steps` or None."""
    read = _read_trial(trial)
    try:
        wall = json.loads((trial / "agent" / "smithers-run.json").read_text()).get("wallSec")
    except (OSError, ValueError, AttributeError):
        wall = None
    if isinstance(wall, (int, float)) and not isinstance(wall, bool):
        read["wallSec"] = wall
    return read


def _read_trial(trial: Path) -> dict[str, Any]:
    agent = trial / "agent"
    rollouts = sorted((agent / "sessions").glob("**/rollout-*.jsonl")) if (agent / "sessions").is_dir() else []
    if rollouts:
        lines = [line for rollout in rollouts for line in rollout.read_text(errors="replace").splitlines()]
        folded = fold_session(lines)
        if folded["calls"]:
            return {"source": "session", **folded}
    # The kept journal before the trajectory: the trajectory is the journal as
    # the adapter of its day folded it, and a later fold reads more of it.
    journal = journal_path(agent / "workspace" / ".flows")
    if journal is not None:
        try:
            folded = fold_journal(read_journal(journal))
        except sqlite3.Error:
            folded = {"calls": []}
        if folded["calls"]:
            return {"source": "journal", **folded}
    try:
        document = json.loads((agent / "trajectory.json").read_text())
    except (OSError, ValueError):
        document = {}
    document = document if isinstance(document, dict) else {}
    extra = document.get("extra") if isinstance(document.get("extra"), dict) else {}
    if isinstance(extra.get("calls"), list):
        rows = [row for row in extra["calls"] if isinstance(row, dict) and isinstance(row.get("purpose"), str)]
        final = (document.get("final_metrics") or {}).get("extra") or {}
        read = {"source": "trajectory", "calls": rows, **totals(rows), "ledgerTokens": final.get("ledgerTokens"),
                "ledgerEntries": _count(final.get("ledgerEntries")) or 0, "ledgerByPurpose": _record(final.get("ledgerByPurpose")),
                "time": _record(final.get("time"))}
        if isinstance(final.get("compactions"), list):
            read["compactions"] = final["compactions"]
        return read
    folded = _fold_steps(document)
    return {"source": "steps" if folded["calls"] else None, **folded}


def _solve(matrix: list[list[float]], vector: list[float]) -> list[float] | None:
    """Gauss-Jordan with partial pivoting; None when the system is singular."""
    size = len(vector)
    scale = max(abs(value) for row in matrix for value in row) or 1.0
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(matrix[row][column]))
        if abs(matrix[pivot][column]) < 1e-9 * scale:
            return None
        matrix[column], matrix[pivot] = matrix[pivot], matrix[column]
        vector[column], vector[pivot] = vector[pivot], vector[column]
        for row in range(size):
            if row != column:
                factor = matrix[row][column] / matrix[column][column]
                matrix[row] = [a - factor * b for a, b in zip(matrix[row], matrix[column])]
                vector[row] -= factor * vector[column]
    return [vector[index] / matrix[index][index] for index in range(size)]


def fit(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Least squares of call seconds on thinking and written tokens:

        seconds = fixed + thinking * a + written * b

    over the agent's own settled calls that report both counts. Fewer than
    four, or counts that move together, have no fit. `fixedSeconds` is what a
    call costs before its first token; the other two are milliseconds a token.
    """
    points = [(row["thinkingTokens"], row["writtenTokens"], row["durationMs"] / 1000) for row in rows
              if row.get("purpose") == "frame" and row.get("settled", True) and row.get("durationMs") is not None
              and row.get("thinkingTokens") is not None and row.get("writtenTokens") is not None]
    if len(points) < FIT_MINIMUM:
        return None
    # Tokens are scaled to thousands so the three columns are of one size.
    design = [(1.0, thinking / 1000, written / 1000) for thinking, written, _ in points]
    seconds = [point[2] for point in points]
    normal = [[sum(row[i] * row[j] for row in design) for j in range(3)] for i in range(3)]
    solved = _solve(normal, [sum(row[i] * value for row, value in zip(design, seconds)) for i in range(3)])
    if solved is None:
        return None
    mean = sum(seconds) / len(seconds)
    spread = sum((value - mean) ** 2 for value in seconds)
    residual = sum((value - sum(a * b for a, b in zip(solved, row))) ** 2 for row, value in zip(design, seconds))
    # Adding zero turns a rounded -0.0 into 0.0.
    fixed, thinking, written = (round(value, 3) + 0.0 for value in solved)
    return {"calls": len(points), "fixedSeconds": fixed, "msPerThinkingToken": thinking, "msPerWrittenToken": written,
            "r2": round(1 - residual / spread, 4) if spread > 0 else None}


def _line(points: list[tuple[int, int]]) -> tuple[float, float, float | None] | None:
    """Least squares of y on x: the intercept, the slope and R squared; None
    for fewer than three points or an x that never moves."""
    if len(points) < STAGE_FIT_MINIMUM:
        return None
    mean_x, mean_y = (sum(point[axis] for point in points) / len(points) for axis in (0, 1))
    spread_x = sum((x - mean_x) ** 2 for x, _ in points)
    if spread_x == 0:
        return None
    slope = sum((x - mean_x) * (y - mean_y) for x, y in points) / spread_x
    fixed = mean_y - slope * mean_x
    spread_y = sum((y - mean_y) ** 2 for _, y in points)
    left = sum((y - (fixed + slope * x)) ** 2 for x, y in points)
    return fixed, slope, round(1 - left / spread_y, 4) if spread_y > 0 else None


def stage_fit(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """A call's time by stage, from the wire's `timing` of the agent's own
    settled calls: the mean wait for the response headers, then

        firstOutputMs - headersMs     = fixed + thinking tokens x a
        lastOutputMs  - firstOutputMs = fixed + written tokens x b

    each by least squares. None when no call records the wire's stages, as in
    a journal from before them and in a Codex session log, which has no
    first-token time. A line needs three calls.
    """
    waits: list[int] = []
    thinking: list[tuple[int, int]] = []
    written: list[tuple[int, int]] = []
    for row in rows:
        timing = _record(row.get("timing")) or {}
        headers, begun, ended = (_count(timing.get(name)) for name in ("headersMs", "firstOutputMs", "lastOutputMs"))
        if row.get("purpose") != "frame" or not row.get("settled", True) or headers is None:
            continue
        waits.append(headers)
        if begun is not None and row.get("thinkingTokens") is not None:
            thinking.append((row["thinkingTokens"], begun - headers))
        if begun is not None and ended is not None and row.get("writtenTokens") is not None:
            written.append((row["writtenTokens"], ended - begun))
    if not waits:
        return None

    def stage(points: list[tuple[int, int]], slope: str) -> dict[str, Any] | None:
        line = _line(points)
        return None if line is None else {"calls": len(points), "fixedMs": round(line[0]), slope: round(line[1], 3) + 0.0,
                                          "r2": line[2]}

    return {"calls": len(waits), "meanHeadersMs": round(sum(waits) / len(waits)),
            "thinking": stage(thinking, "msPerThinkingToken"), "written": stage(written, "msPerWrittenToken")}


# Where a row says when its reply began, the closest reading first: the
# wire's first stream event, the first event the harness saw, which is later
# by whatever the host held back, then the Codex log's first item.
WAITS = (("timing", "firstEventMs"), ("stages", "firstEventMs"), ("timing", "firstItemMs"))


def wait(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The wait before a reply began over the agent's own calls, by the first
    stage in `WAITS` any of them records; None when none does. The Codex
    log's stage is an upper bound for each call, so the least of them is the
    closest it comes to the wait itself."""
    for holder, stage in WAITS:
        waits = [count for count in (_count((_record(row.get(holder)) or {}).get(stage)) for row in rows
                                     if row.get("purpose") == "frame") if count is not None]
        if waits:
            return {"stage": f"{holder}.{stage}", "calls": len(waits), "medianMs": round(statistics.median(waits)),
                    "leastMs": min(waits)}
    return None


STAGE_ORDER = ("preparedMs", "signedMs", "sentMs", "headersMs", "firstEventMs", "firstItemMs", "firstThinkingMs",
               "firstOutputMs", "lastOutputMs", "completedMs", "closedMs")


def stage_medians(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The median offset of every stage the agent's own calls recorded, the
    harness's readings (`stages`) apart from the wire's (`timing`); None when
    no call recorded one. Read down a column, it is where a call's time
    before and during its reply went."""
    found: dict[str, Any] = {}
    for holder in ("stages", "timing"):
        offsets: dict[str, list[int]] = {}
        for row in rows:
            if row.get("purpose") != "frame":
                continue
            for stage, value in (_record(row.get(holder)) or {}).items():
                if stage.endswith("Ms") and _count(value) is not None:
                    offsets.setdefault(stage, []).append(_count(value))
        ordered = [stage for stage in STAGE_ORDER if stage in offsets] + sorted(set(offsets) - set(STAGE_ORDER))
        if ordered:
            found[holder] = {stage: {"calls": len(offsets[stage]), "medianMs": round(statistics.median(offsets[stage]))}
                             for stage in ordered}
    return found or None


def stage_lines(medians: dict[str, Any] | None) -> list[str]:
    """`stage_medians` as text, one line for each of `stages` and `timing`."""
    return [f"median `{holder}` offsets from a call's start: "
            + ", ".join(f"`{stage}` {reading['medianMs'] / 1000:,.1f} s" for stage, reading in stages.items())
            + f" ({max(reading['calls'] for reading in stages.values())} calls)"
            for holder, stages in (medians or {}).items()]


def breakdown(reads: list[dict[str, Any]]) -> dict[str, Any]:
    """One side of a comparison over the trials `read_trial` returned: the
    agent's own calls, where the time went, tokens by purpose and the fit."""
    rows = [row for read in reads for row in read["calls"]]
    own = [row for row in rows if row["purpose"] == "frame"]
    summed = totals(rows)
    frame = summed["byPurpose"].get("frame") or _zero()
    timed = [row["durationMs"] for row in own if row.get("durationMs") is not None]
    time: dict[str, Any] = {name: None for name in ("spanMs", *SPLIT, "otherMs", "recordedMs")}
    split_from_events: set[str] = set()
    for read in reads:
        held = read.get("time") or {}
        for name in time:
            if held.get(name) is not None:
                time[name] = (time[name] or 0) + held[name]
        # A split stored before it said what it derived was all from event times.
        split_from_events.update(held.get("derived", [name for name in (*SPLIT, "otherMs") if held.get("spanMs") is not None]))
    time["derived"] = sorted(split_from_events)
    ledgers = [read["ledgerTokens"] for read in reads if read.get("ledgerTokens") is not None]
    labelled: dict[str, dict[str, Any]] = {}
    for read in reads:
        for purpose, entry in (read.get("ledgerByPurpose") or {}).items():
            held = labelled.setdefault(purpose, {"tokens": 0, "costUsd": None})
            held["tokens"] += entry.get("tokens") or 0
            if entry.get("costUsd") is not None:
                held["costUsd"] = (held["costUsd"] or 0.0) + entry["costUsd"]
    work: dict[str, dict[str, int]] = {}
    classified = any(_record(row.get("work")) for row in own)
    for row in own:
        # A reply rejected in its frame settles no cell, so the journal that
        # classifies cells says nothing of it; it is the kind it names `rejected`.
        kind = (_record(row.get("work")) or {}).get("kind", "rejected" if classified and row.get("rejected") else None)
        if isinstance(kind, str):
            held = work.setdefault(kind, {"calls": 0, "durationMs": 0, "totalTokens": 0})
            held["calls"] += 1
            held["durationMs"] += row.get("durationMs") or 0
            held["totalTokens"] += row.get("totalTokens") or 0
    staged = stage_fit(own)
    sessions = [read["session"] for read in reads if read.get("session")]
    sources: dict[str, int] = {}
    for read in reads:
        sources[str(read["source"])] = sources.get(str(read["source"]), 0) + 1
    side = {
        "trials": len(reads),
        "sources": dict(sorted(sources.items())),
        "modelCalls": len(own),
        "secondsPerCall": round(sum(timed) / len(timed) / 1000, 1) if timed else None,
        "wait": wait(own),
        "stageMedians": stage_medians(own),
        "cacheShare": round(frame["cachedTokens"] / frame["inputTokens"], 4)
        if frame["inputTokens"] and frame["cachedTokens"] is not None else None,
        "thinkingTokens": frame["thinkingTokens"],
        "writtenTokens": frame["writtenTokens"],
        # A record per compaction where the trial has them; else its summary calls, the most an older one shows.
        "compactions": sum(len(read["compactions"]) if isinstance(read.get("compactions"), list)
                           else sum(1 for row in read["calls"] if row["purpose"] == "compaction") for read in reads)
        + sum(session.get("compactions") or 0 for session in sessions),
        "judgeReadings": sum(summed["byPurpose"].get(purpose, {}).get("calls", 0) for purpose in READINGS),
        "time": time,
        "splitTrials": sum(1 for read in reads if (read.get("time") or {}).get("spanMs") is not None),
        "byPurpose": summed["byPurpose"],
        "allPurposes": summed["allPurposes"],
        "ledgerTokens": sum(ledgers) if ledgers else None,
        "ledgerEntries": sum(read.get("ledgerEntries") or 0 for read in reads),
        "ledgerByPurpose": _by_purpose(labelled),
        "unlistedInputTokens": sum(read.get("unlistedInputTokens") or 0 for read in reads),
        "cellWork": dict(sorted(work.items())) or None,
        "fit": fit(own),
        "stageFit": staged,
    }
    if staged is None:
        side["stageFitUnavailable"] = "the Codex session log has no first-token time" if sessions else \
            "no call records the wire's stage times"
    if sessions:
        side["session"] = {
            "cliVersions": sorted({session["cliVersion"] for session in sessions if session.get("cliVersion")}),
            **{name: sorted({value for session in sessions for value in session.get(name) or []})
               for name in ("models", "efforts", "summaries")},
        }
    return side


def _number(value: Any, digits: int = 0) -> str:
    return "-" if value is None else f"{value:,.{digits}f}"


def _seconds(millis: int | None) -> str:
    return "-" if millis is None else f"{millis / 1000:,.1f}"


def split_source(time: dict[str, Any]) -> str:
    """Where a time split came from, as a clause: the frames' own clocks, event times, or both."""
    derived = time.get("derived") or []
    if time.get("recordedMs"):
        return (f"; {_seconds(time['recordedMs'])} s of it on the frames' own clocks"
                + (f"; from event times: {', '.join(derived)}" if derived else ""))
    return "; from event times" if derived else ""


def stage_fit_line(side: dict[str, Any]) -> str:
    """One side's stage fit as a sentence, or why it has none."""
    staged = side.get("stageFit")
    if staged is None:
        return f"no stage fit: {side.get('stageFitUnavailable')}"

    def stage(fitted: dict[str, Any] | None, slope: str, token: str, reached: str) -> str:
        if fitted is None:
            return f"; too few calls to fit the time to the {reached}"
        return (f"; then {fitted['fixedMs'] / 1000:.1f} s + {fitted[slope]:.1f} ms per {token} token to the {reached} "
                f"(R2 {_number(fitted['r2'], 2)})")

    return (f"stage fit over {staged['calls']} calls: headers after {staged['meanHeadersMs'] / 1000:.1f} s"
            + stage(staged["thinking"], "msPerThinkingToken", "thinking", "first output")
            + stage(staged["written"], "msPerWrittenToken", "written", "last"))


def _notes(row: dict[str, Any]) -> str:
    notes = []
    if not row.get("settled", True):
        notes.append("unsettled")
    if row.get("rejected"):
        notes.append(f"rejected {row['rejected']}")
    if row.get("reask"):
        notes.append(f"asked again after {row['reask']}")
    if row.get("retries"):
        # What failed each try and how long it ran, where the journal says.
        failed = ", ".join(" ".join(str(part) for part in (
            lost.get("code"), lost.get("httpStatus"),
            f"after {lost['elapsedMs'] / 1000:.1f} s" if _count(lost.get("elapsedMs")) is not None else None,
        ) if part is not None) for lost in row.get("retried") or [] if isinstance(lost, dict))
        notes.append(f"{row['retries']} retried" + (f" ({failed})" if failed else ""))
    if (row.get("tries") or 1) > 1:
        notes.append(f"{row['tries']} tries")
    for holder, name, label in (("stages", "firstEventMs", "first event"), ("stages", "firstOutputMs", "first output"),
                                ("timing", "headersMs", "headers"), ("timing", "firstItemMs", "first item")):
        reached = _count((_record(row.get(holder)) or {}).get(name))
        if reached is not None:
            notes.append(f"{label} {reached / 1000:.1f} s")
    return ", ".join(notes)


def render(name: str, read: dict[str, Any]) -> str:
    """One trial as text: the summary, the totals by purpose, then every call."""
    side = breakdown([read])
    frame = side["byPurpose"].get("frame") or _zero()
    share = "-" if side["cacheShare"] is None else f"{side['cacheShare'] * 100:.1f}%"
    lines = [f"{name}: {side['modelCalls']} model calls, {_number(side['secondsPerCall'], 1)} s per call, "
             f"cache share {share}",
             f"  record: {read['source']}; weighted tokens "
             f"{_number(weighted(frame['inputTokens'], frame['cachedTokens'], frame['outputTokens']))}"]
    if side["wait"]:
        lines.append(f"  wait before a reply began: median {_seconds(side['wait']['medianMs'])} s, least "
                     f"{_seconds(side['wait']['leastMs'])} s ({side['wait']['stage']}, {side['wait']['calls']} calls)")
    lines += [f"  {line}" for line in stage_lines(side["stageMedians"])]
    for record in read.get("compactions") or []:
        causes = ", ".join(str(cause) for cause in record.get("causes") or []) or "cause not recorded"
        context = _record(record.get("context")) or {}
        sizes = f", context {_number(_count(context.get('before')))} to {_number(_count(context.get('after')))} tokens" \
            if context else ""
        lines.append(f"  compaction before frame {record.get('frame')}: {causes}, {_seconds(record.get('durationMs'))} s{sizes}")
    session = side.get("session")
    if session:
        lines.append(f"  codex-cli {', '.join(session['cliVersions']) or '-'}; effort "
                     f"{', '.join(session['efforts']) or '-'}; summary {', '.join(session['summaries']) or '-'}; "
                     f"compactions {side['compactions']}")
    time = read.get("time")
    if time:
        wall = f"; the adapter's wall clock {read['wallSec']:,.1f} s" if read.get("wallSec") is not None else ""
        lines.append(f"  span {_seconds(time['spanMs'])} s: model {_seconds(time['modelMs'])}, compaction "
                     f"{_seconds(time['compactionMs'])}, commands {_seconds(time['commandsMs'])}, judge "
                     f"{_seconds(time['judgeMs'])}, other {_seconds(time['otherMs'])}{split_source(side['time'])}{wall}")
    if read.get("unlistedInputTokens"):
        lines.append(f"  the trajectory's total holds {read['unlistedInputTokens']:,} input tokens that no step lists")
    fitted = side["fit"]
    if fitted:
        lines.append(f"  fit over {fitted['calls']} calls: {fitted['fixedSeconds']:.1f} s fixed, "
                     f"{fitted['msPerThinkingToken']:.1f} ms per thinking token, {fitted['msPerWrittenToken']:.1f} ms "
                     f"per written token, R2 {_number(fitted['r2'], 2)}")
    lines.append(f"  {stage_fit_line(side)}")
    if read.get("ledgerTokens") is not None:
        missing = read["ledgerTokens"] - side["allPurposes"]["totalTokens"]
        lines.append(f"  ledger {read['ledgerTokens']:,} tokens in {side['ledgerEntries']} entries; rows "
                     f"{side['allPurposes']['totalTokens']:,}" + (f"; {missing:,} in no row" if missing else ""))
    if side["cellWork"]:
        lines.append("  model calls by what their cell did: " + ", ".join(
            f"{kind} {held['calls']} ({_seconds(held['durationMs'])} s)" for kind, held in side["cellWork"].items()))
    ledger = side["ledgerByPurpose"] or {}
    lines += ["", "| Purpose | Calls | Input | Cached | Output | Total | Ledger | Cost USD | Seconds |",
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for purpose, total in side["byPurpose"].items():
        flags = "".join(f" ({total[name]} {name})" for name in ("unsettled", "tokenless") if total[name])
        entry = ledger.get(purpose) or {}
        lines.append(f"| {purpose} | {total['calls']}{flags} | {_number(total['inputTokens'])} | "
                     f"{_number(total['cachedTokens'])} | {_number(total['outputTokens'])} | {total['totalTokens']:,} | "
                     f"{_number(entry.get('tokens'))} | {_number(entry.get('costUsd'), 6)} | "
                     f"{_seconds(total['durationMs'])} |")
    lines += ["", "| # | Purpose | Start | Seconds | Input | Cached | Thinking | Written | Total | Frame | Notes |",
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for index, row in enumerate(read["calls"], 1):
        frame = "-" if row.get("frame") is None else str(row["frame"])
        if (row.get("attempt") or 1) > 1:
            frame += f" try {row['attempt']}"
        counts = " | ".join(_number(row.get(name)) for name in
                            ("inputTokens", "cachedTokens", "thinkingTokens", "writtenTokens", "totalTokens"))
        lines.append(f"| {index} | {row['purpose']} | {(row.get('start') or '-')[11:23]} | "
                     f"{_seconds(row.get('durationMs'))} | {counts} | {frame} | {_notes(row)} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    as_json = "--json" in argv
    trials = [Path(argument) for argument in argv if argument != "--json"]
    if not trials:
        print(__doc__, file=sys.stderr)
        return 64
    reads = [(trial.name, read_trial(trial)) for trial in trials]
    if as_json:
        print(json.dumps([{"trial": name, "source": read["source"], "summary": breakdown([read]), "calls": read["calls"]}
                          for name, read in reads], indent=2))
    else:
        print("\n".join(render(name, read) for name, read in reads), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
