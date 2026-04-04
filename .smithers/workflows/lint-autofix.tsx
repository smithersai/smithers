// smithers-source: seeded
// smithers-display-name: Lint Auto-Fix
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

export const on = ["check_run.completed"] as const;

const policyProxyUrl =
  process.env.SMITHERS_POLICY_PROXY_URL ??
  process.env.SMITHERS_GITHUB_PROXY_URL ??
  "http://127.0.0.1:7331/api/internal/github-proxy";

const smithersBranchPrefix = "smithers/";
const maxLintOutputChars = 25_000;
const maxIssuesInPrompt = 120;
const lintCheckNamePattern =
  /\b(lint|eslint|stylelint|ruff|flake8|pylint|rubocop|ktlint|golangci[- ]?lint|clippy)\b/i;
const smithersCheckNamePattern = /^smithers\s*\/\s*lint-autofix/i;
const manualFixCommentMarkerPrefix = "<!-- smithers:lint-autofix:manual-fix";

const inputSchema = z
  .object({
    event: z.record(z.string(), z.any()).nullable().default(null),
    repository: z.record(z.string(), z.any()).nullable().default(null),
    pullRequest: z.record(z.string(), z.any()).nullable().default(null),
    checkRun: z.record(z.string(), z.any()).nullable().default(null),
    owner: z.string().nullable().default(null),
    repo: z.string().nullable().default(null),
    pullRequestNumber: z.number().int().positive().nullable().default(null),
    installationId: z.number().int().positive().nullable().default(null),
    checkRunId: z.number().int().positive().nullable().default(null),
    checkRunName: z.string().nullable().default(null),
    headBranch: z.string().nullable().default(null),
    headSha: z.string().nullable().default(null),
  })
  .passthrough();

const lintIssueSchema = z.object({
  path: z.string().nullable().default(null),
  line: z.number().int().positive().nullable().default(null),
  column: z.number().int().positive().nullable().default(null),
  message: z.string(),
  rule: z.string().nullable().default(null),
  source: z.enum(["annotation", "check-output"]).default("check-output"),
});

const checkRunContextSchema = z.object({
  shouldHandle: z.boolean(),
  skipReason: z.string().nullable().default(null),
  owner: z.string().nullable().default(null),
  repo: z.string().nullable().default(null),
  pullRequestNumber: z.number().int().positive().nullable().default(null),
  installationId: z.number().int().positive().nullable().default(null),
  checkRunId: z.number().int().positive().nullable().default(null),
  checkRunName: z.string().nullable().default(null),
  checkRunUrl: z.string().nullable().default(null),
  conclusion: z.string().nullable().default(null),
  headBranch: z.string().nullable().default(null),
  headSha: z.string().nullable().default(null),
  lintCommandHints: z.array(z.string()).default([]),
  lintErrorOutput: z.string().default(""),
  issues: z.array(lintIssueSchema).default([]),
});

const fixAttemptSchema = z
  .object({
    status: z.enum(["fixed", "unresolved", "skipped"]).default("unresolved"),
    summary: z.string().default("No summary was provided."),
    lintPassed: z.boolean().default(false),
    pushSucceeded: z.boolean().default(false),
    lintCommandUsed: z.string().nullable().default(null),
    branch: z.string().nullable().default(null),
    commitSha: z.string().nullable().default(null),
    attemptedCommands: z.array(z.string()).default([]),
    fixedIssues: z.array(z.string()).default([]),
    unresolvedIssues: z.array(z.string()).default([]),
    manualSuggestions: z.array(z.string()).default([]),
    failureReason: z.string().nullable().default(null),
  })
  .passthrough();

const publishResultSchema = z.object({
  action: z.enum(["skipped", "none", "commented"]),
  reason: z.string(),
  commentUrl: z.string().nullable().default(null),
  autoFixStatus: z.enum(["skipped", "fixed", "unresolved"]),
  done: z.boolean(),
});

type Input = z.infer<typeof inputSchema>;
type LintIssue = z.infer<typeof lintIssueSchema>;
type CheckRunContext = z.infer<typeof checkRunContextSchema>;
type FixAttempt = z.infer<typeof fixAttemptSchema>;

type ProxyMethod = "GET" | "POST";

