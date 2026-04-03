import { db } from "@/db/client"

export type SettingsRow = {
  id: number
  workspace_root: string
  default_agent: string
  smithers_base_url: string
  allow_network: number
  max_concurrency: number
  max_body_bytes: number
  smithers_managed_per_workspace: number
  smithers_auth_mode: string | null
  smithers_auth_token: string | null
  root_dir_policy: string
  diagnostics_log_level: string
  diagnostics_pretty_logs: number
  onboarding_completed: number
  updated_at: string
}

export type UpsertSettingsRowInput = Omit<SettingsRow, "id">

export function findSettingsRow() {
  return db
    .query<SettingsRow, []>(
      `
        SELECT
          id,
          workspace_root,
          default_agent,
          smithers_base_url,
          allow_network,
          max_concurrency,
          max_body_bytes,
          smithers_managed_per_workspace,
          smithers_auth_mode,
          smithers_auth_token,
          root_dir_policy,
          diagnostics_log_level,
          diagnostics_pretty_logs,
          onboarding_completed,
          updated_at
        FROM app_settings
        WHERE id = 1
      `
    )
    .get()
}

export function upsertSettingsRow(input: UpsertSettingsRowInput) {
  db
    .query(
      `
        INSERT INTO app_settings (
          id,
          workspace_root,
          default_agent,
          smithers_base_url,
          allow_network,
          max_concurrency,
          max_body_bytes,
          smithers_managed_per_workspace,
          smithers_auth_mode,
          smithers_auth_token,
          root_dir_policy,
          diagnostics_log_level,
          diagnostics_pretty_logs,
          onboarding_completed,
          updated_at
        ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
          workspace_root = excluded.workspace_root,
          default_agent = excluded.default_agent,
          smithers_base_url = excluded.smithers_base_url,
          allow_network = excluded.allow_network,
          max_concurrency = excluded.max_concurrency,
          max_body_bytes = excluded.max_body_bytes,
          smithers_managed_per_workspace = excluded.smithers_managed_per_workspace,
          smithers_auth_mode = excluded.smithers_auth_mode,
          smithers_auth_token = excluded.smithers_auth_token,
          root_dir_policy = excluded.root_dir_policy,
          diagnostics_log_level = excluded.diagnostics_log_level,
          diagnostics_pretty_logs = excluded.diagnostics_pretty_logs,
          onboarding_completed = excluded.onboarding_completed,
          updated_at = excluded.updated_at
      `
    )
    .run(
      input.workspace_root,
      input.default_agent,
      input.smithers_base_url,
      input.allow_network,
      input.max_concurrency,
      input.max_body_bytes,
      input.smithers_managed_per_workspace,
      input.smithers_auth_mode,
      input.smithers_auth_token,
      input.root_dir_policy,
      input.diagnostics_log_level,
      input.diagnostics_pretty_logs,
      input.onboarding_completed,
      input.updated_at
    )
}

export function clearSettingsRow() {
  db.query(`DELETE FROM app_settings WHERE id = 1`).run()
}
