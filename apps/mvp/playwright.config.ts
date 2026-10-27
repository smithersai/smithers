import { defineConfig, type PlaywrightTestConfig } from "@playwright/test"
// Workspace packages export their source, which can hold `.vibe` modules (an e2e spec that imports
// @smthrs/integrations reaches @smthrs/errors'). Playwright's own transform leaves them to VibeLang's loader (`build`
// below): this process registers it here, and every worker inherits it through NODE_OPTIONS.
import "vibelang/register"
import { baseURL, onThisMachine, sessionFiles, target } from "./e2e/target"

const VIBELANG_LOADER = "--import=vibelang/register"
if (!(process.env.NODE_OPTIONS ?? "").includes(VIBELANG_LOADER)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${VIBELANG_LOADER}`.trim()
}

// Real browsers against the real app, Worker, Durable Object and model: no mocks. The target is local by default:
// Playwright starts `alchemy dev` (which needs the chat model's credential, CEREBRAS_API_KEY by default, in the
// environment). BASE_URL points the tests at a deployment, and `pnpm e2e:prod` at production (e2e/target.ts,
// docs/infrastructure.md#against-a-deployment). Locally the tests open the dev server over HTTPS and HTTP/2
// (dev/https.ts), as production serves the app.

// The dev server on this machine, on whatever port: its certificate may be self-signed (dev/https.ts).
const devCertificate = onThisMachine(baseURL)

// Every test records its page at the size it renders, a laptop's window, 1:1: `pnpm e2e:gifs` never zooms or crops it
// (Will, 2026-10-20: "video is too zoomed in"). e2e/devices.ts opens each device at the same size.
const viewport = { width: 1280, height: 800 }

/**
 * Against a deployment: the setup signs the test account in once (e2e/deployment/sign-in.setup.ts), every test starts
 * from that session, and the run's results, summary and recordings go to their own folder, apart from a local run's.
 * One worker (the personal-model specs change the shared account) and no retries: production's model and Electric are shared, and a durable retry is the app's job.
 */
const deployment = (): PlaywrightTestConfig => {
  // When the run began, for the spend guard (e2e/spend.ts): set once here, inherited by every worker.
  process.env.E2E_RUN_STARTED_AT ??= String(Date.now())
  const outputDir = "test-results-deployment"
  return {
    outputDir,
    workers: 1,
    retries: 0,
    timeout: 180_000,
    reporter: [["list"], ["json", { outputFile: `${outputDir}/results.json` }], ["./e2e/reporter.ts"]],
    projects: [
      // GitHub's pages stay out of every artifact: the setup records neither video nor trace.
      { name: "deployment-auth", testMatch: /deployment\/[^/]+\.setup\.ts$/, use: { video: "off", trace: "off" } },
      // No traces: a trace holds the requests' cookies, the session among them. Videos, screenshots and logs remain.
      { name: "webkit", dependencies: ["deployment-auth"], use: { browserName: "webkit", storageState: sessionFiles(baseURL).session, trace: "off" } },
      { name: "deployment", dependencies: ["deployment-auth"], use: { storageState: sessionFiles(baseURL).session, trace: "off" } },
    ],
  }
}

/** The specs whose scripted agent answers in the local shared conversation and waits for its turn there. */
const TAKES_TURNS = [
  "answer-ordering", "coedit", "factory", "files", "forms", "generated-view", "model-quota", "notifications", "pin-message",
  "queue", "repo-in-chat", "run-credentials", "run-graph", "sandbox-tools", "status", "sync", "timeline", "toast-overlap",
  "todos",
].map((name) => `**/${name}.spec.ts`)

export default defineConfig({
  testDir: "e2e",
  // `.vibe` modules go to VibeLang's loader, not Playwright's TypeScript transform.
  build: { external: ["**/*.vibe"] },
  // Only specs: e2e/*.test.ts are the e2e scripts' unit tests, which vitest runs.
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  use: {
    baseURL,
    viewport,
    video: { mode: "on", size: viewport },
    trace: "retain-on-failure",
    // A machine whose browsers don't trust its dev certificate, such as one without mkcert, made a self-signed one
    // (docs/infrastructure.md#https-and-http2). The flag, not only `ignoreHTTPSErrors`, lets the service worker
    // register over it. A deployment's certificate is always checked.
    ignoreHTTPSErrors: devCertificate,
    launchOptions: { args: devCertificate ? ["--ignore-certificate-errors"] : [] },
  },
  ...(target === "deployment"
    ? deployment()
    : {
      projects: [
        // The dev server's sandbox limits for its one person (e2e/local/sandbox-limits.setup.ts).
        { name: "local-setup", testMatch: /local\/[^/]+\.setup\.ts$/, use: { video: "off", trace: "off" } },
        { name: "webkit", dependencies: ["local-setup"], use: { browserName: "webkit" }, workers: 1 },
        { name: "local", dependencies: ["local-setup"], testIgnore: TAKES_TURNS },
        // Locally every spec asks in one shared conversation, which answers one question at a time (worker/Answers.ts):
        // specs whose scripted agent waits for its answer, or for its person, take turns instead of timing out behind
        // each other's runs.
        { name: "local-turns", dependencies: ["local-setup"], testMatch: TAKES_TURNS, workers: 1 },
      ],
    }),
  webServer: process.env.BASE_URL
    ? undefined
    : { command: "pnpm dev", url: baseURL, ignoreHTTPSErrors: true, reuseExistingServer: true, timeout: 120_000 },
})
