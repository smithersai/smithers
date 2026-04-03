import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { SmithersError } from "./utils/errors";

const DEFAULT_MANIFEST_PATH = "baml_client/smithers/manifest.json";
const DEFAULT_GENERATE_COMMAND = ["baml-cli"];
const BAML_SOURCE_DIR_NAME = "baml_src";

type PluginMessage = {
  text: string;
  detail?: unknown;
};

type PluginResolveArgs = {
  path: string;
  importer: string;
  namespace: string;
  resolveDir: string;
};

type PluginResolveResult = {
  path: string;
  namespace?: string;
  pluginData?: unknown;
};

type PluginBuilderLike = {
  onStart?(callback: () => void | Promise<void>): void;
  onResolve(
    options: { filter: RegExp; namespace?: string },
    callback: (
      args: PluginResolveArgs,
    ) =>
      | PluginResolveResult
      | undefined
      | Promise<PluginResolveResult | undefined>,
  ): void;
};

export type BamlPluginOptions = {
  cwd?: string;
  from?: string | string[];
  manifestPath?: string;
  generate?: boolean;
  generateCommand?: string[];
  noTests?: boolean;
};

export type BamlBundlerPlugin = {
  name: string;
  setup(build: PluginBuilderLike): void | Promise<void>;
};

type Manifest = {
  version: number;
  entries: Record<string, string>;
};

type ResolvedBamlPluginOptions = {
  cwd: string;
  sourceDirs: string[];
  manifestPath: string;
  generate: boolean;
  generateCommand: string[];
  noTests: boolean;
};

function normalizeSlashes(value: string) {
  return value.replaceAll("\\", "/");
}

function normalizeManifestKey(value: string) {
  return normalizeSlashes(value).replace(/^\.\/+/, "");
}

function canonicalPath(value: string) {
  try {
    return realpathSync.native(value);
  } catch {
    try {
      return resolve(realpathSync.native(dirname(value)), basename(value));
    } catch {
      return resolve(value);
    }
  }
}

function isWithinDir(filePath: string, dirPath: string) {
  const rel = relative(dirPath, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function discoverSourceDirs(rootDir: string) {
  const found = new Set<string>();
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".jj" ||
        entry.name === ".smithers" ||
        entry.name === "baml_client"
      ) {
        continue;
      }

      const nextPath = canonicalPath(resolve(current, entry.name));
      if (entry.name === BAML_SOURCE_DIR_NAME) {
        found.add(nextPath);
        continue;
      }

      queue.push(nextPath);
    }
  }

  const defaultSourceDir = canonicalPath(resolve(rootDir, BAML_SOURCE_DIR_NAME));
  if (found.size === 0 && existsSync(defaultSourceDir)) {
    found.add(defaultSourceDir);
  }

  return [...found].sort();
}

function resolveSourceDirs(rootDir: string, from?: string | string[]) {
  if (from == null) {
    return discoverSourceDirs(rootDir);
  }

  const values = Array.isArray(from) ? from : [from];
  return values.map((value) => canonicalPath(resolve(rootDir, value)));
}

function resolvePluginOptions(options: BamlPluginOptions): ResolvedBamlPluginOptions {
  const cwd = canonicalPath(resolve(options.cwd ?? process.cwd()));
  return {
    cwd,
    sourceDirs: resolveSourceDirs(cwd, options.from),
    manifestPath: resolve(cwd, options.manifestPath ?? DEFAULT_MANIFEST_PATH),
    generate: options.generate ?? true,
    generateCommand: options.generateCommand?.length
      ? options.generateCommand
      : DEFAULT_GENERATE_COMMAND,
    noTests: options.noTests ?? process.env.NODE_ENV === "production",
  };
}

function formatMessages(messages: PluginMessage[]) {
  return messages.map((message) => message.text).join("\n");
}

function ensureGenerateCommand(options: ResolvedBamlPluginOptions) {
  if (!options.generate) return;
  if (options.sourceDirs.length === 0) return;

  const cmd = [...options.generateCommand, "generate"];
  for (const dir of options.sourceDirs) {
    cmd.push("--from", dir);
  }
  if (options.noTests) {
    cmd.push("--no-tests");
  }

  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: options.cwd,
    env: process.env,
    encoding: "utf8",
  });

  if (result.status === 0) {
    return;
  }

  const stderr = (result.stderr ?? "").trim();
  const stdout = (result.stdout ?? "").trim();
  const details = [stderr, stdout, result.error?.message].filter(Boolean).join("\n");
  throw new SmithersError(
    "BAML_COMMAND_FAILED",
    `smithers-baml: failed to run ${JSON.stringify(cmd)}${details ? `\n${details}` : ""}`,
  );
}

