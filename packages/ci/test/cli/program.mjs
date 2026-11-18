// `smithers-ci` as a process over the test parts in parts.vibe, for parts
// that have not landed on main yet. Same program, same host as the bin.
process.env.VIBELANG_PROJECT = new URL("../../tsconfig.test.json", import.meta.url).pathname
await import("vibelang/register")
const { run } = await import("../../src/cli/main.vibe")
const { listenTo } = await import("../../src/cli/Signals.ts")
const { parts } = await import("./parts.vibe")
process.exitCode = await run(process.argv.slice(2), process.cwd(), process.env, parts, listenTo(process))