type ProxyRequest = {
  method: ProxyMethod;
  path: string;
  body?: unknown;
  installationId?: number | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    const parsed = asString(value);
    if (parsed) return parsed;
  }
  return null;
}

function firstInt(values: unknown[]): number | null {
  for (const value of values) {
    const parsed = asNumber(value);
    if (parsed != null) return Math.floor(parsed);
  }
  return null;
}

function firstRecord(values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (value && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  }
  return {};
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord);
}

function parseRepoFullName(
  value: string | null,
): { owner: string; repo: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    owner: trimmed.slice(0, slash),
    repo: trimmed.slice(slash + 1),
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function githubProxyRequest<T>(req: ProxyRequest): Promise<T> {
  const token =
    process.env.SMITHERS_SANDBOX_TOKEN ??
    process.env.SMITHERS_SANDBOX_AUTH_TOKEN ??
    process.env.SMITHERS_POLICY_PROXY_TOKEN;

  const response = await fetch(policyProxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      method: req.method,
      path: req.path,
      ...(req.installationId != null
        ? { installationId: req.installationId }
        : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
    }),
  });

  const raw = await response.text();
  const parsed = raw.length > 0 ? safeJsonParse(raw) : null;

  if (!response.ok) {
    const detail =
      typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
    throw new Error(
      `Policy proxy request failed (${response.status}) for ${req.method} ${req.path}: ${detail}`,
    );
  }

  return parsed as T;
}

function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const clipped = value.slice(0, Math.max(0, maxChars)).trimEnd();
  return `${clipped}\n... [truncated]`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    deduped.push(cleaned);
  }
  return deduped;
}

function dedupeIssues(issues: LintIssue[]): LintIssue[] {
  const seen = new Set<string>();
  const deduped: LintIssue[] = [];
  for (const issue of issues) {
    const key = [
      issue.path ?? "",
      issue.line ?? "",
      issue.column ?? "",
      issue.message,
      issue.rule ?? "",
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}

function isLintCheckName(name: string | null): boolean {
  if (!name) return false;
  return lintCheckNamePattern.test(name);
}

function isSmithersManagedCheck(name: string | null): boolean {
  if (!name) return false;
  return smithersCheckNamePattern.test(name);
}

function parseRuleFromMessage(message: string): { message: string; rule: string | null } {
  const trimmed = message.trim();
  const pairMatch = /^(.*?)(?:\s{2,}|\s+\[)([@A-Za-z0-9_./-]+)\]?\s*$/.exec(trimmed);
  if (!pairMatch) {
    return { message: trimmed, rule: null };
  }

  const normalizedMessage = pairMatch[1]?.trim() ?? trimmed;
  const normalizedRule = pairMatch[2]?.trim() ?? null;
  return {
    message: normalizedMessage || trimmed,
    rule: normalizedRule,
  };
}

function parseLintIssuesFromText(raw: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const eslintLike = /^(.+?):(\d+):(\d+)\s+(?:error|warning)\s+(.+)$/i.exec(trimmed);
    if (eslintLike) {
      const path = asString(eslintLike[1]);
      const parsedLine = firstInt([eslintLike[2]]);
      const parsedColumn = firstInt([eslintLike[3]]);
      const messagePair = parseRuleFromMessage(eslintLike[4] ?? "");

      issues.push({
        path,
        line: parsedLine != null && parsedLine > 0 ? parsedLine : null,
        column: parsedColumn != null && parsedColumn > 0 ? parsedColumn : null,
        message: messagePair.message,
        rule: messagePair.rule,
        source: "check-output",
      });
      continue;
    }

    const compilerLike = /^(.+?)\((\d+),(\d+)\):\s*(?:error|warning)\s*(.+)$/i.exec(trimmed);
    if (compilerLike) {
      const path = asString(compilerLike[1]);
      const parsedLine = firstInt([compilerLike[2]]);
      const parsedColumn = firstInt([compilerLike[3]]);
      const messagePair = parseRuleFromMessage(compilerLike[4] ?? "");

      issues.push({
        path,
        line: parsedLine != null && parsedLine > 0 ? parsedLine : null,
        column: parsedColumn != null && parsedColumn > 0 ? parsedColumn : null,
        message: messagePair.message,
        rule: messagePair.rule,
        source: "check-output",
      });
      continue;
    }

    const pathLineLike = /^(.+?):(\d+)\s+(.+)$/.exec(trimmed);
    if (pathLineLike) {
      const path = asString(pathLineLike[1]);
      const parsedLine = firstInt([pathLineLike[2]]);
      const messagePair = parseRuleFromMessage(pathLineLike[3] ?? "");

      issues.push({
        path,
        line: parsedLine != null && parsedLine > 0 ? parsedLine : null,
        column: null,
        message: messagePair.message,
        rule: messagePair.rule,
        source: "check-output",
      });
    }
  }

  return dedupeIssues(issues);
}

function parseAnnotationIssues(annotations: Record<string, unknown>[]): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const annotation of annotations) {
    const path = asString(annotation.path);
    const line = firstInt([
      annotation.start_line,
      annotation.startLine,
      annotation.line,
      annotation.end_line,
      annotation.endLine,
    ]);
    const column = firstInt([
      annotation.start_column,
      annotation.startColumn,
      annotation.column,
      annotation.end_column,
      annotation.endColumn,
    ]);
    const message = firstString([
      annotation.message,
      annotation.raw_details,
      annotation.title,
    ]);

    if (!message) continue;

    const messagePair = parseRuleFromMessage(message);

    issues.push({
      path,
      line: line != null && line > 0 ? line : null,
      column: column != null && column > 0 ? column : null,
      message: messagePair.message,
      rule: messagePair.rule,
      source: "annotation",
    });
  }

  return dedupeIssues(issues);
}

