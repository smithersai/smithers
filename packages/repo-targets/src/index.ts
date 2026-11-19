/**
 * Shared repository build and review target declarations.
 * @since 0.1.0
 */

export { BuildAndCheckTypeScriptPackage } from "./BuildAndCheckTypeScriptPackage.ts"
export type {
  Options as BuildAndCheckTypeScriptPackageOptions,
  PackageTargets
} from "./BuildAndCheckTypeScriptPackage.ts"
export { CircularImports } from "./CircularImports.ts"
export { WorkspaceSources } from "./WorkspaceSources.ts"
export type { Options as WorkspaceSourcesOptions } from "./WorkspaceSources.ts"
export type { Options as CircularImportsOptions } from "./CircularImports.ts"
export { ImportRules } from "./ImportRules.ts"
export type { ImportRulesTarget, Options as ImportRulesOptions } from "./ImportRules.ts"
export type {
  ForbidCallsRule,
  ForbidNamesRule,
  ForbidRule,
  ForbidHostModulesRule,
  ImportRule,
  RootImportsOnlyRule,
  RuleScope as ImportRuleScope,
  TypeOnlyOption as ImportRuleTypeOnlyOption
} from "./ImportRulesCheck.ts"
export { JevRules } from "./JevRules.ts"
export type { JevRule, JevRulesTarget, Options as JevRulesOptions } from "./JevRules.ts"
export { ReviewDocsAgainstCode } from "./ReviewDocsAgainstCode.ts"
export { ReviewJsdocAgainstCode } from "./ReviewJsdocAgainstCode.ts"
export { smithersReviewPrompt } from "./ReviewLint.ts"
export type { Options as ReviewLintOptions, ReviewLint } from "./ReviewLint.ts"
export { ReviewTagsMigrationsAndKeys } from "./ReviewTagsMigrationsAndKeys.ts"
export { SdkRules } from "./SdkRules.ts"
export type {
  KnownDeepImports as SdkRulesKnownDeepImports,
  Options as SdkRulesOptions,
  Role as SdkRole,
  SdkRulesTargets
} from "./SdkRules.ts"
