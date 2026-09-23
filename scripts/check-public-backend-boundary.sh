#!/usr/bin/env bash
set -euo pipefail

# The open-source composition may depend on deployment-neutral ports only. Keep
# provider SDKs and Plue's private topology out of its exported surface.
public_roots=(packages/backend apps/backend)
if matches=$(rg -n --glob '*.go' '"(cloud\.google\.com|github\.com/GoogleCloudPlatform|github\.com/aws/aws-sdk|github\.com/stripe/stripe-go|github\.com/sendgrid|github\.com/ethereum/go-ethereum)' "${public_roots[@]}" 2>/dev/null); then
  printf '%s\n' "$matches" >&2
  echo 'public backend imports a deployment-only SDK' >&2
  exit 1
fi
if matches=$(rg -n --glob '*.go' 'HostedRollout|RoleHostedAPI|RoleHostedWorker|PLUE_CLI_VERSION' packages/backend/app packages/backend/ports apps/backend 2>/dev/null); then
  printf '%s\n' "$matches" >&2
  echo 'public backend API mentions a Plue-only topology concept' >&2
  exit 1
fi
echo 'public backend boundary passed'
