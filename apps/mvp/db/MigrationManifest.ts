/** Generated from db/migrations by the parallel workspace landing tool. */
import m0001 from "./migrations/0001_messages.ts"
import m0002 from "./migrations/0002_answer_attempts.ts"
import m0003 from "./migrations/0003_paired_positions.ts"
import m0004 from "./migrations/0004_model_roles.ts"
import m0005 from "./migrations/0005_sign_in.ts"
import m0006 from "./migrations/0006_answer_parts.ts"
import m0007 from "./migrations/0007_repositories.ts"
import m0008 from "./migrations/0008_browser_answering.ts"
import m0009 from "./migrations/0009_clone_ids.ts"
import m0010 from "./migrations/0010_views.ts"
import m0011 from "./migrations/0011_question_askers.ts"
import m0012 from "./migrations/0012_model_reservations.ts"
import m0013 from "./migrations/0013_runs.ts"
import m0014 from "./migrations/0014_branch_workspace.ts"
import m0015 from "./migrations/0015_flows.ts"
import m0016 from "./migrations/0016_github_issues.ts"
import m0017 from "./migrations/0017_model_charges.ts"
import m0018 from "./migrations/0018_triage.ts"
import m0019 from "./migrations/0019_spend_alerts.ts"
import m0020 from "./migrations/0020_notifications.ts"
import m0021 from "./migrations/0021_secrets.ts"
import m0022 from "./migrations/0022_todos.ts"
import m0023 from "./migrations/0023_branch_sharing.ts"
import m0024 from "./migrations/0024_sandbox_calls.ts"
import m0025 from "./migrations/0025_flow_source.ts"
import m0026 from "./migrations/0026_text_updates.ts"
import m0027 from "./migrations/0027_todo_issue.ts"
import m0028 from "./migrations/0028_clone_progress.ts"
import m0029 from "./migrations/0029_alert_channels.ts"
import m0030 from "./migrations/0030_timeline_summary_role.ts"
import m0031 from "./migrations/0031_pulls.ts"
import m0032 from "./migrations/0032_issue_commitment.ts"
import m0033 from "./migrations/0033_pull_writes.ts"
import m0035 from "./migrations/0035_todo_report_receipts.ts"
import m0036 from "./migrations/0036_todo_run.ts"
import m0037 from "./migrations/0037_pull_default_branch.ts"
import m0038 from "./migrations/0038_sandbox_call_start_timeout.ts"
import m0039 from "./migrations/0039_stacked_todos.ts"
import m0040 from "./migrations/0040_flow_draft_deleted.ts"
import m0041 from "./migrations/0041_refs_changed_at.ts"
import m0042 from "./migrations/0042_coding_model_role.ts"
import m0043 from "./migrations/0043_docs_views.ts"
import m0044 from "./migrations/0044_todo_retry.ts"
import m0045 from "./migrations/0045_todo_base_ancestry.ts"
import m0046 from "./migrations/0046_domains.ts"
import m0047 from "./migrations/0047_conversation_people.ts"
import m0048 from "./migrations/0048_github_projection_fences.ts"
import m0049 from "./migrations/0049_triage_write_claims.ts"
import m0050 from "./migrations/0050_drop_merge_unknown.ts"
import m0051 from "./migrations/0051_github_repo_roles.ts"
import m0052 from "./migrations/0052_agent_views.ts"
import m0053 from "./migrations/0053_repo_runs.ts"
import m0054 from "./migrations/0054_message_pins.ts"
import m0055 from "./migrations/0055_branch_ref_namespace.ts"
import m0056 from "./migrations/0056_personal_models.ts"
import m0057 from "./migrations/0057_model_usage_outcome.ts"
import m0058 from "./migrations/0058_hosted_model.ts"
import m0059 from "./migrations/0059_model_quota_failure.ts"
import m0060 from "./migrations/0060_repo_about.ts"
import m0061 from "./migrations/0061_flow_placement_machine.ts"
import m0062 from "./migrations/0062_sandbox_budgets.ts"
import m0063 from "./migrations/0063_app_template_views.ts"
import m0064 from "./migrations/0064_bug_reports.ts"
import m0065 from "./migrations/0065_model_tiers.ts"
import m0066 from "./migrations/0066_timeline_summaries.ts"
import m0067 from "./migrations/0067_bug_report_errors.ts"
import m0068 from "./migrations/0068_branch_publish.ts"
import m0069 from "./migrations/0069_branch_resync.ts"
import m0070 from "./migrations/0070_about_refusal_quota.ts"
import m0071 from "./migrations/0071_branch_write_notices.ts"
import m0072 from "./migrations/0072_role_observations.ts"
import m0073 from "./migrations/0073_feeds.ts"
import m0074 from "./migrations/0074_host_sessions.ts"
import m0075 from "./migrations/0075_model_connections.ts"
import m0076 from "./migrations/0076_merge_flow.ts"
import m0077 from "./migrations/0077_independent_lanes.ts"
import m0078 from "./migrations/0078_agent_runners.ts"
import m0079 from "./migrations/0079_timeline_phases.ts"
import m0080 from "./migrations/0080_timeline_attempts.ts"
import m0081 from "./migrations/0081_todo_crashed.ts"
import m0082 from "./migrations/0082_agent_transcripts.ts"
import m0083 from "./migrations/0083_agent_stops.ts"
import m0084 from "./migrations/0084_fleet.ts"
import m0085 from "./migrations/0085_runner_held.ts"
import m0086 from "./migrations/0086_repo_overflow.ts"
import m0087 from "./migrations/0087_flow_draft_receipts.ts"
import m0088 from "./migrations/0088_work_links.ts"
import m0089 from "./migrations/0089_runner_git_credentials.ts"
import m0090 from "./migrations/0090_github_repo_role_reads.ts"
import m0091 from "./migrations/0091_github_repo_role_read_refusal.ts"
import m0092 from "./migrations/0092_feed_barriers.ts"
import m0093 from "./migrations/0093_session_role_verified.ts"
import m0094 from "./migrations/0094_admin_fences.ts"
import m0095 from "./migrations/0095_runner_reauthorization.ts"
import m0096 from "./migrations/0096_github_repo_role_state.ts"
import m0097 from "./migrations/0097_runner_reconfirmation.ts"
import m0098 from "./migrations/0098_about_claim_generation.ts"
import m0099 from "./migrations/0099_todo_attach.ts"
import m0100 from "./migrations/0100_todo_leaves.ts"
import m0101 from "./migrations/0101_machine_tokens.ts"
import m0102 from "./migrations/0102_repository_visibility_receipt.ts"
import m0103 from "./migrations/0103_notification_access_projection.ts"
import m0104 from "./migrations/0104_visibility_read_claims.ts"
import m0105 from "./migrations/0105_notification_denial_sequence.ts"
import m0106 from "./migrations/0106_machine_write_diagnostics.ts"
import m0107 from "./migrations/0107_notification_emit_projection.ts"
import m0108 from "./migrations/0108_issue_tree.ts"
import m0109 from "./migrations/0109_session_deadlines.ts"
import m0110 from "./migrations/0110_session_signing_keys.ts"
import m0111 from "./migrations/0111_session_reauthentication.ts"
import m0112 from "./migrations/0112_session_tags.ts"
import m0113 from "./migrations/0113_session_ends.ts"
import m0114 from "./migrations/0114_session_key_fingerprints.ts"
import m0115 from "./migrations/0115_compromised_session_keys.ts"
import m0116 from "./migrations/0116_session_seal_fingerprint.ts"
import m0117 from "./migrations/0117_wait_address.ts"
import m0118 from "./migrations/0118_scheduled_runs.ts"
import m0119 from "./migrations/0119_flow_revision_names.ts"
import m0120 from "./migrations/0120_ephemeral_branch_requests.ts"
import m0121 from "./migrations/0121_triage_label_writes.ts"
import m0122 from "./migrations/0122_reconcile_pulls.ts"
import m0123 from "./migrations/0123_personal_credential_nonce.ts"
import m0124 from "./migrations/0124_flow_placement_syntax.ts"
import m0125 from "./migrations/0125_flow_source_limits.ts"

