/** Declaration drift is a review gate, not a semantic compatibility verdict. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import {
  copyInputDeclarations,
  packageCompiler,
  portableDeclarationFiles
} from "../../../packages/repo-targets/scripts/build-library.mjs"
import {
  buildPrivateEffectAdapters,
  privateEffectAdapters
} from "../../../packages/repo-targets/scripts/private-effect-adapters.mjs"
import { isMain, libraryPackages, repoRoot } from "../../../packages/repo-targets/scripts/workspace-packages.mjs"

import { versionedSources } from "./set-release-version.mjs"

const declarations = (directory, prefix = "") =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = `${prefix}${entry.name}`
    return entry.isDirectory()
      ? declarations(join(directory, entry.name), `${name}/`)
      : entry.name.endsWith(".d.ts")
      ? [name]
      : []
  })

/**
 * The declaration text with order-insensitive inferred members put in one order.
 *
 * TypeScript prints an inferred union in type-creation order and an inferred
 * object type in checker order, so an unrelated edit elsewhere in the same
 * program can reorder either without changing the type. Union constituents are
 * sorted by their canonical text, and a type literal's named members
 * (properties, methods, accessors) are stably sorted by name, which keeps the
 * order of same-name method overloads; each member carries its own leading
 * comments. Call, construct and index signatures keep their written order, as
 * do interfaces, classes, overloaded functions and every other declaration,
 * whose text is kept verbatim, so each real signature, export or doc change
 * still differs.
 */
export const canonicalDeclaration = (text) => {
  const source = ts.createSourceFile("api.d.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const byKey = (left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  const leading = (node) => text.slice(node.pos, node.getStart(source))
  // A node's full text (leading trivia included) with its children canonical.
  const full = (node) => {
    if (ts.isUnionTypeNode(node)) {
      const types = node.types.map((type) => ({ key: body(type) })).sort(byKey)
      return leading(node) + types.map(({ key }) => key).join(" | ")
    }
    if (ts.isTypeLiteralNode(node)) {
      const member = (entry) =>
        `${leading(entry).trim().replace(/\s+/g, " ")} ${body(entry).replace(/[;,]$/, "")}`.trim()
      const unnamed = node.members.filter((entry) => entry.name === undefined).map(member)
      const named = node.members.filter((entry) => entry.name !== undefined)
        .map((entry) => ({ key: body(entry.name), text: member(entry) }))
        .sort(byKey)
        .map((entry) => entry.text)
      const members = [...unnamed, ...named]
      return leading(node) + (members.length === 0 ? "{}" : `{ ${members.join("; ")}; }`)
    }
    // Tokens between syntax children are copied verbatim rather than rescanned.
    let result = ""
    let cursor = node.pos
    ts.forEachChild(node, (child) => {
      result += text.slice(cursor, child.pos) + full(child)
      cursor = child.end
    })
    return result + text.slice(cursor, node.end)
  }
  const body = (node) => full(node).slice(node.getStart(source) - node.pos)
  return full(source)
}

/** Replace only the emitted type or initializer of an explicitly stamped source declaration. */
const normalizeVersionStamp = (text, dir, file, version) => {
  const sourcePath = `${dir}/src/${file.replace(/\.d\.ts$/, ".ts")}`
  const stamp = versionedSources.find(({ declarationReexports, declarationStamp, path }) =>
    declarationStamp !== undefined && (path === sourcePath || (declarationReexports?.includes(sourcePath) ?? false))
  )?.declarationStamp
  if (!stamp || typeof version !== "string") return text
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== stamp.constant) continue
      let literal = declaration.initializer ?? (declaration.type && ts.isLiteralTypeNode(declaration.type)
        ? declaration.type.literal
        : undefined)
      if (stamp.property !== undefined && declaration.type && ts.isTypeLiteralNode(declaration.type)) {
        const property = declaration.type.members.find((member) =>
          ts.isPropertySignature(member) && member.name.getText(source) === stamp.property
        )
        literal = property?.type && ts.isLiteralTypeNode(property.type) ? property.type.literal : undefined
      }
      if (literal && ts.isStringLiteral(literal) && literal.text === version) {
        return text.slice(0, literal.getStart(source)) + "\"<release-version>\"" + text.slice(literal.end)
      }
    }
  }
  return text
}

