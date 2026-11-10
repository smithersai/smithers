import { GitHub } from "@smthrs/integrations"
import type { Role } from "../src/features/auth/contract.ts"
export const GitHubAuth = Object.assign(GitHub.Auth.GitHubAuth, { layer: GitHub.Auth.layer })
export type GitHubAuth = GitHub.Auth.GitHubAuth
export const GitHubRefused = GitHub.Auth.GitHubRefused
export type GitHubRefused = GitHub.Auth.GitHubRefused
export const appSlug = GitHub.Auth.appSlug
export const GITHUB_WEB = GitHub.Auth.GITHUB_WEB
export const GITHUB_API = GitHub.Auth.GITHUB_API
export type Permission = GitHub.Auth.Permission
export type Tokens = GitHub.Auth.Tokens

/**
 * A person's role from their GitHub permission (decision 0007 §1 and §9), never with more power over the repository
 * than GitHub gives: admin is Admin, maintain is Maintainer, write is Member, triage and read are Guest, and no
 * permission is no role.
 */
export const roleOf = (permission: Permission): Role | null => {
  switch (permission) {
    case "admin":
      return "admin"
    case "maintain":
      return "maintainer"
    case "write":
      return "member"
    case "triage":
    case "read":
      return "guest"
    case "none":
      return null
  }
}

