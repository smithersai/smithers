import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { SmithersError } from "../utils/errors";

const GITHUB_API_DEFAULT_BASE_URL = "https://api.github.com";
const SMITHERS_CONFIG_DIR = ".smithers";
const SMITHERS_CONFIG_FILE = "config.json";
const BACKEND_DB_FILE = "smithers.db";
const BACKEND_CONNECTIONS_TABLE = "_smithers_repo_connections";

export const ACCEPTED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
]);

type GitHubRepoResponse = {
  private?: boolean;
  full_name?: string;
  license?: {
    spdx_id?: string | null;
  } | null;
};

type BackendRepoConnectionRow = {
  local_repo_root: string;
  github_owner: string;
  github_repo: string;
  github_full_name: string;
  license_spdx: string;
  license_source: "github" | "local-license";
  connected_at_ms: number;
  updated_at_ms: number;
};

export type RepoConnectionRecord = {
  owner: string;
  repo: string;
  fullName: string;
  licenseSpdx: string;
  licenseSource: "github" | "local-license";
  connectedAt: string;
};

type RepoCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  nowMs?: number;
};

type RepoCommandReadOptions = {
  cwd?: string;
};

type SmithersLocalConfig = {
  repoConnection?: RepoConnectionRecord;
  [key: string]: unknown;
};

export type RepoConnectResult = {
  connected: true;
  repo: string;
  license: string;
  licenseSource: "github" | "local-license";
  localConfigPath: string;
  backendDbPath: string;
};

export type RepoDisconnectResult = {
  connected: false;
  disconnected: boolean;
  repo: string | null;
  localRemoved: boolean;
  backendRemoved: boolean;
  localConfigPath: string;
  backendDbPath: string;
};

export type RepoStatusResult = {
  connected: boolean;
  repo: string | null;
  license: string | null;
  backendSynced: boolean;
  localConfigPath: string;
  backendDbPath: string;
};

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function truncate(value: string, limit = 220): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

function resolveRepoRoot(cwd?: string): string {
  return resolve(cwd ?? process.cwd());
}

function smithersConfigPath(repoRoot: string) {
  return resolve(repoRoot, SMITHERS_CONFIG_DIR, SMITHERS_CONFIG_FILE);
}

function backendDbPath(repoRoot: string) {
  return resolve(repoRoot, BACKEND_DB_FILE);
}

function ensureJjRepo(repoRoot: string) {
  const jjPath = resolve(repoRoot, ".jj");
  if (!existsSync(jjPath)) {
    throw new SmithersError(
      "JJ_REPO_REQUIRED",
      "Current directory is not a jj repository (.jj/ missing).",
      { repoRoot, jjPath },
    );
  }
}

function parseOwnerRepo(ownerRepo: string): { owner: string; repo: string } {
  const trimmed = ownerRepo.trim();
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  if (!match) {
    throw new SmithersError(
      "INVALID_REPO_IDENTIFIER",
      "Repository must be in owner/repo format.",
      { value: ownerRepo },
    );
  }
  return { owner: match[1]!, repo: match[2]! };
}

function normalizeSpdxId(spdxId: unknown): string | null {
  if (typeof spdxId !== "string") return null;
  const trimmed = spdxId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function inferSpdxIdFromLicenseText(licenseText: string): string | null {
  const normalized = licenseText.toLowerCase();

  if (
    normalized.includes("mit license") ||
    normalized.includes(
      "permission is hereby granted, free of charge, to any person obtaining a copy",
    )
  ) {
    return "MIT";
  }

  if (
    normalized.includes("apache license") &&
    normalized.includes("version 2.0")
  ) {
    return "Apache-2.0";
  }

  const isBsdLike = normalized.includes(
    "redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met",
  );
  if (isBsdLike) {
    if (normalized.includes("neither the name of")) {
      return "BSD-3-Clause";
    }
    return "BSD-2-Clause";
  }

  if (
    normalized.includes(
      "permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted",
    )
  ) {
    return "ISC";
  }

  if (
    normalized.includes("mozilla public license") &&
    normalized.includes("version 2.0")
  ) {
    return "MPL-2.0";
  }

  return null;
}

function readLicenseFromRepoRoot(repoRoot: string): string | null {
  const entries = readdirSync(repoRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^license(?:[._-].+)?$/i.test(entry.name))
    .map((entry) => resolve(repoRoot, entry.name))
    .sort((a, b) => a.localeCompare(b));

  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      if (raw.trim().length > 0) return raw;
    } catch {}
  }

  return null;
}

