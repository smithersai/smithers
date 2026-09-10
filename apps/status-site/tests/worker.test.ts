import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createStatusSiteWorker, type StatusSiteEnv } from "../src/worker.ts";

const homeHtml = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const statusRaw = readFileSync(new URL("../site/status.json", import.meta.url), "utf8");
const status = JSON.parse(statusRaw) as {
  updatedAt: string;
  monitoringSince: string;
  overall: string;
  overallNote: string;
  components: Array<{ name: string; description?: string; status: string }>;
  history: Record<string, { status: string; note?: string }>;
  incidents: Array<{ title?: string; updates?: Array<{ body?: string }> }>;
};

const BANNERS: Record<string, string> = {
  operational: "All systems operational",
  degraded: "Degraded performance",
  outage: "Outage",
  maintenance: "Under maintenance",
};
const LABELS: Record<string, string> = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Outage",
  maintenance: "Maintenance",
};

/**
 * The static state a reader without JavaScript sees, read straight out of the
 * markup without running the inline script. Every field is visible text or a
 * class, never the script's own lookup tables, so a wrong label cannot be
 * satisfied by the BANNERS/LABELS literals further down the page.
 */
function staticState(html: string) {
  const bannerClass = /<div class="banner (\w+)" id="banner"/.exec(html)?.[1] ?? null;
  const bannerText = /<h1 id="banner-text">([^<]*)<\/h1>/.exec(html)?.[1] ?? null;
  const stamp = /<p class="stamp" id="stamp">Last updated ([^<]*)<\/p>/.exec(html)?.[1] ?? null;
  const note = /<p class="note" id="note">\s*([^<]*?)\s*<\/p>/.exec(html)?.[1] ?? null;
  const rows = [
    ...html.matchAll(
      /<span class="name">([^<]+)<\/span>\s*<span class="desc">([^<]*)<\/span>\s*<span class="state (\w+)"><span class="dot"><\/span>([^<]*)<\/span>/g,
    ),
  ].map(([, name, desc, state, label]) => ({ name, desc, state, label }));
  return { bannerClass, bannerText, stamp, note, rows };
}

/** The same state derived from the feed, the way the inline script renders it. */
const feedState = {
  bannerClass: status.overall,
  bannerText: BANNERS[status.overall] as string,
  stamp: status.updatedAt.slice(0, 10),
  note: status.overallNote,
  rows: status.components.map((component) => ({
    name: component.name,
    desc: component.description ?? "",
    state: component.status,
    label: LABELS[component.status] as string,
  })),
};

