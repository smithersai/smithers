import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "bun:test"

import { REPOSITORY_ROOT } from "@/config/paths"
import {
  ensureWorkspaceSmithersLayout,
  getManagedSmithersDbPath,
  getWorkspaceWorkflowRootPath,
} from "@/services/workspace-layout"

const workspacePathsToDelete = new Set<string>()

function createWorkspacePath() {
  const workspacePath = mkdtempSync(path.join(tmpdir(), "burns-workspace-layout-"))
  workspacePathsToDelete.add(workspacePath)
  return workspacePath
}

afterEach(() => {
  for (const workspacePath of workspacePathsToDelete) {
    rmSync(workspacePath, { recursive: true, force: true })
  }
  workspacePathsToDelete.clear()
})

describe("workspace smithers layout", () => {
  it("migrates legacy Burns workflow and state directories into .smithers", () => {
    const workspacePath = createWorkspacePath()
    const legacyWorkflowPath = path.join(workspacePath, ".burns", "workflows", "issue-to-pr")
    const legacyStatePath = path.join(workspacePath, ".mr-burns", "state")

    mkdirSync(legacyWorkflowPath, { recursive: true })
    mkdirSync(legacyStatePath, { recursive: true })
    writeFileSync(path.join(legacyWorkflowPath, "workflow.tsx"), "export default {}", {
      encoding: "utf8",
      flag: "w",
    })
    writeFileSync(path.join(legacyStatePath, "smithers.db"), "db", {
      encoding: "utf8",
      flag: "w",
    })

    const layout = ensureWorkspaceSmithersLayout(workspacePath)

    expect(layout.workflowRoot).toBe(getWorkspaceWorkflowRootPath(workspacePath))
    expect(readFileSync(path.join(layout.workflowRoot, "issue-to-pr", "workflow.tsx"), "utf8")).toBe(
      "export default {}"
    )
    expect(readFileSync(path.join(layout.stateRoot, "smithers.db"), "utf8")).toBe("db")
  })

  it("moves legacy top-level smithers database files into .smithers/state", () => {
    const workspacePath = createWorkspacePath()

    writeFileSync(path.join(workspacePath, "smithers.db"), "main", "utf8")
    writeFileSync(path.join(workspacePath, "smithers.db-shm"), "shm", "utf8")
    writeFileSync(path.join(workspacePath, "smithers.db-wal"), "wal", "utf8")

    const layout = ensureWorkspaceSmithersLayout(workspacePath)

    expect(layout.dbPath).toBe(getManagedSmithersDbPath(workspacePath))
    expect(readFileSync(layout.dbPath, "utf8")).toBe("main")
    expect(readFileSync(`${layout.dbPath}-shm`, "utf8")).toBe("shm")
    expect(readFileSync(`${layout.dbPath}-wal`, "utf8")).toBe("wal")
  })

  it("creates a workspace node_modules symlink back to the daemon runtime dependencies", () => {
    const workspacePath = createWorkspacePath()

    ensureWorkspaceSmithersLayout(workspacePath)

    const nodeModulesPath = path.join(workspacePath, "node_modules")
    expect(lstatSync(nodeModulesPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(nodeModulesPath)).toBe(path.join(REPOSITORY_ROOT, "node_modules"))
  })
})
