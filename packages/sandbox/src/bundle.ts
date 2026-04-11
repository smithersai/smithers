import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { SmithersError } from "@smithers/core/errors";
import {
  assertJsonPayloadWithinBounds,
  assertOptionalArrayMaxLength,
  assertOptionalStringMaxLength,
} from "@smithers/core/utils/input-bounds";
import { resolveSandboxPath } from "@smithers/tools/utils";

export const SANDBOX_MAX_BUNDLE_BYTES = 100 * 1024 * 1024; // 100MB
export const SANDBOX_MAX_README_BYTES = 5 * 1024 * 1024; // 5MB
export const SANDBOX_MAX_PATCH_FILES = 1000;
export const SANDBOX_BUNDLE_RUN_ID_MAX_LENGTH = 256;
export const SANDBOX_BUNDLE_PATH_MAX_LENGTH = 1024;
export const SANDBOX_BUNDLE_OUTPUT_MAX_DEPTH = 16;
export const SANDBOX_BUNDLE_OUTPUT_MAX_ARRAY_LENGTH = 512;
export const SANDBOX_BUNDLE_OUTPUT_MAX_STRING_LENGTH = 64 * 1024;

export type SandboxBundleManifest = {
  outputs: unknown;
  status: "finished" | "failed" | "cancelled";
  runId?: string;
  patches?: string[];
};

export type ValidatedSandboxBundle = {
  manifest: SandboxBundleManifest;
  bundleSizeBytes: number;
  patchFiles: string[];
  logsPath: string | null;
  bundlePath: string;
};

type WalkResult = {
  files: string[];
  totalBytes: number;
};

async function walkFiles(dir: string): Promise<WalkResult> {
  const pending = [dir];
  const files: string[] = [];
  let totalBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        files.push(full);
        const info = await stat(full);
        totalBytes += info.size;
      }
    }
  }

  return { files, totalBytes };
}

function parseReadmeJson(readme: string): SandboxBundleManifest {
  const trimmed = readme.trim();
  if (trimmed.length === 0) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Sandbox bundle README.md is empty.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new SmithersError(
      "INVALID_INPUT",
      "Sandbox bundle README.md must contain valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SmithersError(
      "INVALID_INPUT",
      "Sandbox bundle README.md JSON must be an object.",
    );
  }
  const manifest = parsed as Record<string, unknown>;
  const status = manifest.status;
  if (status !== "finished" && status !== "failed" && status !== "cancelled") {
    throw new SmithersError(
      "INVALID_INPUT",
      "Sandbox bundle README.md must include status: finished | failed | cancelled.",
    );
  }
  return {
    outputs: manifest.outputs,
    status,
    runId: typeof manifest.runId === "string" ? manifest.runId : undefined,
    patches: Array.isArray(manifest.patches)
      ? manifest.patches.filter((v): v is string => typeof v === "string")
      : undefined,
  };
}

function assertPatchPathSafe(bundlePath: string, patchPath: string) {
  const base = resolveSandboxPath(bundlePath, "patches");
  const resolved = resolveSandboxPath(bundlePath, patchPath);
  const rel = relative(base, resolved);
  if (rel.startsWith("..") || rel === "") {
    throw new SmithersError(
      "TOOL_PATH_ESCAPE",
      `Sandbox patch path escapes bundle root: ${patchPath}`,
      { patchPath },
    );
  }
}

async function estimateBundleWriteBytes(params: {
  output: unknown;
  patches?: Array<{ path: string; content: string }>;
  artifacts?: Array<{ path: string; content: string }>;
  runId?: string;
  status: "finished" | "failed" | "cancelled";
  streamLogPath?: string | null;
}) {
  const readmeBytes = Buffer.byteLength(
    JSON.stringify(
      {
        outputs: params.output,
        status: params.status,
        runId: params.runId,
        patches: (params.patches ?? []).map((patch) => patch.path),
      },
      null,
      2,
    ),
    "utf8",
  );
  const patchBytes = (params.patches ?? []).reduce(
    (total, patch) => total + Buffer.byteLength(patch.content, "utf8"),
    0,
  );
  const artifactBytes = (params.artifacts ?? []).reduce(
    (total, artifact) => total + Buffer.byteLength(artifact.content, "utf8"),
    0,
  );
  const streamLogBytes = params.streamLogPath
    ? (await stat(params.streamLogPath).catch(() => null))?.size ?? 0
    : 0;
  return readmeBytes + patchBytes + artifactBytes + streamLogBytes;
}

