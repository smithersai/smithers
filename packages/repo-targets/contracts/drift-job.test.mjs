import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const workflowPath = new URL('../../../.github/workflows/drift.yml', import.meta.url)
const ciPath = new URL('../../../.github/workflows/ci.yml', import.meta.url)
const flowsPackagePath = new URL('../../../.smithers/flows/PACKAGE.ts', import.meta.url)
const rootPackagePath = new URL('../../../PACKAGE.ts', import.meta.url)
const manifestPath = new URL('../../../package.json', import.meta.url)
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const runFile = promisify(execFile)
const gateCommands = [
  "pnpm exec smthrs lint '//...:fmt' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:targetIndex' --known-red '.github/ci-known-red.json' --verbose",
  // factory.json drift once surfaced only in the Release gates (#3770).
  "pnpm exec smthrs lint '//:factoryProjection' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:docsDrift' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs build '//.smithers/flows:apiBaseline' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//packages/repo-targets:conflictMarkers' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//packages/repo-targets:trackedHygiene' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:driftCi' --known-red '.github/ci-known-red.json' --verbose",
  "pnpm exec smthrs lint '//:ci' --known-red '.github/ci-known-red.json' --verbose",
]

const assertNativeSetup = (steps, ciSteps) => {
  const helpers = steps.filter((step) => step.name === 'Install native smithers-jj-export')
  assert.equal(helpers.length, 1, 'drift must install the native filesystem helper exactly once')
  const helper = helpers[0]
  const ciHelper = ciSteps.find((step) => step.name === helper.name)
  assert.ok(ciHelper, 'CI declares the shared native helper install')
  assert.equal(helper.run, ciHelper.run, 'drift uses the same unprivileged helper command as CI')
  assert.equal(helper.shell, 'bash')
  assert.equal(helper.id, 'setup', 'gates wait for the native helper installation to succeed')
  assert.equal(helper.if, undefined, 'a failed dependency install must prevent helper setup success')
  const installIndex = steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile --ignore-scripts')
  const helperIndex = steps.indexOf(helper)
  const gateIndex = steps.findIndex((step) => gateCommands.includes(step.run))
  assert.ok(installIndex >= 0 && installIndex < helperIndex && helperIndex < gateIndex, 'install dependencies and helper before any gate')
  return helper
}

test('retired Plue main mirror has no workflow, lint input or credential reference', async () => {
  const directory = new URL('../../../.github/workflows/', import.meta.url)
  assert.ok(!(await readdir(directory)).includes('mirror-sync.yml'), 'SCOPE-3 retired the Plue deployment')
  for (const file of ['ci.yml', 'release.yml']) {
    assert.doesNotMatch(await readFile(new URL(file, directory), 'utf8'), /mirror-sync\.yml|SMITHERS_CLOUD_MIRROR_TOKEN/)
  }
  assert.doesNotMatch(await readFile(rootPackagePath, 'utf8'), /mirror-sync\.yml|SMITHERS_CLOUD_MIRROR_TOKEN/)
})

