#!/bin/sh
# shellcheck disable=SC2154
set -eu
# shellcheck disable=SC1090
. "${SMITHERS_LIB:-/opt/smithers/lib.sh}"
[ "$#" -eq 1 ] || die "usage: upgrade.sh VERIFIED_PRE_UPGRADE_BACKUP"
load_database_url
: "${SMITHERS_DATA_ROOT:=/var/lib/smithers}"
export SMITHERS_DATA_ROOT; backup=$1
load_release; lock_maintenance; verify_backup "$backup"; state=$(state_file); [ -f "$state" ] || die "state version manifest is missing"
state_version=$(field "$state" SMITHERS_DISTRIBUTION_VERSION); state_schema=$(field "$state" SMITHERS_SCHEMA_VERSION); state_postgres=$(field "$state" SMITHERS_POSTGRES_MAJOR)
[ "$state_version" = "$(field "$backup/MANIFEST" SMITHERS_DISTRIBUTION_VERSION)" ] && [ "$state_schema" = "$(field "$backup/MANIFEST" SMITHERS_SCHEMA_VERSION)" ] && [ "$state_postgres" = "$(field "$backup/MANIFEST" SMITHERS_POSTGRES_MAJOR)" ] || die "backup does not match the installed pre-upgrade state"
[ "$state_postgres" = "$release_postgres" ] || die "PostgreSQL major upgrades require a separate dump and restore"
case "$state_schema:$release_schema" in *[!0-9:]*) die "schema versions must be numeric" ;; esac
[ "$state_schema" -le "$release_schema" ] || die "schema downgrade from ${state_schema} to ${release_schema} is refused"
[ "$state_version" != "$release_version" ] || die "state already matches image version ${release_version}"
"${SMITHERS_BACKEND_BINARY:-/opt/smithers/bin/smithers-backend}" migrate apply
write_state; printf 'upgraded %s to %s\n' "$state_version" "$release_version"
