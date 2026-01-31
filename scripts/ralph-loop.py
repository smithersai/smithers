#!/usr/bin/env python3
"""
Ralph Loop - Autonomous Agent Relay System

Runs a continuous loop of AI agents, each with a different focus area.
Agents read RALPH.md, self-discover work, complete one task with TDD, and commit.

Focuses rotate between implementation work (Smithers v2) and maintenance work.
"""

import argparse
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# Project root
PROJECT_ROOT = Path(__file__).parent.parent

# Focus areas that rotate - mix of implementation and maintenance
# Implementation focuses (Smithers v2) come first, then maintenance
FOCUSES = [
    # === Backend (Python) ===
    "AGENTD",           # Agent daemon: session management, tool execution, streaming
    "PROTOCOL",         # Event types, request/response, NDJSON serialization
    "STORAGE",          # SQLite tables, event sourcing, session persistence
    "FOUNDATION",       # Wire core integration: adapters → persistence → UI
    # === Frontend (Swift) ===
    "SWIFT_UI",         # SwiftUI: chat transcript, message rendering, tool cards
    "SWIFT_TERMINAL",   # libghostty integration: terminal drawer, PTY, tabs
    "SWIFT_GRAPH",      # Graph view: canvas, layout engine, selection sync
    "SWIFT_INSPECTOR",  # Inspector panels: Stack, Diff, Todos, Browser, Tools
    # === Features (Python + Swift) ===
    "CHECKPOINTS",      # JJ integration: checkpoint create/restore, stack ops
    "SKILLS",           # Skills system: registry, ⌘K palette, execution
    "SEARCH",           # FTS search: SQLite indexing, global search UI
    # === Maintenance ===
    "TESTING",          # Add missing tests, improve coverage, edge cases
    "TYPE_SAFETY",      # Fix pyright errors, improve type hints
    "BUG_HUNTING",      # Search for bugs, edge cases, race conditions
]

# Focus descriptions for the prompt
FOCUS_DESCRIPTIONS = {
    # Backend (Python)
    "AGENTD": "Python: Agent daemon - session management, tool execution pipeline, streaming events, adapter integration",
    "PROTOCOL": "Python: Protocol - event types, request/response models, NDJSON serialization, schema validation",
    "STORAGE": "Python: Storage - SQLite tables (session_events), event sourcing, session persistence, migrations",
    "FOUNDATION": "Python: Wire core integration - SessionManager → adapters → event persistence → Swift bridge",
    # Frontend (Swift)
    "SWIFT_UI": "Swift: Chat UI - virtualized message list, markdown rendering, streaming text, tool cards, input bar",
    "SWIFT_TERMINAL": "Swift: libghostty integration - terminal drawer, PTY attachment, tab management, CWD tracking",
    "SWIFT_GRAPH": "Swift: Graph view - Canvas renderer, Sugiyama layout, pan/zoom, node selection, chat sync",
    "SWIFT_INSPECTOR": "Swift: Inspector panels - Stack view, Diff viewer, Todos panel, Browser tab, Tool details",
    # Features (Python + Swift)
    "CHECKPOINTS": "Python+Swift: JJ integration - RepoStateService wrapper, checkpoint create/restore, stack UI",
    "SKILLS": "Python+Swift: Skills system - registry, ⌘K palette, execution pipeline, Summarize/Plan/Rebase skills",
    "SEARCH": "Python+Swift: Search - FTS5 indexing, global search UI, result navigation, match highlighting",
    # Maintenance
    "TESTING": "Add missing tests, improve coverage, ensure edge cases are handled (Python and Swift)",
    "TYPE_SAFETY": "Fix pyright errors, improve type hints, add generics where helpful",
    "BUG_HUNTING": "Search for bugs, edge cases, race conditions, security issues",
}

