import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Private D-Bus and real Secret Service: never opens the user's Linux keyring. */
export const isolatedKeyring = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-keyring-"))
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_RUNTIME_DIR: root
  }
  let busPid: number | undefined, keyringPid: number | undefined
  if (process.platform === "linux") {
    const [address, pid] = execFileSync("dbus-daemon", ["--session", "--fork", "--print-address=1", "--print-pid=1"], {
      encoding: "utf8",
      env: environment
    }).trim().split("\n")
    busPid = Number(pid)
    environment.DBUS_SESSION_BUS_ADDRESS = address
    const output = execFileSync("gnome-keyring-daemon", ["--unlock", "--components=secrets"], {
      input: "fixture-password",
      encoding: "utf8",
      env: environment
    })
    for (const line of output.trim().split("\n")) {
      const split = line.indexOf("=")
      if (split > 0) environment[line.slice(0, split)] = line.slice(split + 1)
    }
    if (environment.GNOME_KEYRING_PID) keyringPid = Number(environment.GNOME_KEYRING_PID)
  }
  return {
    environment,
    close: () => {
      if (keyringPid) process.kill(keyringPid, "SIGTERM")
      if (busPid) process.kill(busPid, "SIGTERM")
      rmSync(root, { recursive: true, force: true })
    }
  }
}
