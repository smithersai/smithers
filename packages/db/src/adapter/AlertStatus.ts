import { DB_ALERT_ALLOWED_STATUSES } from "./DB_ALERT_ALLOWED_STATUSES";

export type AlertStatus = (typeof DB_ALERT_ALLOWED_STATUSES)[number];
