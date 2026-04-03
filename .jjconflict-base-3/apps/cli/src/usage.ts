const FULL_USAGE = [
  "Burns CLI",
  "",
  "Usage:",
  "  burns start [--open] [--web-url <url>]",
  "  burns daemon",
  "  burns web [--host <host>] [--port <port>] [--open]",
  "",
  "Commands:",
  "  start   Start daemon and web UI server, optionally open the web URL in a browser.",
  "  daemon  Start daemon only.",
  "  web     Serve prebuilt web assets from dist/web.",
].join("\n")

const START_USAGE = [
  "Usage:",
  "  burns start [--open] [--web-url <url>]",
  "",
  "Options:",
  "  --open            Open the web URL in your browser after daemon startup.",
  "  --web-url <url>   URL to open with --open. Default: http://127.0.0.1:4173",
].join("\n")

const DAEMON_USAGE = [
  "Usage:",
  "  burns daemon",
].join("\n")

const WEB_USAGE = [
  "Usage:",
  "  burns web [--host <host>] [--port <port>] [--open]",
  "",
  "Options:",
  "  --host <host>   Host/interface to bind. Default: 127.0.0.1",
  "  --port <port>   Port to bind. Default: 4173",
  "  --open          Open the served URL in your browser.",
].join("\n")

export function renderUsage(topic?: "start" | "daemon" | "web") {
  if (topic === "start") {
    return START_USAGE
  }

  if (topic === "daemon") {
    return DAEMON_USAGE
  }

  if (topic === "web") {
    return WEB_USAGE
  }

  return FULL_USAGE
}