async function fetchGitHubRepo(
  owner: string,
  repo: string,
  options: RepoCommandOptions,
): Promise<GitHubRepoResponse> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = trimTrailingSlashes(
    env.SMITHERS_GITHUB_API_BASE_URL ?? GITHUB_API_DEFAULT_BASE_URL,
  );
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "smithers-cli",
  };
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers });
  } catch (error: any) {
    throw new SmithersError(
      "GITHUB_API_FAILED",
      `Failed to query GitHub repository metadata for ${owner}/${repo}: ${error?.message ?? String(error)}`,
      { owner, repo, url },
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new SmithersError(
      "GITHUB_API_FAILED",
      `GitHub API request failed (${response.status}) for ${owner}/${repo}${details ? `: ${truncate(details)}` : ""}`,
      { owner, repo, url, status: response.status },
    );
  }

  try {
    return (await response.json()) as GitHubRepoResponse;
  } catch (error: any) {
    throw new SmithersError(
      "GITHUB_API_FAILED",
      `GitHub API returned invalid JSON for ${owner}/${repo}: ${error?.message ?? String(error)}`,
      { owner, repo, url },
    );
  }
}

function readLocalConfig(repoRoot: string): SmithersLocalConfig {
  const configPath = smithersConfigPath(repoRoot);
  if (!existsSync(configPath)) {
    return {};
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(configPath, "utf8");
    parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch (error: any) {
    throw new SmithersError(
      "INVALID_REPO_CONFIG",
      `Failed to parse ${configPath}: ${error?.message ?? String(error)}`,
      { configPath },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SmithersError(
      "INVALID_REPO_CONFIG",
      `${configPath} must contain a JSON object.`,
      { configPath },
    );
  }

  return parsed as SmithersLocalConfig;
}

function writeLocalConfig(repoRoot: string, config: SmithersLocalConfig) {
  const configPath = smithersConfigPath(repoRoot);
  mkdirSync(resolve(repoRoot, SMITHERS_CONFIG_DIR), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function parseRepoConnectionRecord(value: unknown): RepoConnectionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const maybe = value as Partial<RepoConnectionRecord>;
  if (
    typeof maybe.owner !== "string" ||
    typeof maybe.repo !== "string" ||
    typeof maybe.fullName !== "string" ||
    typeof maybe.licenseSpdx !== "string" ||
    typeof maybe.connectedAt !== "string"
  ) {
    return null;
  }

  const source =
    maybe.licenseSource === "local-license" ? "local-license" : "github";

  return {
    owner: maybe.owner,
    repo: maybe.repo,
    fullName: maybe.fullName,
    licenseSpdx: maybe.licenseSpdx,
    connectedAt: maybe.connectedAt,
    licenseSource: source,
  };
}

function ensureRepoConnectionsTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${BACKEND_CONNECTIONS_TABLE} (
      local_repo_root TEXT PRIMARY KEY,
      github_owner TEXT NOT NULL,
      github_repo TEXT NOT NULL,
      github_full_name TEXT NOT NULL,
      license_spdx TEXT NOT NULL,
      license_source TEXT NOT NULL,
      connected_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function withBackendDb<T>(repoRoot: string, run: (db: Database) => T): T {
  const db = new Database(backendDbPath(repoRoot));
  try {
    ensureRepoConnectionsTable(db);
    return run(db);
  } finally {
    try {
      db.close();
    } catch {}
  }
}

function upsertBackendConnection(
  repoRoot: string,
  connection: RepoConnectionRecord,
  nowMs: number,
) {
  withBackendDb(repoRoot, (db) => {
    db.query(
      `
        INSERT INTO ${BACKEND_CONNECTIONS_TABLE} (
          local_repo_root,
          github_owner,
          github_repo,
          github_full_name,
          license_spdx,
          license_source,
          connected_at_ms,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_repo_root) DO UPDATE SET
          github_owner = excluded.github_owner,
          github_repo = excluded.github_repo,
          github_full_name = excluded.github_full_name,
          license_spdx = excluded.license_spdx,
          license_source = excluded.license_source,
          updated_at_ms = excluded.updated_at_ms
      `,
    ).run(
      repoRoot,
      connection.owner,
      connection.repo,
      connection.fullName,
      connection.licenseSpdx,
      connection.licenseSource,
      nowMs,
      nowMs,
    );
  });
}

function deleteBackendConnection(repoRoot: string): boolean {
  return withBackendDb(repoRoot, (db) => {
    const result = db
      .query(
        `DELETE FROM ${BACKEND_CONNECTIONS_TABLE} WHERE local_repo_root = ?`,
      )
      .run(repoRoot) as { changes?: number };
    return (result.changes ?? 0) > 0;
  });
}

function readBackendConnection(repoRoot: string): RepoConnectionRecord | null {
  return withBackendDb(repoRoot, (db) => {
    const row = db
      .query(
        `
          SELECT
            local_repo_root,
            github_owner,
            github_repo,
            github_full_name,
            license_spdx,
            license_source,
            connected_at_ms
          FROM ${BACKEND_CONNECTIONS_TABLE}
          WHERE local_repo_root = ?
          LIMIT 1
        `,
      )
      .get(repoRoot) as BackendRepoConnectionRow | null;

    if (!row) return null;
    return {
      owner: row.github_owner,
      repo: row.github_repo,
      fullName: row.github_full_name,
      licenseSpdx: row.license_spdx,
      licenseSource:
        row.license_source === "local-license" ? "local-license" : "github",
      connectedAt: new Date(row.connected_at_ms).toISOString(),
    };
  });
}

export async function connectRepository(
  ownerRepo: string,
  options: RepoCommandOptions = {},
): Promise<RepoConnectResult> {
  const repoRoot = resolveRepoRoot(options.cwd);
  ensureJjRepo(repoRoot);

  const { owner, repo } = parseOwnerRepo(ownerRepo);
  const githubRepo = await fetchGitHubRepo(owner, repo, options);

  if (githubRepo.private === true) {
    throw new SmithersError(
      "REPO_NOT_PUBLIC",
      `Repository ${owner}/${repo} is private.`,
      { owner, repo },
    );
  }

  let licenseSpdx = normalizeSpdxId(githubRepo.license?.spdx_id);
  let licenseSource: "github" | "local-license" = "github";

  if (!licenseSpdx) {
    const localLicense = readLicenseFromRepoRoot(repoRoot);
    const inferred = localLicense
      ? inferSpdxIdFromLicenseText(localLicense)
      : null;
    if (inferred) {
      licenseSpdx = inferred;
      licenseSource = "local-license";
    }
  }

  if (!licenseSpdx || !ACCEPTED_LICENSES.has(licenseSpdx)) {
    throw new SmithersError(
      "LICENSE_NOT_PERMITTED",
      `Repository ${owner}/${repo} must use one of: ${Array.from(ACCEPTED_LICENSES).join(", ")}.`,
      { owner, repo, license: licenseSpdx ?? null },
    );
  }

  const fullName =
    typeof githubRepo.full_name === "string" &&
    /^[^/\s]+\/[^/\s]+$/.test(githubRepo.full_name)
      ? githubRepo.full_name
      : `${owner}/${repo}`;

  const nowMs = options.nowMs ?? Date.now();
  const connection: RepoConnectionRecord = {
    owner,
    repo,
    fullName,
    licenseSpdx,
    licenseSource,
    connectedAt: new Date(nowMs).toISOString(),
  };

  const previousConfig = readLocalConfig(repoRoot);
  const nextConfig: SmithersLocalConfig = {
    ...previousConfig,
    repoConnection: connection,
  };
  writeLocalConfig(repoRoot, nextConfig);

  try {
    upsertBackendConnection(repoRoot, connection, nowMs);
  } catch (error: any) {
    // Keep local + backend writes aligned on failure.
    writeLocalConfig(repoRoot, previousConfig);
    throw new SmithersError(
      "BACKEND_CONNECTION_WRITE_FAILED",
      `Failed to store backend repo connection mapping: ${error?.message ?? String(error)}`,
      { repoRoot },
    );
  }

  return {
    connected: true,
    repo: connection.fullName,
    license: connection.licenseSpdx,
    licenseSource: connection.licenseSource,
    localConfigPath: smithersConfigPath(repoRoot),
    backendDbPath: backendDbPath(repoRoot),
  };
}

export function disconnectRepository(
  options: RepoCommandReadOptions = {},
): RepoDisconnectResult {
  const repoRoot = resolveRepoRoot(options.cwd);
  const config = readLocalConfig(repoRoot);
  const localConnection = parseRepoConnectionRecord(config.repoConnection);
  const hadLocalConnection = localConnection !== null;

  if ("repoConnection" in config) {
    const nextConfig: SmithersLocalConfig = { ...config };
    delete nextConfig.repoConnection;
    writeLocalConfig(repoRoot, nextConfig);
  }

  const backendRemoved = deleteBackendConnection(repoRoot);

  return {
    connected: false,
    disconnected: hadLocalConnection || backendRemoved,
    repo: localConnection?.fullName ?? null,
    localRemoved: hadLocalConnection,
    backendRemoved,
    localConfigPath: smithersConfigPath(repoRoot),
    backendDbPath: backendDbPath(repoRoot),
  };
}

export function getRepositoryStatus(
  options: RepoCommandReadOptions = {},
): RepoStatusResult {
  const repoRoot = resolveRepoRoot(options.cwd);
  const config = readLocalConfig(repoRoot);
  const localConnection = parseRepoConnectionRecord(config.repoConnection);
  const backendConnection = readBackendConnection(repoRoot);
  const activeConnection = localConnection ?? backendConnection;

  return {
    connected: activeConnection !== null,
    repo: activeConnection?.fullName ?? null,
    license: activeConnection?.licenseSpdx ?? null,
    backendSynced:
      localConnection !== null &&
      backendConnection !== null &&
      localConnection.fullName === backendConnection.fullName &&
      localConnection.licenseSpdx === backendConnection.licenseSpdx,
    localConfigPath: smithersConfigPath(repoRoot),
    backendDbPath: backendDbPath(repoRoot),
  };
}