// Decision 0127: for 300+ main runs this job only awaited a main-pinned callee
// whose root setup refused by design, so no gate below ever ran. The job that
// reports Per-commit drift must run every gate itself, unprivileged.
test('drift job runs every gate itself, unprivileged, with a per-SHA verdict', async () => {
  const { default: YAML } = await import('yaml')
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'))
  const main = YAML.parse(await readFile(ciPath, 'utf8'))
  assert.equal(workflow.name, 'Drift')
  assert.deepEqual(workflow.on, { push: { branches: ['main'] }, pull_request: null })
  assert.deepEqual(Object.keys(workflow.jobs), ['drift'])
  const job = workflow.jobs.drift
  assert.equal(job.name, 'Per-commit drift', 'the literal status context C-PRC-01 observes')
  assert.equal(job.needs, undefined, 'the verdict job depends on no other job')
  assert.equal(job.uses, undefined, 'the verdict job is not a reusable-workflow call')
  assert.equal(job['runs-on'], main.jobs.test['runs-on'], 'drift runs on the image the CI job runs on')
  assert.equal(job['timeout-minutes'], 20, 'a clean run takes 7-10 minutes; a 10-minute cap cancels the last gates')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  for (const part of ['github.workflow', 'github.event_name', 'github.ref', 'github.sha']) {
    assert.ok(workflow.concurrency.group.includes(part), `drift concurrency must include ${part}`)
  }
  assert.equal(
    main.concurrency.group,
    "ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref }}",
    'main CI must retain its existing ref-keyed group',
  )
  assert.equal(main.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}")

  const steps = job.steps
  assert.ok(Array.isArray(steps))
  assert.ok(steps[0].uses?.startsWith('actions/checkout@'), 'no step runs before checkout')
  // Every action is a third-party action pinned by full SHA; none is this
  // repository's own action, which a dormant gate could switch off.
  const actions = steps.filter((step) => step.uses).map((step) => step.uses.split('@')[0])
  assert.deepEqual(actions, ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node', 'oven-sh/setup-bun', 'Swatinem/rust-cache'])
  for (const step of steps.filter((step) => step.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/)
  const gateSteps = steps.filter((step) => step.run?.includes('pnpm exec smthrs '))
  assert.deepEqual(gateSteps.map((step) => step.run), gateCommands, 'drift runs exactly the allowed gate argv in order')
  for (const gate of gateSteps) assert.equal(gate.if, "${{ !cancelled() && steps.setup.conclusion == 'success' }}")
  assert.equal(steps.filter((step) => step.id === 'setup').length, 1, 'drift has one install/setup sentinel')
  const setup = steps.find((step) => step.id === 'setup')
  const helper = assertNativeSetup(steps, main.jobs.test.steps)
  assert.equal(setup, helper)
  assert.equal(steps[0].with?.['persist-credentials'], 'false', 'gate steps must not read the job token from .git/config')
  assert.equal(steps[0].with?.ref, undefined, 'checkout takes the event revision GitHub selected')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(workflow.env, undefined)
  assert.equal(job.env, undefined)
  assert.equal(job.permissions, undefined, 'the job inherits contents: read and widens nothing')
  for (const holder of [job, ...steps]) {
    assert.equal(holder['continue-on-error'], undefined, 'every gate failure fails the verdict')
  }
  assert.ok(!JSON.stringify(workflow).includes('secrets.'), 'drift gates need no secrets')
  assert.ok(steps.every((step) => !/sudo|apt-get|sysctl/.test(step.run ?? '')), 'no drift step asks for root')
  assert.ok(steps.filter((step) => step !== helper).every((step) => !/cargo|rustup|foundry|docker|postgres|smthrs (test|docs)\b/i.test(`${step.name ?? ''} ${step.run ?? ''} ${step.uses ?? ''}`)), 'only the declared native helper may build with Cargo; no broad gates')
  const setupCommands = [
    "pnpm install --frozen-lockfile --ignore-scripts",
    "npm install --global 'npm@11.16.0' --ignore-scripts --no-audit --no-fund\ntest \"$(npm --version)\" = '11.16.0'\n",
  ]
  assert.deepEqual(steps.filter((step) => step.run && !gateCommands.includes(step.run)).map((step) => step.run), [
    setupCommands[1], setupCommands[0], helper.run,
  ], 'every shell command is an allowed setup command or drift gate')
})

test('drift setup contract rejects a missing helper or gates preceding its installation', async () => {
  const { default: YAML } = await import('yaml')
  const steps = YAML.parse(await readFile(workflowPath, 'utf8')).jobs.drift.steps
  const ciSteps = YAML.parse(await readFile(ciPath, 'utf8')).jobs.test.steps
  const helper = assertNativeSetup(steps, ciSteps)
  assert.throws(() => assertNativeSetup(steps.filter((step) => step !== helper), ciSteps), /must install the native filesystem helper/)
  assert.throws(() => assertNativeSetup([...steps.filter((step) => step !== helper), helper], ciSteps), /before any gate/)
  assert.throws(() => assertNativeSetup(steps.map((step) => step === helper ? { ...step, id: undefined } : step), ciSteps), /gates wait for the native helper/)
  assert.throws(() => assertNativeSetup(steps.map((step) => step === helper ? { ...step, run: 'true' } : step), ciSteps), /same unprivileged helper command/)
  assert.throws(() => assertNativeSetup(steps.map((step) => step === helper ? { ...step, if: '${{ always() }}' } : step), ciSteps), /failed dependency install/)
})

test('no workflow references a dormant trusted setup, campaign or callee', async () => {
  const workflows = new URL('../../../.github/workflows/', import.meta.url)
  const names = await readdir(workflows)
  for (const retired of ['trusted-drift.yml', 'trusted-setup-validation.yml']) assert.ok(!names.includes(retired), retired)
  for (const action of ['trusted-ci-setup', 'trusted-ci-setup-campaign']) {
    await assert.rejects(readdir(new URL(`../../../.github/actions/${action}/`, import.meta.url)), { code: 'ENOENT' })
  }
  for (const name of names) {
    assert.doesNotMatch(await readFile(new URL(name, workflows), 'utf8'), /trusted-ci-setup|trusted-drift|trusted-setup-validation/, name)
  }
  assert.doesNotMatch(await readFile(rootPackagePath, 'utf8'), /trustedSetupRevision|trustedWorkflowRevision|workflowCall/)
})

test('API baseline and docs drift targets are check-only and independent of release packing', async () => {
  const source = await readFile(flowsPackagePath, 'utf8')
  const api = source.match(/const apiBaseline\s*=\s*Smithers\.NodeBinary\(\{([\s\S]*?)\n\}\)/)?.[1]
  assert.ok(api, 'apiBaseline must use NodeBinary')
  assert.match(api, /check-api-baseline\.mjs/)
  assert.match(api, /--build-declarations/)
  assert.match(api, /deps:\s*\[\]/)
  assert.doesNotMatch(api, /releasePack/)
  const release = source.match(/const releasePack\s*=\s*Smithers\.NodeBinary\(\{([\s\S]*?)\n\}\)/)?.[1]
  assert.ok(release, 'releasePack must use NodeBinary')
  assert.match(release, /deps:\s*\[\s*apiBaseline\s*,/, 'releasePack must depend on apiBaseline')
  const docs = (await readFile(rootPackagePath, 'utf8')).match(/const docsDrift\s*=\s*Smithers\.Shell\.Diff\(\{([\s\S]*?)\n\}\)/)?.[1]
  assert.ok(docs, 'docsDrift must use Shell.Diff')
  assert.match(docs, /changes:\s*\[\]/)
  assert.match(docs, /pnpm run docs:check/)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.match(manifest.scripts['docs:check'], /smthrs flow start docs-sync --data '\{"mode":"check"\}' --wait/)
  const packageCheck = await readFile(new URL('../../../.smithers/flows/docs-sync/package-docs.test.mjs', import.meta.url), 'utf8')
  assert.match(packageCheck, /"pack", "--dry-run"/)
  for (const generator of ['ingest-reference.mjs', 'generate-llms.mjs']) {
    assert.match(docs, new RegExp(`${generator.replace('.', '\\.')}[\\s\\S]{0,100}--check`), `${generator} must run in check mode`)
  }
  assert.doesNotMatch(docs, /(?:pnpm|npm|bun)\s+(?:run\s+)?(?:test|build)\b/)
})

test('standalone root drift target owns the generated workflow', async () => {
  const source = await readFile(rootPackagePath, 'utf8')
  const drift = source.match(/const driftCi\s*=\s*Smithers\.GithubCiGen\(\{([\s\S]*?)\n\}\)/)?.[1]
  assert.ok(drift)
  assert.match(drift, /workflowName:\s*['"]Drift['"]/)
  assert.match(drift, /output:\s*['"]\.github\/workflows\/drift\.yml['"]/)
  assert.match(drift, /concurrency:\s*['"]commit['"]/)
  assert.match(source, /const driftJob[\s\S]*?timeoutMinutes:\s*20/)
  assert.match(drift, /knownRed:\s*['"]\.github\/ci-known-red\.json['"]/, 'the generator must retain known-red when drift.yml is refreshed')
})

const write = async (root, path, contents) => {
  const file = join(root, path)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, contents)
}

const declarationFiles = async (root, prefix = '') => {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const name = `${prefix}${entry.name}`
    return entry.isDirectory()
      ? declarationFiles(join(root, entry.name), `${name}/`)
      : entry.name.endsWith('.d.ts') ? [name] : []
  }))
  return files.flat().sort()
}

const scratchOutputs = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('smithers-api-declarations-')).sort()

test('declaration build matches normal TypeScript release emit and cleans isolated output', async () => {
  const { default: ts } = await import('typescript')
  const { apiSurface, withDeclarationBuild } = await import('../../../.smithers/flows/release/check-api-baseline.mjs')
  const root = await mkdtemp(join(tmpdir(), 'smithers-api-fixture-'))
  const previousTmpdir = process.env.TMPDIR
  const previousTemp = process.env.TEMP
  const previousTmp = process.env.TMP
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = root
  try {
    await write(root, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n')
    await write(root, 'packages/example/package.json', JSON.stringify({
      name: '@smthrs/example',
      publishConfig: { exports: { '.': './dist/esm/index.js' } },
    }))
    await write(root, 'packages/example/tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        rootDir: 'src', outDir: 'dist/esm', declaration: true, skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }))
    await write(root, 'packages/example/src/index.ts', 'export const infer = (value: string) => ({ value, length: value.length });\nexport { Options } from "./options.js";\n')
    await write(root, 'packages/example/src/options.ts', 'export interface Options { retries?: number }\n')
    await write(root, 'packages/private/package.json', JSON.stringify({ name: '@smthrs/private', private: true }))
    await write(root, 'packages/private/tsconfig.json', '{ invalid json')
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir')

    const config = ts.getParsedCommandLineOfConfigFile(join(root, 'packages/example/tsconfig.json'), {
      outDir: join(root, 'normal'), skipLibCheck: true,
    }, ts.sys)
    assert.equal(config.errors.length, 0)
    const normalProgram = ts.createProgram(config.fileNames, config.options)
    const normalDiagnostics = ts.getPreEmitDiagnostics(normalProgram)
    assert.deepEqual(normalDiagnostics, [])
    const normal = normalProgram.emit()
    assert.equal(normal.emitSkipped, false, ts.formatDiagnosticsWithColorAndContext(normal.diagnostics, {
      getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
    }))
    const before = await scratchOutputs()
    let emittedRoot
    const result = await withDeclarationBuild(root, async (output) => {
      emittedRoot = output
      const generated = join(output, 'packages/example/dist/esm')
      const names = await declarationFiles(generated)
      assert.deepEqual(names, ['index.d.ts', 'options.d.ts'])
      for (const name of names) {
        assert.equal(await readFile(join(generated, name), 'utf8'), await readFile(join(root, 'normal', name), 'utf8'))
      }
      assert.deepEqual(await readdir(generated), names)
      await assert.rejects(readdir(join(output, 'packages/example/dist/cjs')), { code: 'ENOENT' })
      assert.deepEqual(await readdir(join(output, 'packages')), ['example'])
      assert.equal(Object.keys(apiSurface(root, output)).join(','), '@smthrs/example')
      return 'checked'
    })
    assert.equal(result, 'checked')
    await assert.rejects(readFile(join(root, 'packages/example/dist/esm/index.js')), { code: 'ENOENT' })
    await assert.rejects(readdir(join(root, 'packages/example/dist/cjs')), { code: 'ENOENT' })
    await assert.rejects(readdir(emittedRoot), { code: 'ENOENT' })
    assert.deepEqual(await scratchOutputs(), before)

    let failedOutput
    await assert.rejects(withDeclarationBuild(root, async (output) => {
      failedOutput = output
      throw new Error('callback failed')
    }), /callback failed/)
    await assert.rejects(readdir(failedOutput), { code: 'ENOENT' })
    assert.deepEqual(await scratchOutputs(), before)

    await rm(join(root, 'packages/example/tsconfig.json'))
    await assert.rejects(withDeclarationBuild(root, () => {}), /(?:Cannot read file|TS5058: The specified path does not exist)/)
    assert.deepEqual(await scratchOutputs(), before)

    await write(root, 'packages/example/tsconfig.json', '{ invalid json')
    await assert.rejects(withDeclarationBuild(root, () => {}))
    assert.deepEqual(await scratchOutputs(), before)

    await write(root, 'packages/example/tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', declaration: true, noEmitOnError: true, skipLibCheck: true },
      include: ['src/**/*.ts'],
    }))
    await write(root, 'packages/example/src/index.ts', 'export const broken: = 1;\n')
    await assert.rejects(withDeclarationBuild(root, () => { throw new Error('callback must not run') }), /declaration emit with tsc failed/)
    assert.deepEqual(await scratchOutputs(), before)
  } finally {
    for (const [key, value] of [['TMPDIR', previousTmpdir], ['TEMP', previousTemp], ['TMP', previousTmp]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('public build declarations match release-style tsc for all source files', async () => {
  const { default: ts } = await import('typescript')
  const { apiSurface, withDeclarationBuild } = await import('../../../.smithers/flows/release/check-api-baseline.mjs')
  const root = await mkdtemp(join(tmpdir(), 'smithers-api-build-parity-'))
  try {
    await write(root, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n')
    await mkdir(join(root, 'packages'))
    const buildRoot = join(root, 'packages/build')
    await cp(join(repositoryRoot, 'packages/smithers/build/src'), join(buildRoot, 'src'), { recursive: true })
    await cp(join(repositoryRoot, 'packages/smithers/build/package.json'), join(buildRoot, 'package.json'))
    await cp(join(repositoryRoot, 'packages/smithers/build/tsconfig.json'), join(buildRoot, 'tsconfig.json'))
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
    await symlink(join(repositoryRoot, 'packages/smithers/build/node_modules'), join(buildRoot, 'node_modules'), 'dir')
    await write(root, 'packages/build/src/Added.ts', 'export interface Added { value: string }\n')
    // Checking the private seed creates B first; a noCheck declaration emit
    // reaches the exported conditional first and creates A first instead.
    await write(root, 'packages/build/src/DeclarationOrder.ts', `
const seed: B = { b: true }
export const inferred = Math.random() ? getA() : getB()
interface A { a: boolean }
interface B { b: boolean }
declare function getA(): A
declare function getB(): B
`)

    const releaseRoot = join(root, 'release')
    const releaseDir = join(releaseRoot, 'packages/build/dist/esm')
    await runFile(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
      '-p', join(root, 'packages/build/tsconfig.json'), '--outDir', releaseDir,
    ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 })

    const releaseDeclarations = await declarationFiles(releaseDir)
    const config = ts.getParsedCommandLineOfConfigFile(join(buildRoot, 'tsconfig.json'), {}, ts.sys)
    assert.equal(config.errors.length, 0)
    const sourceDeclarations = config.fileNames
      .filter((name) => name.startsWith(join(buildRoot, 'src')) && /(?<!\.d)\.tsx?$/.test(name))
      .map((name) => relative(join(buildRoot, 'src'), name).replace(/\.tsx?$/, '.d.ts'))
      .sort()
    assert.deepEqual(releaseDeclarations, sourceDeclarations, 'release tsc must cover every @smthrs/build source file')
    assert.ok(releaseDeclarations.includes('Added.d.ts'))
    assert.ok(releaseDeclarations.includes('Install.d.ts'))
    const releaseSurface = apiSurface(root, releaseRoot)
    assert.deepEqual(Object.keys(releaseSurface), ['@smthrs/build'])

    const oldRoot = join(root, 'old-declarations')
    const oldConfig = ts.getParsedCommandLineOfConfigFile(join(root, 'packages/build/tsconfig.json'), {
      noEmit: false, declaration: true, emitDeclarationOnly: true, declarationMap: false,
      incremental: false, composite: false, noCheck: true,
      outDir: join(oldRoot, 'packages/build/dist/esm'),
    }, ts.sys)
    assert.equal(oldConfig.errors.length, 0)
    assert.equal(ts.createProgram(oldConfig.fileNames, oldConfig.options).emit().emitSkipped, false)
    assert.notEqual(
      await readFile(join(oldRoot, 'packages/build/dist/esm/DeclarationOrder.d.ts'), 'utf8'),
      await readFile(join(releaseDir, 'DeclarationOrder.d.ts'), 'utf8'),
      'the former noCheck emit must exercise the declaration-order regression',
    )

    await withDeclarationBuild(root, async (output) => {
      const generated = join(output, 'packages/build/dist/esm')
      assert.deepEqual(await declarationFiles(generated), releaseDeclarations)
      assert.deepEqual(apiSurface(root, output), releaseSurface)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CLI combines declaration build and baseline update from current source', async () => {
  const { apiSurface, withDeclarationBuild } = await import('../../../.smithers/flows/release/check-api-baseline.mjs')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'smithers-api-cli-fixture-')))
  const packageRoot = join(root, 'packages/example')
  const cli = join(root, '.smithers/flows/release/check-api-baseline.mjs')
  const baselinePath = join(root, '.smithers/flows/release/fixtures/public-api-baseline.json')
  const runCli = (...options) => runFile(process.execPath, [cli, ...options], { cwd: root })
  try {
    await write(root, 'package.json', '{"type":"module"}\n')
    await write(root, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n')
    await write(root, 'packages/example/package.json', JSON.stringify({
      name: '@smthrs/example',
      type: 'module',
      publishConfig: { exports: { '.': './dist/esm/index.js' } },
    }))
    await write(root, 'packages/example/tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        rootDir: 'src', outDir: 'dist/esm', declaration: true, skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }))
    await write(root, 'packages/example/src/index.ts', 'export function value(input: string): string { return input }\n')
    await cp(join(repositoryRoot, '.smithers/flows/release/check-api-baseline.mjs'), cli)
    await cp(join(repositoryRoot, 'packages/repo-targets/scripts/workspace-packages.mjs'), join(root, 'packages/repo-targets/scripts/workspace-packages.mjs'))
    await cp(join(repositoryRoot, 'packages/repo-targets/scripts/build-library.mjs'), join(root, 'packages/repo-targets/scripts/build-library.mjs'))
    await cp(join(repositoryRoot, 'packages/repo-targets/scripts/private-effect-adapters.mjs'), join(root, 'packages/repo-targets/scripts/private-effect-adapters.mjs'))
    await mkdir(join(root, '.smithers/flows/release/fixtures'), { recursive: true })
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
    await symlink(join(repositoryRoot, 'node_modules'), join(packageRoot, 'node_modules'), 'dir')

    await assert.rejects(readdir(join(packageRoot, 'dist')), { code: 'ENOENT' })
    const first = await runCli('--build-declarations', '--update')
    assert.match(first.stdout, /Recorded declarations for 1 public packages/)
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
    assert.equal(baseline.format, 2)
    const releaseRoot = join(root, 'release')
    await runFile(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
      '-p', join(packageRoot, 'tsconfig.json'), '--outDir', join(releaseRoot, 'packages/example/dist/esm'),
    ], { cwd: root })
    assert.deepEqual(baseline.packages, apiSurface(root, releaseRoot))
    const firstHash = baseline.packages['@smthrs/example'].declarations['index.d.ts']
    await assert.rejects(readdir(join(packageRoot, 'dist')), { code: 'ENOENT' })

    await write(root, 'packages/example/src/index.ts', 'export function value(input: number): number { return input }\n')
    await assert.rejects(runCli('--build-declarations'), (error) => {
      assert.match(`${error.stderr}\n${error.stdout}`, /Declaration\/API drift requires compatibility review/)
      assert.match(`${error.stderr}\n${error.stdout}`, /Review declaration diffs, consumer type tests and release notes before explicitly updating the baseline/)
      assert.match(error.stderr, /node \.smithers\/flows\/release\/check-api-baseline\.mjs --build-declarations --update/)
      return true
    })
    const second = await runCli('--update', '--build-declarations')
    assert.match(second.stdout, /Recorded declarations for 1 public packages/)
    const updated = JSON.parse(await readFile(baselinePath, 'utf8'))
    assert.notEqual(updated.packages['@smthrs/example'].declarations['index.d.ts'], firstHash)
    await assert.rejects(readdir(join(packageRoot, 'dist')), { code: 'ENOENT' })
    const check = await runCli('--build-declarations')
    assert.match(check.stdout, /Declaration baseline matches 1 public packages/)
    for (const options of [['--unknown'], ['--update', '--update'], ['--build-declarations', '--build-declarations']]) {
      await assert.rejects(runCli(...options), (error) => {
        assert.match(error.stderr, /usage: node \.smithers\/flows\/release\/check-api-baseline\.mjs/)
        return true
      })
    }
    assert.equal(await readFile(baselinePath, 'utf8'), `${JSON.stringify(updated, null, 2)}\n`)
    const alias = join(root, 'alias.mjs')
    await symlink(cli, alias)
    const linked = await runFile(process.execPath, [alias, '--build-declarations'], { cwd: root })
    assert.match(linked.stdout, /Declaration baseline matches 1 public packages/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the Cloud drift check runs exactly the gates the generated drift workflow runs', async () => {
  const script = await readFile(new URL('../../../.smithers/flows/checks/coding-check.sh', import.meta.url), 'utf8')
  const gates = script.match(/drift_gates="([^"]*)"/)?.[1].split('\n')
  assert.ok(gates, 'coding-check.sh declares its drift gates')
  const expected = gateCommands.map((command) => {
    const [, verb, pattern] = command.match(/^pnpm exec smthrs (\w+) '([^']+)'/)
    return `${verb} ${pattern}`
  })
  assert.deepEqual(gates, expected)
  const body = await readFile(new URL('../../../.smithers/flows/checks/drift/flow.mdx', import.meta.url), 'utf8')
  assert.match(body, /flows: \[coding\/CommandCheck\]/)
  assert.match(body, /\{"argv":\["sh","\.smithers\/flows\/checks\/coding-check\.sh","drift"\]/)
  assert.ok(gates.every((gate) => !gate.startsWith('test ')), 'the drift check runs no test target')
})

test('C-PRC-01 observes the literal required status and clean per-SHA check through GitHub APIs', {
  skip: !process.env.SMITHERS_PRC_STATUS_ACCEPTANCE_COMMIT,
}, async () => {
  const commit = process.env.SMITHERS_PRC_STATUS_ACCEPTANCE_COMMIT
  assert.match(commit, /^[0-9a-f]{40}$/)
  const readApi = async (path) => {
    const response = await fetch(`https://api.github.com/repos/smithersai/smithers/${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'smithers-prc-acceptance' },
      signal: AbortSignal.timeout(30_000),
    })
    assert.equal(response.status, 200, `${path}: ${response.status}`)
    return response.json()
  }
  const rules = await readApi('rules/branches/main')
  const checks = rules.filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
  assert.ok(checks.some((check) => check.context === 'Per-commit drift'), 'main must require the literal Per-commit drift context')
  const runs = await readApi(`commits/${commit}/check-runs?per_page=100`)
  assert.ok(runs.check_runs.some((run) => run.name === 'Per-commit drift' && run.head_sha === commit
    && run.status === 'completed' && run.conclusion === 'success'), 'the exact landed SHA must have a clean Per-commit drift run')
})


test('documentation drift checks every current site generator', async () => {
  const source = await readFile(rootPackagePath, 'utf8')
  const docs = source.match(/const docsDrift\s*=\s*Smithers\.Shell\.Diff\(\{([\s\S]*?)\n\}\)/)?.[1]
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'apps/site/package.json'), 'utf8'))
  const generators = manifest.scripts['sync:docs'].split(' && ')
  const checks = [...docs.matchAll(/node scripts\/[^ "&]+ --check/g)].map(([command]) => command)
  assert.deepEqual(checks, generators.map((command) => command + ' --check'))
  for (const command of generators) await readFile(join(repositoryRoot, 'apps/site', command.slice('node '.length)), 'utf8')
})
