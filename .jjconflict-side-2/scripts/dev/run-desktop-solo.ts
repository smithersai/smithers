type ManagedProcess = {
  name: string;
  proc: Bun.Subprocess;
};

const repoRoot = process.cwd();
const desktopWebUrl = process.env.BURNS_DESKTOP_WEB_URL?.trim() || "http://localhost:5173";
const apiBaseUrl = process.env.BURNS_API_BASE_URL?.trim() || "http://127.0.0.1:7332";
const sharedEnv = {
  ...process.env,
  BURNS_DESKTOP_WEB_URL: desktopWebUrl,
  BURNS_API_BASE_URL: apiBaseUrl,
};

const managed: ManagedProcess[] = [];
let shuttingDown = false;

function spawnManaged(name: string, cmd: string[]): Bun.Subprocess {
  const proc = Bun.spawn(cmd, {
    cwd: repoRoot,
    env: sharedEnv,
    stdout: "inherit",
    stderr: "inherit",
  });

  managed.push({ name, proc });
  return proc;
}

function terminateAll(exitCode: number): never {
  if (shuttingDown) {
    process.exit(exitCode);
  }

  shuttingDown = true;
  for (const { proc } of managed) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // best-effort shutdown
    }
  }

  process.exit(exitCode);
}

process.on("SIGINT", () => terminateAll(0));
process.on("SIGTERM", () => terminateAll(0));

console.log(`[dev:desktop-solo] web=${desktopWebUrl} api=${apiBaseUrl}`);

spawnManaged("daemon", ["bun", "run", "dev:daemon"]);
spawnManaged("web", ["bun", "run", "dev:web"]);
spawnManaged("desktop", ["bun", "run", "dev:desktop"]);

await Promise.race(
  managed.map(async ({ name, proc }) => {
    const exitCode = await proc.exited;
    if (shuttingDown) {
      return;
    }

    console.error(`[dev:desktop-solo] ${name} exited with code ${exitCode}`);
    terminateAll(exitCode ?? 1);
  }),
);
