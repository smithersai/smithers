/** Answers each requirement against Node 26.10.0. */
export declare const compareVersions: () => {
    atLeast: "unsupported_requirement" | boolean;
    exact: "unsupported_requirement" | boolean;
    below: "unsupported_requirement" | boolean;
    caret: "unsupported_requirement" | boolean;
};
/**
 * Verifies a host that reports `version` against `>=26.4.0`, and resolves
 * with the measured version or the refusal's code.
 */
export declare const verifyHost: (version: string) => Promise<string>;