function readManifest(manifestPath: string) {
  if (!existsSync(manifestPath)) {
    throw new SmithersError(
      "BAML_MANIFEST_NOT_FOUND",
      `smithers-baml: manifest not found at ${manifestPath}. ` +
        `Run the BAML Smithers generator so it emits ${DEFAULT_MANIFEST_PATH}.`,
    );
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<Manifest>;
  if (!raw || typeof raw !== "object" || !raw.entries || typeof raw.entries !== "object") {
    throw new SmithersError(
      "BAML_MANIFEST_INVALID",
      `smithers-baml: invalid manifest at ${manifestPath}. Expected { version, entries }.`,
    );
  }

  return raw as Manifest;
}

function candidateManifestKeys(sourcePath: string, options: ResolvedBamlPluginOptions) {
  const canonicalSourcePath = canonicalPath(sourcePath);
  const keys = new Set<string>();
  keys.add(normalizeManifestKey(relative(options.cwd, canonicalSourcePath)));
  keys.add(normalizeManifestKey(canonicalSourcePath));

  for (const sourceDir of options.sourceDirs) {
    if (canonicalSourcePath === sourceDir || isWithinDir(canonicalSourcePath, sourceDir)) {
      keys.add(normalizeManifestKey(relative(sourceDir, canonicalSourcePath)));
    }
  }

  return [...keys].filter(Boolean);
}

function resolveGeneratedModulePath(
  sourcePath: string,
  options: ResolvedBamlPluginOptions,
) {
  const manifest = readManifest(options.manifestPath);
  const normalizedEntries = new Map<string, string>();
  for (const [key, value] of Object.entries(manifest.entries)) {
    normalizedEntries.set(normalizeManifestKey(key), value);
  }

  const candidates = candidateManifestKeys(sourcePath, options);
  for (const key of candidates) {
    const entry = normalizedEntries.get(key);
    if (!entry) continue;

    if (isAbsolute(entry)) {
      return canonicalPath(entry);
    }

    const fromCwd = resolve(options.cwd, entry);
    if (existsSync(fromCwd)) {
      return canonicalPath(fromCwd);
    }

    const fromManifestDir = resolve(dirname(options.manifestPath), entry);
    if (existsSync(fromManifestDir)) {
      return canonicalPath(fromManifestDir);
    }

    return canonicalPath(fromCwd);
  }

  throw new SmithersError(
    "BAML_ENTRY_NOT_FOUND",
    `smithers-baml: no manifest entry found for ${sourcePath}. ` +
      `Tried keys: ${candidates.join(", ") || "(none)"}.`,
  );
}

function resolveSourcePath(args: PluginResolveArgs, cwd: string) {
  if (isAbsolute(args.path)) {
    return canonicalPath(resolve(args.path));
  }

  const baseDir = args.resolveDir || (args.importer ? dirname(args.importer) : cwd);
  return canonicalPath(resolve(baseDir, args.path));
}

export function createBamlPlugin(options: BamlPluginOptions = {}): BamlBundlerPlugin {
  const resolved = resolvePluginOptions(options);

  return {
    name: "smithers-baml",
    setup(build) {
      const runGenerate = async () => {
        ensureGenerateCommand(resolved);
      };

      if (typeof build.onStart === "function") {
        build.onStart(runGenerate);
      } else {
        void runGenerate();
      }

      build.onResolve({ filter: /\.baml$/ }, async (args) => {
        const sourcePath = resolveSourcePath(args, resolved.cwd);
        return {
          path: resolveGeneratedModulePath(sourcePath, resolved),
        };
      });
    },
  };
}

export function bamlPlugin(options: BamlPluginOptions = {}) {
  if (typeof Bun === "undefined" || typeof Bun.plugin !== "function") {
    throw new SmithersError(
      "BAML_REQUIRES_BUN",
      "bamlPlugin() requires Bun. Use createBamlPlugin() when wiring esbuild directly.",
    );
  }

  Bun.plugin(createBamlPlugin(options) as unknown as Bun.BunPlugin);
}

export const __internal = {
  candidateManifestKeys,
  discoverSourceDirs,
  formatMessages,
  normalizeManifestKey,
  readManifest,
  resolveGeneratedModulePath,
  resolvePluginOptions,
  resolveSourcePath,
};
