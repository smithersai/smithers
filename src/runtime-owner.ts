export function parseRuntimeOwnerPid(
  runtimeOwnerId: string | null | undefined,
): number | null {
  if (!runtimeOwnerId) return null;
  const trimmed = runtimeOwnerId.trim();
  if (trimmed.length === 0) return null;

  const exact = trimmed.match(/^pid:(\d+)(?::.*)?$/i);
  if (exact) {
    const pid = Number(exact[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  return null;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}
