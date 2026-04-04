// smithers-source: seeded
// smithers-display-name: PR Description
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

export const on = ["pull_request.opened", "stack_submit"] as const;

const policyProxyUrl =
  process.env.SMITHERS_POLICY_PROXY_URL ??
  process.env.SMITHERS_GITHUB_PROXY_URL ??
  "http://127.0.0.1:7331/api/internal/github-proxy";

const stackStartMarker = "<!-- smithers:stack:start -->";
const stackEndMarker = "<!-- smithers:stack:end -->";
const generatedMarker = "<!-- smithers:pr-description:generated -->";
const generatedCommentMarker = "<!-- smithers:pr-description:comment -->";

const inputSchema = z
  .object({
    event: z.record(z.string(), z.any()).nullable().default(null),
    repository: z.record(z.string(), z.any()).nullable().default(null),
    pullRequest: z.record(z.string(), z.any()).nullable().default(null),
    owner: z.string().nullable().default(null),
    repo: z.string().nullable().default(null),
    pullRequestNumber: z.number().int().positive().nullable().default(null),
    installationId: z.number().int().positive().nullable().default(null),
    maxFiles: z.number().int().min(1).max(200).default(120),
    maxCommits: z.number().int().min(1).max(200).default(40),
    maxPatchChars: z.number().int().min(1000).max(250000).default(40_000),
  })
  .passthrough();

const diffFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().nullable().default(null),
});

const commitContextSchema = z.object({
  sha: z.string(),
  title: z.string(),
  body: z.string().nullable().default(null),
});

const descriptionContextSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  pullRequestNumber: z.number().int().positive(),
  installationId: z.number().int().positive().nullable().default(null),
  pullRequestTitle: z.string(),
  pullRequestBody: z.string().nullable().default(null),
  pullRequestUrl: z.string().nullable().default(null),
  baseRef: z.string().nullable().default(null),
  headRef: z.string().nullable().default(null),
  files: z.array(diffFileSchema).default([]),
  commits: z.array(commitContextSchema).default([]),
  totalFiles: z.number().int().nonnegative(),
  totalChangedLines: z.number().int().nonnegative(),
});

const generatedDescriptionSchema = z.object({
  summary: z.string(),
  whatChanged: z.array(z.string()).default([]),
  why: z.array(z.string()).default([]),
});

const publishResultSchema = z.object({
  action: z.enum(["updated_pr_body", "posted_comment", "skipped"]),
  reason: z.string(),
  bodyUpdated: z.boolean().default(false),
  pullRequestUrl: z.string().nullable().default(null),
  commentUrl: z.string().nullable().default(null),
  generatedMarkdown: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type DiffFile = z.infer<typeof diffFileSchema>;
type CommitContext = z.infer<typeof commitContextSchema>;
type DescriptionContext = z.infer<typeof descriptionContextSchema>;
type GeneratedDescription = z.infer<typeof generatedDescriptionSchema>;

type DescriptionTarget = {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  installationId: number | null;
  maxFiles: number;
  maxCommits: number;
  maxPatchChars: number;
};

type ProxyMethod = "GET" | "POST" | "PATCH";

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

function resolveDescriptionTarget(input: Input): DescriptionTarget {
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
    maxFiles: clampInt(asNumber(input.maxFiles), 1, 200, 120),
    maxCommits: clampInt(asNumber(input.maxCommits), 1, 200, 40),
    maxPatchChars: clampInt(asNumber(input.maxPatchChars), 1000, 250000, 40_000),
  };
}

function splitCommitMessage(message: string): { title: string; body: string | null } {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return { title: "(no commit message)", body: null };
  }

  const [title, ...rest] = trimmed.split(/\r?\n/);
  const body = rest.join("\n").trim();
  return {
    title: title.trim(),
    body: body.length > 0 ? body : null,
  };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const clipped = value.slice(0, Math.max(0, maxChars)).trimEnd();
  return `${clipped}\n... [truncated]`;
}

