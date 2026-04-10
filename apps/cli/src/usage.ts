const FULL_USAGE = [
  "Burns CLI",
  "",
  "Usage:",
  "  burns start",
  "  burns daemon",
  "",
  "Commands:",
  "  start   Start daemon only. Legacy alias retained after UI removal.",
  "  daemon  Start daemon only.",
].join("\n")

const START_USAGE = [
  "Usage:",
  "  burns start",
  "",
  "Notes:",
  "  Legacy alias for `burns daemon`.",
].join("\n")

const DAEMON_USAGE = [
  "Usage:",
  "  burns daemon",
].join("\n")

export function renderUsage(topic?: "start" | "daemon") {
  if (topic === "start") {
    return START_USAGE
  }

  if (topic === "daemon") {
    return DAEMON_USAGE
  }

  return FULL_USAGE
}
