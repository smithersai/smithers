#!/bin/sh
set -eu
umask 077
die() { printf '%s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"; }
load_database_url() {
  if [ -z "${SMITHERS_DATABASE_URL:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
    SMITHERS_DATABASE_URL=$DATABASE_URL
    export SMITHERS_DATABASE_URL
  fi
  [ -n "${SMITHERS_DATABASE_URL:-}" ] || die "SMITHERS_DATABASE_URL or DATABASE_URL is required"
}
field() {
  file=$1 key=$2
  value=$(sed -n "s/^${key}=//p" "$file")
  [ -n "$value" ] || die "missing ${key} in ${file}"
  case "$value" in *[!A-Za-z0-9._+-]*) die "invalid ${key} in ${file}" ;; esac
  printf '%s\n' "$value"
}
load_release() {
  release_file=${SMITHERS_RELEASE_FILE:-/opt/smithers/version.env}
  [ -f "$release_file" ] || die "distribution version manifest is unavailable: $release_file"
  release_version=$(field "$release_file" SMITHERS_DISTRIBUTION_VERSION)
  release_schema=$(field "$release_file" SMITHERS_SCHEMA_VERSION)
  release_postgres=$(field "$release_file" SMITHERS_POSTGRES_MAJOR)
}
state_file() { printf '%s/version.env\n' "$SMITHERS_DATA_ROOT"; }
write_state() {
  destination=$(state_file); temporary="${destination}.tmp.$$"; umask 077
  { printf 'SMITHERS_DISTRIBUTION_VERSION=%s\n' "$release_version"; printf 'SMITHERS_SCHEMA_VERSION=%s\n' "$release_schema"; printf 'SMITHERS_POSTGRES_MAJOR=%s\n' "$release_postgres"; } >"$temporary"
  sync "$temporary"; mv "$temporary" "$destination"
}
verify_state_matches_release() {
  state=$(state_file); [ -f "$state" ] || die "state version manifest is missing; restore it with the data or initialize an empty installation"
  state_version=$(field "$state" SMITHERS_DISTRIBUTION_VERSION); state_schema=$(field "$state" SMITHERS_SCHEMA_VERSION); state_postgres=$(field "$state" SMITHERS_POSTGRES_MAJOR)
  [ "$state_version" = "$release_version" ] || die "state version ${state_version} requires an explicit upgrade to ${release_version}"
  [ "$state_schema" = "$release_schema" ] || die "state schema ${state_schema} is incompatible with image schema ${release_schema}; restore a verified backup or run the explicit upgrade"
  [ "$state_postgres" = "$release_postgres" ] || die "backup tools require PostgreSQL ${release_postgres}, state declares ${state_postgres}"
}
lock_maintenance() {
  require flock; mkdir -p "$SMITHERS_DATA_ROOT"; chmod 700 "$SMITHERS_DATA_ROOT"
  exec 9>"$SMITHERS_DATA_ROOT/.maintenance.lock"; flock -n 9 || die "Smithers is running; stop the app container before maintenance"
}
sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
verify_backup() {
  backup=$1; [ -d "$backup" ] || die "backup directory does not exist: $backup"
  [ -f "$backup/MANIFEST" ] && [ -f "$backup/postgres.dump" ] && [ -f "$backup/files.tar" ] || die "backup is incomplete"
  [ "$(sha256_file "$backup/postgres.dump")" = "$(field "$backup/MANIFEST" POSTGRES_SHA256)" ] || die "PostgreSQL dump checksum failed"
  [ "$(sha256_file "$backup/files.tar")" = "$(field "$backup/MANIFEST" FILES_SHA256)" ] || die "file archive checksum failed"
  tar -tf "$backup/files.tar" | awk '/(^\/|(^|\/)\.\.($|\/))/ { bad=1 } END { exit bad }' || die "file archive contains an unsafe path"
}
