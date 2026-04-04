// smithers-source: seeded
// smithers-display-name: AI Review
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

export const on = [
  "pull_request.opened",
  "pull_request.synchronize",
  "stack_submit",
] as const;

const policyProxyUrl =
  process.env.SMITHERS_POLICY_PROXY_URL ??
  process.env.SMITHERS_GITHUB_PROXY_URL ??
  "http://127.0.0.1:7331/api/internal/github-proxy";

const checkRunName = "smithers / ai-review";
const checkRunTitle = "AI Code Review";

const inputSchema = z
  .object({
    event: z.record(z.string(), z.any()).nullable().default(null),
    repository: z.record(z.string(), z.any()).nullable().default(null),
    pullRequest: z.record(z.string(), z.any()).nullable().default(null),
    owner: z.string().nullable().default(null),
    repo: z.string().nullable().default(null),
    pullRequestNumber: z.number().int().positive().nullable().default(null),
    installationId: z.number().int().positive().nullable().default(null),
    headSha: z.string().nullable().default(null),
    baseSha: z.string().nullable().default(null),
    maxFiles: z.number().int().min(1).max(200).default(120),
    maxChangedLines: z.number().int().min(50).max(5000).default(500),
  })
  .passthrough();

const lineSpanSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
});

const diffFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().nullable().default(null),
  reviewable: z.boolean().default(false),
  skipReason: z.string().nullable().default(null),
  lineSpans: z.array(lineSpanSchema).default([]),
});

const diffContextSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  pullRequestNumber: z.number().int().positive(),
  installationId: z.number().int().positive().nullable().default(null),
  headSha: z.string(),
  baseSha: z.string().nullable().default(null),
  files: z.array(diffFileSchema).default([]),
  totalFiles: z.number().int().nonnegative(),
  reviewedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  totalChangedLines: z.number().int().nonnegative(),
  reviewLineBudget: z.number().int().positive(),
});

const reviewFindingSchema = z.object({
  filePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  severity: z.enum(["critical", "major", "minor", "nit"]),
  category: z.enum(["bug", "security", "style", "performance"]),
  message: z.string(),
  suggestion: z.string().nullable().default(null),
});

const reviewFileSchema = z.object({
  filePath: z.string(),
  summary: z.string(),
  findings: z.array(reviewFindingSchema).default([]),
});

const reviewOutputSchema = z.object({
  summary: z.string(),
  fileReviews: z.array(reviewFileSchema).default([]),
});

const checkRunOutputSchema = z.object({
  summary: z.string(),
  conclusion: z.enum(["success", "neutral", "failure"]),
  annotationsPosted: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
  filesReviewed: z.number().int().nonnegative(),
  checkRunId: z.number().int().nullable().default(null),
  checkRunUrl: z.string().nullable().default(null),
  findings: z.array(reviewFindingSchema).default([]),
});

type Input = z.infer<typeof inputSchema>;
type DiffContext = z.infer<typeof diffContextSchema>;
type DiffFile = z.infer<typeof diffFileSchema>;
type ReviewOutput = z.infer<typeof reviewOutputSchema>;
type ReviewFinding = z.infer<typeof reviewFindingSchema>;
type LineSpan = z.infer<typeof lineSpanSchema>;

type ReviewTarget = {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  installationId: number | null;
  headSha: string | null;
  baseSha: string | null;
  maxFiles: number;
  maxChangedLines: number;
};

type ProxyMethod = "GET" | "POST" | "PATCH";

type ProxyRequest = {
  method: ProxyMethod;
  path: string;
  body?: unknown;
  installationId?: number | null;
};

type CheckRunAnnotation = {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title: string;
  raw_details?: string;
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

function clampInt(
  value: number | null,
  min: number,
  max: number,
  fallback: number,
) {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
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

function parsePatchLineSpans(patch: string): LineSpan[] {
  const spans: LineSpan[] = [];
  const lines = patch.split("\n");
  for (const line of lines) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = Number(match[2] ?? "1");
    if (!Number.isFinite(start) || start <= 0) continue;
    if (!Number.isFinite(count) || count <= 0) continue;
    spans.push({
      start,
      end: start + count - 1,
    });
  }
  return spans;
}

function countPatchChangedLines(patch: string): number {
  let count = 0;
  for (const line of patch.split("\n")) {
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      count += 1;
    }
  }
  return count;
}