async function collectDescriptionContext(input: Input): Promise<DescriptionContext> {
  const target = resolveDescriptionTarget(input);
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  const repoPath = `/repos/${owner}/${repo}`;

  const pullRequest = await githubProxyRequest<Record<string, unknown>>({
    method: "GET",
    path: `${repoPath}/pulls/${target.pullRequestNumber}`,
    installationId: target.installationId,
  });

  const pullRequestTitle = asString(pullRequest.title) ?? `PR #${target.pullRequestNumber}`;
  const pullRequestBody = asString(pullRequest.body);
  const pullRequestUrl = firstString([pullRequest.html_url, pullRequest.url]);
  const baseRef = asString(asRecord(pullRequest.base).ref);
  const headRef = asString(asRecord(pullRequest.head).ref);

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

  let patchBudget = target.maxPatchChars;
  const files: DiffFile[] = rawFiles
    .map((file) => {
      const path = asString(file.filename);
      if (!path) return null;

      const status = asString(file.status) ?? "modified";
      const additions = Math.max(0, Math.floor(asNumber(file.additions) ?? 0));
      const deletions = Math.max(0, Math.floor(asNumber(file.deletions) ?? 0));
      const changes = Math.max(
        0,
        Math.floor(asNumber(file.changes) ?? additions + deletions),
      );

      let patch = asString(file.patch);
      if (patch && patchBudget > 0) {
        patch = truncateText(patch, patchBudget);
        patchBudget = Math.max(0, patchBudget - patch.length);
      } else {
        patch = null;
      }

      return {
        path,
        status,
        additions,
        deletions,
        changes,
        patch,
      };
    })
    .filter((value): value is DiffFile => value !== null);

  const rawCommits: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10 && rawCommits.length < target.maxCommits; page += 1) {
    const commitBatchUnknown = await githubProxyRequest<unknown>({
      method: "GET",
      path: `${repoPath}/pulls/${target.pullRequestNumber}/commits?per_page=100&page=${page}`,
      installationId: target.installationId,
    });
    const commitBatch = Array.isArray(commitBatchUnknown)
      ? commitBatchUnknown.map(asRecord)
      : [];
    if (commitBatch.length === 0) break;
    rawCommits.push(...commitBatch.slice(0, target.maxCommits - rawCommits.length));
    if (commitBatch.length < 100) break;
  }

  const commits: CommitContext[] = rawCommits.map((commit) => {
    const message =
      asString(asRecord(commit.commit).message) ??
      asString(commit.message) ??
      "";
    const split = splitCommitMessage(message);

    return {
      sha: asString(commit.sha) ?? "unknown",
      title: split.title,
      body: split.body,
    };
  });

  const totalChangedLines = files.reduce((sum, file) => sum + file.changes, 0);

  return {
    owner: target.owner,
    repo: target.repo,
    pullRequestNumber: target.pullRequestNumber,
    installationId: target.installationId,
    pullRequestTitle,
    pullRequestBody,
    pullRequestUrl,
    baseRef,
    headRef,
    files,
    commits,
    totalFiles: files.length,
    totalChangedLines,
  };
}

