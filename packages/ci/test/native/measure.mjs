// `smithers-ci` on a repository that already builds with Smithers build, replaying the patterns the first
// argument names (comma-separated), until the command line has a flag for them. The other arguments are the
// program's own: node measure.mjs '//packages/ci/...' --commits 3 --json
process.env.VIBELANG_PROJECT = new URL("../../tsconfig.test.json", import.meta.url).pathname
await import("vibelang/register")
const { run } = await import("../../src/cli/main.vibe")
const { withTargets } = await import("./measure.vibe")
const [patterns = "", ...args] = process.argv.slice(2)
process.exitCode = await run(args, process.cwd(), process.env, withTargets(patterns.split(",")))