function renderIssueForPrompt(issue: LintIssue): string {
  const location = issue.path
    ? `${issue.path}${issue.line ? `:${issue.line}` : ""}${issue.column ? `:${issue.column}` : ""}`
    : "(unknown location)";
  const rule = issue.rule ? ` [${issue.rule}]` : "";
  return `${location} ${issue.message}${rule}`.trim();
}

function buildLintErrorOutput(
  summary: string,
  text: string,
  issues: LintIssue[],
): string {
  const sections: string[] = [];
  if (summary.trim()) {
    sections.push("Check summary:");
    sections.push(summary.trim());
    sections.push("");
  }
  if (text.trim()) {
    sections.push("Check details:");
    sections.push(text.trim());
    sections.push("");
  }
  if (issues.length > 0) {
    sections.push("Structured lint findings:");
    sections.push(...issues.slice(0, maxIssuesInPrompt).map((issue) => `- ${renderIssueForPrompt(issue)}`));
  }

  const combined = sections.join("\n").trim();
  if (!combined) {
    return "No lint error output was available in the check run payload.";
  }
  return truncateChars(combined, maxLintOutputChars);
}

function buildLintCommandHints(
  checkRunName: string | null,
  lintOutput: string,
): string[] {
  const combined = `${checkRunName ?? ""}\n${lintOutput}`.toLowerCase();
  const hints: string[] = [];

  if (combined.includes("eslint")) {
    hints.push(
      "bunx eslint . --fix",
      "pnpm eslint . --fix",
      "npm exec eslint . --fix",
      "npm run lint -- --fix",
    );
  }

  if (combined.includes("stylelint")) {
    hints.push(
      "bunx stylelint '**/*.{css,scss}' --fix",
      "pnpm stylelint '**/*.{css,scss}' --fix",
      "npm run stylelint -- --fix",
    );
  }

  if (combined.includes("ruff")) {
    hints.push("ruff check . --fix", "ruff format .");
  }

  if (combined.includes("flake8")) {
    hints.push("ruff check . --fix", "python -m autopep8 -ir .");
  }

  if (combined.includes("pylint")) {
    hints.push("python -m pylint .", "ruff check . --fix");
  }

  if (combined.includes("rubocop")) {
    hints.push("bundle exec rubocop -A", "rubocop -A");
  }

  if (combined.includes("golangci")) {
    hints.push("golangci-lint run --fix", "gofmt -w .");
  }

  if (combined.includes("ktlint")) {
    hints.push("ktlint -F");
  }

  if (combined.includes("clippy")) {
    hints.push("cargo clippy --fix --allow-dirty --allow-staged");
  }

  hints.push(
    "bun run lint -- --fix",
    "pnpm lint --fix",
    "npm run lint -- --fix",
    "yarn lint --fix",
    "bun run lint",
    "pnpm lint",
    "npm run lint",
    "yarn lint",
  );

  return dedupeStrings(hints);
}

