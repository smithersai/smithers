import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, getWebUrl } from "./web"

export type BurnsCommand =
  | { kind: "help"; topic?: "start" | "daemon" | "web" }
  | { kind: "daemon" }
  | { kind: "start"; openWeb: boolean; webUrl: string }
  | { kind: "web"; host: string; port: number; openWeb: boolean }

type ParseResult =
  | { ok: true; command: BurnsCommand }
  | { ok: false; error: string }

function parsePort(rawValue: string) {
  const parsedPort = Number(rawValue)
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return null
  }

  return parsedPort
}

function parseStartArgs(args: string[]): ParseResult {
  let openWeb = false
  let webUrl = getWebUrl(DEFAULT_WEB_HOST, DEFAULT_WEB_PORT)

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === "--help" || arg === "-h") {
      return { ok: true, command: { kind: "help", topic: "start" } }
    }

    if (arg === "--open") {
      openWeb = true
      continue
    }

    if (arg === "--web-url") {
      const nextValue = args[index + 1]
      if (!nextValue) {
        return { ok: false, error: "Missing value for --web-url" }
      }

      webUrl = nextValue
      index += 1
      continue
    }

    return { ok: false, error: `Unknown option for burns start: ${arg}` }
  }

  return {
    ok: true,
    command: {
      kind: "start",
      openWeb,
      webUrl,
    },
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

function parseWebArgs(args: string[]): ParseResult {
  let host = DEFAULT_WEB_HOST
  let port = DEFAULT_WEB_PORT
  let openWeb = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === "--help" || arg === "-h") {
      return { ok: true, command: { kind: "help", topic: "web" } }
    }

    if (arg === "--open") {
      openWeb = true
      continue
    }

    if (arg === "--host") {
      const nextValue = args[index + 1]
      if (!nextValue) {
        return { ok: false, error: "Missing value for --host" }
      }

      host = nextValue
      index += 1
      continue
    }

    if (arg === "--port") {
      const nextValue = args[index + 1]
      if (!nextValue) {
        return { ok: false, error: "Missing value for --port" }
      }

      const parsedPort = parsePort(nextValue)
      if (!parsedPort) {
        return { ok: false, error: `Invalid --port value: ${nextValue}` }
      }

      port = parsedPort
      index += 1
      continue
    }

    return { ok: false, error: `Unknown option for burns web: ${arg}` }
  }

  return {
    ok: true,
    command: {
      kind: "web",
      host,
      port,
      openWeb,
    },
  }
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

  if (commandName === "web") {
    return parseWebArgs(commandArgs)
  }

  return {
    ok: false,
    error: `Unknown command: ${commandName}`,
  }
}
