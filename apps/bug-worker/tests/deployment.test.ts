import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { workerProps } from "../alchemy.run.ts";
import { BugWorkerDeployment } from "../infra/Deployment.ts";

/**
 * The stack's installation-specific values come from deployment
 * configuration: two configurations plan disjoint resources, and the source
 * holds no hosted account's identifiers.
 */
const deploy = (env: Record<string, string>) =>
  Effect.runSyncExit(BugWorkerDeployment.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))));
const deployment = (env: Record<string, string>) => {
  const exit = deploy(env);
  if (exit._tag !== "Success") throw new Error(`deployment failed: ${String(exit.cause)}`);
  return exit.value;
};
const plain = (props: ReturnType<typeof workerProps>) => {
  const { env, ...rest } = props;
  return { ...rest, env: Object.keys(env).sort(), publicBaseUrl: "PUBLIC_BASE_URL" in env ? env.PUBLIC_BASE_URL : undefined };
};

describe("deployment configuration", () => {
  test("with no configuration, the stack plans a generic installation on workers.dev", () => {
    const props = plain(workerProps(deployment({})));
    expect(props.name).toBe("smithers-bug-worker");
    expect(props.workersDev).toBe(true);
    expect(props.domain).toBeUndefined();
    expect(props.publicBaseUrl).toBeUndefined();
    expect(props.env).toEqual(["BUGS", "BUG_ADMIN_TOKEN", "RATE_LIMITS"]);
    expect(deployment({}).reportsNamespace).toBe("smithers-bug-reports");
  });

  test("two configurations plan disjoint resource names and hostnames", () => {
    const a = deployment({
      BUG_WORKER_NAME: "intake-a", BUG_REPORTS_NAMESPACE: "reports-a",
      BUG_WORKER_DOMAIN: "bug.a.example", BUG_WORKER_DOMAIN_ALIASES: "bugs.a.example, intake.a.example",
      BUG_WORKER_ZONE_ID: "0123456789abcdef0123456789abcdef",
    });
    const b = deployment({ BUG_WORKER_NAME: "intake-b", BUG_REPORTS_NAMESPACE: "reports-b", BUG_WORKER_DOMAIN: "bug.b.example" });
    const [pa, pb] = [plain(workerProps(a)), plain(workerProps(b))];
    expect(pa).toMatchObject({
      name: "intake-a", workersDev: false, publicBaseUrl: "https://bug.a.example",
      domain: { name: "bug.a.example", aliases: ["bugs.a.example", "intake.a.example"], zoneId: "0123456789abcdef0123456789abcdef" },
    });
    expect(pb).toMatchObject({ name: "intake-b", workersDev: false, publicBaseUrl: "https://bug.b.example", domain: { name: "bug.b.example" } });
    expect(pb.domain).not.toHaveProperty("zoneId");
    expect(pb.domain).not.toHaveProperty("aliases");
    expect(a.reportsNamespace).not.toBe(b.reportsNamespace);
  });

  test("a value that cannot be a name, hostname or zone stops the plan", () => {
    const invalid: Record<string, string>[] = [
      { BUG_WORKER_NAME: "Has Spaces" },
      { BUG_REPORTS_NAMESPACE: "-leading" },
      { BUG_WORKER_DOMAIN: "https://bug.example.com" },
      { BUG_WORKER_DOMAIN: "bug.example.com", BUG_WORKER_DOMAIN_ALIASES: "bug.example.com" },
      { BUG_WORKER_DOMAIN: "bug.example.com", BUG_WORKER_ZONE_ID: "not-a-zone" },
      { BUG_WORKER_DOMAIN_ALIASES: "bugs.example.com" },
      { BUG_WORKER_ZONE_ID: "0123456789abcdef0123456789abcdef" },
    ];
    for (const env of invalid) {
      expect(deploy(env)._tag).toBe("Failure");
    }
  });

  test("the stack, its configuration, the worker and the package hold no hosted identifiers", () => {
    const root = new URL("../", import.meta.url);
    const files = [
      "alchemy.run.ts", "package.json", "README.md",
      ...readdirSync(new URL("infra/", root)).map((name) => `infra/${name}`),
      ...readdirSync(new URL("src/", root)).map((name) => `src/${name}`),
    ];
    for (const file of files) {
      const text = readFileSync(new URL(file, root), "utf8");
      expect({ file, hosted: text.match(/williamcory|--stage prod|\b[0-9a-f]{32}\b/g) }).toEqual({ file, hosted: null });
    }
  });
});