function resolveReviewTarget(input: Input): ReviewTarget {
  const event = asRecord(input.event);
  const payload = firstRecord([event.payload, event]);
  const pullRequest = firstRecord([
    input.pullRequest,
    payload.pull_request,
    payload.pullRequest,
  ]);
  const pullRequestHead = asRecord(pullRequest.head);
  const pullRequestBase = asRecord(pullRequest.base);
  const repository = firstRecord([
    input.repository,
    payload.repository,
    asRecord(pullRequestBase.repo),
    asRecord(pullRequestHead.repo),
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
  const pullRequestNumber = firstInt([
    input.pullRequestNumber,
    (input as Record<string, unknown>).prNumber,
    pullRequest.number,
    payload.number,
  ]);
  const installation = firstRecord([payload.installation, event.installation]);
  const installationId = firstInt([input.installationId, installation.id]);
  const headSha = firstString([input.headSha, pullRequestHead.sha, payload.after]);
  const baseSha = firstString([input.baseSha, pullRequestBase.sha, payload.before]);
  const maxFiles = clampInt(asNumber(input.maxFiles), 1, 200, 120);
  const maxChangedLines = clampInt(
    asNumber(input.maxChangedLines),
    50,
    5000,
    500,
  );

  if (!owner || !repo || pullRequestNumber == null || pullRequestNumber <= 0) {
    throw new Error(
      "Could not resolve PR context. Expected owner/repo/pullRequestNumber in workflow input or event payload.",
    );
  }

  return {
    owner,
    repo,
    pullRequestNumber,
    installationId,
    headSha,
    baseSha,
    maxFiles,
    maxChangedLines,
  };
}

async function collectDiffContext(input: Input): Promise<DiffContext> {
  const target = resolveReviewTarget(input);
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  const repoPath = `/repos/${owner}/${repo}`;

  const pullRequest = await githubProxyRequest<Record<string, unknown>>({
    method: "GET",
    path: `${repoPath}/pulls/${target.pullRequestNumber}`,
    installationId: target.installationId,
  });

  const headSha = firstString([
    target.headSha,
    asString(asRecord(pullRequest.head).sha),
  ]);
  const baseSha = firstString([
    target.baseSha,
    asString(asRecord(pullRequest.base).sha),
  ]);

  if (!headSha) {
    throw new Error("Unable to resolve pull request head SHA.");
  }

  const rawFiles: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10 && rawFiles.length < target.maxFiles; page += 1) {
    const fileBatchUnknown = await githubProxyRequest<unknown>({
      method: "GET",
      path: `${repoPath}/pulls/${target.pullRequestNumber}/files?per_page=100&page=${page}`,
      installationId: target.installationId,
    });
    const fileBatch = Array.isArray(fileBatchUnknown)
      ? fileBatchUnknown.map(asRecord)
      : [];
    if (fileBatch.length === 0) break;
    rawFiles.push(...fileBatch.slice(0, target.maxFiles - rawFiles.length));
    if (fileBatch.length < 100) break;
  }

  let reviewBudgetUsed = 0;
  const files: DiffFile[] = [];

  for (const file of rawFiles) {
    const path = asString(file.filename);
    if (!path) continue;

    const status = asString(file.status) ?? "modified";
    const patch = asString(file.patch);
    const additions = Math.max(0, Math.floor(asNumber(file.additions) ?? 0));
    const deletions = Math.max(0, Math.floor(asNumber(file.deletions) ?? 0));
    const diffLinesFromPatch = patch ? countPatchChangedLines(patch) : 0;
    const changes = Math.max(
      0,
      Math.floor(asNumber(file.changes) ?? (diffLinesFromPatch || additions + deletions)),
    );
    const lineSpans = patch ? parsePatchLineSpans(patch) : [];

    let reviewable = Boolean(patch) && status !== "removed";
    let skipReason: string | null = null;

    if (!patch) {
      skipReason = "No textual patch available (binary or oversized diff).";
      reviewable = false;
    } else if (status === "removed") {
      skipReason = "Removed files cannot be annotated on new-line positions.";
      reviewable = false;
    } else if (reviewBudgetUsed + Math.max(1, changes) > target.maxChangedLines) {
      skipReason = `Skipped to stay within line budget (${target.maxChangedLines}).`;
      reviewable = false;
    }

    if (reviewable) {
      reviewBudgetUsed += Math.max(1, changes);
    }

    files.push({
      path,
      status,
      additions,
      deletions,
      changes,
      patch,
      reviewable,
      skipReason,
      lineSpans,
    });
  }

  const totalChangedLines = files.reduce((sum, file) => sum + file.changes, 0);
  const reviewedFiles = files.filter((file) => file.reviewable).length;
  const skippedFiles = files.length - reviewedFiles;

  return {
    owner: target.owner,
    repo: target.repo,
    pullRequestNumber: target.pullRequestNumber,
    installationId: target.installationId,
    headSha,
    baseSha,
    files,
    totalFiles: files.length,
    reviewedFiles,
    skippedFiles,
    totalChangedLines,
    reviewLineBudget: target.maxChangedLines,
  };
}

function buildReviewPrompt(diff: DiffContext): string {
  const sections: string[] = [];

  for (const file of diff.files) {
    sections.push(`### ${file.path}`);
    sections.push(
      `Status: ${file.status} | additions: ${file.additions} | deletions: ${file.deletions} | changes: ${file.changes}`,
    );
    sections.push(`Reviewable: ${file.reviewable ? "yes" : "no"}`);
    if (file.skipReason) sections.push(`Skip reason: ${file.skipReason}`);
    if (file.lineSpans.length > 0) {
      sections.push(
        `Valid changed line ranges in the new file: ${file.lineSpans.map((span) => `${span.start}-${span.end}`).join(", ")}`,
      );
    }
    if (file.patch) {
      sections.push("```diff");
      sections.push(file.patch);
      sections.push("```");
    } else {
      sections.push("_No patch available._");
    }
    sections.push("");
  }

  return [
    "# AI Pull Request Review",
    "",
    `Repository: ${diff.owner}/${diff.repo}`,
    `Pull request: #${diff.pullRequestNumber}`,
    `Head SHA: ${diff.headSha}`,
    "",
    "Review focus areas:",
    "- bugs",
    "- security issues",
    "- style issues",
    "- performance issues",
    "",
    "Instructions:",
    "1. Create one `fileReviews` entry for every file listed below (same file path).",
    "2. For non-reviewable files, keep `findings` empty and explain why in the file summary.",
    "3. For reviewable files, include only concrete findings tied to changed lines.",
    "4. Use line numbers from the new file side of the diff.",
    "5. Keep severity strict: critical (prod/security break), major (likely bug), minor (quality risk), nit (small suggestion).",
    "",
    "Changed files:",
    "",
    ...sections,
    "Return strict JSON matching the required output schema.",
  ].join("\n");
}

function clampLineToSpans(
  line: number,
  spans: LineSpan[],
): number | null {
  if (spans.length === 0 || !Number.isFinite(line)) return null;
  let nearest = spans[0]!.start;
  let nearestDistance = Math.abs(line - nearest);

  for (const span of spans) {
    if (line >= span.start && line <= span.end) {
      return Math.floor(line);
    }

    const candidate = line < span.start ? span.start : span.end;
    const distance = Math.abs(line - candidate);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = candidate;
    }
  }

  return Math.floor(nearest);
}