# The prompt template - references RALPH.md for full context
PROMPT_TEMPLATE = """You are an autonomous agent working on the Smithers codebase.

## CRITICAL: Read RALPH.md First

The file `RALPH.md` contains:
- Complete codebase map with file locations and status
- Implementation priority (Tier 0/1/2 tasks)
- Current state assessment
- Workflow instructions
- Commit style guide

**Read RALPH.md before doing anything else.**

## Your Focus: {focus}

{focus_description}

## Always Green Rule

Before ANY work, verify the codebase is green:
```bash
uv run pytest              # ALL tests must pass
uv run pyright             # Type checking must pass
uv run ruff check .        # Linting must pass
```

If ANY check fails, **fix it first** - that IS your task.

## Workflow

1. Read `RALPH.md` (complete instructions)
2. Verify green: `uv run pytest && uv run pyright && uv run ruff check .`
3. If failures → fix them (this IS your task)
4. Read PRD: `prd/smithers-v2-task-guide.md` for task breakdown
5. Identify ONE task matching your focus: {focus}
6. Implement with TDD (test first)
7. Verify green again
8. Commit with emoji conventional commit
9. Done - stop after ONE meaningful task

## Commands

```bash
uv run pytest                    # Run all tests
uv run pytest tests/test_X.py    # Run specific test
uv run pyright                   # Type check
uv run ruff check .              # Lint
uv run ruff format .             # Format
```

## Important

- Read RALPH.md for the complete codebase map
- Python focuses → Python code, Swift focuses → Swift code
- Complete exactly ONE task, then stop
- Quality over quantity
- Always stay green

Now begin. Read RALPH.md, verify green, find your task, complete it, commit it.
"""

LOG_FILE = PROJECT_ROOT / "logs" / "ralph-loop.log"