function makeEnv(): StatusSiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(homeHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        if (url.pathname === "/status.json") {
          const etag = '"feed-v1"';
          if (request.headers.get("if-none-match") === etag) {
            // A 304 need not include a content type or body.
            return new Response(null, { status: 304, headers: { etag } });
          }
          return new Response(statusRaw, { headers: { "content-type": "application/json", etag } });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

describe("status feed", () => {
  test("only records history on or after monitoring began", () => {
    expect(status.monitoringSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const day of Object.keys(status.history)) {
      expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(day >= status.monitoringSince).toBe(true);
    }
  });

  test("uses only the states the page knows how to render", () => {
    const known = Object.keys(LABELS);
    expect(known).toContain(status.overall);
    for (const component of status.components) expect(known).toContain(component.status);
    for (const day of Object.values(status.history)) expect(known).toContain(day.status);
  });

  test("lists no component we have not shipped", () => {
    const names = status.components.map((component) => component.name);
    expect(names.join(" ")).not.toContain("docs");
    expect(JSON.stringify(status.components)).not.toContain("docs.smithers.sh");
  });
});

describe("status page copy", () => {
  test("renders the committed overall state as the static banner", () => {
    const { bannerClass, bannerText } = staticState(homeHtml);
    expect(bannerClass).toBe(feedState.bannerClass);
    expect(bannerText).toBe(feedState.bannerText);
  });

  test("static stamp and note agree with the feed", () => {
    const { stamp, note } = staticState(homeHtml);
    expect(stamp).toBe(feedState.stamp);
    expect(note).toBe(feedState.note);
  });

  test("static component rows agree with the feed", () => {
    expect(staticState(homeHtml).rows).toEqual(feedState.rows);
  });

  test("static parity rejects a page whose visible labels lag the feed", () => {
    // Every no-JavaScript field must be read from visible markup, not from the
    // script's BANNERS/LABELS literals, which contain every heading regardless of
    // state. Each mutation below leaves those literals intact and must still fail.
    const mutations: Array<[string, (html: string) => string]> = [
      ["banner heading", (html) => html.replace('<h1 id="banner-text">All systems operational</h1>', '<h1 id="banner-text">Outage</h1>')],
      ["badge labels", (html) => html.replaceAll("<span class=\"dot\"></span>Operational</span>", "<span class=\"dot\"></span>Outage</span>")],
      ["banner class", (html) => html.replace('<div class="banner operational" id="banner"', '<div class="banner outage" id="banner"')],
      ["stamp", (html) => html.replace("Last updated 2026-08-08", "Last updated 2026-01-01")],
      ["note", (html) => html.replace("Components are checked by hand", "Components are checked hourly")],
    ];
    for (const [name, mutate] of mutations) {
      const mutated = mutate(homeHtml);
      expect(mutated, name).not.toBe(homeHtml);
      expect(staticState(mutated), name).not.toEqual(feedState);
    }
    expect(staticState(homeHtml)).toEqual(feedState);
  });

  test("promises no SLA, uptime percentage, or round-the-clock support", () => {
    expect(homeHtml).toContain("Best-effort incident response during the alpha. No SLA is implied.");
    // The feed's own copy (overallNote, descriptions, history notes, incident
    // bodies) is rendered onto the page verbatim, so it is scanned too.
    for (const text of [homeHtml.toLowerCase(), statusRaw.toLowerCase()]) {
      expect(text).not.toContain("99.9");
      expect(text).not.toContain("uptime guarantee");
      expect(text).not.toContain("guaranteed uptime");
      expect(text).not.toContain("24/7");
      expect(text).not.toMatch(/\d+(\.\d+)?\s*% uptime/);
      expect(text).not.toMatch(/\bsla\b(?! is implied)/);
    }
  });

  test("offers no subscribe affordance, because none is wired up", () => {
    const text = homeHtml.toLowerCase();
    expect(text).not.toContain("subscribe");
    expect(text).not.toContain("notify me");
    expect(text).not.toContain("<form");
  });

  test("labels missing days as no data rather than as healthy", () => {
    expect(homeHtml).toContain("No data &mdash; not monitored that day");
    expect(homeHtml).toContain("no data (before monitoring began)");
  });

  test("says so plainly when it cannot load the feed", () => {
    expect(homeHtml).toContain("Status feed unavailable");
    expect(homeHtml).toContain("It is not a statement that everything is fine.");
  });

  test("gives the calendar prev/next month navigation and a legend", () => {
    expect(homeHtml).toContain('id="cal-prev"');
    expect(homeHtml).toContain('id="cal-next"');
    expect(homeHtml).toContain('class="legend"');
  });

  test("ships an inline script that at least parses", () => {
    // A syntax error here kills every rendered section silently, so guard it.
    const script = /<script>([\s\S]*?)<\/script>/.exec(homeHtml)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script as string)).not.toThrow();
  });

  test("shows an empty incident history honestly", () => {
    if (status.incidents.length === 0) expect(homeHtml).toContain("No incidents reported.");
  });
});

