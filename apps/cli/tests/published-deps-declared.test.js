// Regression guardrail: every external import in a published package must be
// declared in that package's own package.json (dependencies or peerDependencies).
//
// This catches the class of bug where `bunx smithers-orchestrator init` fails
// with `Cannot find module '<X>' from '.../node_modules/smithers-orchestrator/src/<foo>.js'`
// because <X> is imported but not declared. The monorepo masks this during
// development because phantom deps hoist from the root node_modules, but the
// bunx install layout is strict.
//
// If this test fails, add the missing entry to the relevant package.json.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/**
 * Enumerate all published workspace packages. `skipSubdirs` lists entry points
 * whose externals are intentionally owned by the consumer (plugin-host
 * pattern), not by Smithers itself.
 */
function discoverPackages() {
    /** @type {{ name: string; dir: string; skipSubdirs: string[]; }[]} */
    const packages = [];
    for (const base of ["packages", "apps"]) {
        const absBase = resolve(REPO_ROOT, base);
        for (const entry of readdirSync(absBase)) {
            const dir = `${base}/${entry}`;
            const manifestPath = join(REPO_ROOT, dir, "package.json");
            if (!existsSync(manifestPath)) {
                continue;
            }
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
            if (manifest.private) {
                continue;
            }
            packages.push({
                name: manifest.name,
                dir,
                skipSubdirs: manifest.name === "smithers-orchestrator"
                    ? ["src/pi-plugin", "src/ide"]
                    : [],
            });
        }
    }
    return packages;
}
const PACKAGES = discoverPackages();

// Node built-ins — always resolvable, never need declaration.
const NODE_BUILTINS = new Set([
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
    "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
    "events", "fs", "http", "http2", "https", "inspector", "module", "net",
    "os", "path", "perf_hooks", "process", "punycode", "querystring",
    "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
    "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
    "zlib",
]);

// Bun-specific globals and virtual modules that are always available when
// running under bun (the shebang `#!/usr/bin/env bun` in the bin).
const BUN_VIRTUALS = new Set(["bun", "bun:test", "bun:sqlite", "bun:jsc", "bun:ffi"]);

/**
 * @param {string} specifier
 */
function isRelative(specifier) {
    return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..";
}

/**
 * @param {string} specifier
 */
function isNodeBuiltin(specifier) {
    if (specifier.startsWith("node:")) return true;
    const [head] = specifier.split("/", 1);
    return NODE_BUILTINS.has(head);
}

/**
 * @param {string} specifier
 * @returns {string} the package name (scoped or unscoped) without the subpath
 */
function packageNameFromSpecifier(specifier) {
    if (specifier.startsWith("@")) {
        const [scope, name] = specifier.split("/", 2);
        return name ? `${scope}/${name}` : scope;
    }
    return specifier.split("/", 1)[0];
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walkSourceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            out.push(...walkSourceFiles(full));
            continue;
        }
        if (/\.(m?js|cjs|ts|tsx|jsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
            out.push(full);
        }
    }
    return out;
}

// Anchor patterns to start-of-line (with only leading whitespace) so we don't
// match `import`/`from` occurrences inside string literals and template-literal
// codegen — e.g. `'import { Foo } from "~/bar"'` inside workflow-pack
// templates. Dynamic imports are skipped; they don't block module-load.
const IMPORT_PATTERNS = [
    /^[\t ]*import(?!\s+type\b)\s+(?:[^'"`()]*?\s+from\s+)?["']([^"']+)["']/gm,
    /^[\t ]*export(?!\s+type\b)\s+[^'"`()]*?\s+from\s+["']([^"']+)["']/gm,
    /^[\t ]*(?:const|let|var)\s+[^=]+=\s*require\s*\(\s*["']([^"']+)["']\s*\)/gm,
];

/**
 * @param {string} contents
 * @returns {Set<string>}
 */
function collectImports(contents) {
    const out = new Set();
    for (const pattern of IMPORT_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(contents)) !== null) {
            out.add(match[1]);
        }
    }
    return out;
}

for (const pkg of PACKAGES) {
    test(`${pkg.name}: every external import is declared in package.json`, () => {
        const pkgDir = resolve(REPO_ROOT, pkg.dir);
        const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
        const declared = new Set([
            ...Object.keys(manifest.dependencies ?? {}),
            ...Object.keys(manifest.peerDependencies ?? {}),
            ...Object.keys(manifest.optionalDependencies ?? {}),
        ]);
        const selfName = manifest.name;

        const srcDir = join(pkgDir, "src");
        const files = walkSourceFiles(srcDir);

        /** @type {Map<string, string[]>} */
        const missing = new Map();
        for (const file of files) {
            const rel = file.slice(pkgDir.length + 1);
            if (pkg.skipSubdirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) {
                continue;
            }
            const contents = readFileSync(file, "utf8");
            for (const specifier of collectImports(contents)) {
                if (isRelative(specifier)) continue;
                if (isNodeBuiltin(specifier)) continue;
                if (BUN_VIRTUALS.has(specifier)) continue;
                const name = packageNameFromSpecifier(specifier);
                if (name === selfName) continue;
                if (declared.has(name)) continue;
                const existing = missing.get(name);
                if (existing) existing.push(rel);
                else missing.set(name, [rel]);
            }
        }

        if (missing.size > 0) {
            const lines = [
                `${pkg.name} imports ${missing.size} package(s) that are not declared in its package.json:`,
                "",
                ...[...missing.entries()].map(([name, users]) => {
                    const sample = users.slice(0, 3).join(", ") + (users.length > 3 ? `, +${users.length - 3} more` : "");
                    return `  - ${name}  (used by: ${sample})`;
                }),
                "",
                `Add these to ${pkg.dir}/package.json "dependencies" so published installs can resolve them.`,
            ];
            throw new Error(lines.join("\n"));
        }

        expect(missing.size).toBe(0);
    });
}
