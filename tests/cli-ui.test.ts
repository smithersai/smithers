import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  buildUrl,
  probeServerHealth,
  resolveUiPort,
  shouldSuppressAutoOpen,
} from "../src/cli/ui";

let server: Bun.Server<undefined> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

describe("buildUrl", () => {
  test("builds the dashboard deep link", () => {
    expect(buildUrl(4173, { kind: "dashboard" })).toBe(
      "http://localhost:4173/?tab=runs",
    );
  });

  test("builds the run deep link", () => {
    expect(buildUrl(4173, { kind: "run", runId: "run-123" })).toBe(
      "http://localhost:4173/?tab=runs&runId=run-123",
    );
  });

  test("builds the node deep link", () => {
    expect(
      buildUrl(4173, {
        kind: "node",
        runId: "run-123",
        nodeId: "deploy",
      }),
    ).toBe("http://localhost:4173/?tab=runs&runId=run-123&nodeId=deploy");
  });

  test("builds the approvals deep link", () => {
    expect(buildUrl(4173, { kind: "approvals" })).toBe(
      "http://localhost:4173/?tab=approvals",
    );
  });

  test("uses a custom port", () => {
    expect(buildUrl(9999, { kind: "run", runId: "run-123" })).toBe(
      "http://localhost:9999/?tab=runs&runId=run-123",
    );
  });
});

describe("shouldSuppressAutoOpen", () => {
  test("suppresses browser open in CI", () => {
    expect(
      shouldSuppressAutoOpen({ CI: "1" } as NodeJS.ProcessEnv, "darwin"),
    ).toBe(true);
  });

  test("suppresses browser open on linux without a display", () => {
    expect(shouldSuppressAutoOpen({} as NodeJS.ProcessEnv, "linux")).toBe(true);
  });

  test("allows browser open on linux with a display", () => {
    expect(
      shouldSuppressAutoOpen({ DISPLAY: ":0" } as NodeJS.ProcessEnv, "linux"),
    ).toBe(false);
  });

  test("suppresses browser open over ssh without a display", () => {
    expect(
      shouldSuppressAutoOpen(
        { SSH_CONNECTION: "host", DISPLAY: "" } as NodeJS.ProcessEnv,
        "darwin",
      ),
    ).toBe(true);
  });
});

describe("probeServerHealth", () => {
  test("probes a healthy server on a non-default port", async () => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
          return Response.json({ ok: true });
        }

        return new Response("not found", { status: 404 });
      },
    });

    const port = server.port;
    if (port === undefined) {
      throw new Error("Expected Bun.serve() to expose a bound port");
    }
    expect(port).not.toBe(4173);
    await expect(
      Effect.runPromise(probeServerHealth(port)),
    ).resolves.toBe(true);
  });

  test("respects configured env port", () => {
    expect(
      resolveUiPort({ SMITHERS_UI_PORT: "9999" } as NodeJS.ProcessEnv),
    ).toBe(9999);
  });
});