function normalizeFindings(
  diff: DiffContext,
  review: ReviewOutput,
): ReviewFinding[] {
  const fileMap = new Map(diff.files.map((file) => [file.path, file]));
  const normalized: ReviewFinding[] = [];
  const dedupe = new Set<string>();

  for (const fileReview of review.fileReviews ?? []) {
    const diffFile = fileMap.get(fileReview.filePath);
    if (!diffFile || !diffFile.reviewable || diffFile.lineSpans.length === 0) {
      continue;
    }

    for (const finding of fileReview.findings ?? []) {
      const start = clampLineToSpans(finding.startLine, diffFile.lineSpans);
      const end = clampLineToSpans(finding.endLine, diffFile.lineSpans);
      if (start == null || end == null) continue;

      const normalizedFinding: ReviewFinding = {
        ...finding,
        filePath: diffFile.path,
        startLine: Math.min(start, end),
        endLine: Math.max(start, end),
      };

      const key = [
        normalizedFinding.filePath,
        normalizedFinding.startLine,
        normalizedFinding.endLine,
        normalizedFinding.severity,
        normalizedFinding.category,
        normalizedFinding.message,
      ].join("|");

      if (!dedupe.has(key)) {
        dedupe.add(key);
        normalized.push(normalizedFinding);
      }
    }
  }

  return normalized;
}

