/**
 * The libraries a Mach-O executable loads from outside macOS itself. An
 * installed app can rely only on /System/Library and /usr/lib; anything else
 * (a Homebrew or nvm prefix, a build directory) is absent on a user's Mac.
 */
export const foreignLibraries = (executable: string): ReadonlyArray<string> => {
  const result = Bun.spawnSync(["/usr/bin/otool", "-L", executable], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`otool -L ${executable} failed: ${new TextDecoder().decode(result.stderr).trim()}`)
  }
  const foreign: Array<string> = []
  for (const line of new TextDecoder().decode(result.stdout).trim().split("\n").slice(1)) {
    // Universal binaries repeat the file header for each architecture.
    if (line === `${executable}:` || (line.startsWith(`${executable} (architecture `) && line.endsWith("):"))) continue
    if (line.trim() === "") continue
    const library = line.trim().split(" (compatibility version", 1)[0]
    if (library.startsWith("/System/Library/") || library.startsWith("/usr/lib/")) continue
    foreign.push(library)
  }
  return foreign
}
