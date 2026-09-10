#!/usr/bin/env node
// Simulates what an END USER's npm resolves when installing the published
// packages, and fails on dependency duplication the pnpm monorepo hides.
//
// Why: pnpm dedupes across the workspace and one exact pin in the workspace
// settles every internal edge, so check-single-effect-version.mjs stays green
// even when an npm consumer gets twenty nested copies of effect. Smithers
// 0.31.0 shipped roughly 660 MB of duplicated effect for exactly that reason:
// the exact pins conflicted with the @effect/* ecosystem's caret ranges. Effect
// is also the one dependency that must be a singleton for correctness, because
// schema internals are not interoperable between instances.
//
// How: read the release manifest scripts/pack-release.mjs publishes from, pack
// each of those manifests into a minimal tarball (rewriting workspace: ranges
// to real versions), point a throwaway fixture at all of them with file: deps,
// run `npm install --package-lock-only` so npm's own arborist builds the tree,
// then assert on the resolved lockfile.
// Individual library and CLI profiles additionally install the unchanged
// manifests on npm and pnpm, inspect physical copies and native resolution,
// and prove unrelated optional adapters stay absent. An adjacent incompatible
// Effect RC must be refused by each manager's strict peer check.
//
// The install reads registry metadata, so this gate needs the network.
//
// Usage: node scripts/check-npm-dedupe.mjs [--max-packages <n>] [--keep-tmp]
//
// `resolveConsumerTree`, `copiesOf`, and `SINGLETONS` are exported so
// check-npm-dedupe.test.mjs asserts the same two claims over the same fixture
// without restating the recipe.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspaceManifests } from "./pack-release.mjs";
import { minimalProfiles, adapterProfiles, runConsumerMatrix } from "./release-consumers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keepTmp = args.includes("--keep-tmp");
const usage = "usage: node scripts/check-npm-dedupe.mjs [--max-packages <n>] [--keep-tmp]";

/**
 * Reads the optional `--max-packages` budget.
 *
 * A bare `--max-packages`, or one followed by another flag, used to parse as
 * `NaN`. The budget's only use is `total > maxPackages`, which is false for
 * `NaN`, so the aggregate package-count assertion silently stopped asserting
 * while the log line still printed `(budget NaN)`. A budget that cannot fail is
 * worse than no budget, so an unusable value is a usage error.
 */
export const maxPackagesFrom = (args, fallback = 925) => {
  const flag = args.indexOf("--max-packages");
  if (flag === -1) return fallback;
  const value = Number(args[flag + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `--max-packages requires a positive integer, received ${JSON.stringify(args[flag + 1] ?? null)}`,
    );
  }
  return value;
};
const npmInstallArgs = [
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--loglevel=error",
];

// The one dependency that must resolve to exactly one copy. Two Effect
// instances do not share schema internals, so a duplicate is a runtime defect,
// not a size problem.
export const SINGLETONS = ["effect"];

// A peer stays optional for this combined install only when no other selected
// package requires it. In particular the CLI owns its Node runtime and TS
// loader even though browser-facing libraries expose those as optional peers.
export const optionalPeersOf = (manifests) => {
  const installed = new Set(manifests.map((manifest) => manifest.name));
  const names = new Set();
  const required = new Set();
  for (const manifest of manifests) {
    // An explicitly selected package is present even when a sibling only
    // mentions it as an optional peer (for example the all-package smoke).
    if (manifest.name !== undefined) required.add(manifest.name);
    for (const name of Object.keys(manifest.dependencies ?? {})) required.add(name);
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional !== true) required.add(name);
    }
    for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
      if (meta?.optional === true && !installed.has(name)) names.add(name);
    }
  }
  return [...names].filter((name) => !required.has(name)).sort();
};

// The published set, read from the same manifest the release packs.
function workspacePackages() {
  return [...readWorkspaceManifests().values()]
    .map((manifest) => ({ name: manifest.name, version: manifest.version, manifest }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function rewriteWorkspaceProtocol(manifest, versionByName) {
  const clone = JSON.parse(JSON.stringify(manifest));
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = clone[section];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        const version = versionByName.get(name);
        if (!version) throw new Error(`${manifest.name}: no workspace version for ${name}`);
        deps[name] = version;
      }
    }
  }
  return clone;
}

// Minimal POSIX ustar tarball holding a single package/package.json — enough
// for npm arborist to resolve metadata; --package-lock-only never unpacks
// sources.
export function manifestTarball(manifest) {
  const body = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, 100);
  header.write("0000644", 100, 8);
  header.write("0000000", 108, 8);
  header.write("0000000", 116, 8);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8);
  header.write("0", 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  const end = Buffer.alloc(1024);
  return gzipSync(Buffer.concat([header, body, pad, end]));
}

export function copiesOf(lockPackages, name) {
  const top = `node_modules/${name}`;
  const copies = [];
  for (const key of Object.keys(lockPackages)) {
    if (key === top || key.endsWith(`/node_modules/${name}`)) copies.push(key);
  }
  return copies;
}