function severityToAnnotationLevel(
  severity: ReviewFinding["severity"],
): CheckRunAnnotation["annotation_level"] {
  if (severity === "critical") return "failure";
  if (severity === "major") return "warning";
  return "notice";
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function determineConclusion(
  findings: ReviewFinding[],
): "success" | "neutral" | "failure" {
  if (findings.some((finding) => finding.severity === "critical" || finding.severity === "major")) {
    return "failure";
  }
  if (findings.length > 0) return "neutral";
  return "success";
}

function buildSummary(
  diff: DiffContext,
  review: ReviewOutput,
  findings: ReviewFinding[],
  conclusion: "success" | "neutral" | "failure",
) {
  const counts = {
    critical: findings.filter((finding) => finding.severity === "critical").length,
    major: findings.filter((finding) => finding.severity === "major").length,
    minor: findings.filter((finding) => finding.severity === "minor").length,
    nit: findings.filter((finding) => finding.severity === "nit").length,
  };

  const topFindings = findings.slice(0, 20).map(
    (finding) =>
      `- [${finding.severity}/${finding.category}] \`${finding.filePath}:${finding.startLine}\` ${finding.message}`,
  );

  return [
    `AI review for \`${diff.owner}/${diff.repo}#${diff.pullRequestNumber}\``,
    "",
    `Conclusion: **${conclusion}**`,
    `Files changed: ${diff.totalFiles}`,
    `Files reviewed: ${diff.reviewedFiles}`,
    `Files skipped: ${diff.skippedFiles}`,
    `Findings: ${findings.length} (critical: ${counts.critical}, major: ${counts.major}, minor: ${counts.minor}, nit: ${counts.nit})`,
    "",
    review.summary ? `Reviewer summary: ${review.summary}` : null,
    topFindings.length > 0 ? "Top findings:" : "No actionable findings detected.",
    ...topFindings,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

async function postCheckRun(
  diff: DiffContext,
  review: ReviewOutput,
) {
  const findings = normalizeFindings(diff, review);
  const conclusion = determineConclusion(findings);
  const summary = buildSummary(diff, review, findings, conclusion);

  const annotations: CheckRunAnnotation[] = findings.map((finding) => ({
    path: finding.filePath,
    start_line: finding.startLine,
    end_line: finding.endLine,
    annotation_level: severityToAnnotationLevel(finding.severity),
    title: `${finding.severity.toUpperCase()} • ${finding.category}`,
    message: finding.message,
    ...(finding.suggestion ? { raw_details: finding.suggestion } : {}),
  }));

  const owner = encodeURIComponent(diff.owner);
  const repo = encodeURIComponent(diff.repo);
  const repoPath = `/repos/${owner}/${repo}`;
  const annotationBatches = chunkArray(annotations, 50);
  const firstBatch = annotationBatches.shift() ?? [];
  const hasMoreBatches = annotationBatches.length > 0;

  const createCheckRunResponse = await githubProxyRequest<Record<string, unknown>>({
    method: "POST",
    path: `${repoPath}/check-runs`,
    installationId: diff.installationId,
    body: {
      name: checkRunName,
      head_sha: diff.headSha,
      status: hasMoreBatches ? "in_progress" : "completed",
      ...(hasMoreBatches ? {} : { conclusion }),
      output: {
        title: checkRunTitle,
        summary,
        annotations: firstBatch,
      },
    },
  });

  const checkRunId = firstInt([createCheckRunResponse.id]);
  const checkRunUrl = firstString([
    createCheckRunResponse.html_url,
    createCheckRunResponse.url,
  ]);

  let annotationsPosted = firstBatch.length;

  if (checkRunId != null) {
    for (const batch of annotationBatches) {
      await githubProxyRequest<Record<string, unknown>>({
        method: "PATCH",
        path: `${repoPath}/check-runs/${checkRunId}`,
        installationId: diff.installationId,
        body: {
          status: "in_progress",
          output: {
            title: checkRunTitle,
            summary,
            annotations: batch,
          },
        },
      });
      annotationsPosted += batch.length;
    }

    if (hasMoreBatches) {
      await githubProxyRequest<Record<string, unknown>>({
        method: "PATCH",
        path: `${repoPath}/check-runs/${checkRunId}`,
        installationId: diff.installationId,
        body: {
          status: "completed",
          conclusion,
          output: {
            title: checkRunTitle,
            summary,
          },
        },
      });
    }
  }

  return {
    summary,
    conclusion,
    annotationsPosted,
    filesChanged: diff.totalFiles,
    filesReviewed: diff.reviewedFiles,
    checkRunId,
    checkRunUrl,
    findings,
  };
}

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  diffContext: diffContextSchema,
  review: reviewOutputSchema,
  checkRun: checkRunOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="ai-review">
    <Task id="collect-diff" output={outputs.diffContext} timeoutMs={30_000}>
      {async () => collectDiffContext(ctx.input)}
    </Task>

    <Task
      id="review"
      output={outputs.review}
      needs={{ diff: "collect-diff" }}
      deps={{ diff: diffContextSchema }}
      agent={agents.smartTool}
      timeoutMs={60_000}
      heartbeatTimeoutMs={60_000}
    >
      {(deps) => buildReviewPrompt(deps.diff)}
    </Task>

    <Task
      id="publish-check-run"
      output={outputs.checkRun}
      needs={{ diff: "collect-diff", review: "review" }}
      deps={{ diff: diffContextSchema, review: reviewOutputSchema }}
      timeoutMs={30_000}
    >
      {(deps) => postCheckRun(deps.diff, deps.review)}
    </Task>
  </Workflow>
));
