import { describe, expect, test } from "bun:test";
import { standaloneThemeCss } from "@smthrs/ui-styleguide";
import { createReviewWorker } from "../../src/server/worker.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

function makeWorker() {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "http://unused",
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil: () => undefined,
  });
}

describe("landing page", () => {
  test("onboards new users to review cloud with the shared standalone theme", async () => {
    const worker = makeWorker();
    const env = await buildTestEnv();
    const res = await worker.fetch(new Request("https://review.test/"), env);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(body).toContain("smithers review");
    expect(body).toContain("--publish");
    expect(body).toContain("/api/sessions");
    expect(body).toContain("/api/plan");
    expect(body).not.toContain("publish quota");
    expect(body).toContain("/w/");
    expect(body).toContain(standaloneThemeCss());
  });
});
