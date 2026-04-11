import type { LogLevel } from "effect";
import type { SmithersLogFormat } from "./SmithersLogFormat";

export type ResolvedSmithersObservabilityOptions = {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly serviceName: string;
  readonly logFormat: SmithersLogFormat;
  readonly logLevel: LogLevel.LogLevel;
};