async function fetchCheckRunAnnotations(context: {
  owner: string;
  repo: string;
  installationId: number | null;
  checkRunId: number;
}): Promise<LintIssue[]> {
  const owner = encodeURIComponent(context.owner);
  const repo = encodeURIComponent(context.repo);
  const repoPath = `/repos/${owner}/${repo}`;
  const annotations: Record<string, unknown>[] = [];

  for (let page = 1; page <= 5; page += 1) {
    const batchUnknown = await githubProxyRequest<unknown>({
      method: "GET",
      path: `${repoPath}/check-runs/${context.checkRunId}/annotations?per_page=100&page=${page}`,
      installationId: context.installationId,
    });

    const batch = Array.isArray(batchUnknown) ? batchUnknown.map(asRecord) : [];
    if (batch.length === 0) break;

    annotations.push(...batch);
    if (batch.length < 100) break;
  }

  return parseAnnotationIssues(annotations);
}

async function collectCheckRunContext(input: Input): Promise<CheckRunContext> {
  const event = asRecord(input.event);
  const payload = firstRecord([event.payload, event]);
  const payloadCheckRun = firstRecord([
    input.checkRun,
    payload.check_run,
    payload.checkRun,
  ]);
  const payloadCheckSuite = firstRecord([
    payload.check_suite,
    payload.checkSuite,
    payloadCheckRun.check_suite,
    payloadCheckRun.checkSuite,
  ]);
  const payloadPullRequests = [
    ...toRecordArray(payloadCheckRun.pull_requests),
    ...toRecordArray(payloadCheckSuite.pull_requests),
  ];
  const payloadPullRequest = firstRecord([
    input.pullRequest,
    payload.pull_request,
    payload.pullRequest,
    payloadPullRequests[0],
  ]);

  const payloadPullRequestHead = asRecord(payloadPullRequest.head);
  const payloadPullRequestBase = asRecord(payloadPullRequest.base);

  const repository = firstRecord([
    input.repository,
    payload.repository,
    asRecord(payloadPullRequestBase.repo),
    asRecord(payloadPullRequestHead.repo),
  ]);
  const repositoryOwner = asRecord(repository.owner);
  const repositoryFullName = parseRepoFullName(asString(repository.full_name));

  const owner = firstString([
    input.owner,
    repositoryOwner.login,
    repositoryOwner.name,
    typeof repository.owner === "string" ? repository.owner : null,
    repositoryFullName?.owner,
  ]);
  const repo = firstString([
    input.repo,
    repository.name,
    repositoryFullName?.repo,
  ]);

  const installation = firstRecord([payload.installation, event.installation]);
  const installationId = firstInt([input.installationId, installation.id]);
  const checkRunId = firstInt([input.checkRunId, payloadCheckRun.id]);

  if (!owner || !repo || checkRunId == null || checkRunId <= 0) {
    return {
      shouldHandle: false,
      skipReason:
        "Missing owner/repo/checkRunId in the check_run payload; cannot run lint autofix.",
      owner: owner ?? null,
      repo: repo ?? null,
      pullRequestNumber: null,
      installationId:
        installationId != null && installationId > 0 ? installationId : null,
      checkRunId: checkRunId != null && checkRunId > 0 ? checkRunId : null,
      checkRunName: firstString([input.checkRunName, payloadCheckRun.name]),
      checkRunUrl: firstString([
        payloadCheckRun.html_url,
        payloadCheckRun.details_url,
        payloadCheckRun.url,
      ]),
      conclusion: firstString([payloadCheckRun.conclusion]),
      headBranch: firstString([
        input.headBranch,
        payloadCheckRun.head_branch,
        payloadCheckSuite.head_branch,
      ]),
      headSha: firstString([input.headSha, payloadCheckRun.head_sha]),
      lintCommandHints: [],
      lintErrorOutput: "No lint output available.",
      issues: [],
    };
  }

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const repoPath = `/repos/${encodedOwner}/${encodedRepo}`;

  let checkRunRecord = payloadCheckRun;
  try {
    const fetched = await githubProxyRequest<Record<string, unknown>>({
      method: "GET",
      path: `${repoPath}/check-runs/${checkRunId}`,
      installationId,
    });
    checkRunRecord = firstRecord([fetched, payloadCheckRun]);
  } catch {
    checkRunRecord = payloadCheckRun;
  }

  const checkSuite = firstRecord([
    checkRunRecord.check_suite,
    checkRunRecord.checkSuite,
    payloadCheckSuite,
  ]);
  const mergedPullRequests = [
    ...toRecordArray(checkRunRecord.pull_requests),
    ...payloadPullRequests,
  ];
  const pullRequest = firstRecord([
    input.pullRequest,
    payloadPullRequest,
    mergedPullRequests[0],
  ]);
  const pullRequestHead = asRecord(pullRequest.head);

  const pullRequestNumber = firstInt([
    input.pullRequestNumber,
    pullRequest.number,
    payload.number,
  ]);
  const checkRunName = firstString([
    input.checkRunName,
    checkRunRecord.name,
    payloadCheckRun.name,
  ]);
  const checkRunUrl = firstString([
    checkRunRecord.html_url,
    checkRunRecord.details_url,
    checkRunRecord.url,
    payloadCheckRun.html_url,
    payloadCheckRun.details_url,
  ]);
  const conclusion = firstString([
    checkRunRecord.conclusion,
    payloadCheckRun.conclusion,
  ]);
  const headBranch = firstString([
    input.headBranch,
    checkRunRecord.head_branch,
    checkSuite.head_branch,
    pullRequestHead.ref,
  ]);
  const headSha = firstString([
    input.headSha,
    checkRunRecord.head_sha,
    checkSuite.head_sha,
    pullRequestHead.sha,
    payload.after,
  ]);
  const outputRecord = asRecord(checkRunRecord.output);
  const payloadOutputRecord = asRecord(payloadCheckRun.output);
  const outputSummary = firstString([
    outputRecord.summary,
    payloadOutputRecord.summary,
  ]) ?? "";
  const outputText = firstString([
    outputRecord.text,
    payloadOutputRecord.text,
  ]) ?? "";

  const commonContext = {
    owner,
    repo,
    pullRequestNumber:
      pullRequestNumber != null && pullRequestNumber > 0 ? pullRequestNumber : null,
    installationId:
      installationId != null && installationId > 0 ? installationId : null,
    checkRunId,
    checkRunName,
    checkRunUrl,
    conclusion,
    headBranch,
    headSha,
  };

  const baseLintOutput = buildLintErrorOutput(outputSummary, outputText, []);
  const baseLintCommands = buildLintCommandHints(checkRunName, baseLintOutput);

  if (conclusion !== "failure") {
    return {
      shouldHandle: false,
      skipReason:
        "Check run conclusion is not failure; lint autofix only runs on failed checks.",
      ...commonContext,
      lintCommandHints: baseLintCommands,
      lintErrorOutput: baseLintOutput,
      issues: [],
    };
  }

  if (!isLintCheckName(checkRunName)) {
    return {
      shouldHandle: false,
      skipReason:
        "Check run name does not match lint patterns; ignoring non-lint check.",
      ...commonContext,
      lintCommandHints: baseLintCommands,
      lintErrorOutput: baseLintOutput,
      issues: [],
    };
  }

  if (isSmithersManagedCheck(checkRunName)) {
    return {
      shouldHandle: false,
      skipReason:
        "Check run appears to be Smithers-managed; skipping to avoid workflow loops.",
      ...commonContext,
      lintCommandHints: baseLintCommands,
      lintErrorOutput: baseLintOutput,
      issues: [],
    };
  }

  if (!headBranch || !headBranch.startsWith(smithersBranchPrefix)) {
    return {
      shouldHandle: false,
      skipReason:
        "Lint autofix only runs on smithers/* PR branches.",
      ...commonContext,
      lintCommandHints: baseLintCommands,
      lintErrorOutput: baseLintOutput,
      issues: [],
    };
  }

  if (pullRequestNumber == null || pullRequestNumber <= 0) {
    return {
      shouldHandle: false,
      skipReason:
        "Check run is not associated with a pull request; cannot post fallback guidance.",
      ...commonContext,
      lintCommandHints: baseLintCommands,
      lintErrorOutput: baseLintOutput,
      issues: [],
    };
  }

  let annotationIssues: LintIssue[] = [];
  try {
    annotationIssues = await fetchCheckRunAnnotations({
      owner,
      repo,
      installationId:
        installationId != null && installationId > 0 ? installationId : null,
      checkRunId,
    });
  } catch {
    annotationIssues = [];
  }

  const parsedIssues = parseLintIssuesFromText(
    [outputSummary, outputText].filter(Boolean).join("\n"),
  );
  const issues = dedupeIssues([...annotationIssues, ...parsedIssues]).slice(
    0,
    maxIssuesInPrompt,
  );
  const lintErrorOutput = buildLintErrorOutput(outputSummary, outputText, issues);
  const lintCommandHints = buildLintCommandHints(checkRunName, lintErrorOutput);

  return {
    shouldHandle: true,
    skipReason: null,
    ...commonContext,
    lintCommandHints,
    lintErrorOutput,
    issues,
  };
}

