import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  resolveSmithersObservabilityOptions,
  renderPrometheusMetrics,
} from "../src/observability";
import type { SmithersLogFormat } from "../src/observability";
import { LogLevel } from "effect";

describe("resolveSmithersObservabilityOptions", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "SMITHERS_OTEL_ENABLED",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_SERVICE_NAME",
    "SMITHERS_LOG_FORMAT",
    "SMITHERS_LOG_LEVEL",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test("returns defaults when no options or env vars", () => {
    const result = resolveSmithersObservabilityOptions();
    expect(result.enabled).toBe(false);
    expect(result.endpoint).toBe("http://localhost:4318");
    expect(result.serviceName).toBe("smithers");
    expect(result.logFormat).toBe("logfmt");
    expect(result.logLevel).toBe(LogLevel.Info);
  });

  test("explicit options override defaults", () => {
    const result = resolveSmithersObservabilityOptions({
      enabled: true,
      endpoint: "http://custom:4317",
      serviceName: "my-service",
      logFormat: "json",
      logLevel: "debug",
    });
    expect(result.enabled).toBe(true);
    expect(result.endpoint).toBe("http://custom:4317");
    expect(result.serviceName).toBe("my-service");
    expect(result.logFormat).toBe("json");
    expect(result.logLevel).toBe(LogLevel.Debug);
  });

  test("env vars used when no options provided", () => {
    process.env.SMITHERS_OTEL_ENABLED = "true";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://env:4318";
    process.env.OTEL_SERVICE_NAME = "env-service";
    process.env.SMITHERS_LOG_FORMAT = "pretty";
    process.env.SMITHERS_LOG_LEVEL = "warning";
    const result = resolveSmithersObservabilityOptions();
    expect(result.enabled).toBe(true);
    expect(result.endpoint).toBe("http://env:4318");
    expect(result.serviceName).toBe("env-service");
    expect(result.logFormat).toBe("pretty");
    expect(result.logLevel).toBe(LogLevel.Warning);
  });

  test("SMITHERS_OTEL_ENABLED=1 enables", () => {
    process.env.SMITHERS_OTEL_ENABLED = "1";
    const result = resolveSmithersObservabilityOptions();
    expect(result.enabled).toBe(true);
  });

  test("SMITHERS_OTEL_ENABLED=0 does not enable", () => {
    process.env.SMITHERS_OTEL_ENABLED = "0";
    const result = resolveSmithersObservabilityOptions();
    expect(result.enabled).toBe(false);
  });

  test("resolves all log levels", () => {
    const levels: [string, LogLevel.LogLevel][] = [
      ["none", LogLevel.None],
      ["trace", LogLevel.Trace],
      ["debug", LogLevel.Debug],
      ["info", LogLevel.Info],
      ["warning", LogLevel.Warning],
      ["warn", LogLevel.Warning],
      ["error", LogLevel.Error],
      ["fatal", LogLevel.Fatal],
      ["all", LogLevel.All],
    ];
    for (const [input, expected] of levels) {
      const result = resolveSmithersObservabilityOptions({ logLevel: input });
      expect(result.logLevel).toBe(expected);
    }
  });

  test("unknown log level defaults to Info", () => {
    const result = resolveSmithersObservabilityOptions({ logLevel: "banana" });
    expect(result.logLevel).toBe(LogLevel.Info);
  });

  test("resolves all log formats", () => {
    const formats: [SmithersLogFormat, SmithersLogFormat][] = [
      ["json", "json"],
      ["pretty", "pretty"],
      ["string", "string"],
      ["logfmt", "logfmt"],
    ];
    for (const [input, expected] of formats) {
      const result = resolveSmithersObservabilityOptions({
        logFormat: input,
      });
      expect(result.logFormat).toBe(expected);
    }
  });

  test("unknown log format defaults to logfmt", () => {
    process.env.SMITHERS_LOG_FORMAT = "unknown";
    const result = resolveSmithersObservabilityOptions();
    expect(result.logFormat).toBe("logfmt");
  });

  test("explicit enabled=false overrides env var", () => {
    process.env.SMITHERS_OTEL_ENABLED = "true";
    const result = resolveSmithersObservabilityOptions({ enabled: false });
    expect(result.enabled).toBe(false);
  });
});

describe("Prometheus formatting edge cases", () => {
  test("renderPrometheusMetrics returns string output", () => {
    const output = renderPrometheusMetrics();
    expect(typeof output).toBe("string");
  });

  test("output ends with newline when metrics present", () => {
    const output = renderPrometheusMetrics();
    if (output.length > 0) {
      expect(output.endsWith("\n")).toBe(true);
    }
  });

  test("output contains TYPE annotations", () => {
    const output = renderPrometheusMetrics();
    if (output.length > 0) {
      expect(output).toContain("# TYPE");
    }
  });
});