def log(message: str) -> None:
    """Log a message with timestamp."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[{timestamp}] {message}"
    print(log_line)

    # Also append to log file
    LOG_FILE.parent.mkdir(exist_ok=True)
    with open(LOG_FILE, "a") as f:
        f.write(log_line + "\n")


def verify_green() -> tuple[bool, list[str]]:
    """Verify all checks pass. Returns (success, list of failures)."""
    failures = []

    # Check 1: pytest
    log("Checking pytest...")
    result = subprocess.run(
        ["uv", "run", "pytest", "-x", "-q", "--tb=no"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        failures.append("pytest")
        log(f"  ❌ pytest failed")
    else:
        log(f"  ✅ pytest passed")

    # Check 2: pyright
    log("Checking pyright...")
    result = subprocess.run(
        ["uv", "run", "pyright", "--outputjson"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        failures.append("pyright")
        log(f"  ❌ pyright failed")
    else:
        log(f"  ✅ pyright passed")

    # Check 3: ruff
    log("Checking ruff...")
    result = subprocess.run(
        ["uv", "run", "ruff", "check", "."],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        failures.append("ruff")
        log(f"  ❌ ruff failed")
    else:
        log(f"  ✅ ruff passed")

    return len(failures) == 0, failures


def run_agent(focus: str, cycle: int, agent_cmd: str = "claude") -> bool:
    """Run an AI agent with the given focus. Returns True if successful."""
    focus_description = FOCUS_DESCRIPTIONS.get(focus, f"Work on {focus} tasks")
    prompt = PROMPT_TEMPLATE.format(focus=focus, focus_description=focus_description)

    log(f"=== Cycle {cycle} | Focus: {focus} ===")
    log(f"Starting {agent_cmd} agent...")

    try:
        if agent_cmd == "claude":
            # Claude Code CLI
            cmd = [
                "claude",
                "-p", prompt,
                "--dangerously-skip-permissions",
            ]
        elif agent_cmd == "codex":
            # Codex CLI
            cmd = [
                "codex",
                "exec",
                "--dangerously-bypass-approvals-and-sandbox",
                prompt,
            ]
        else:
            log(f"❌ Unknown agent command: {agent_cmd}")
            return False

        result = subprocess.run(
            cmd,
            cwd=PROJECT_ROOT,
            capture_output=False,  # Let output stream to terminal
            timeout=1800,  # 30 minute timeout per agent
        )

        if result.returncode == 0:
            log(f"✅ Agent completed successfully (focus: {focus})")
            return True
        else:
            log(f"⚠️ Agent exited with code {result.returncode} (focus: {focus})")
            return False

    except subprocess.TimeoutExpired:
        log(f"⏰ Agent timed out after 30 minutes (focus: {focus})")
        return False
    except FileNotFoundError:
        log(f"❌ Error: '{agent_cmd}' command not found. Is it installed?")
        return False
    except Exception as e:
        log(f"❌ Error running agent: {e}")
        return False


def main():
    """Main ralph loop."""
    parser = argparse.ArgumentParser(description="Ralph Loop - Autonomous Agent Relay")
    parser.add_argument(
        "--agent",
        choices=["claude", "codex"],
        default="claude",
        help="Which AI agent CLI to use (default: claude)",
    )
    parser.add_argument(
        "--start-focus",
        choices=FOCUSES,
        default=None,
        help="Start with a specific focus (default: rotate from beginning)",
    )
    parser.add_argument(
        "--implementation-only",
        action="store_true",
        help="Only run implementation focuses (skip maintenance)",
    )
    parser.add_argument(
        "--maintenance-only",
        action="store_true",
        help="Only run maintenance focuses (skip implementation)",
    )
    parser.add_argument(
        "--single",
        action="store_true",
        help="Run only one cycle then exit",
    )
    args = parser.parse_args()

    # Determine which focuses to use
    # Structure: Backend (4) + Frontend (4) + Features (3) + Maintenance (3)
    if args.implementation_only:
        # Backend + Frontend + Features (first 11)
        focuses = FOCUSES[:11]
    elif args.maintenance_only:
        # Maintenance only (last 3)
        focuses = FOCUSES[11:]
    else:
        focuses = FOCUSES

    log("=" * 60)
    log("🚀 Ralph Loop Starting")
    log(f"Project: {PROJECT_ROOT}")
    log(f"Agent: {args.agent}")
    log(f"Focuses: {', '.join(focuses)}")
    log("=" * 60)

    # Initial green verification
    is_green, failures = verify_green()
    if not is_green:
        log(f"⚠️ Codebase not green ({', '.join(failures)}) - first agent will fix")

    cycle = 0
    focus_index = 0

    # Handle --start-focus
    if args.start_focus:
        if args.start_focus in focuses:
            focus_index = focuses.index(args.start_focus)
            log(f"Starting at focus: {args.start_focus}")
        else:
            log(f"⚠️ Focus {args.start_focus} not in active focuses, starting from beginning")

    consecutive_failures = 0
    max_consecutive_failures = 3

    while True:
        cycle += 1
        focus = focuses[focus_index]

        log("")
        log(f"{'=' * 60}")
        log(f"Cycle {cycle} starting (focus: {focus})")
        log(f"{'=' * 60}")

        success = run_agent(focus, cycle, args.agent)

        if success:
            consecutive_failures = 0
            # Verify we're still green after agent work
            is_green, failures = verify_green()
            if not is_green:
                log(f"⚠️ Agent left codebase not green ({', '.join(failures)})")
                consecutive_failures += 1
        else:
            consecutive_failures += 1

        if consecutive_failures >= max_consecutive_failures:
            log(f"⚠️ {max_consecutive_failures} consecutive failures - pausing for 5 minutes")
            time.sleep(300)
            consecutive_failures = 0

        # Single mode - exit after one cycle
        if args.single:
            log("Single mode - exiting after one cycle")
            break

        # Rotate to next focus
        focus_index = (focus_index + 1) % len(focuses)

        # Sleep between runs
        sleep_seconds = 10
        log(f"💤 Sleeping {sleep_seconds} seconds before next cycle...")
        time.sleep(sleep_seconds)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("\n🛑 Ralph Loop stopped by user")
        sys.exit(0)