function buildDescriptionPrompt(context: DescriptionContext): string {
  const commitLines =
    context.commits.length > 0
      ? context.commits.map((commit) => {
          const body = commit.body ? `\n${truncateText(commit.body, 300)}` : "";
          return `- ${commit.sha.slice(0, 12)} ${commit.title}${body}`;
        })
      : ["- (No commit messages were available)"];

  const fileSections =
    context.files.length > 0
      ? context.files.flatMap((file) => [
          `### ${file.path}`,
          `Status: ${file.status} | additions: ${file.additions} | deletions: ${file.deletions} | changes: ${file.changes}`,
          file.patch ? `\`\`\`diff\n${file.patch}\n\`\`\`` : "_No patch available._",
          "",
        ])
      : ["- No changed files were returned by the API."];

  return [
    "# Pull Request Description Generator",
    "",
    `Repository: ${context.owner}/${context.repo}`,
    `Pull request: #${context.pullRequestNumber}`,
    `Title: ${context.pullRequestTitle}`,
    context.baseRef ? `Base branch: ${context.baseRef}` : null,
    context.headRef ? `Head branch: ${context.headRef}` : null,
    "",
    "Generate a concise, structured PR description with these fields:",
    "- summary: short paragraph",
    "- whatChanged: 3-8 bullet points",
    "- why: 2-6 bullet points, inferred from code diff + commit intent",
    "",
    "Rules:",
    "1. Ground every point in the provided commits/diff.",
    "2. Be concrete about touched subsystems and behavior changes.",
    "3. Do not mention tests unless they are in the diff.",
    "4. Keep language direct and professional.",
    "5. Return strict JSON matching the schema.",
    "",
    "Commit messages:",
    ...commitLines,
    "",
    "Changed files:",
    "",
    ...fileSections,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function normalizeList(items: string[], maxItems: number): string[] {
  const dedupe = new Set<string>();
  const normalized: string[] = [];
  for (const item of items) {
    const cleaned = item.trim();
    if (cleaned.length === 0) continue;
    if (dedupe.has(cleaned)) continue;
    dedupe.add(cleaned);
    normalized.push(cleaned);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

function normalizeGeneratedDescription(
  generated: GeneratedDescription,
  context: DescriptionContext,
): GeneratedDescription {
  const summary = generated.summary.trim() || context.pullRequestTitle;
  const whatChanged = normalizeList(generated.whatChanged ?? [], 8);
  const why = normalizeList(generated.why ?? [], 6);

  return {
    summary,
    whatChanged:
      whatChanged.length > 0
        ? whatChanged
        : ["Updated code paths in this pull request based on the observed diff."],
    why:
      why.length > 0
        ? why
        : [
            "Aligns the implementation with the intent implied by commit messages and code changes.",
          ],
  };
}

function renderGeneratedMarkdown(generated: GeneratedDescription): string {
  return [
    "## Summary",
    generated.summary,
    "",
    "## What Changed",
    ...generated.whatChanged.map((line) => `- ${line}`),
    "",
    "## Why",
    ...generated.why.map((line) => `- ${line}`),
    "",
    generatedMarker,
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeStackSection(body: string): string {
  if (!body.includes(stackEndMarker)) return body;
  if (body.includes(stackStartMarker)) {
    const pattern = new RegExp(
      `${escapeRegExp(stackStartMarker)}[\\s\\S]*?${escapeRegExp(stackEndMarker)}`,
      "g",
    );
    return body.replace(pattern, " ");
  }
  return body.replace(stackEndMarker, " ");
}

function isMinimalPrBody(rawBody: string | null | undefined): boolean {
  if (!rawBody) return true;
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) return true;

  const withoutStack = removeStackSection(trimmed)
    .replace(/^\|.*\|\s*$/gm, " ")
    .replace(/^:?-{3,}:?\s*$/gm, " ")
    .replace(/<!--[^]*?-->/g, " ")
    .trim();

  if (withoutStack.length === 0) return true;

  const collapsed = withoutStack.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return true;

  const normalized = collapsed
    .replace(/^[#>*\-\s]+/g, "")
    .replace(/[\s`*_#>|]+/g, " ")
    .trim()
    .toLowerCase();

  if (normalized.length === 0) return true;
  if (
    normalized.length <= 32 &&
    /^(tbd|todo|n\/a|na|none|placeholder|description|summary|wip|draft|pending)$/.test(normalized)
  ) {
    return true;
  }

  const lines = withoutStack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^#+\s+/.test(line));

  return lines.length === 0;
}

function hasGeneratedDescription(rawBody: string | null | undefined): boolean {
  if (!rawBody) return false;
  return rawBody.includes(generatedMarker);
}

function injectGeneratedDescription(
  rawBody: string | null | undefined,
  generatedMarkdown: string,
): string {
  const body = (rawBody ?? "").trimEnd();
  const generated = generatedMarkdown.trim();
  if (body.length === 0) return generated;

  const markerIndex = body.indexOf(stackEndMarker);
  if (markerIndex >= 0) {
    const before = body.slice(0, markerIndex + stackEndMarker.length).trimEnd();
    const after = body.slice(markerIndex + stackEndMarker.length).trim();
    if (after.length === 0) {
      return `${before}\n\n${generated}`;
    }
    return `${before}\n\n${generated}\n\n${after}`;
  }

  return `${body}\n\n${generated}`;
}

function buildCommentBody(generatedMarkdown: string): string {
  return [
    "Smithers generated a PR description suggestion. Existing PR body content was left unchanged.",
    "",
    generatedMarkdown,
    "",
    generatedCommentMarker,
  ].join("\n");
}

async function hasGeneratedComment(context: DescriptionContext): Promise<boolean> {
  const owner = encodeURIComponent(context.owner);
  const repo = encodeURIComponent(context.repo);
  const issuePath = `/repos/${owner}/${repo}/issues/${context.pullRequestNumber}/comments`;

  for (let page = 1; page <= 3; page += 1) {
    const commentsUnknown = await githubProxyRequest<unknown>({
      method: "GET",
      path: `${issuePath}?per_page=100&page=${page}`,
      installationId: context.installationId,
    });
    const comments = Array.isArray(commentsUnknown)
      ? commentsUnknown.map(asRecord)
      : [];
    if (comments.length === 0) return false;

    const matched = comments.some((comment) => {
      const body = asString(comment.body);
      return Boolean(body && body.includes(generatedCommentMarker));
    });
    if (matched) return true;

    if (comments.length < 100) return false;
  }

  return false;
}

async function publishDescription(
  context: DescriptionContext,
  generatedRaw: GeneratedDescription,
) {
  const generated = normalizeGeneratedDescription(generatedRaw, context);
  const generatedMarkdown = renderGeneratedMarkdown(generated);
  const existingBody = context.pullRequestBody;

  if (hasGeneratedDescription(existingBody)) {
    return {
      action: "skipped" as const,
      reason: "PR body already contains a Smithers-generated description.",
      bodyUpdated: false,
      pullRequestUrl: context.pullRequestUrl,
      commentUrl: null,
      generatedMarkdown,
    };
  }

  const owner = encodeURIComponent(context.owner);
  const repo = encodeURIComponent(context.repo);
  const repoPath = `/repos/${owner}/${repo}`;

  if (isMinimalPrBody(existingBody)) {
    const body = injectGeneratedDescription(existingBody, generatedMarkdown);

    const updatedPr = await githubProxyRequest<Record<string, unknown>>({
      method: "PATCH",
      path: `${repoPath}/pulls/${context.pullRequestNumber}`,
      installationId: context.installationId,
      body: { body },
    });

    return {
      action: "updated_pr_body" as const,
      reason: "PR body was empty/minimal, so a generated description was injected.",
      bodyUpdated: true,
      pullRequestUrl: firstString([updatedPr.html_url, context.pullRequestUrl]),
      commentUrl: null,
      generatedMarkdown,
    };
  }

  if (await hasGeneratedComment(context)) {
    return {
      action: "skipped" as const,
      reason: "PR already has user-authored description and an existing generated suggestion comment.",
      bodyUpdated: false,
      pullRequestUrl: context.pullRequestUrl,
      commentUrl: null,
      generatedMarkdown,
    };
  }

  const comment = await githubProxyRequest<Record<string, unknown>>({
    method: "POST",
    path: `${repoPath}/issues/${context.pullRequestNumber}/comments`,
    installationId: context.installationId,
    body: {
      body: buildCommentBody(generatedMarkdown),
    },
  });

  return {
    action: "posted_comment" as const,
    reason: "PR already had a description, so suggestion was posted as a comment.",
    bodyUpdated: false,
    pullRequestUrl: context.pullRequestUrl,
    commentUrl: firstString([comment.html_url, comment.url]),
    generatedMarkdown,
  };
}

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  context: descriptionContextSchema,
  generated: generatedDescriptionSchema,
  publish: publishResultSchema,
});

export default smithers((ctx) => (
  <Workflow name="pr-description">
    <Task id="collect-context" output={outputs.context} timeoutMs={30_000}>
      {async () => collectDescriptionContext(ctx.input)}
    </Task>

    <Task
      id="generate-description"
      output={outputs.generated}
      needs={{ context: "collect-context" }}
      deps={{ context: descriptionContextSchema }}
      agent={agents.smart}
      timeoutMs={60_000}
      heartbeatTimeoutMs={60_000}
    >
      {(deps) => buildDescriptionPrompt(deps.context)}
    </Task>

    <Task
      id="publish-description"
      output={outputs.publish}
      needs={{ context: "collect-context", generated: "generate-description" }}
      deps={{
        context: descriptionContextSchema,
        generated: generatedDescriptionSchema,
      }}
      timeoutMs={30_000}
    >
      {(deps) => publishDescription(deps.context, deps.generated)}
    </Task>
  </Workflow>
));