/** Every published migration identity, in ascending apply order. */
export const migrations = {
  "0001_messages": m0001,
  "0002_answer_attempts": m0002,
  "0003_paired_positions": m0003,
  "0004_model_roles": m0004,
  "0005_sign_in": m0005,
  "0006_answer_parts": m0006,
  "0007_repositories": m0007,
  "0008_browser_answering": m0008,
  "0009_clone_ids": m0009,
  "0010_views": m0010,
  "0011_question_askers": m0011,
  "0012_model_reservations": m0012,
  "0013_runs": m0013,
  "0014_branch_workspace": m0014,
  "0015_flows": m0015,
  "0016_github_issues": m0016,
  "0017_model_charges": m0017,
  "0018_triage": m0018,
  "0019_spend_alerts": m0019,
  "0020_notifications": m0020,
  "0021_secrets": m0021,
  "0022_todos": m0022,
  "0023_branch_sharing": m0023,
  "0024_sandbox_calls": m0024,
  "0025_flow_source": m0025,
  "0026_text_updates": m0026,
  "0027_todo_issue": m0027,
  "0028_clone_progress": m0028,
  "0029_alert_channels": m0029,
  "0030_timeline_summary_role": m0030,
  "0031_pulls": m0031,
  "0032_issue_commitment": m0032,
  "0033_pull_writes": m0033,
  "0035_todo_report_receipts": m0035,
  "0036_todo_run": m0036,
  "0037_pull_default_branch": m0037,
  "0038_sandbox_call_start_timeout": m0038,
  "0039_stacked_todos": m0039,
  "0040_flow_draft_deleted": m0040,
  "0041_refs_changed_at": m0041,
  "0042_coding_model_role": m0042,
  "0043_docs_views": m0043,
  "0044_todo_retry": m0044,
  "0045_todo_base_ancestry": m0045,
  "0046_domains": m0046,
  "0047_conversation_people": m0047,
  "0048_github_projection_fences": m0048,
  "0049_triage_write_claims": m0049,
  "0050_drop_merge_unknown": m0050,
  "0051_github_repo_roles": m0051,
  "0052_agent_views": m0052,
  "0053_repo_runs": m0053,
  "0054_message_pins": m0054,
  "0055_branch_ref_namespace": m0055,
  "0056_personal_models": m0056,
  "0057_model_usage_outcome": m0057,
  "0058_hosted_model": m0058,
  "0059_model_quota_failure": m0059,
  "0060_repo_about": m0060,
  "0061_flow_placement_machine": m0061,
  "0062_sandbox_budgets": m0062,
  "0063_app_template_views": m0063,
  "0064_bug_reports": m0064,
  "0065_model_tiers": m0065,
  "0066_timeline_summaries": m0066,
  "0067_bug_report_errors": m0067,
  "0068_branch_publish": m0068,
  "0069_branch_resync": m0069,
  "0070_about_refusal_quota": m0070,
  "0071_branch_write_notices": m0071,
  "0072_role_observations": m0072,
  "0073_feeds": m0073,
  "0074_host_sessions": m0074,
  "0075_model_connections": m0075,
  "0076_merge_flow": m0076,
  "0077_independent_lanes": m0077,
  "0078_agent_runners": m0078,
  "0079_timeline_phases": m0079,
  "0080_timeline_attempts": m0080,
  "0081_todo_crashed": m0081,
  "0082_agent_transcripts": m0082,
  "0083_agent_stops": m0083,
  "0084_fleet": m0084,
  "0085_runner_held": m0085,
  "0086_repo_overflow": m0086,
  "0087_flow_draft_receipts": m0087,
  "0088_work_links": m0088,
  "0089_runner_git_credentials": m0089,
  "0090_github_repo_role_reads": m0090,
  "0091_github_repo_role_read_refusal": m0091,
  "0092_feed_barriers": m0092,
  "0093_session_role_verified": m0093,
  "0094_admin_fences": m0094,
  "0095_runner_reauthorization": m0095,
  "0096_github_repo_role_state": m0096,
  "0097_runner_reconfirmation": m0097,
  "0098_about_claim_generation": m0098,
  "0099_todo_attach": m0099,
  "0100_todo_leaves": m0100,
  "0101_machine_tokens": m0101,
  "0102_repository_visibility_receipt": m0102,
  "0103_notification_access_projection": m0103,
  "0104_visibility_read_claims": m0104,
  "0105_notification_denial_sequence": m0105,
  "0106_machine_write_diagnostics": m0106,
  "0107_notification_emit_projection": m0107,
  "0108_issue_tree": m0108,
  "0109_session_deadlines": m0109,
  "0110_session_signing_keys": m0110,
  "0111_session_reauthentication": m0111,
  "0112_session_tags": m0112,
  "0113_session_ends": m0113,
  "0114_session_key_fingerprints": m0114,
  "0115_compromised_session_keys": m0115,
  "0116_session_seal_fingerprint": m0116,
  "0117_wait_address": m0117,
  "0118_scheduled_runs": m0118,
  "0119_flow_revision_names": m0119,
  "0120_ephemeral_branch_requests": m0120,
  "0121_triage_label_writes": m0121,
  "0122_reconcile_pulls": m0122,
  "0123_personal_credential_nonce": m0123,
  "0124_flow_placement_syntax": m0124,
  "0125_flow_source_limits": m0125,
}
