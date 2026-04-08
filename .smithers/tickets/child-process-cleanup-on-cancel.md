# Child processes not killed on workflow cancel

## Problem

Cancelling running workflows does not kill grandchild processes. When a user
cancels workflows (e.g. via Ctrl-C or the cancel API), only the direct child
process gets SIGTERM/SIGKILL — but any processes that child spawned (Claude
agents, git, npm, etc.) survive and keep running. This leads to unbounded
process accumulation.

### Observed behavior

User spawned workflows from the wrong worktree, cancelled them, but all
sub-process Claude agents stayed alive. 4 workflow steps were running, each
spawned normal Claude agents, resulting in ~45 zombie Claude processes consuming
resources until manually killed.

### Root cause

Three compounding issues in `src/agents/BaseCliAgent.ts`:

**1. Missing `detached: true` on spawn (line 897)**

```typescript
// BROKEN — no process group
const child = spawn(command, args, {
  cwd,
  env,
  stdio: ["pipe", "pipe", "pipe"],
  // detached: true is missing
});
```

Without `detached: true`, the child is not placed in its own process group.
`child.kill()` only sends the signal to the direct child PID, not to any
processes it spawned. Grandchildren (the actual Claude agent processes) are
orphaned and reparented to init/launchd.

Compare with the working pattern in `src/tools/bash.ts:87` and
`src/effect/child-process.ts:98` which both use `detached: true` and kill
the entire process group via `process.kill(-child.pid, "SIGKILL")`.

**2. `terminateChild()` only kills direct child (lines 965-978)**

```typescript
const terminateChild = () => {
  child.kill("SIGTERM");       // only the direct child
  setTimeout(() => {
    child.kill("SIGKILL");     // only the direct child
  }, 250);
};
```

Even if `terminateChild()` fires, it sends signals to `child.pid` not
`-child.pid` (the process group). The correct pattern (already used elsewhere
in the codebase) is:

```typescript
process.kill(-child.pid!, "SIGTERM");
setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 250);
```

**3. Signal handler race condition (lines 993-999)**

```typescript
if (signal) {
  if (signal.aborted) {
    kill("CLI aborted");
  } else {
    signal.addEventListener("abort", () => kill("CLI aborted"), { once: true });
  }
}
```

The abort listener is registered inside the `Effect.async` callback. If the
abort signal fires before line 997 executes, `terminateChild()` is never
called. The Effect.async cleanup handler (lines 1173-1184) is the fallback, but
it only runs on Effect interruption — not on raw signal abort. If the abort path
doesn't go through Effect's interrupt mechanism, cleanup is skipped entirely.

## Fix

### 1. Add `detached: true` to spawn

```typescript
const child = spawn(command, args, {
  cwd,
  env,
  stdio: ["pipe", "pipe", "pipe"],
  detached: true,
});
```

### 2. Kill the process group in `terminateChild()`

```typescript
const terminateChild = () => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // process group already exited
  }
  const killTimer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already dead
    }
  }, 250);
  child.once("close", () => clearTimeout(killTimer));
};
```

### 3. Prevent detached child from keeping terminal

When using `detached: true`, the child process can keep the parent's terminal
alive. Call `child.unref()` after spawn so Node doesn't wait for it on exit
(the explicit `terminateChild()` handles cleanup instead).

## Files

- `src/agents/BaseCliAgent.ts:897` — spawn options
- `src/agents/BaseCliAgent.ts:965-978` — `terminateChild()` function
- `src/agents/BaseCliAgent.ts:993-999` — signal listener registration
- `src/effect/child-process.ts:98` — reference implementation (working pattern)
- `src/tools/bash.ts:87` — reference implementation (working pattern)

## Related

- `src/external/python-subprocess.ts:31-38` — uses `spawnSync()` which has a
  similar issue (no abort signal support), but is synchronous so it's a
  different class of problem.