async function validateSandboxBundleWriteParams(params: {
  bundlePath: string;
  output: unknown;
  status: "finished" | "failed" | "cancelled";
  runId?: string;
  streamLogPath?: string | null;
  patches?: Array<{ path: string; content: string }>;
  artifacts?: Array<{ path: string; content: string }>;
}) {
  assertOptionalStringMaxLength(
    "bundlePath",
    params.bundlePath,
    SANDBOX_BUNDLE_PATH_MAX_LENGTH,
  );
  assertOptionalStringMaxLength(
    "runId",
    params.runId,
    SANDBOX_BUNDLE_RUN_ID_MAX_LENGTH,
  );
  assertOptionalArrayMaxLength(
    "patches",
    params.patches,
    SANDBOX_MAX_PATCH_FILES,
  );
  assertOptionalArrayMaxLength(
    "artifacts",
    params.artifacts,
    SANDBOX_MAX_PATCH_FILES,
  );
  if (params.output !== undefined) {
    assertJsonPayloadWithinBounds("output", params.output, {
      maxArrayLength: SANDBOX_BUNDLE_OUTPUT_MAX_ARRAY_LENGTH,
      maxDepth: SANDBOX_BUNDLE_OUTPUT_MAX_DEPTH,
      maxStringLength: SANDBOX_BUNDLE_OUTPUT_MAX_STRING_LENGTH,
    });
  }
  for (const patch of params.patches ?? []) {
    assertOptionalStringMaxLength(
      "patch.path",
      patch.path,
      SANDBOX_BUNDLE_PATH_MAX_LENGTH,
    );
  }
  for (const artifact of params.artifacts ?? []) {
    assertOptionalStringMaxLength(
      "artifact.path",
      artifact.path,
      SANDBOX_BUNDLE_PATH_MAX_LENGTH,
    );
  }
  const estimatedBytes = await estimateBundleWriteBytes(params);
  if (estimatedBytes > SANDBOX_MAX_BUNDLE_BYTES) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Sandbox bundle exceeds ${SANDBOX_MAX_BUNDLE_BYTES} bytes`,
      { maxBytes: SANDBOX_MAX_BUNDLE_BYTES, estimatedBytes },
    );
  }
}

export async function validateSandboxBundle(
  bundlePath: string,
): Promise<ValidatedSandboxBundle> {
  const resolvedReadme = resolveSandboxPath(bundlePath, "README.md");
  const readmeStats = await stat(resolvedReadme).catch(() => null);
  if (!readmeStats?.isFile()) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Sandbox bundle is missing README.md",
      { bundlePath },
    );
  }
  if (readmeStats.size > SANDBOX_MAX_README_BYTES) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Sandbox bundle README.md exceeds ${SANDBOX_MAX_README_BYTES} bytes`,
      { bundlePath, maxBytes: SANDBOX_MAX_README_BYTES },
    );
  }

  const readmeRaw = await readFile(resolvedReadme, "utf8");
  const manifest = parseReadmeJson(readmeRaw);
  const walked = await walkFiles(bundlePath);
  if (walked.totalBytes > SANDBOX_MAX_BUNDLE_BYTES) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Sandbox bundle exceeds ${SANDBOX_MAX_BUNDLE_BYTES} bytes`,
      { bundlePath, maxBytes: SANDBOX_MAX_BUNDLE_BYTES },
    );
  }

  const patchFiles = walked.files
    .filter((file) => relative(bundlePath, file).startsWith("patches/"))
    .filter((file) => file.endsWith(".patch"))
    .map((file) => relative(bundlePath, file));

  if (patchFiles.length > SANDBOX_MAX_PATCH_FILES) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Sandbox bundle has too many patch files (max ${SANDBOX_MAX_PATCH_FILES}).`,
      { patchCount: patchFiles.length, maxPatches: SANDBOX_MAX_PATCH_FILES },
    );
  }

  for (const patchPath of patchFiles) {
    assertPatchPathSafe(bundlePath, patchPath);
  }

  for (const patchPath of manifest.patches ?? []) {
    assertPatchPathSafe(bundlePath, patchPath);
  }

  const logsPath = resolveSandboxPath(bundlePath, "logs/stream.ndjson");
  const logsStats = await stat(logsPath).catch(() => null);

  return {
    manifest,
    bundleSizeBytes: walked.totalBytes,
    patchFiles,
    logsPath: logsStats?.isFile() ? logsPath : null,
    bundlePath,
  };
}

export async function writeSandboxBundle(params: {
  bundlePath: string;
  output: unknown;
  status: "finished" | "failed" | "cancelled";
  runId?: string;
  streamLogPath?: string | null;
  patches?: Array<{ path: string; content: string }>;
  artifacts?: Array<{ path: string; content: string }>;
}) {
  await validateSandboxBundleWriteParams(params);
  await mkdir(params.bundlePath, { recursive: true });
  await mkdir(join(params.bundlePath, "patches"), { recursive: true });
  await mkdir(join(params.bundlePath, "artifacts"), { recursive: true });
  await mkdir(join(params.bundlePath, "logs"), { recursive: true });

  for (const patch of params.patches ?? []) {
    const file = resolveSandboxPath(params.bundlePath, patch.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, patch.content, "utf8");
  }

  for (const artifact of params.artifacts ?? []) {
    const file = resolveSandboxPath(params.bundlePath, artifact.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, artifact.content, "utf8");
  }

  if (params.streamLogPath) {
    const logContent = await readFile(params.streamLogPath, "utf8").catch(() => "");
    await writeFile(
      resolveSandboxPath(params.bundlePath, "logs/stream.ndjson"),
      logContent,
      "utf8",
    );
  }

  await writeFile(
    resolveSandboxPath(params.bundlePath, "README.md"),
    JSON.stringify(
      {
        outputs: params.output,
        status: params.status,
        runId: params.runId,
        patches: (params.patches ?? []).map((p) => p.path),
      },
      null,
      2,
    ),
    "utf8",
  );
}