/**
 * Builds the throwaway npm consumer fixture and resolves it with npm's own
 * arborist.
 *
 * The caller gets the resolved lockfile's package map, the optional-peer set
 * the release manifests declare, and the fixture directory when it was kept.
 * Nothing here decides pass or fail, so the CLI and the node:test suite judge
 * the same tree.
 */
export function resolveConsumerTree({ keepTmp: keep = false } = {}) {
  const packages = workspacePackages();
  const optionalPeers = optionalPeersOf(packages.map((pkg) => pkg.manifest));
  const versionByName = new Map(packages.map((pkg) => [pkg.name, pkg.version]));
  const tmp = mkdtempSync(join(tmpdir(), "smithers-npm-dedupe-"));
  try {
    const tgzDir = join(tmp, "tgz");
    mkdirSync(tgzDir);
    const fixtureDeps = {};
    const fixtureOptional = {};
    for (const pkg of packages) {
      const rewritten = rewriteWorkspaceProtocol(pkg.manifest, versionByName);
      const file = join(tgzDir, `${pkg.name.replace("/", "-")}-${pkg.version}.tgz`);
      writeFileSync(file, manifestTarball(rewritten));
      // os/cpu-restricted packages (jj binaries) are optionalDependencies in
      // real consumers; npm hard-fails EBADPLATFORM on non-optional ones.
      if (rewritten.os || rewritten.cpu) fixtureOptional[pkg.name] = `file:${file}`;
      else fixtureDeps[pkg.name] = `file:${file}`;
    }
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify(
        {
          name: "npm-dedupe-fixture",
          private: true,
          version: "0.0.0",
          dependencies: fixtureDeps,
          optionalDependencies: fixtureOptional,
        },
        null,
        2,
      ),
    );

    console.log(`resolving ${packages.length} workspace packages with npm arborist (registry metadata)...`);
    const install =
      process.platform === "win32"
        ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...npmInstallArgs], {
            cwd: tmp,
            stdio: "inherit",
            timeout: 10 * 60_000,
          })
        : spawnSync("npm", npmInstallArgs, { cwd: tmp, stdio: "inherit", timeout: 10 * 60_000 });
    if (install.error || install.status !== 0) {
      throw new Error(`npm install --package-lock-only failed: ${install.error?.message ?? `exit ${install.status}`}`);
    }
    const lock = JSON.parse(readFileSync(join(tmp, "package-lock.json"), "utf8"));
    return { packages, optionalPeers, lockPackages: lock.packages ?? {}, tmp: keep ? tmp : undefined };
  } finally {
    if (!keep) rmSync(tmp, { recursive: true, force: true });
  }
}

/** Real physical installs of individual libraries, with no rewritten dependency edges. */
export async function resolveConsumerProfiles() {
  const directory = mkdtempSync(join(tmpdir(), "smithers-k-profile-manifests-"));
  try {
    const entries = workspacePackages().map(({ manifest }) => {
      const filename = manifest.name.replace("/", "-") + ".tgz";
      writeFileSync(join(directory, filename), manifestTarball(manifest));
      return { name: manifest.name, version: manifest.version, filename };
    });
    return await runConsumerMatrix(directory, entries, {
      profiles: [...minimalProfiles(entries), adapterProfiles(entries)[0]]
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(maxPackages) {
  const { optionalPeers: OPTIONAL_ABSENT, lockPackages, tmp } = resolveConsumerTree({ keepTmp });

  const failures = [];
  for (const name of SINGLETONS) {
    const copies = copiesOf(lockPackages, name);
    const versions = new Set(copies.map((key) => lockPackages[key]?.version));
    if (copies.length !== 1 || versions.size !== 1) {
      failures.push(
        `${name} resolves to ${copies.length} copie(s) at ${[...versions].join(", ")}:\n  - ${copies.join("\n  - ")}`,
      );
    } else {
      console.log(`ok: ${name}@${[...versions][0]} (single copy)`);
    }
  }
  for (const name of OPTIONAL_ABSENT) {
    const copies = copiesOf(lockPackages, name);
    if (copies.length > 0) {
      failures.push(
        `${name} must stay out of the default install (optional peer), found:\n  - ${copies.join("\n  - ")}`,
      );
    }
  }
  console.log(`ok: ${OPTIONAL_ABSENT.length} optional peers absent from default install`);

  const total = Object.keys(lockPackages).filter((key) => key.startsWith("node_modules/")).length;
  console.log(`resolved package count: ${total} (budget ${maxPackages})`);
  if (total > maxPackages) {
    failures.push(`package count ${total} exceeds budget ${maxPackages}`);
  }

  if (tmp !== undefined) console.log(`fixture kept at ${tmp}`);
  if (failures.length > 0) {
    console.error(`\nnpm dedupe check failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
    process.exitCode = 1;
  }
  await resolveConsumerProfiles();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let maxPackages;
  try {
    maxPackages = maxPackagesFrom(args);
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    process.exit(2);
  }
  await main(maxPackages);
}
