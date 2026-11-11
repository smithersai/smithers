/** Existing out-of-scope module replacements, ratcheted until their owning fixes land.
 * No new file or additional replacement is admitted; all other tests use scoped adapters.
 * @since 1.0.0
 */
export const legacyModuleReplacements: Readonly<Record<string, number>> = {
  "test/Affected.test.ts": 3,
  "test/AffectedCliContainment.test.ts": 1,
  "test/AffectedContainment.test.ts": 1,
  "test/AgentPublication.test.ts": 1,
  "test/Cache.test.ts": 1,
  "test/ContainedProcessWindows.test.ts": 2,
  "test/DockerOwnership.test.ts": 3,
  "test/DockerProbe.test.ts": 1,
  "test/FetchRuleContract.test.ts": 1,
  "test/FetchRuleEquivalence.test.ts": 1,
  "test/GitCommit.test.ts": 1,
  "test/GoExec.test.ts": 2,
  "test/GoExecFailures.test.ts": 2,
  "test/GoExecution.test.ts": 2,
  "test/GoPlanningContracts.test.ts": 5,
  "test/LaneExecution.test.ts": 1,
  "test/MaterializeRollback.test.ts": 1,
  "test/MemoryBackend.test.ts": 1,
  "test/NativeArtifactOutput.test.ts": 1,
  "test/Owners.test.ts": 1,
  "test/PlanDigestIndex.test.ts": 2,
  "test/PlanHostLookups.test.ts": 2,
  "test/PlanInputSharing.test.ts": 2,
  "test/PackageExecReporter.test.ts": 2,
  "test/ServiceSupervisor.test.ts": 1
}