function buildFixPrompt(context: CheckRunContext): string {
  const issueLines =
    context.issues.length > 0
      ? context.issues
          .slice(0, maxIssuesInPrompt)
          .map((issue, index) => `${index + 1}. ${renderIssueForPrompt(issue)}`)
      : ["(No structured issues were parsed. Use the raw check output below.)"];

  const commandHints =
    context.lintCommandHints.length > 0
      ? context.lintCommandHints.map((command, index) => `${index + 1}. \`${command}\``)
      : ["1. `bun run lint -- --fix`", "2. `npm run lint -- --fix`"];

  return [
    "# Lint CI Auto-Fix",
    "",
    `Repository: ${context.owner}/${context.repo}`,
    context.pullRequestNumber != null
      ? `Pull request: #${context.pullRequestNumber}`
      : null,
    context.headBranch ? `Head branch: ${context.headBranch}` : null,
    context.checkRunName ? `Failing check: ${context.checkRunName}` : null,
    "",
    "You are repairing lint failures on the PR branch. Complete all steps below:",
    "1. Confirm you are on the PR head branch and it starts with `smithers/`.",
    "2. Address every listed lint issue with minimal code changes.",
    "3. Run lint autofix commands first, then manual edits for remaining issues.",
    "4. Re-run lint until the failing lint check is green locally.",
    "5. Commit and push the fixes to the same PR branch.",
    "",
    "Commit + push requirements:",
    "- Commit message: `chore: auto-fix lint failures`",
    context.headBranch
      ? `- Push target: \`origin HEAD:${context.headBranch}\``
      : "- Push target: origin HEAD:<current-branch>",
    "",
    "If you cannot fully fix the lint failures:",
    "- Do not report success.",
    "- Return `status: unresolved`.",
    "- Explain exact blockers and provide concrete manual suggestions.",
    "",
    "Suggested lint commands (try in this order):",
    ...commandHints,
    "",
    "Structured lint issues:",
    ...issueLines,
    "",
    "Raw check output:",
    "```text",
    context.lintErrorOutput,
    "```",
    "",
    "Return strict JSON matching the schema.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function buildManualFixComment(
  context: CheckRunContext,
  fixAttempt: FixAttempt | null,
  reason: string,
): string {
  const unresolved = dedupeStrings(fixAttempt?.unresolvedIssues ?? []);
  const manualSuggestions = dedupeStrings(fixAttempt?.manualSuggestions ?? []);
  const fallbackSuggestions = [
    "Run the lint command locally with autofix enabled and inspect remaining failures.",
    "Apply manual edits for non-autofixable lint rules, then rerun lint.",
    "Push the updates to this PR branch to trigger a fresh check run.",
  ];

  const suggestions =
    manualSuggestions.length > 0 ? manualSuggestions : fallbackSuggestions;

  const marker = `${manualFixCommentMarkerPrefix} check-run:${context.checkRunId ?? "unknown"} -->`;

  return [
    "Smithers tried to auto-fix this lint failure but could not complete it.",
    "",
    context.checkRunName ? `- Check: \`${context.checkRunName}\`` : null,
    context.checkRunUrl ? `- Check run: ${context.checkRunUrl}` : null,
    context.headBranch ? `- Branch: \`${context.headBranch}\`` : null,
    "",
    `Reason: ${reason}`,
    "",
    unresolved.length > 0
      ? "Remaining lint issues:"
      : "No structured unresolved issues were returned. See the failing check output for details.",
    ...unresolved.map((issue) => `- ${issue}`),
    "",
    "Suggested manual fix:",
    ...suggestions.map((item) => `- ${item}`),
    "",
    marker,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

async function postManualFixComment(
  context: CheckRunContext,
  body: string,
): Promise<string | null> {
  if (!context.owner || !context.repo || context.pullRequestNumber == null) {
    return null;
  }

  const owner = encodeURIComponent(context.owner);
  const repo = encodeURIComponent(context.repo);
  const response = await githubProxyRequest<Record<string, unknown>>({
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${context.pullRequestNumber}/comments`,
    installationId: context.installationId,
    body: { body },
  });

  return firstString([response.html_url, response.url]);
}

async function publishOutcome(
  context: CheckRunContext,
  fixAttempt: FixAttempt | null,
) {
  if (!context.shouldHandle) {
    return {
      action: "skipped" as const,
      reason: context.skipReason ?? "Lint autofix was skipped.",
      commentUrl: null,
      autoFixStatus: "skipped" as const,
      done: true,
    };
  }

  const branchMatches = context.headBranch
    ? !fixAttempt?.branch || fixAttempt.branch === context.headBranch
    : true;

  const successful =
    fixAttempt?.status === "fixed" &&
    fixAttempt.lintPassed &&
    fixAttempt.pushSucceeded &&
    branchMatches &&
    Boolean(context.headBranch?.startsWith(smithersBranchPrefix));

  if (successful) {
    return {
      action: "none" as const,
      reason:
        "Lint issues were auto-fixed, committed, and pushed to the PR branch. Lint passed on local re-check.",
      commentUrl: null,
      autoFixStatus: "fixed" as const,
      done: true,
    };
  }

  const unresolvedReason =
    fixAttempt?.failureReason ??
    fixAttempt?.summary ??
    "Lint autofix could not fully resolve all failures.";

  try {
    const commentBody = buildManualFixComment(
      context,
      fixAttempt,
      unresolvedReason,
    );
    const commentUrl = await postManualFixComment(context, commentBody);

    return {
      action: commentUrl ? ("commented" as const) : ("none" as const),
      reason: commentUrl
        ? "Lint autofix could not complete; posted manual guidance on the PR."
        : "Lint autofix could not complete and no PR comment could be posted (missing PR context).",
      commentUrl,
      autoFixStatus: "unresolved" as const,
      done: false,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      action: "none" as const,
      reason: `Lint autofix could not complete and comment posting failed: ${detail}`,
      commentUrl: null,
      autoFixStatus: "unresolved" as const,
      done: false,
    };
  }
}

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  checkRunContext: checkRunContextSchema,
  fixAttempt: fixAttemptSchema,
  publish: publishResultSchema,
});

export default smithers((ctx) => {
  const checkRunContext = ctx.outputMaybe(outputs.checkRunContext, {
    nodeId: "collect-check-run-context",
  });
  const fixAttempt = ctx.outputMaybe(outputs.fixAttempt, { nodeId: "apply-fixes" });

  return (
    <Workflow name="lint-autofix">
      <Task
        id="collect-check-run-context"
        output={outputs.checkRunContext}
        timeoutMs={30_000}
      >
        {async () => collectCheckRunContext(ctx.input)}
      </Task>

      {checkRunContext?.shouldHandle ? (
        <Task
          id="apply-fixes"
          output={outputs.fixAttempt}
          agent={agents.smartTool}
          timeoutMs={180_000}
        >
          {() => buildFixPrompt(checkRunContext)}
        </Task>
      ) : null}

      {checkRunContext && (!checkRunContext.shouldHandle || fixAttempt) ? (
        <Task id="publish" output={outputs.publish} timeoutMs={30_000}>
          {() =>
            publishOutcome(
              checkRunContext,
              checkRunContext.shouldHandle ? (fixAttempt ?? null) : null,
            )
          }
        </Task>
      ) : null}
    </Workflow>
  );
});