/** Include private declarations too: public signatures can reference them. */
export const apiSurface = (root = repoRoot, declarationRoot = root) =>
  Object.fromEntries(
    libraryPackages(root).filter(({ manifest }) => !manifest.private).map(({ name, dir, manifest }) => {
      const directory = join(declarationRoot, dir, "dist/esm")
      const names = declarations(directory).sort()
      if (names.length === 0) throw new Error(`${name}: no declarations; build the package before checking its API`)
      const vendor = join(declarationRoot, dir, "dist/vendor")
      if (privateEffectAdapters(manifest).length > 0) {
        names.push(...declarations(vendor).sort().map((name) => "../vendor/" + name))
      }
      return [name, {
        exports: manifest.publishConfig.exports,
        declarations: Object.fromEntries(names.map((file) => {
          const text = readFileSync(join(directory, file), "utf8").replace(/\r\n/g, "\n")
            .replace(/^\/\/# sourceMappingURL=.*$/gm, "").trim()
          const contents = canonicalDeclaration(normalizeVersionStamp(text, dir, file, manifest.version))
          return [file, createHash("sha256").update(contents).digest("hex")]
        }))
      }]
    }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  )

export const assertApiBaseline = (expected, actual) => {
  const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter((name) =>
    JSON.stringify(expected[name]) !== JSON.stringify(actual[name])
  )
  if (changed.length > 0) {
    throw new Error(
      `Declaration/API drift requires compatibility review:\n${changed.map((name) => `  ${name}`).join("\n")}\n` +
        "Review declaration diffs, consumer type tests and release notes before explicitly updating the baseline.\n" +
        "Record reviewed declarations with: node .smithers/flows/release/check-api-baseline.mjs --build-declarations --update"
    )
  }
}

/** Compile release declarations and their private adapter types without shared outputs. */
export const withDeclarationBuild = async (root, check) => {
  const output = mkdtempSync(join(tmpdir(), "smithers-api-declarations-"))
  try {
    for (const { dir, name, manifest } of libraryPackages(root)) {
      if (manifest.private) continue
      const packageRoot = join(root, dir)
      const directory = join(output, dir, "dist/esm")
      // Packages may pin different TypeScript versions; use the release
      // compiler and its own configuration: the package's tsc, or vibelang
      // when VibeLang sources are in reach, as its build does.
      const compiler = packageCompiler(packageRoot)
      const result = spawnSync(process.execPath, [
        compiler.path,
        "-p",
        "tsconfig.json",
        "--outDir",
        directory,
        "--noEmit",
        "false",
        "--declaration",
        "--emitDeclarationOnly",
        "--declarationMap",
        "false",
        "--incremental",
        "false",
        "--composite",
        "false"
      ], {
        cwd: packageRoot,
        encoding: "utf8"
      })
      if (result.error || result.status !== 0) {
        throw new Error(
          `${name}: declaration emit with ${compiler.name} failed: ${
            result.error?.message ?? result.signal ?? result.status
          }
${result.stderr ?? ""}
${result.stdout ?? ""}`
        )
      }
      portableDeclarationFiles(directory)
      copyInputDeclarations(join(packageRoot, "src"), directory)
      await buildPrivateEffectAdapters(packageRoot, { distRoot: join(output, dir, "dist") })
    }
    return await check(output)
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
}

if (isMain(import.meta)) {
  const options = process.argv.slice(2)
  if (
    options.some((option) => !["--update", "--build-declarations"].includes(option)) ||
    new Set(options).size !== options.length
  ) {
    throw new Error("usage: node .smithers/flows/release/check-api-baseline.mjs [--build-declarations] [--update]")
  }
  const check = (declarationRoot = repoRoot) => {
    const path = join(repoRoot, ".smithers/flows/release/fixtures/public-api-baseline.json")
    const surface = apiSurface(repoRoot, declarationRoot)
    if (options.includes("--update")) {
      writeFileSync(path, `${JSON.stringify({ format: 2, packages: surface }, null, 2)}\n`)
      console.log(`Recorded declarations for ${Object.keys(surface).length} public packages`)
    } else {
      const baseline = JSON.parse(readFileSync(path, "utf8"))
      if (baseline.format !== 2) throw new Error("unsupported API baseline format")
      assertApiBaseline(baseline.packages, surface)
      console.log(`Declaration baseline matches ${Object.keys(surface).length} public packages`)
    }
  }
  if (options.includes("--build-declarations")) await withDeclarationBuild(repoRoot, check)
  else check()
}
