/**
 * What the file system under a directory has free, and how much a directory
 * holds on it: the two numbers a replay keeps the disk from filling by.
 *
 * @since 0.1.0
 */

import { execFile } from "node:child_process"
import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"
import { openPinnedPath } from "./PinnedFile.ts"

/**
 * One gigabyte, as a disk's size is written.
 *
 * @category constants
 * @since 0.1.0
 */
export const gigabyte = 1_000_000_000

/**
 * `bytes` as a person reads a size: `47 GB`, `3.2 GB`, `0.4 GB`.
 *
 * @category rendering
 * @since 0.1.0
 */
export const sizeOf = (bytes: number): string => {
  const gb = Math.max(0, bytes) / gigabyte
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`
}

/**
 * The bytes the file system that holds a path has free for a program of this
 * user, and its size.
 *
 * @category models
 * @since 0.1.0
 */
export interface Space {
  readonly free: number
  readonly total: number
}

/**
 * The free bytes and the size of the file system that holds `path`.
 *
 * @category reading
 * @since 0.1.0
 */
export const spaceOf = async (path: string): Promise<Space> => {
  const found = await NodeFs.statfs(path)
  return { free: found.bavail * found.bsize, total: found.blocks * found.bsize }
}

// Darwin has neither /proc/self/fd nor a directory-relative open in Node. Its system Perl can
// fchdir to an O_NOFOLLOW directory handle. Keep cwd private to the child and reopen each queued
// path from its verified root, holding at most one handle regardless of depth.
const physicalBlocks = `use strict;
use Fcntl qw(O_RDONLY O_NOFOLLOW O_DIRECTORY :mode);
my ($root, $dev, $ino) = @ARGV;
my @pending = ([[$root, $dev, $ino]]);
my %seen;
my $blocks = 0;
DIRECTORY: while (my $path = pop @pending) {
  for my $part (@$path) {
    my ($name, $expected_dev, $expected_ino) = @$part;
    sysopen(my $dir, $name, O_RDONLY | O_NOFOLLOW | O_DIRECTORY) or next DIRECTORY;
    my @info = stat($dir);
    next DIRECTORY unless @info && $info[0] == $expected_dev && $info[1] == $expected_ino;
    chdir($dir) or next DIRECTORY;
  }
  opendir(my $entries, ".") or next;
  while (defined(my $name = readdir($entries))) {
    next if $name eq "." || $name eq "..";
    my @info = lstat($name);
    next unless @info;
    next if $seen{"$info[0]:$info[1]"}++;
    if (S_ISDIR($info[2])) { push @pending, [@$path, [$name, $info[0], $info[1]]]; }
    else { $blocks += $info[12]; }
  }
}
print $blocks;
`

/**
 * The bytes on disk of every file under `path`, each file once however many
 * names it has, links not followed. A file or directory that goes while it is
 * read counts nothing.
 *
 * @category reading
 * @since 0.1.0
 */
export const heldUnder = async (path: string, signal?: AbortSignal, platform = process.platform): Promise<number> => {
  const pathMax = platform === "darwin" ? 1024 : 4096
  const seen = new Set<string>()
  let held = 0
  const inspect = (at: string) => NodeFs.lstat(at, { bigint: true })
  type Directory = { at: string; info: Awaited<ReturnType<typeof inspect>>; parent?: Directory | undefined }
  const pending: Array<Directory> = []
  const openDirectory = async (next: Directory) => {
    // Linux limits a single pathname to 4095 bytes. Reopen a long suffix one component at a time.
    const suffix: Array<Directory> = []
    let prefix = next
    while (prefix.parent && Buffer.byteLength(prefix.at) >= pathMax) {
      suffix.push(prefix)
      prefix = prefix.parent
    }
    let dir = await openPinnedPath(prefix.at, true, platform, prefix.info)
    for (const child of suffix.reverse()) {
      const previous = dir
      try {
        dir = await openPinnedPath(
          NodePath.join(previous.path, NodePath.basename(child.at)),
          true,
          platform,
          child.info
        )
      } finally {
        await previous.close()
      }
    }
    return dir
  }
  const collect = async (source: string, at: string, parent?: Directory) => {
    try {
      const info = await inspect(source)
      const identity = `${info.dev}:${info.ino}`
      if (seen.has(identity)) return
      seen.add(identity)
      if (info.isDirectory()) pending.push({ at, info, parent })
      else held += Number(info.blocks) * 512
    } catch {
      // A name can disappear after readdir.
    }
  }
  await collect(path, path)
  const root = pending[0]
  while (pending.length > 0 && !signal?.aborted) {
    const next = pending.pop()!
    try {
      const directory = await openDirectory(next)
      try {
        for (const name of await NodeFs.readdir(directory.path)) {
          if (signal?.aborted) break
          const child = NodePath.join(directory.path, name)
          if (platform === "darwin" && Buffer.byteLength(child) >= pathMax) {
            // Recount from the root so a hard link inside and outside the long subtree counts once.
            const args = [
              "-e",
              physicalBlocks,
              "--",
              NodePath.resolve(path),
              String(root!.info.dev),
              String(root!.info.ino)
            ]
            return await new Promise<number>((resolve) => {
              execFile(
                "/usr/bin/perl",
                args,
                { env: {}, signal },
                (_error, stdout) => resolve(Math.max(held, Number(stdout) * 512))
              )
            })
          }
          await collect(child, NodePath.join(next.at, name), next)
        }
      } finally {
        await directory.close()
      }
    } catch {
      // A queued directory was replaced or became unreadable.
    }
  }
  return held
}
