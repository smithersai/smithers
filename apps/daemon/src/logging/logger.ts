import pino, { type DestinationStream, type LevelWithSilent, type Logger } from "pino"
import pretty from "pino-pretty"

import { findSettingsRow } from "@/db/repositories/settings-repository"

export type BurnsLogger = Logger

type CreateLoggerOptions = {
  level?: LevelWithSilent
  timestamp?: boolean
  destination?: DestinationStream
  base?: Record<string, unknown>
  pretty?: boolean
}

let rootLogger: BurnsLogger | null = null

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false
  }

  return undefined
}

function createPrettyDestination() {
  return pretty({
    colorize: true,
    translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
    ignore: "pid,hostname",
    errorLikeObjectKeys: ["err", "error"],
    singleLine: false,
  })
}

function getDefaultLogLevel(): LevelWithSilent {
  if (process.env.BURNS_LOG_LEVEL) {
    return process.env.BURNS_LOG_LEVEL as LevelWithSilent
  }

  const storedSettings = findSettingsRow()
  if (storedSettings?.diagnostics_log_level) {
    return storedSettings.diagnostics_log_level as LevelWithSilent
  }

  return process.env.NODE_ENV === "test" ? "silent" : "info"
}

export function createLogger(options: CreateLoggerOptions = {}): BurnsLogger {
  const storedSettings = findSettingsRow()
  const prettyFromEnv = parseBooleanEnv(process.env.BURNS_LOG_PRETTY)
  const shouldUsePretty =
    !options.destination &&
    (options.pretty ??
      prettyFromEnv ??
      (storedSettings ? Boolean(storedSettings.diagnostics_pretty_logs) : undefined) ??
      (Boolean(process.stdout?.isTTY) && process.env.NODE_ENV !== "test"))

  const loggerOptions = {
    level: options.level ?? getDefaultLogLevel(),
    base: {
      service: "burns-daemon",
      ...(options.base ?? {}),
    },
    messageKey: "message",
    timestamp: options.timestamp === false ? false : pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  } satisfies pino.LoggerOptions

  return pino(loggerOptions, options.destination ?? (shouldUsePretty ? createPrettyDestination() : undefined))
}

export function getLogger(): BurnsLogger {
  if (!rootLogger) {
    rootLogger = createLogger()
  }

  return rootLogger
}

export function resetLogger() {
  rootLogger = null
}
