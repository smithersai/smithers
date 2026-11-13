/** The component kit takes app state through props, including across local re-exports. */
export const appIndependenceRules = [{
  kind: "forbid" as const,
  files: ["src/**"],
  normalizeRelative: true,
  modules: [
    "**/apps/**",
    "@smthrs/mvp",
    "@smthrs/mvp/**",
    "zustand",
    "zustand/**",
  ],
  because: "The component kit takes app state through props; app stores stay in the consuming app.",
}];