describe("status site worker", () => {
  test("serves the status page", async () => {
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/"), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain(BANNERS[status.overall] as string);
  });

  test("serves the status feed with a short TTL", async () => {
    const response = await createStatusSiteWorker().fetch(
      new Request("https://status.smithers.sh/status.json"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"feed-v1"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await response.json()) as { overall: string }).overall).toBe(status.overall);
  });

  test("relays conditional feed revalidation with validators and feed headers", async () => {
    const worker = createStatusSiteWorker();
    const env = makeEnv();
    const initial = await worker.fetch(new Request("https://status.smithers.sh/status.json"), env);
    const etag = initial.headers.get("etag");
    expect(etag).toBe('"feed-v1"');
    const request = new Request("https://status.smithers.sh/status.json", {
      headers: { "if-none-match": etag!, origin: "https://consumer.example" },
    });
    const fetch = spyOn(env.ASSETS, "fetch");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await worker.fetch(request, env);
      expect(fetch).toHaveBeenCalledWith(request);
      expect(response.status).toBe(304);
      expect(response.headers.get("etag")).toBe(etag);
      expect(response.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.body).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      warn.mockRestore();
    }
  });

  const refusals = [
    { status: 404, contentType: "text/plain", reason: "missing" },
    { status: 200, contentType: "text/html", reason: "not-json" },
    { status: 503, contentType: "application/json", reason: "unexpected-status" },
  ];

  for (const refusal of refusals) {
    function refusedEnv(): StatusSiteEnv {
      return {
        ASSETS: {
          async fetch() {
            return new Response("unavailable", {
              status: refusal.status,
              headers: { "content-type": refusal.contentType },
            });
          },
        },
      };
    }

    test(`returns an uncached, cross-origin feed error for ${refusal.reason}`, async () => {
      const response = await createStatusSiteWorker().fetch(
        new Request("https://status.smithers.sh/status.json", {
          headers: { origin: "https://consumer.example" },
        }),
        refusedEnv(),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("json");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "status feed unavailable", reason: refusal.reason });
    });

    test(`logs the binding response for ${refusal.reason}`, async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await createStatusSiteWorker().fetch(
          new Request("https://status.smithers.sh/status.json?private=value"),
          refusedEnv(),
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("status feed refused", {
          status: refusal.status,
          contentType: refusal.contentType,
          pathname: "/status.json",
        });
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("keeps CORS on feed method rejections", async () => {
    const response = await createStatusSiteWorker().fetch(
      new Request("https://status.smithers.sh/status.json", {
        method: "POST",
        headers: { origin: "https://consumer.example" },
      }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("404s the feed instead of serving HTML when it is missing", async () => {
    const env: StatusSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response("not found", { status: 404 });
        },
      },
    };
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/status.json"), env);
    expect(response.status).toBe(404);
  });

  test("404s the feed when the SPA fallback serves the page in its place", async () => {
    // This, not a 404, is what the real assets binding does for a missing file:
    // not_found_handling is single-page-application, so it returns index.html
    // with a 200. Serving that as the feed would be HTML pretending to be status.
    const env: StatusSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response(homeHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
        },
      },
    };
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/status.json"), env);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("json");
  });

  test("falls back to the status page for unknown paths", async () => {
    const response = await createStatusSiteWorker().fetch(
      new Request("https://status.smithers.sh/incidents"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Incident history");
  });

  test("reports health without touching static assets", async () => {
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/healthz"), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, service: "status-site" });
  });

  test("rejects non-GET/HEAD methods with 405", async () => {
    const response = await createStatusSiteWorker().fetch(
      new Request("https://status.smithers.sh/", { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("method not allowed");
  });

  test("locks the page to its one inline script with a content security policy", async () => {
    // The hash is recomputed from index.html here, so editing the script without
    // updating the worker's constant fails this test instead of shipping a page
    // whose only script the browser refuses to run.
    const script = /<script>([\s\S]*?)<\/script>/.exec(homeHtml)?.[1] ?? "";
    expect(script).toBeTruthy();
    const hash = createHash("sha256").update(script, "utf8").digest("base64");
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/"), makeEnv());
    expect(response.headers.get("content-security-policy")).toBe(
      [
        "default-src 'none'",
        `script-src 'sha256-${hash}'`,
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    // A hash-only script-src covers exactly one block and no inline handlers.
    expect(homeHtml.match(/<script/g)).toHaveLength(1);
    expect(homeHtml).not.toMatch(/\son[a-z]+=["']/i);
    expect(homeHtml).not.toContain("javascript:");
  });

  test("keeps the page policy on the SPA fallback under /assets/", async () => {
    // The real binding answers a missing /assets/x with index.html and a 200.
    // Stamping that HTML immutable would pin the page at that path for a year.
    const env: StatusSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response(homeHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
        },
      },
    };
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/assets/app.js"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("content-security-policy")).toContain("script-src");
    expect(await response.text()).toContain(BANNERS[status.overall] as string);
  });

  test("never caches a binding error for an asset", async () => {
    const env: StatusSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response("upstream error", { status: 503, headers: { "content-type": "text/plain" } });
        },
      },
    };
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/assets/app.js"), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("never caches a missing status page", async () => {
    // A deploy that drops index.html must be gone the moment the next one lands.
    const env: StatusSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response("not found", { status: 404 });
        },
      },
    };
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/"), env);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("serves static assets with an immutable cache header", async () => {
    const env: StatusSiteEnv = {
      ASSETS: {
        async fetch(request: Request) {
          if (new URL(request.url).pathname === "/assets/app.js") {
            return new Response("console.log('hi')", {
              headers: { "content-type": "text/javascript; charset=utf-8" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      },
    };
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/assets/app.js"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
