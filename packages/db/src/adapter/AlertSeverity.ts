import { DB_ALERT_ALLOWED_SEVERITIES } from "./DB_ALERT_ALLOWED_SEVERITIES";

export type AlertSeverity = (typeof DB_ALERT_ALLOWED_SEVERITIES)[number];
