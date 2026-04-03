import { cleanupTestWorkspaceArtifacts } from "@/testing/test-workspace-cleanup"

const summary = cleanupTestWorkspaceArtifacts()

console.log("Test workspace cleanup complete")
console.log(`- workspaces deleted: ${summary.workspaceRowsDeleted}`)
console.log(`- approvals deleted: ${summary.approvalRowsDeleted}`)
console.log(`- run events deleted: ${summary.runEventRowsDeleted}`)
console.log(`- directories deleted: ${summary.directoriesDeleted}`)

if (summary.skippedDirectories.length > 0) {
  console.log("- skipped directories:")
  for (const directoryPath of summary.skippedDirectories) {
    console.log(`  - ${directoryPath}`)
  }
}

if (summary.errors.length > 0) {
  console.error("- cleanup errors:")
  for (const error of summary.errors) {
    console.error(`  - ${error}`)
  }
  process.exitCode = 1
}
