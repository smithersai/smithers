export type BurnsCommand =
  | { kind: "help"; topic?: "start" | "daemon" }
  | { kind: "daemon" }
  | { kind: "start" }

type ParseResult =
  | { ok: true; command: BurnsCommand }
  | { ok: false; error: string }

const REMOVED_UI_MESSAGE =
  "The Burns UI was removed from this repo. `burns web` and `burns ui` are no longer available."

function parseStartArgs(args: string[]): ParseResult {
  if (args.length === 0) {
    return {
      ok: true,
      command: { kind: "start" },
    }
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { ok: true, command: { kind: "help", topic: "start" } }
  }

  return {
    ok: false,
    error:
      "The Burns UI was removed from this repo. `burns start` no longer accepts web options; use `burns start` or `burns daemon` with no extra flags.",
  }
}

function parseDaemonArgs(args: string[]): ParseResult {
  if (args.length === 0) {
    return {
      ok: true,
      command: { kind: "daemon" },
    }
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return {
      ok: true,
      command: { kind: "help", topic: "daemon" },
    }
  }

  return { ok: false, error: `Unknown option for burns daemon: ${args[0]}` }
}

export function parseCliArgs(argv: string[]): ParseResult {
  if (argv.length === 0) {
    return {
      ok: true,
      command: {
        kind: "help",
      },
    }
  }

  const [commandName, ...commandArgs] = argv

  if (commandName === "--help" || commandName === "-h") {
    return {
      ok: true,
      command: {
        kind: "help",
      },
    }
  }

  if (commandName === "start") {
    return parseStartArgs(commandArgs)
  }

  if (commandName === "daemon") {
    return parseDaemonArgs(commandArgs)
  }

  if (commandName === "web" || commandName === "ui") {
    return { ok: false, error: REMOVED_UI_MESSAGE }
  }

  return {
    ok: false,
    error: `Unknown command: ${commandName}`,
  }
}
