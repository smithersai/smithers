import type { SmithersErrorCode } from "./SmithersErrorCode.ts";
import type { SmithersErrorOptions } from "./SmithersErrorOptions.ts";
import { getSmithersErrorDocsUrl } from "./getSmithersErrorDocsUrl.ts";

function formatSmithersErrorMessage(message: string, docsUrl: string): string {
  if (message.includes(docsUrl)) return message;
  return `${message} See ${docsUrl}`;
}

export class SmithersError extends Error {
  readonly code: SmithersErrorCode;
  readonly summary: string;
  readonly docsUrl: string;
  details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(
    code: SmithersErrorCode,
    summary: string,
    details?: Record<string, unknown>,
    causeOrOptions?: unknown | SmithersErrorOptions,
  ) {
    const docsUrl = getSmithersErrorDocsUrl(code);
    const isOptionsObject =
      causeOrOptions &&
      typeof causeOrOptions === "object" &&
      (Object.prototype.hasOwnProperty.call(causeOrOptions, "cause") ||
        Object.prototype.hasOwnProperty.call(causeOrOptions, "includeDocsUrl") ||
        Object.prototype.hasOwnProperty.call(causeOrOptions, "name"));
    const options =
      isOptionsObject
        ? (causeOrOptions as SmithersErrorOptions)
        : ({ cause: causeOrOptions } satisfies SmithersErrorOptions);
    super(
      options.includeDocsUrl === false
        ? summary
        : formatSmithersErrorMessage(summary, docsUrl),
      { cause: options.cause },
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = options.name ?? "SmithersError";
    this.code = code;
    this.summary = summary;
    this.docsUrl = docsUrl;
    this.details = details;
    this.cause = options.cause;
  }
}
