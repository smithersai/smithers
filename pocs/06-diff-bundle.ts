/**
 * POC 6: DiffBundle — stateless filesystem change capture for replay
 *
 * Demonstrates how side-effectful tasks capture filesystem changes as
 * serializable diffs instead of relying on actual filesystem state:
 *
 * 1. Before a task runs, capture the "base" state (git ref or file hashes)
 * 2. Task modifies files (simulated agent work)
 * 3. After task, compute diff between base and current state
 * 4. DiffBundle is the task's output — serializable, replayable
 * 5. On replay: apply the DiffBundle instead of re-running the agent
 *
 * This is critical for sandboxes (different filesystem) and replay
 * (deterministic without re-execution).
 *
 * Run: bun run pocs/06-diff-bundle.ts
 */

import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"
import * as os from "node:os"

// ─── DiffBundle types ───────────────────────────────────────────────────────

type FilePatch = {
  path: string
  operation: "add" | "modify" | "delete"
  before: string | null // null for "add"
  after: string | null  // null for "delete"
}

type DiffBundle = {
  seq: number
  baseSnapshot: Map<string, string> // path → content hash
  patches: FilePatch[]
  computedAtMs: number
}

// ─── DiffBundle computation ─────────────────────────────────────────────────

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12)
}

function captureSnapshot(dir: string): Map<string, string> {
  const snapshot = new Map<string, string>()
  if (!fs.existsSync(dir)) return snapshot
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    const filePath = path.join(dir, file as string)
    if (fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath, "utf-8")
      snapshot.set(file as string, hashContent(content))
    }
  }
  return snapshot
}

function computeDiffBundle(
  dir: string,
  baseSnapshot: Map<string, string>,
  seq: number
): DiffBundle {
  const currentSnapshot = captureSnapshot(dir)
  const patches: FilePatch[] = []

  // Find added and modified files
  for (const [filePath, hash] of currentSnapshot) {
    const baseHash = baseSnapshot.get(filePath)
    const fullPath = path.join(dir, filePath)
    const content = fs.readFileSync(fullPath, "utf-8")

    if (!baseHash) {
      patches.push({ path: filePath, operation: "add", before: null, after: content })
    } else if (baseHash !== hash) {
      patches.push({ path: filePath, operation: "modify", before: null, after: content })
    }
  }

  // Find deleted files
  for (const [filePath] of baseSnapshot) {
    if (!currentSnapshot.has(filePath)) {
      patches.push({ path: filePath, operation: "delete", before: null, after: null })
    }
  }

  return { seq, baseSnapshot, patches, computedAtMs: Date.now() }
}

function applyDiffBundle(dir: string, bundle: DiffBundle): void {
  for (const patch of bundle.patches) {
    const fullPath = path.join(dir, patch.path)
    switch (patch.operation) {
      case "add":
      case "modify":
        fs.mkdirSync(path.dirname(fullPath), { recursive: true })
        fs.writeFileSync(fullPath, patch.after!)
        break
      case "delete":
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath)
        break
    }
  }
}

// ─── Simulate the full flow ─────────────────────────────────────────────────

const program = Effect.gen(function* () {
  yield* Effect.log("━━━ POC 6: DiffBundle — stateless filesystem changes ━━━")
  yield* Effect.log("")

  // Create two temp directories: "sandbox" (where agent runs) and "parent" (where we replay)
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "smithers-poc-sandbox-"))
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "smithers-poc-parent-"))

  try {
    // ─── Setup: initial file in both dirs ───────────────────────────────
    const initialContent = `export function auth() {\n  return "basic";\n}\n`
    fs.writeFileSync(path.join(sandboxDir, "auth.ts"), initialContent)
    fs.writeFileSync(path.join(parentDir, "auth.ts"), initialContent)

    yield* Effect.log(`Sandbox dir: ${sandboxDir}`)
    yield* Effect.log(`Parent dir:  ${parentDir}`)
    yield* Effect.log("")

    // ─── Step 1: Capture base snapshot before agent runs ────────────────
    const baseSnapshot = captureSnapshot(sandboxDir)
    yield* Effect.log("Base snapshot captured:")
    for (const [f, h] of baseSnapshot) {
      yield* Effect.log(`  ${f}: ${h}`)
    }
    yield* Effect.log("")

    // ─── Step 2: Simulate agent modifying files (in sandbox) ────────────
    yield* Effect.log("Agent modifying files in sandbox...")

    // Modify existing file
    fs.writeFileSync(
      path.join(sandboxDir, "auth.ts"),
      `import { jwt } from "./jwt";\n\nexport function auth() {\n  return jwt.verify();\n}\n`
    )

    // Add new file
    fs.writeFileSync(
      path.join(sandboxDir, "jwt.ts"),
      `export const jwt = {\n  verify: () => true,\n  sign: (payload: any) => "token",\n};\n`
    )

    // Add new test file
    fs.writeFileSync(
      path.join(sandboxDir, "auth.test.ts"),
      `import { auth } from "./auth";\ntest("auth works", () => expect(auth()).toBe(true));\n`
    )

    yield* Effect.log("  ✓ Modified auth.ts")
    yield* Effect.log("  ✓ Added jwt.ts")
    yield* Effect.log("  ✓ Added auth.test.ts")
    yield* Effect.log("")

    // ─── Step 3: Compute DiffBundle ─────────────────────────────────────
    const bundle = computeDiffBundle(sandboxDir, baseSnapshot, 1)
    yield* Effect.log(`DiffBundle computed (seq=${bundle.seq}):`)
    for (const patch of bundle.patches) {
      const size = patch.after?.length ?? 0
      yield* Effect.log(`  ${patch.operation}: ${patch.path} (${size} bytes)`)
    }
    yield* Effect.log("")

    // The bundle is serializable — this is what gets stored in the event log
    const serialized = JSON.stringify(bundle, (_key, value) => {
      if (value instanceof Map) return Object.fromEntries(value)
      return value
    })
    yield* Effect.log(`Serialized bundle size: ${serialized.length} bytes`)
    yield* Effect.log("")

    // ─── Step 4: Apply DiffBundle to parent (replay) ────────────────────
    yield* Effect.log("Applying DiffBundle to parent directory (replay)...")
    applyDiffBundle(parentDir, bundle)

    // Verify parent matches sandbox
    const parentFiles = fs.readdirSync(parentDir)
    yield* Effect.log("")
    yield* Effect.log("Parent directory after replay:")
    for (const file of parentFiles) {
      const content = fs.readFileSync(path.join(parentDir, file), "utf-8")
      const sandboxContent = fs.readFileSync(path.join(sandboxDir, file), "utf-8")
      const match = content === sandboxContent
      yield* Effect.log(`  ${file}: ${match ? "✓ matches sandbox" : "✗ MISMATCH"}`)
    }

    yield* Effect.log("")
    yield* Effect.log("Key observations:")
    yield* Effect.log("  - DiffBundle captures ALL filesystem changes as serializable data")
    yield* Effect.log("  - No shared filesystem needed between sandbox and parent")
    yield* Effect.log("  - On replay: apply the bundle instead of re-running the agent")
    yield* Effect.log("  - Bundle can be persisted in the event log (MessageStorage)")
    yield* Effect.log("  - Conflict detection: compare base snapshot with parent's current state")

  } finally {
    // Cleanup
    fs.rmSync(sandboxDir, { recursive: true, force: true })
    fs.rmSync(parentDir, { recursive: true, force: true })
  }
})

Effect.runPromise(program).catch(console.error)
