/**
 * The default environment variables of a GitHub Actions runner, as GitHub
 * documents them.
 *
 * Source: "Variables reference", section "Default environment variables",
 * https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables
 *
 * Copied from the table in
 * https://github.com/github/docs/blob/a9386877b03ac0d9452656f38e15d9eaf9f14ec7/content/actions/reference/workflows-and-actions/variables.md
 * (the file's newest commit on 2026-11-18, dated 2026-08-27), every row in the
 * table's order. `GITHUB_ARTIFACTS` and `GITHUB_ARTIFACTS_LIST` are in the
 * table behind the version flag `actions-artifacts-file`. To refresh: fetch
 * the file, list the first column of the table, and replace the names below.
 */
export const githubDefaultVariables: ReadonlyArray<string> = [
  "CI",
  "GITHUB_ACTION",
  "GITHUB_ACTION_PATH",
  "GITHUB_ACTION_REPOSITORY",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  "GITHUB_ACTOR_ID",
  "GITHUB_API_URL",
  "GITHUB_ARTIFACTS",
  "GITHUB_ARTIFACTS_LIST",
  "GITHUB_BASE_REF",
  "GITHUB_ENV",
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_GRAPHQL_URL",
  "GITHUB_HEAD_REF",
  "GITHUB_JOB",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_REF_PROTECTED",
  "GITHUB_REF_TYPE",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_RETENTION_DAYS",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_SERVER_URL",
  "GITHUB_SHA",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_TRIGGERING_ACTOR",
  "GITHUB_WORKFLOW",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_WORKSPACE",
  "RUNNER_ARCH",
  "RUNNER_DEBUG",
  "RUNNER_ENVIRONMENT",
  "RUNNER_NAME",
  "RUNNER_OS",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE"
]
