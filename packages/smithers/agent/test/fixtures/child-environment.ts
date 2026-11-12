/**
 * The environment a suite's child Node process starts with.
 *
 * A child gets a fixed minimal set rather than the runner's whole environment,
 * plus the runner's `NODE_OPTIONS`: the declared runtime's preloads arrive
 * there, and the child imports workspace sources that only those preloads can
 * load, such as VibeLang modules through `vibelang/register`.
 */
export const childEnvironment = (extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  LANG: "C.UTF-8",
  ...(process.env.NODE_OPTIONS === undefined ? {} : { NODE_OPTIONS: process.env.NODE_OPTIONS }),
  ...extra
})
