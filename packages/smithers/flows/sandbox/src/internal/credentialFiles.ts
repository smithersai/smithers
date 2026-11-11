/**
 * Lists the files in a home directory that hold nothing but credentials.
 *
 * @since 1.0.0
 */

/**
 * Files and directories that hold nothing but credentials, relative to a home
 * directory: git's store, netrc, PyPI, GitHub CLI, Cargo, AWS, Google Cloud,
 * the agent CLIs' sign-ins, and the SSH private keys `ssh` reads by default.
 * A `DirectorySandbox` fork never copies them, and `captureSnapshot` removes
 * them from every home before it captures. Files that mix credentials with
 * configuration, such as `.npmrc` or Docker's `config.json`, are not listed.
 *
 * @category constants
 * @since 1.0.0
 */
export const credentialFiles: ReadonlyArray<string> = [
  ".git-credentials",
  ".netrc",
  ".pypirc",
  ".config/gh/hosts.yml",
  ".cargo/credentials.toml",
  ".aws/credentials",
  ".config/gcloud/application_default_credentials.json",
  ".config/gcloud/credentials.db",
  ".config/gcloud/access_tokens.db",
  ".claude/.credentials.json",
  ".claude.json",
  ".claude.json.backup",
  ".config/anthropic",
  ".codex/auth.json",
  ".gemini/oauth_creds.json",
  ".config/github-copilot/hosts.json",
  ".config/github-copilot/apps.json",
  ".local/share/opencode/auth.json",
  ".ssh/id_rsa",
  ".ssh/id_ecdsa",
  ".ssh/id_ecdsa_sk",
  ".ssh/id_ed25519",
  ".ssh/id_ed25519_sk",
  ".ssh/id_xmss",
  ".ssh/id_dsa"
]
