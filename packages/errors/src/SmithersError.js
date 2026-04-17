import { getSmithersErrorDocsUrl } from "./getSmithersErrorDocsUrl.js";
/** @typedef {import("./SmithersErrorCode.ts").SmithersErrorCode} SmithersErrorCode */
/** @typedef {import("./SmithersErrorOptions.ts").SmithersErrorOptions} SmithersErrorOptions */

/**
 * @param {string} message
 * @param {string} docsUrl
 * @returns {string}
 */
function formatSmithersErrorMessage(message, docsUrl) {
    if (message.includes(docsUrl))
        return message;
    return `${message} See ${docsUrl}`;
}
export class SmithersError extends Error {
    /** @type {SmithersErrorCode} */
    code;
    /** @type {string} */
    summary;
    /** @type {string} */
    docsUrl;
    /** @type {Record<string, unknown> | undefined} */
    details;
    /** @type {unknown} */
    cause;
    /** @type {string} */
    name;
    /**
   * @param {SmithersErrorCode} code
   * @param {string} summary
   * @param {Record<string, unknown>} [details]
   * @param {unknown | SmithersErrorOptions} [causeOrOptions]
   */
    constructor(code, summary, details, causeOrOptions) {
        const docsUrl = getSmithersErrorDocsUrl(code);
        const isOptionsObject = causeOrOptions &&
            typeof causeOrOptions === "object" &&
            (Object.prototype.hasOwnProperty.call(causeOrOptions, "cause") ||
                Object.prototype.hasOwnProperty.call(causeOrOptions, "includeDocsUrl") ||
                Object.prototype.hasOwnProperty.call(causeOrOptions, "name"));
        const options = /** @type {SmithersErrorOptions} */ (isOptionsObject
            ? causeOrOptions
            : { cause: causeOrOptions });
        super(options.includeDocsUrl === false
            ? summary
            : formatSmithersErrorMessage(summary, docsUrl), { cause: options.cause });
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = options.name ?? "SmithersError";
        this.code = code;
        this.summary = summary;
        this.docsUrl = docsUrl;
        this.details = details;
        this.cause = options.cause;
    }
}
