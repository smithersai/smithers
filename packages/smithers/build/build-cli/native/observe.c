/*
 * smthrs-observe: records the file-system calls of a command, as `strace -f -y` would write them, without
 * stopping the command's threads.
 *
 *     smthrs-observe [--keep] <trace file> -- <command> [<argument>...]
 *     smthrs-observe --probe
 *     smthrs-observe --rights <program>...
 *     smthrs-observe --reap -- <command> [<argument>...]
 *     smthrs-observe --probe --reap
 *
 * The command runs under a seccomp filter whose listener this program holds. The kernel hands each watched call
 * to one of the supervisor's threads; only the calling thread waits, and the call then goes on in the kernel as
 * the command made it (`SECCOMP_USER_NOTIF_FLAG_CONTINUE`). The supervisor never makes a call for the command.
 *
 * Each line names the call with every path made absolute from the directory the call starts from, read at that
 * stop from `/proc/<thread>/cwd` or `/proc/<thread>/fd/<n>`, and an answer read from the file system just before
 * the call goes on: `fstatat` with `AT_NO_AUTOMOUNT`, which opens nothing, follows nothing the call would not, and
 * never blocks. A path through a link the kernel makes for a process (`/proc/self/cwd`, `/proc/<pid>/fd/<n>`,
 * `/dev/stdin`) is written as the path it leads to for the process that made the call, read at that stop with
 * readlink on `/proc/<process>/...`. What is still under `/proc`, `/dev` or `/sys` after that is the machine's
 * state, not a file of the run: it is never looked at, and a record leaves it out. An answer read just before may
 * only add to what the record holds:
 *
 * - A name counts as made by the run only where this supervisor saw it absent at a stop of this run.
 * - A call that makes a name where the directory it goes in was missing at the stop is looked at again once the call
 *   has surely ended: at the next stop of the same thread, or at the end of the run. Another thread may have made the
 *   directory between the stop and the call (npm makes its cache's directories so, many at once), and the call then
 *   made the name. Where the name is there by then, the line says the call made it; written as missing, the name
 *   would read as one the run found missing and something else made.
 * - Before a call that writes a name that is already there (a rename, a link, a symlink, an exclusive create), a
 *   line notes that the run found it there.
 * - A program a process starts is written with no answer (`= ?`): it counts as looked at and started, and changes
 *   nothing a reader keeps about the process. A second line (`= 0`) follows once `/proc/<process>/cmdline` shows
 *   the program's arguments at a later stop of that process.
 * - A socket counts as bound only once the socket itself says so (`getsockname` on a copy taken at the stop). The
 *   copy is let go as soon as the socket says so, at the next bind or connect of the run, before that call goes
 *   on: held longer, it would keep the port of a socket the run closed in use, and a program that listens on a
 *   port again (a lock made of a port, as eliza's build lock is) would find it taken. A copy whose socket is not
 *   bound yet is asked again then, and at the end of the run.
 *
 * A signal must never cut a call short where it would not unrecorded. A call waiting for this supervisor can be
 * cut short until the call is received (`SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV`), and a process whose handler
 * lacks `SA_RESTART` would then see `EINTR` from a `stat` or a `fork`. So a process that sets such a handler is
 * traced (ptrace, every thread, its children until they start another program). When a signal cuts a watched
 * call short, the signal is kept and the kernel restarts the call; once the restarted call is received the signal
 * is sent again and is delivered, with what it first said, when the call ends (a fork: once it made its process).
 * A traced thread is let go when it starts to end: a traced process that ended is its tracer's to reap first, so its
 * parent, told by the process's pidfd that it ended, could not reap it yet, and tokio's reaper panics then (uv's
 * `pidfd is ready to read, the process should have exited`).
 * A call that waits in the kernel itself (a FIFO, a device) is cut short there as it would be unrecorded. On
 * aarch64 the stop no longer shows the call's answer: a thread stopped at the `svc #0` of a watched call that
 * restarts is taken as cut short there (cutShort).
 *
 * Each line carries the process (the thread group), not the thread: the lines of a process are complete, never
 * interrupted, so a reader needs no thread to pair them.
 *
 * A lookup or an open to read that says again what a line already said is not written: the same process, running
 * the same program, asked for the same path in the same way and had the same answer, and no call of the run has
 * made, removed, moved, linked or changed the rights of a name since. A reader keeps the first time a process
 * found a path or found it missing, so such a line changes nothing it keeps, and a compiler that looks up the
 * same header in each of its search paths a thousand times writes each line once.
 *
 * Lines are written in the order the kernel numbered the calls, after the command and every process it left have
 * ended. The trace starts with `<pid> +++ smthrs-observe 1 +++` and ends with `<pid> +++ complete +++`; a trace
 * without the last line was cut short. A run this program cannot see whole gets a line
 * `<pid> +++ unrecorded: <reason> +++`, and the command still runs untouched. A program the run started whose file
 * asks for rights (set-user-id, set-group-id, file capabilities) gets a line `<pid> +++ rights: <program> +++`: the
 * run has no new privileges, so that program ran without them. `--rights` names which of the programs it is given
 * ask for rights, for a run recorded another way.
 *
 * The command's exit status is this program's. When this program cannot start the command it exits 125, and 126
 * when it cannot record (`--probe` answers 0 where it can, and otherwise says why on standard error).
 *
 * With `--keep` the command is a step of a job whose processes live until the job ends, as on a CI runner: what it
 * leaves running is followed, never killed. When the command ends, the trace of everything so far is written,
 * sealed, and then its exit status to the trace file's name with `.status` added (`<code> <pid>`), which ends the
 * step. The lines of what it left come after, appended to the trace file's name with `.kept` added as they are
 * made, until every process of the run has ended or the job's end kills this program.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/user.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV
#define SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV (1UL << 5)
#endif
#ifndef SECCOMP_USER_NOTIF_FLAG_CONTINUE
#define SECCOMP_USER_NOTIF_FLAG_CONTINUE (1UL << 0)
#endif
#ifndef CLONE_NEWTIME
#define CLONE_NEWTIME 0x00000080
#endif
#ifndef AT_NO_AUTOMOUNT
#define AT_NO_AUTOMOUNT 0x800
#endif
#ifndef AT_EMPTY_PATH
#define AT_EMPTY_PATH 0x1000
#endif
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_pidfd_getfd
#define SYS_pidfd_getfd 438
#endif

#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#define X32_BIT 0x40000000u
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#define X32_BIT 0u
#else
#error "smthrs-observe is built for x86_64 and aarch64 Linux"
#endif

/* ---- What each watched call is ---------------------------------------------------------------------------- */

/* How the supervisor writes a call. */
enum kind {
  K_OPEN,      /* open, openat, openat2, creat: a path, flags */
  K_LOOK,      /* stat, lstat, newfstatat, statx, access, faccessat(2), readlink(at): a path looked at */
  K_EXEC,      /* execve, execveat */
  K_CHDIR,     /* chdir */
  K_MKDIR,     /* mkdir, mkdirat */
  K_REMOVE,    /* unlink, unlinkat, rmdir */
  K_CHANGE,    /* chmod, chown, lchown, utime(s), futimesat, utimensat, truncate, fchmodat(2), fchownat */
  K_CHANGE_FD, /* fchmod, fchown: the descriptor's file */
  K_RENAME,    /* rename, renameat, renameat2 */
  K_LINK,      /* link, linkat */
  K_SYMLINK,   /* symlink, symlinkat */
  K_CONNECT,
  K_BIND,
  K_VIEW,      /* mount, umount2, pivot_root, chroot, setns, move_mount, open_tree, fsmount, fsopen */
  K_SPACE,     /* unshare with a new namespace */
  K_FORK,      /* fork, vfork, clone, clone3: a process (a thread is its process's), or a new namespace */
  K_RING,      /* io_uring_setup */
  K_RING_ENTER,/* io_uring_enter: what the ring is told to do */
  K_HANDLE,    /* open_by_handle_at */
  K_FILTER,    /* seccomp: a filter of the run's own */
  K_HANDLER,   /* rt_sigaction: a handler that lets a signal cut a waiting call short */
};

/* Where a call's arguments are: `dir` is the argument index of a directory descriptor (-1: the working
 * directory), `path` of the path (-1: none); `dir2`/`path2` likewise for a second path; `flags` the index of the
 * flags (-1: none). */
struct call {
  int nr;
  const char *name;
  enum kind kind;
  signed char dir, path, dir2, path2, flags;
  unsigned char nofollow; /* the call does not follow a link at the end of its path */
};

#define CWD -1
#define NONE -1
static const struct call calls[] = {
#ifdef SYS_open
  {SYS_open, "open", K_OPEN, CWD, 0, NONE, NONE, 1, 0},
#endif
  {SYS_openat, "openat", K_OPEN, 0, 1, NONE, NONE, 2, 0},
#ifdef SYS_openat2
  {SYS_openat2, "openat2", K_OPEN, 0, 1, NONE, NONE, NONE, 0},
#endif
#ifdef SYS_creat
  {SYS_creat, "creat", K_OPEN, CWD, 0, NONE, NONE, NONE, 0},
#endif
#ifdef SYS_stat
  {SYS_stat, "stat", K_LOOK, CWD, 0, NONE, NONE, NONE, 0},
#endif
#ifdef SYS_lstat
  {SYS_lstat, "lstat", K_LOOK, CWD, 0, NONE, NONE, NONE, 1},
#endif
#ifdef SYS_newfstatat
  {SYS_newfstatat, "newfstatat", K_LOOK, 0, 1, NONE, NONE, 3, 0},
#endif
#ifdef SYS_statx
  {SYS_statx, "statx", K_LOOK, 0, 1, NONE, NONE, 2, 0},
#endif
#ifdef SYS_access
  {SYS_access, "access", K_LOOK, CWD, 0, NONE, NONE, NONE, 0},
#endif
  {SYS_faccessat, "faccessat", K_LOOK, 0, 1, NONE, NONE, NONE, 0},
#ifdef SYS_faccessat2
  {SYS_faccessat2, "faccessat2", K_LOOK, 0, 1, NONE, NONE, 3, 0},
#endif
#ifdef SYS_readlink
  {SYS_readlink, "readlink", K_LOOK, CWD, 0, NONE, NONE, NONE, 1},
#endif
  {SYS_readlinkat, "readlinkat", K_LOOK, 0, 1, NONE, NONE, NONE, 1},
  {SYS_execve, "execve", K_EXEC, CWD, 0, NONE, NONE, NONE, 0},
  {SYS_execveat, "execveat", K_EXEC, 0, 1, NONE, NONE, 4, 0},
  {SYS_chdir, "chdir", K_CHDIR, CWD, 0, NONE, NONE, NONE, 0},
#ifdef SYS_mkdir
  {SYS_mkdir, "mkdir", K_MKDIR, CWD, 0, NONE, NONE, NONE, 1},
#endif
  {SYS_mkdirat, "mkdirat", K_MKDIR, 0, 1, NONE, NONE, NONE, 1},
#ifdef SYS_unlink
  {SYS_unlink, "unlink", K_REMOVE, CWD, 0, NONE, NONE, NONE, 1},
#endif
#ifdef SYS_rmdir
  {SYS_rmdir, "rmdir", K_REMOVE, CWD, 0, NONE, NONE, NONE, 1},
#endif
  {SYS_unlinkat, "unlinkat", K_REMOVE, 0, 1, NONE, NONE, NONE, 1},
#ifdef SYS_chmod
  {SYS_chmod, "chmod", K_CHANGE, CWD, 0, NONE, NONE, NONE, 0},
#endif
#ifdef SYS_chown
  {SYS_chown, "chown", K_CHANGE, CWD, 0, NONE, NONE, NONE, 0},
#endif
#ifdef SYS_lchown
  {SYS_lchown, "lchown", K_CHANGE, CWD, 0, NONE, NONE, NONE, 1},
#endif
#ifdef SYS_utime
  {SYS_utime, "utime", K_CHANGE, CWD, 0, NONE, NONE, NONE, 0},
#endif
#ifdef SYS_utimes
  {SYS_utimes, "utimes", K_CHANGE, CWD, 0, NONE, NONE, NONE, 0},
#endif
#ifdef SYS_futimesat
  {SYS_futimesat, "futimesat", K_CHANGE, 0, 1, NONE, NONE, NONE, 0},
#endif
  {SYS_utimensat, "utimensat", K_CHANGE, 0, 1, NONE, NONE, 3, 0},
  {SYS_truncate, "truncate", K_CHANGE, CWD, 0, NONE, NONE, NONE, 0},
  {SYS_fchmodat, "fchmodat", K_CHANGE, 0, 1, NONE, NONE, NONE, 0},
#ifdef SYS_fchmodat2
  {SYS_fchmodat2, "fchmodat2", K_CHANGE, 0, 1, NONE, NONE, 3, 0},
#endif
  {SYS_fchownat, "fchownat", K_CHANGE, 0, 1, NONE, NONE, 4, 0},
  {SYS_fchmod, "fchmod", K_CHANGE_FD, 0, NONE, NONE, NONE, NONE, 0},
  {SYS_fchown, "fchown", K_CHANGE_FD, 0, NONE, NONE, NONE, NONE, 0},
#ifdef SYS_rename
  {SYS_rename, "rename", K_RENAME, CWD, 0, CWD, 1, NONE, 1},
#endif
#ifdef SYS_renameat
  {SYS_renameat, "renameat", K_RENAME, 0, 1, 2, 3, NONE, 1},
#endif
  {SYS_renameat2, "renameat2", K_RENAME, 0, 1, 2, 3, 4, 1},
#ifdef SYS_link
  {SYS_link, "link", K_LINK, CWD, 0, CWD, 1, NONE, 1},
#endif
  {SYS_linkat, "linkat", K_LINK, 0, 1, 2, 3, 4, 1},
#ifdef SYS_symlink
  {SYS_symlink, "symlink", K_SYMLINK, NONE, NONE, CWD, 1, NONE, 1},
#endif
  {SYS_symlinkat, "symlinkat", K_SYMLINK, NONE, NONE, 1, 2, NONE, 1},
  {SYS_connect, "connect", K_CONNECT, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_bind, "bind", K_BIND, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_mount, "mount", K_VIEW, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_umount2, "umount2", K_VIEW, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_pivot_root, "pivot_root", K_VIEW, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_chroot, "chroot", K_VIEW, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_setns, "setns", K_VIEW, NONE, NONE, NONE, NONE, NONE, 0},
#ifdef SYS_move_mount
  {SYS_move_mount, "move_mount", K_VIEW, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_open_tree, "open_tree", K_VIEW, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_fsmount, "fsmount", K_VIEW, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_fsopen, "fsopen", K_VIEW, NONE, NONE, NONE, NONE, NONE, 0},
#endif
  {SYS_unshare, "unshare", K_SPACE, NONE, NONE, NONE, NONE, 0, 0},
  {SYS_clone, "clone", K_FORK, NONE, NONE, NONE, NONE, 0, 0},
#ifdef SYS_clone3
  {SYS_clone3, "clone3", K_FORK, NONE, NONE, NONE, NONE, NONE, 0},
#endif
#ifdef SYS_fork
  {SYS_fork, "fork", K_FORK, NONE, NONE, NONE, NONE, NONE, 0},
#endif
#ifdef SYS_vfork
  {SYS_vfork, "vfork", K_FORK, NONE, NONE, NONE, NONE, NONE, 0},
#endif
  {SYS_io_uring_setup, "io_uring_setup", K_RING, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_io_uring_enter, "io_uring_enter", K_RING_ENTER, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_open_by_handle_at, "open_by_handle_at", K_HANDLE, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_seccomp, "seccomp", K_FILTER, NONE, NONE, NONE, NONE, NONE, 0},
  {SYS_rt_sigaction, "rt_sigaction", K_HANDLER, NONE, NONE, NONE, NONE, NONE, 0},
};
#define NCALLS ((int)(sizeof calls / sizeof calls[0]))

#define NEW_NAMESPACES (CLONE_NEWNS | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWUTS | \
                        CLONE_NEWCGROUP | CLONE_NEWTIME)

static const struct call *callOf(int nr) {
  for (int i = 0; i < NCALLS; i++)
    if (calls[i].nr == nr) return &calls[i];
  return NULL;
}

/* ---- The filter ---------------------------------------------------------------------------------------------- */

/*
 * A call of another architecture, or an x32 call, goes to the supervisor, which marks the run unrecorded. `clone`
 * and `unshare` go to it only with a flag that makes a namespace: the filter reads that argument. Every other
 * watched call goes to it always; everything else passes.
 */
static int install(void) {
  struct sock_filter f[16 + 4 * NCALLS];
  int n = 0;
#define S(code, k) (f[n++] = (struct sock_filter)BPF_STMT(code, k))
#define J(code, k, t, e) (f[n++] = (struct sock_filter)BPF_JUMP(code, k, t, e))
  S(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  J(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0);
  S(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
  S(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
  if (X32_BIT != 0) {
    J(BPF_JMP | BPF_JSET | BPF_K, X32_BIT, 0, 1);
    S(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
  }
  for (int i = 0; i < NCALLS; i++) {
    if (calls[i].nr == SYS_unshare) {
      /* The flags' low word holds every namespace flag. */
      J(BPF_JMP | BPF_JEQ | BPF_K, calls[i].nr, 0, 4);
      S(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
      J(BPF_JMP | BPF_JSET | BPF_K, NEW_NAMESPACES, 0, 1);
      S(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
      S(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
      continue;
    }
    if (calls[i].nr == SYS_clone) {
      /* A thread in no new namespace passes: its calls are its process's. A process stops. */
      J(BPF_JMP | BPF_JEQ | BPF_K, calls[i].nr, 0, 5);
      S(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
      J(BPF_JMP | BPF_JSET | BPF_K, NEW_NAMESPACES, 2, 0);
      J(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 0, 1);
      S(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
      S(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
      continue;
    }
    J(BPF_JMP | BPF_JEQ | BPF_K, calls[i].nr, 0, 1);
    S(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
  }
  S(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
#undef S
#undef J
  struct sock_fprog prog = {.len = (unsigned short)n, .filter = f};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER,
                      SECCOMP_FILTER_FLAG_NEW_LISTENER | SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV, &prog);
}

/* ---- Lines ---------------------------------------------------------------------------------------------------- */

struct line {
  uint64_t id;
  uint32_t sub;
  uint32_t length;
  char *text;
};

struct lines {
  struct line *items;
  size_t count, capacity;
};

struct text {
  char *data;
  size_t length, capacity;
  int failed;
};

static void grow(struct text *t, size_t more) {
  if (t->failed || t->length + more + 1 <= t->capacity) return;
  size_t capacity = t->capacity == 0 ? 256 : t->capacity;
  while (capacity < t->length + more + 1) capacity *= 2;
  char *data = realloc(t->data, capacity);
  if (data == NULL) {
    t->failed = 1;
    return;
  }
  t->data = data;
  t->capacity = capacity;
}

static void put(struct text *t, const char *s, size_t n) {
  grow(t, n);
  if (t->failed) return;
  memcpy(t->data + t->length, s, n);
  t->length += n;
  t->data[t->length] = 0;
}

static void puts_(struct text *t, const char *s) { put(t, s, strlen(s)); }

static void printf_(struct text *t, const char *format, ...) {
  char small[512];
  va_list v;
  va_start(v, format);
  int n = vsnprintf(small, sizeof small, format, v);
  va_end(v);
  if (n < 0) return;
  if ((size_t)n < sizeof small) {
    put(t, small, (size_t)n);
    return;
  }
  grow(t, (size_t)n);
  if (t->failed) return;
  va_start(v, format);
  vsnprintf(t->data + t->length, (size_t)n + 1, format, v);
  va_end(v);
  t->length += (size_t)n;
}

/* A string as strace writes it with `-s` larger than the string: printable ASCII as it is, `"` and `\` escaped,
 * the usual control escapes, and every other byte as `\xHH`. */
/*
 * Writes the inside of a quoted string as strace writes it: `"`, `\` and every byte that is not printable ASCII
 * escaped. With `angled`, `<` and `>` too, as strace -y writes the path of a descriptor between them: a directory
 * named with a newline (click's tests make one) would otherwise end the line.
 */
static void escaped(struct text *t, const char *s, size_t n, int angled) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    char e[5];
    switch (c) {
      case '"': put(t, "\\\"", 2); continue;
      case '\\': put(t, "\\\\", 2); continue;
      case '\n': put(t, "\\n", 2); continue;
      case '\t': put(t, "\\t", 2); continue;
      case '\r': put(t, "\\r", 2); continue;
      case '\v': put(t, "\\v", 2); continue;
      case '\f': put(t, "\\f", 2); continue;
      default: break;
    }
    if (c >= 0x20 && c < 0x7f && !(angled && (c == '<' || c == '>'))) {
      put(t, (const char *)&c, 1);
    } else {
      snprintf(e, sizeof e, "\\x%02x", c);
      put(t, e, 4);
    }
  }
}

static void quoted(struct text *t, const char *s, size_t n) {
  put(t, "\"", 1);
  escaped(t, s, n, 0);
  put(t, "\"", 1);
}

static void quotedz(struct text *t, const char *s) { quoted(t, s, strlen(s)); }

/* A descriptor's path, as strace -y writes it: `<path>`. */
static void angledz(struct text *t, const char *s) {
  put(t, "<", 1);
  escaped(t, s, strlen(s), 1);
  put(t, ">", 1);
}

/* ---- State shared by the serving threads ------------------------------------------------------------------- */

static int listener = -1;
static int stopping;
static pid_t rootPid;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static struct lines all;
static int dropped;

/* Reasons the run cannot be recorded, each once. */
static char *reasons[16];
static int reasonCount;

static void unrecorded(const char *reason) {
  pthread_mutex_lock(&lock);
  for (int i = 0; i < reasonCount; i++)
    if (strcmp(reasons[i], reason) == 0) {
      pthread_mutex_unlock(&lock);
      return;
    }
  if (reasonCount < 16) reasons[reasonCount++] = strdup(reason);
  pthread_mutex_unlock(&lock);
}

/*
 * Programs the run started whose file asks for rights a process with no new privileges never gets: set-user-id,
 * set-group-id, or file capabilities (`security.capability`). This program sets no new privileges for the run, so
 * each one ran without what its file asks for, as it would not on a CI runner. The mount the file is on is not
 * asked: a jail that holds this program mounts every path `nosuid` itself.
 */
static char *rightsNeeded[16];
static int rightsCount;

/* Whether a program's file asks for rights: 1 when it does, 0 when not or when it cannot be looked at. */
static int asksRights(const char *program) {
  struct stat st;
  if (stat(program, &st) != 0 || !S_ISREG(st.st_mode)) return 0;
  if (st.st_mode & (S_ISUID | S_ISGID)) return 1;
  return getxattr(program, "security.capability", NULL, 0) > 0;
}

static void rights(const char *program) {
  if (!asksRights(program)) return;
  pthread_mutex_lock(&lock);
  for (int i = 0; i < rightsCount; i++)
    if (strcmp(rightsNeeded[i], program) == 0) {
      pthread_mutex_unlock(&lock);
      return;
    }
  if (rightsCount < 16) rightsNeeded[rightsCount++] = strdup(program);
  pthread_mutex_unlock(&lock);
}

/* Keeps a line; answers its place among the lines, or -1 when it could not be kept. */
static long keep(uint64_t id, uint32_t sub, struct text *t) {
  if (t->failed) {
    __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
    free(t->data);
    return -1;
  }
  pthread_mutex_lock(&lock);
  if (all.count == all.capacity) {
    size_t capacity = all.capacity == 0 ? 65536 : all.capacity * 2;
    struct line *items = realloc(all.items, capacity * sizeof *items);
    if (items == NULL) {
      dropped = 1;
      pthread_mutex_unlock(&lock);
      free(t->data);
      return -1;
    }
    all.items = items;
    all.capacity = capacity;
  }
  long place = (long)all.count;
  all.items[all.count++] = (struct line){id, sub, (uint32_t)t->length, t->data};
  pthread_mutex_unlock(&lock);
  return place;
}

/* A thread's process. A thread id is not given again while the thread lives, and the run's threads live while
 * they make calls, so a thread id read once stands for its process for the run. */
#define TGIDS 8192
static struct {
  pid_t tid, tgid;
} tgids[TGIDS];

static void bornOf(pid_t tgid, pid_t parent);

static pid_t tgidOf(pid_t tid) {
  unsigned slot = (unsigned)tid % TGIDS;
  pthread_mutex_lock(&lock);
  for (unsigned i = 0; i < 16; i++) {
    unsigned at = (slot + i) % TGIDS;
    if (tgids[at].tid == tid) {
      pid_t tgid = tgids[at].tgid;
      pthread_mutex_unlock(&lock);
      return tgid;
    }
    if (tgids[at].tid == 0) break;
  }
  pthread_mutex_unlock(&lock);
  char name[64], buffer[1024];
  snprintf(name, sizeof name, "/proc/%d/status", tid);
  int fd = open(name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return tid;
  ssize_t n = read(fd, buffer, sizeof buffer - 1);
  close(fd);
  if (n <= 0) return tid;
  buffer[n] = 0;
  char *at = strstr(buffer, "\nTgid:");
  pid_t tgid = at == NULL ? tid : (pid_t)strtol(at + 6, NULL, 10);
  char *parentAt = strstr(buffer, "\nPPid:");
  if (tgid == tid && parentAt != NULL) bornOf(tgid, (pid_t)strtol(parentAt + 6, NULL, 10));
  pthread_mutex_lock(&lock);
  for (unsigned i = 0; i < 16; i++) {
    unsigned place = (slot + i) % TGIDS;
    if (tgids[place].tid == 0 || tgids[place].tid == tid) {
      tgids[place].tid = tid;
      tgids[place].tgid = tgid;
      break;
    }
  }
  pthread_mutex_unlock(&lock);
  return tgid;
}

/* A program a process was told to start, until a later stop of the process shows it running. */
struct starting {
  pid_t tgid, tid;
  uint64_t id;
  char *argv;   /* the arguments, each ended by a zero byte, as /proc/<pid>/cmdline holds them */
  size_t argvLength;
  char *script; /* the path as the call gave it, then the arguments after the first: what follows an interpreter */
  size_t scriptLength;
  char *line;   /* the line that says it started */
  struct starting *next;
};
static struct starting *startings;

/* A process a process started and that has not been seen yet: where the call was, and how many programs its
 * parent had been told to start by then. */
struct forking {
  pid_t parent;
  uint64_t id;
  unsigned generation;
  struct forking *next;
};
static struct forking *forkings;

/* How many programs each process has been told to start. */
#define GENERATIONS 8192
static struct {
  pid_t tgid;
  unsigned count;
} generations[GENERATIONS];

static unsigned *generationOf(pid_t tgid) {
  unsigned slot = (unsigned)tgid % GENERATIONS;
  for (unsigned i = 0; i < 64; i++) {
    unsigned at = (slot + i) % GENERATIONS;
    if (generations[at].tgid == tgid) return &generations[at].count;
    if (generations[at].tgid == 0) {
      generations[at].tgid = tgid;
      return &generations[at].count;
    }
  }
  return NULL;
}

/* Calls that make, remove, move, link a name or change its rights: a lookup after one may be answered otherwise. */
static unsigned long namesChanged;

/* A lookup or an open to read already written: by which process and program, how, and what it was told. */
struct asked {
  struct asked *next;
  pid_t tgid;
  unsigned generation;
  unsigned long changed;
  int error;
  uint64_t how;
  char path[];
};
#define ASKED_BUCKETS 65536
#define ASKED_MOST 1000000
static struct asked *asked[ASKED_BUCKETS];
static unsigned askedCount;
static pthread_mutex_t askedLock = PTHREAD_MUTEX_INITIALIZER;

/*
 * Whether a line with this answer would say again what a line already said: the same process, running the same
 * program, asked for `path` the same way (`how`) and had the same answer, and no name changed since. Notes the
 * question otherwise, so the next one that says the same is not written.
 */
static int askedAgain(pid_t tgid, uint64_t how, const char *path, int error) {
  unsigned *generation = generationOf(tgid);
  if (generation == NULL) return 0;
  unsigned long changed = __atomic_load_n(&namesChanged, __ATOMIC_ACQUIRE);
  uint64_t hash = 1469598103934665603ull ^ (uint64_t)tgid ^ (how << 32);
  for (const char *at = path; *at != 0; at++) hash = (hash ^ (unsigned char)*at) * 1099511628211ull;
  struct asked **bucket = &asked[hash % ASKED_BUCKETS];
  int again = 0;
  pthread_mutex_lock(&askedLock);
  struct asked *found = *bucket;
  while (found != NULL && !(found->tgid == tgid && found->how == how && strcmp(found->path, path) == 0)) {
    found = found->next;
  }
  if (found != NULL) {
    again = found->generation == *generation && found->changed == changed && found->error == error;
    found->generation = *generation;
    found->changed = changed;
    found->error = error;
  } else if (askedCount < ASKED_MOST) {
    size_t length = strlen(path) + 1;
    struct asked *made = malloc(sizeof *made + length);
    if (made != NULL) {
      *made = (struct asked){*bucket, tgid, *generation, changed, error, how};
      memcpy(made->path, path, length);
      *bucket = made;
      askedCount++;
    }
  }
  pthread_mutex_unlock(&askedLock);
  return again;
}

/* A socket a process asked to bind, with a copy of it, until the socket says it is bound or the run ends. */
struct binding {
  uint64_t id;
  int copy;
  struct sockaddr_storage asked;
  socklen_t askedLength;
  char *line;
  struct binding *next;
};
static struct binding *bindings;
static void settleBindings(void);

/* ---- Reading the stopped thread ------------------------------------------------------------------------------ */

/* A zero-ended string at `address` in the thread's memory; 0 when it cannot be read. */
static int stringAt(pid_t tid, uint64_t address, char *out, size_t capacity) {
  size_t got = 0;
  if (address == 0) return 0;
  while (got < capacity - 1) {
    size_t page = 4096 - ((address + got) & 4095);
    size_t want = page < capacity - 1 - got ? page : capacity - 1 - got;
    struct iovec local = {out + got, want}, remote = {(void *)(uintptr_t)(address + got), want};
    ssize_t n = process_vm_readv(tid, &local, 1, &remote, 1, 0);
    if (n <= 0) return 0;
    if (memchr(out + got, 0, (size_t)n) != NULL) return 1;
    got += (size_t)n;
  }
  return 0; /* longer than any path */
}

static int bytesAt(pid_t tid, uint64_t address, void *out, size_t length) {
  struct iovec local = {out, length}, remote = {(void *)(uintptr_t)address, length};
  return process_vm_readv(tid, &local, 1, &remote, 1, 0) == (ssize_t)length;
}

/* Where a directory descriptor (or the working directory, for AT_FDCWD) of the thread is. 0 when it has none. */
static int placeOf(pid_t tid, int fd, char *out, size_t capacity) {
  char link[64];
  if (fd == AT_FDCWD)
    snprintf(link, sizeof link, "/proc/%d/cwd", tid);
  else
    snprintf(link, sizeof link, "/proc/%d/fd/%d", tid, fd);
  ssize_t n = readlink(link, out, capacity - 1);
  if (n <= 0) return 0;
  out[n] = 0;
  return 1;
}

/* The next part of a path from `*at`, past slashes and `.` parts: `*at` moves to its start, and its length is
 * answered (0 at the end). */
static size_t partOf(const char **at) {
  for (;;) {
    while (**at == '/') (*at)++;
    if ((*at)[0] == '.' && ((*at)[1] == '/' || (*at)[1] == 0)) {
      (*at)++;
      continue;
    }
    return strcspn(*at, "/");
  }
}

static int partIs(const char *part, size_t length, const char *word) {
  return strlen(word) == length && strncmp(part, word, length) == 0;
}

/* A part that is a decimal number below a billion, as a process id or a descriptor is. */
static int numberOf(const char *part, size_t length, long *out) {
  if (length == 0 || length > 9) return 0;
  long value = 0;
  for (size_t i = 0; i < length; i++) {
    if (part[i] < '0' || part[i] > '9') return 0;
    value = value * 10 + (part[i] - '0');
  }
  *out = value;
  return 1;
}

/*
 * A path through a link the kernel makes for a process leads where that link leads for the process that made the
 * call: `/proc/self`, `/proc/thread-self` or `/proc/<pid>`, also under `task/<tid>`, then `root`, `cwd`, `exe` or
 * `fd/<n>`; and `/dev/fd/<n>`, `/dev/stdin`, `/dev/stdout` and `/dev/stderr`, which are `/proc/self/fd/<n>`. The
 * link is read here, at the stop, with readlink on `/proc/<process>/...`: nothing the run named is opened or
 * followed. The rest of the path goes on from where the link leads, so the line names the file the call reaches.
 * A link that leads to no file of the run (a pipe, a socket, a descriptor not open) leaves the path as it was,
 * under `/proc` or `/dev`, where no record looks. Answers 0 with `why` set when the path cannot be followed so: it
 * goes back up (`..`) inside `/proc` or `/dev`, or its link leads to a file that was removed.
 */
static int stepView(pid_t tid, char *path, size_t capacity, const char **why) {
  for (int hop = 0; hop < 40; hop++) {
    const char *at = path;
    size_t n = partOf(&at);
    long process = -1, thread = -1, fd = -1;
    const char *name = "fd";
    if (!partIs(at, n, "dev") && !partIs(at, n, "proc")) return 1;
    pid_t tgid = tgidOf(tid);
    if (partIs(at, n, "dev")) {
      at += n;
      n = partOf(&at);
      if (partIs(at, n, "..")) break;
      if (partIs(at, n, "fd")) {
        at += n;
        n = partOf(&at);
        if (partIs(at, n, "..")) break;
        if (!numberOf(at, n, &fd)) return 1;
      } else if (partIs(at, n, "stdin")) {
        fd = 0;
      } else if (partIs(at, n, "stdout")) {
        fd = 1;
      } else if (partIs(at, n, "stderr")) {
        fd = 2;
      } else {
        return 1;
      }
      at += n;
      process = tgid;
    } else if (partIs(at, n, "proc")) {
      at += n;
      n = partOf(&at);
      if (partIs(at, n, "self")) {
        process = tgid;
      } else if (partIs(at, n, "thread-self")) {
        process = tgid;
        thread = tid;
      } else if (partIs(at, n, "..")) {
        break;
      } else if (!numberOf(at, n, &process)) {
        return 1;
      }
      at += n;
      n = partOf(&at);
      if (thread < 0 && partIs(at, n, "task")) {
        at += n;
        n = partOf(&at);
        if (partIs(at, n, "..")) break;
        if (!numberOf(at, n, &thread)) return 1;
        at += n;
        n = partOf(&at);
      }
      if (partIs(at, n, "root") || partIs(at, n, "cwd") || partIs(at, n, "exe")) {
        name = partIs(at, n, "root") ? "root" : partIs(at, n, "cwd") ? "cwd" : "exe";
        at += n;
      } else if (partIs(at, n, "fd")) {
        at += n;
        n = partOf(&at);
        if (partIs(at, n, "..")) break;
        if (!numberOf(at, n, &fd)) return 1;
        at += n;
      } else if (partIs(at, n, "..")) {
        break;
      } else {
        return 1; /* what the process is, not a file it reaches */
      }
    } else {
      return 1;
    }
    char link[96], target[PATH_MAX + 1], rest[PATH_MAX + 1];
    if (thread >= 0 && fd >= 0)
      snprintf(link, sizeof link, "/proc/%ld/task/%ld/fd/%ld", process, thread, fd);
    else if (thread >= 0)
      snprintf(link, sizeof link, "/proc/%ld/task/%ld/%s", process, thread, name);
    else if (fd >= 0)
      snprintf(link, sizeof link, "/proc/%ld/fd/%ld", process, fd);
    else
      snprintf(link, sizeof link, "/proc/%ld/%s", process, name);
    ssize_t got = readlink(link, target, sizeof target - 1);
    /* No such process or descriptor: the call fails as the kernel answers it, and reads nothing. */
    if (got <= 0) return 1;
    target[got] = 0;
    /* A pipe, a socket, an anonymous file the run made in memory: no file of the run. */
    if (target[0] != '/' || strncmp(target, "/memfd:", 7) == 0) return 1;
    if (got > 10 && strcmp(target + got - 10, " (deleted)") == 0) {
      *why = "removed";
      return 0;
    }
    snprintf(rest, sizeof rest, "%s", at);
    size_t length = strlen(target);
    const char *more = rest;
    /* The link leads to a path with no link in it, so a `..` right after it goes up from there. Where that leads
     * back into /proc or /dev, the next round follows it again. */
    for (size_t part = partOf(&more); partIs(more, part, ".."); part = partOf(&more)) {
      while (length > 1 && target[length - 1] != '/') length--;
      if (length > 1) length--;
      target[length] = 0;
      more += part;
    }
    if (*more == 0)
      snprintf(path, capacity, "%s", target);
    else if (length == 1)
      snprintf(path, capacity, "/%s", more);
    else
      snprintf(path, capacity, "%s/%s", target, more);
  }
  *why = "up";
  return 0;
}

/* A path a call names, made absolute from the directory it starts from, and followed in the caller's view through
 * any link the kernel makes for a process (stepView). `*empty` is set for an empty path, which names the
 * descriptor itself. Answers 0 with `why` when the path cannot be known. */
static int pathOf(pid_t tid, const struct seccomp_notif *req, int dirIndex, int pathIndex, char *out,
                  size_t capacity, const char **why) {
  char path[PATH_MAX + 1], base[PATH_MAX + 1];
  if (!stringAt(tid, req->data.args[pathIndex], path, sizeof path)) {
    *why = "address";
    return 0;
  }
  if (path[0] == '/') {
    snprintf(out, capacity, "%s", path);
    return stepView(tid, out, capacity, why);
  }
  int fd = dirIndex == CWD ? AT_FDCWD : (int)req->data.args[dirIndex];
  if (!placeOf(tid, fd, base, sizeof base) || base[0] != '/') {
    *why = "base";
    return 0;
  }
  if (path[0] == 0)
    snprintf(out, capacity, "%s", base);
  else if (strcmp(base, "/") == 0)
    snprintf(out, capacity, "/%s", path);
  else
    snprintf(out, capacity, "%s/%s", base, path);
  return stepView(tid, out, capacity, why);
}

static int pseudo(const char *path) {
  return strncmp(path, "/proc", 5) == 0 && (path[5] == 0 || path[5] == '/') ? 1
       : strncmp(path, "/dev", 4) == 0 && (path[4] == 0 || path[4] == '/')  ? 1
       : strncmp(path, "/sys", 4) == 0 && (path[4] == 0 || path[4] == '/')  ? 1
                                                                            : 0;
}

/* What is at a path just before the call: 0 when something is, or the error a look finds. Nothing under /proc,
 * /dev or /sys is looked at. */
static int lookKind(const char *path, int nofollow, int *directory) {
  if (directory != NULL) *directory = 0;
  if (pseudo(path)) return 0;
  struct stat st;
  if (fstatat(AT_FDCWD, path, &st, AT_NO_AUTOMOUNT | (nofollow ? AT_SYMLINK_NOFOLLOW : 0)) == 0) {
    if (directory != NULL) *directory = S_ISDIR(st.st_mode);
    return 0;
  }
  return errno;
}

static int look(const char *path, int nofollow) { return lookKind(path, nofollow, NULL); }

/*
 * What the kernel answers a call that makes the name `path` where nothing is: 0 when the directory the name goes in
 * is there. A name written with a slash at its end (`dir/`, as uv writes each directory of a package it unpacks) is
 * the name before the slash, and only a directory can be made there: a call that makes anything else gets `refusal`,
 * as it does from the kernel.
 */
static int parentThere(const char *path, int directory, int refusal) {
  char parent[PATH_MAX + 1];
  snprintf(parent, sizeof parent, "%s", path);
  size_t length = strlen(parent);
  while (length > 1 && parent[length - 1] == '/') parent[--length] = 0;
  if (length < strlen(path) && !directory) return refusal;
  char *slash = strrchr(parent, '/');
  if (slash == NULL) return 1;
  if (slash == parent) return 1;
  *slash = 0;
  return look(parent, 0);
}

static const char *errnoName(int error) {
  switch (error) {
    case EPERM: return "EPERM";
    case ENOENT: return "ENOENT";
    case ESRCH: return "ESRCH";
    case EINTR: return "EINTR";
    case EIO: return "EIO";
    case ENXIO: return "ENXIO";
    case E2BIG: return "E2BIG";
    case ENOEXEC: return "ENOEXEC";
    case EBADF: return "EBADF";
    case ECHILD: return "ECHILD";
    case EAGAIN: return "EAGAIN";
    case ENOMEM: return "ENOMEM";
    case EACCES: return "EACCES";
    case EFAULT: return "EFAULT";
    case EBUSY: return "EBUSY";
    case EEXIST: return "EEXIST";
    case EXDEV: return "EXDEV";
    case ENODEV: return "ENODEV";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case EINVAL: return "EINVAL";
    case ENFILE: return "ENFILE";
    case EMFILE: return "EMFILE";
    case ENOTTY: return "ENOTTY";
    case ETXTBSY: return "ETXTBSY";
    case EFBIG: return "EFBIG";
    case ENOSPC: return "ENOSPC";
    case ESPIPE: return "ESPIPE";
    case EROFS: return "EROFS";
    case EMLINK: return "EMLINK";
    case EPIPE: return "EPIPE";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENOSYS: return "ENOSYS";
    case ENOTEMPTY: return "ENOTEMPTY";
    case ELOOP: return "ELOOP";
    case EOVERFLOW: return "EOVERFLOW";
    case ENOTSOCK: return "ENOTSOCK";
    case EDESTADDRREQ: return "EDESTADDRREQ";
    case EPROTOTYPE: return "EPROTOTYPE";
    case EAFNOSUPPORT: return "EAFNOSUPPORT";
    case EADDRINUSE: return "EADDRINUSE";
    case EADDRNOTAVAIL: return "EADDRNOTAVAIL";
    case ENETDOWN: return "ENETDOWN";
    case ENETUNREACH: return "ENETUNREACH";
    case ECONNABORTED: return "ECONNABORTED";
    case ECONNRESET: return "ECONNRESET";
    case ENOBUFS: return "ENOBUFS";
    case EISCONN: return "EISCONN";
    case ENOTCONN: return "ENOTCONN";
    case ETIMEDOUT: return "ETIMEDOUT";
    case ECONNREFUSED: return "ECONNREFUSED";
    case EHOSTUNREACH: return "EHOSTUNREACH";
    case EALREADY: return "EALREADY";
    case EINPROGRESS: return "EINPROGRESS";
    case EDQUOT: return "EDQUOT";
    case ESTALE: return "ESTALE";
    case EOPNOTSUPP: return "EOPNOTSUPP";
    default: return "EIO";
  }
}

static void answer(struct text *t, int error) {
  if (error == 0) {
    puts_(t, " = 0");
    return;
  }
  printf_(t, " = -1 %s (%s)", errnoName(error), strerror(error));
}

/* A call that makes a name, answered before it ran that the directory the name goes in is missing: its line, where
 * the answer starts in it, and the name. */
struct made {
  pid_t tid;
  size_t place, at;
  char *name;
  struct made *next;
};
#define MADE_BUCKETS 1024
static struct made *madeAfter[MADE_BUCKETS];
static pthread_mutex_t making = PTHREAD_MUTEX_INITIALIZER;

/* Answers a call that makes `name`, and notes where the answer starts when the name was missing and so was its
 * directory: the answer may be wrong by the time the call runs (madeYet). */
static void answerMaking(struct text *t, int error, int missing, const char *name, const char **made, size_t *at) {
  if (missing && (error == ENOENT || error == ENOTDIR)) {
    *made = name;
    *at = t->length;
  }
  answer(t, error);
}

static void awaitMade(pid_t tid, long place, size_t at, const char *name) {
  if (place < 0) return;
  struct made *m = malloc(sizeof *m);
  if (m == NULL) return;
  m->name = strdup(name);
  if (m->name == NULL) {
    free(m);
    return;
  }
  m->tid = tid;
  m->place = (size_t)place;
  m->at = at;
  pthread_mutex_lock(&making);
  struct made **bucket = &madeAfter[(unsigned)tid % MADE_BUCKETS];
  m->next = *bucket;
  *bucket = m;
  pthread_mutex_unlock(&making);
}

/* The call has ended: where its name is there now, the call made it. */
static void madeYet(struct made *m) {
  if (look(m->name, 1) == 0) {
    pthread_mutex_lock(&lock);
    struct line *l = &all.items[m->place];
    char *text = m->at <= l->length ? realloc(l->text, m->at + 4) : NULL;
    if (text != NULL) {
      memcpy(text + m->at, " = 0", 4);
      l->text = text;
      l->length = (uint32_t)(m->at + 4);
    }
    pthread_mutex_unlock(&lock);
  }
  free(m->name);
  free(m);
}

/* A thread stopped again, so its last call ended. With `tid` 0, the run ended, and every call did. */
static void settleMade(pid_t tid) {
  struct made *ended = NULL;
  pthread_mutex_lock(&making);
  for (unsigned b = tid == 0 ? 0 : (unsigned)tid % MADE_BUCKETS; b < MADE_BUCKETS; b++) {
    for (struct made **at = &madeAfter[b]; *at != NULL;) {
      struct made *m = *at;
      if (tid != 0 && m->tid != tid) {
        at = &m->next;
        continue;
      }
      *at = m->next;
      m->next = ended;
      ended = m;
    }
    if (tid != 0) break;
  }
  pthread_mutex_unlock(&making);
  while (ended != NULL) {
    struct made *next = ended->next;
    madeYet(ended);
    ended = next;
  }
}

static void begin(struct text *t, pid_t tgid, const char *name) { printf_(t, "%d %s(", tgid, name); }

/* A line that says the run found a path there: a lookup that does not follow a link at its end. */
static void found(pid_t tgid, uint64_t id, uint32_t sub, const char *path) {
  struct text t = {0};
  begin(&t, tgid, "newfstatat");
  puts_(&t, "AT_FDCWD, ");
  quotedz(&t, path);
  puts_(&t, ", {...}, AT_SYMLINK_NOFOLLOW) = 0");
  keep(id, sub, &t);
}

static void openFlags(struct text *t, uint64_t flags) {
  int mode = (int)(flags & O_ACCMODE);
  puts_(t, mode == O_WRONLY ? "O_WRONLY" : mode == O_RDWR ? "O_RDWR" : "O_RDONLY");
  if (flags & O_CREAT) puts_(t, "|O_CREAT");
  if (flags & O_EXCL) puts_(t, "|O_EXCL");
  if (flags & O_TRUNC) puts_(t, "|O_TRUNC");
  if (flags & O_APPEND) puts_(t, "|O_APPEND");
  if (flags & O_DIRECTORY) puts_(t, "|O_DIRECTORY");
  if (flags & O_NOFOLLOW) puts_(t, "|O_NOFOLLOW");
  if ((flags & O_TMPFILE) == O_TMPFILE) puts_(t, "|O_TMPFILE");
  if (flags & O_PATH) puts_(t, "|O_PATH");
}

/* An address as strace writes it, for the families a reader asks about. */
static void socketAddress(struct text *t, const struct sockaddr_storage *a, socklen_t length) {
  if (a->ss_family == AF_UNIX) {
    const struct sockaddr_un *u = (const struct sockaddr_un *)a;
    size_t n = length > offsetof(struct sockaddr_un, sun_path) ? length - offsetof(struct sockaddr_un, sun_path) : 0;
    if (n > sizeof u->sun_path) n = sizeof u->sun_path;
    puts_(t, "{sa_family=AF_UNIX, sun_path=");
    if (n > 0 && u->sun_path[0] == 0) {
      puts_(t, "@");
      quoted(t, u->sun_path + 1, n - 1);
    } else {
      quoted(t, u->sun_path, strnlen(u->sun_path, n));
    }
    puts_(t, "}");
  } else if (a->ss_family == AF_INET) {
    const struct sockaddr_in *i = (const struct sockaddr_in *)a;
    char host[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &i->sin_addr, host, sizeof host);
    printf_(t, "{sa_family=AF_INET, sin_port=htons(%u), sin_addr=inet_addr(\"%s\")}", ntohs(i->sin_port), host);
  } else if (a->ss_family == AF_INET6) {
    const struct sockaddr_in6 *i = (const struct sockaddr_in6 *)a;
    char host[INET6_ADDRSTRLEN];
    inet_ntop(AF_INET6, &i->sin6_addr, host, sizeof host);
    printf_(t, "{sa_family=AF_INET6, sin6_port=htons(%u), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, \"%s\", "
               "&sin6_addr), sin6_scope_id=0}",
            ntohs(i->sin6_port), host);
  } else {
    printf_(t, "{sa_family=%u}", (unsigned)a->ss_family);
  }
}

/* Whether a program of the run's network namespace listens on a loopback port: the tables the kernel keeps. */
static int listening(pid_t tid, unsigned port) {
  static const char *tables[] = {"tcp", "tcp6", "udp", "udp6"};
  for (int i = 0; i < 4; i++) {
    char name[64], row[512];
    snprintf(name, sizeof name, "/proc/%d/net/%s", tid, tables[i]);
    FILE *f = fopen(name, "re");
    if (f == NULL) return 1; /* cannot tell: something may be there */
    while (fgets(row, sizeof row, f) != NULL) {
      char *colon = strchr(row, ':');
      if (colon == NULL) continue;
      colon = strchr(colon + 1, ':'); /* local address ends at its port */
      if (colon == NULL) continue;
      unsigned local = (unsigned)strtoul(colon + 1, NULL, 16);
      if (local == port) {
        fclose(f);
        return 1;
      }
    }
    fclose(f);
  }
  return 0;
}

static int loopbackAddress(const struct sockaddr_storage *a) {
  if (a->ss_family == AF_INET) return (ntohl(((const struct sockaddr_in *)a)->sin_addr.s_addr) >> 24) == 127;
  if (a->ss_family == AF_INET6) {
    const struct in6_addr *x = &((const struct sockaddr_in6 *)a)->sin6_addr;
    if (IN6_IS_ADDR_LOOPBACK(x)) return 1;
    return IN6_IS_ADDR_V4MAPPED(x) && x->s6_addr[12] == 127;
  }
  return 0;
}

/* A process seen for the first time: when every call of its parent that started a process and has no process
 * yet was made while the parent ran one program, the earliest is where it began, and the reader is told so at
 * that place. Otherwise nothing is said, and the process inherits nothing a reader keeps. */
static void bornOf(pid_t tgid, pid_t parent) {
  pthread_mutex_lock(&lock);
  struct forking **earliest = NULL;
  int ambiguous = 0;
  unsigned generation = 0;
  for (struct forking **at = &forkings; *at != NULL; at = &(*at)->next) {
    if ((*at)->parent != parent) continue;
    if (earliest == NULL) {
      generation = (*at)->generation;
    } else if ((*at)->generation != generation) {
      ambiguous = 1;
    }
    if (earliest == NULL || (*at)->id < (*earliest)->id) earliest = at;
  }
  unsigned *now = generationOf(parent);
  if (earliest == NULL || ambiguous || now == NULL || *now != generation) {
    pthread_mutex_unlock(&lock);
    return;
  }
  struct forking *f = *earliest;
  *earliest = f->next;
  pthread_mutex_unlock(&lock);
  struct text t = {0};
  printf_(&t, "%d clone(child_stack=NULL, flags=SIGCHLD) = %d", parent, tgid);
  keep(f->id, 2, &t);
  free(f);
}

/* ---- Signals: a process whose handler would let a signal cut a waiting call short ---------------------------- */

static pthread_t mainThread;
static pthread_mutex_t seizing = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t seized = PTHREAD_COND_INITIALIZER;
static pid_t seizeAsked;
static int seizeServed;
#define WATCHED 4096
static pid_t watchedPids[WATCHED];

static int isWatched(pid_t tgid) {
  for (int i = 0; i < WATCHED; i++)
    if (watchedPids[i] == tgid) return 1;
  return 0;
}
static void setWatched(pid_t tgid, int on) {
  for (int i = 0; i < WATCHED; i++) {
    if (on && watchedPids[i] == 0) {
      watchedPids[i] = tgid;
      return;
    }
    if (!on && watchedPids[i] == tgid) watchedPids[i] = 0;
  }
}

/* Asks the main thread, which alone may trace, to watch a process: answered before the handler is set. */
static void expose(pid_t tgid) {
  pthread_mutex_lock(&seizing);
  if (!isWatched(tgid)) {
    seizeAsked = tgid;
    seizeServed = 0;
    pthread_kill(mainThread, SIGUSR2);
    while (!seizeServed) pthread_cond_wait(&seized, &seizing);
  }
  pthread_mutex_unlock(&seizing);
}

/* Seizes every thread of a process; new threads and children come by the events. */
static void seizeAll(pid_t tgid) {
  long options =
    PTRACE_O_TRACECLONE | PTRACE_O_TRACEFORK | PTRACE_O_TRACEVFORK | PTRACE_O_TRACEEXEC | PTRACE_O_TRACEEXIT;
  for (int round = 0, added = 1; added && round < 50; round++) {
    added = 0;
    char name[64];
    snprintf(name, sizeof name, "/proc/%d/task", tgid);
    DIR *d = opendir(name);
    if (d == NULL) return;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
      pid_t tid = (pid_t)atoi(e->d_name);
      /* EPERM: already ours; ESRCH: gone. */
      if (ptrace(PTRACE_SEIZE, tid, 0, options) == 0) added = 1;
    }
    closedir(d);
  }
  setWatched(tgid, 1);
}

static void serveSeizes(void) {
  pthread_mutex_lock(&seizing);
  if (seizeAsked != 0 && !seizeServed) {
    seizeAll(seizeAsked);
    seizeServed = 1;
    seizeAsked = 0;
    pthread_cond_broadcast(&seized);
  }
  pthread_mutex_unlock(&seizing);
}

static int restartable(enum kind k) {
  return k == K_OPEN || k == K_LOOK || k == K_EXEC || k == K_CHDIR || k == K_MKDIR || k == K_REMOVE ||
         k == K_CHANGE || k == K_CHANGE_FD || k == K_RENAME || k == K_LINK || k == K_SYMLINK || k == K_FORK ||
         k == K_HANDLER;
}

/* A signal held back from a thread whose watched call it cut short in the wait for the supervisor. */
struct kept {
  pid_t tid, tgid;
  int sig;
  siginfo_t info;
  int sent;              /* sent again */
  int received;          /* sent again once the restarted call was received: that wait cannot be cut short */
  int afterCall;         /* a fork: sent at its event, once it made the process (a fork gives way to any signal) */
  struct timespec since; /* when it was kept */
  struct kept *next;
};
static struct kept *keptSignals;
static pthread_mutex_t keeping = PTHREAD_MUTEX_INITIALIZER;

/*
 * Signals that come faster than a recorded thread can take them: each one stops the thread for this supervisor,
 * and the thread makes no more calls, where unrecorded it would. For each thread, how many signals stopped it since
 * this supervisor last received a call of it, how many of them found the same signal already pending again when it
 * stopped, and since when. At `stormStops` of them, or at `stormLeast` over `stormMs` or longer, with at least one in
 * four pending again, the recording ends: the run is stopped, and the build runs the step again without it.
 *
 * Neither bound is a rate: how fast this supervisor takes signal stops is the machine's, and on a slow one a
 * storm's stops come slowly while the thread still makes no calls. A signal pending again says the signals come
 * faster than this machine takes them; a thread that only computes between a runtime's timers (Go preempts a
 * goroutine every 10 ms) makes no calls either, but its signal is never pending again. Measured on the build server
 * (2026-11-21) with a timer to a handler around `stat`: at 16 microseconds or faster the thread made no recorded
 * call, with 61 to 100 in 100 stops pending again, and at 32 or slower it made its calls. With these bounds a timer
 * of 24 microseconds or faster was stopped within 3.4 s on 4 free cores, 6.8 s on 2 shared with busy loops and
 * 34 s on a quarter of one, where 20,000 stops a second never stopped 2 microseconds there; 64 or slower ended
 * recorded, and so did 32 but for one run of two on the busy cores.
 */
#define STORM_SLOTS 4096
static const unsigned stormStops = 1000;
static const unsigned stormLeast = 100;
static const long stormMs = 1000;
static struct {
  pid_t tid;
  unsigned stops;
  unsigned again;
  struct timespec first;
} storms[STORM_SLOTS];
static pthread_mutex_t storming = PTHREAD_MUTEX_INITIALIZER;
static int stormed;
#ifdef STORM_STATS
static unsigned mostStops;
static long longestMs;
#endif

static unsigned stormSlot(pid_t tid) {
  unsigned slot = (unsigned)tid % STORM_SLOTS;
  for (unsigned i = 0; i < STORM_SLOTS; i++) {
    unsigned at = (slot + i) % STORM_SLOTS;
    if (storms[at].tid == tid || storms[at].tid == 0) return at;
  }
  return slot;
}

/* A call of `tid` was received: the signals that stopped it before are over. */
static void receivedCall(pid_t tid) {
  pthread_mutex_lock(&storming);
  unsigned at = stormSlot(tid);
  if (storms[at].tid == tid) storms[at].stops = storms[at].again = 0;
  pthread_mutex_unlock(&storming);
}

#ifndef PTRACE_PEEKSIGINFO
#define PTRACE_PEEKSIGINFO 0x4209
#endif
#ifndef PTRACE_PEEKSIGINFO_SHARED
#define PTRACE_PEEKSIGINFO_SHARED 1u
#endif

/* Whether `sig` is pending for `tid` again, for the thread or its process, while the thread is stopped for it: its
 * queues as ptrace reads them (PTRACE_PEEKSIGINFO, Linux 3.10). */
static int pendingAgain(pid_t tid, int sig) {
  struct {
    uint64_t off;
    uint32_t flags;
    int32_t nr;
  } queue = {.off = 0, .nr = 32};
  siginfo_t pending[32];
  for (int shared = 0; shared < 2; shared++) {
    queue.flags = shared ? PTRACE_PEEKSIGINFO_SHARED : 0u;
    long n = ptrace(PTRACE_PEEKSIGINFO, tid, &queue, pending);
    for (long i = 0; i < n; i++) if (pending[i].si_signo == sig) return 1;
  }
  return 0;
}

/* How many times a signal stopped a thread of the run: each stop is a round trip to this program. */
static unsigned long signalStops;

/* A signal `sig` stopped `tid`. */
static void signalStop(pid_t tid, int sig) {
  __atomic_add_fetch(&signalStops, 1, __ATOMIC_RELAXED);
  int again = pendingAgain(tid, sig);
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  pthread_mutex_lock(&storming);
  unsigned at = stormSlot(tid);
  if (storms[at].tid != tid) {
    storms[at].tid = tid;
    storms[at].stops = storms[at].again = 0;
  }
  if (storms[at].stops == 0) storms[at].first = now;
  storms[at].stops++;
  storms[at].again += (unsigned)again;
  unsigned stops = storms[at].stops;
  long ms = (now.tv_sec - storms[at].first.tv_sec) * 1000 + (now.tv_nsec - storms[at].first.tv_nsec) / 1000000;
#ifdef STORM_STATS
  if (stops > mostStops) mostStops = stops;
  if (ms > longestMs) longestMs = ms;
#endif
  int over = 4 * storms[at].again >= stops && (stops >= stormStops || (stops >= stormLeast && ms >= stormMs));
  pthread_mutex_unlock(&storming);
  if (over && !__atomic_exchange_n(&stormed, 1, __ATOMIC_ACQ_REL)) {
    unrecorded("signals arrive faster than a recorded call completes");
  }
}

/* At a signal stop: whether the thread was cut short in a watched call that the kernel restarts when no signal is
 * delivered. Only reads: the call's number and its answer, or on aarch64 where the thread stands. */
static int cutShort(pid_t tid, int *fork) {
#if defined(__x86_64__)
  struct user_regs_struct r;
  if (ptrace(PTRACE_GETREGS, tid, 0, &r) != 0) return 0;
  long nr = (long)r.orig_rax, ret = (long)r.rax;
#else
  /* aarch64 readies the restart before this stop: x0 holds the call's first argument again and pc the `svc #0`
   * that made the call, so the answer is gone; x8 still holds the call's number. A thread found at an `svc #0` it
   * has not made yet reads the same way: its signal is then kept until that call is received, or 50 ms
   * (sendStale), a delay the program cannot tell from a signal sent a moment later. */
  struct user_regs_struct r;
  struct iovec io = {.iov_base = &r, .iov_len = sizeof r};
  if (ptrace(PTRACE_GETREGSET, tid, (void *)1 /* NT_PRSTATUS */, &io) != 0) return 0;
  errno = 0;
  /* The word that holds pc, read where it is aligned so the read never reaches past pc's page. */
  unsigned long at = (unsigned long)r.pc & ~7ul;
  long word = ptrace(PTRACE_PEEKTEXT, tid, (void *)at, 0);
  if (errno != 0) return 0;
  unsigned int instruction = (unsigned int)((unsigned long)word >> (r.pc == at ? 0 : 32));
  if (instruction != 0xd4000001u) return 0; /* svc #0 */
  long nr = (long)r.regs[8], ret = -512;
#endif
  if (nr < 0 || (ret != -512 && ret != -513 && ret != -514)) return 0;
  const struct call *c = callOf((int)nr);
  if (c == NULL || !restartable(c->kind)) return 0;
  *fork = c->kind == K_FORK;
  return 1;
}

/* The serving thread, at a call it received: a signal kept for this thread is sent again now, while the wait can
 * only be killed; it is delivered when the call ends. */
static void sendKept(pid_t tid, pid_t tgid) {
  pthread_mutex_lock(&keeping);
  for (struct kept *k = keptSignals; k != NULL; k = k->next) {
    if (k->tid != tid || k->sent || k->afterCall) continue;
    k->sent = 1;
    k->received = 1;
    syscall(SYS_tgkill, tgid, tid, k->sig);
  }
  pthread_mutex_unlock(&keeping);
}

/* The main thread, at the event of a fork that made its process: the signals kept for that fork are sent now. */
static void sendAfterFork(pid_t tid) {
  pthread_mutex_lock(&keeping);
  for (struct kept *k = keptSignals; k != NULL; k = k->next) {
    if (k->tid != tid || k->sent || !k->afterCall) continue;
    k->sent = 1;
    syscall(SYS_tgkill, k->tgid, tid, k->sig);
  }
  pthread_mutex_unlock(&keeping);
}

/* The main thread, at a signal stop: answers the signal to deliver (0 for none). A watched call cut short comes
 * first: the signal is kept and the call runs again, unless the signal was sent again after the restarted call was
 * received. Otherwise a kept signal sent again is put back as it first came. */
static int atSignal(pid_t tid, int sig) {
  signalStop(tid, sig);
  int fork = 0;
  if (cutShort(tid, &fork)) {
    pthread_mutex_lock(&keeping);
    /* Sent once the call was received, so the call itself waited (a FIFO, a device) and was cut short there, as
     * it would be unrecorded: delivered, with what it first said. */
    for (struct kept **at = &keptSignals; *at != NULL; at = &(*at)->next) {
      struct kept *k = *at;
      if (k->tid != tid || !k->received || k->sig != sig) continue;
      ptrace(PTRACE_SETSIGINFO, tid, 0, &k->info);
      *at = k->next;
      free(k);
      pthread_mutex_unlock(&keeping);
      return sig;
    }
    pthread_mutex_unlock(&keeping);
    siginfo_t info;
    if (ptrace(PTRACE_GETSIGINFO, tid, 0, &info) != 0) return sig;
    pthread_mutex_lock(&keeping);
    /* A signal of the first 31 is pending once however often it is sent: one kept is enough. */
    for (struct kept *k = keptSignals; k != NULL; k = k->next) {
      if (k->tid == tid && k->sig == sig && sig < SIGRTMIN && !k->sent) {
        k->afterCall = k->afterCall || fork;
        pthread_mutex_unlock(&keeping);
        return 0;
      }
    }
    struct kept *k = calloc(1, sizeof *k);
    if (k == NULL) {
      pthread_mutex_unlock(&keeping);
      return sig;
    }
    k->info = info;
    k->afterCall = fork;
    k->tid = tid;
    k->tgid = tgidOf(tid);
    k->sig = sig;
    clock_gettime(CLOCK_MONOTONIC, &k->since);
    k->next = keptSignals;
    keptSignals = k;
    pthread_mutex_unlock(&keeping);
    return 0; /* nothing delivered: the kernel restarts the call */
  }
  pthread_mutex_lock(&keeping);
  for (struct kept **at = &keptSignals; *at != NULL; at = &(*at)->next) {
    struct kept *k = *at;
    if (k->tid != tid || !k->sent || k->sig != sig) continue;
    /* The signal it was sent: delivered with what it first said. */
    ptrace(PTRACE_SETSIGINFO, tid, 0, &k->info);
    *at = k->next;
    free(k);
    pthread_mutex_unlock(&keeping);
    return sig;
  }
  pthread_mutex_unlock(&keeping);
  return sig;
}

/* Whether a thread waits in a call for the supervisor: a kept signal sent now would cut that call short again. */
static int waitingForUs(pid_t tid) {
  char name[64], wchan[64];
  snprintf(name, sizeof name, "/proc/%d/wchan", tid);
  int fd = open(name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t n = read(fd, wchan, sizeof wchan - 1);
  close(fd);
  if (n <= 0) return 0;
  wchan[n] = 0;
  return strncmp(wchan, "seccomp_do_user_notification", 28) == 0;
}

/* A kept signal whose call never came back to the supervisor within 50 ms is sent again, once the thread no longer
 * waits for the supervisor. */
static void sendStale(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  pthread_mutex_lock(&keeping);
  for (struct kept **at = &keptSignals; *at != NULL;) {
    struct kept *k = *at;
    long ms = (now.tv_sec - k->since.tv_sec) * 1000 + (now.tv_nsec - k->since.tv_nsec) / 1000000;
    if (!k->sent && !k->afterCall && ms >= 50 && !waitingForUs(k->tid)) {
      k->sent = 1;
      if (syscall(SYS_tgkill, k->tgid, k->tid, k->sig) != 0) {
        /* The thread is gone: so is the signal, as the kernel would have it. */
        *at = k->next;
        free(k);
        continue;
      }
    }
    at = &k->next;
  }
  pthread_mutex_unlock(&keeping);
}

/* A thread that ended takes its kept signals with it. */
static void dropKept(pid_t tid) {
  pthread_mutex_lock(&keeping);
  for (struct kept **at = &keptSignals; *at != NULL;) {
    if ((*at)->tid == tid) {
      struct kept *k = *at;
      *at = k->next;
      free(k);
    } else at = &(*at)->next;
  }
  pthread_mutex_unlock(&keeping);
}

/* ---- One stop ------------------------------------------------------------------------------------------------ */

/* A process whose program was to change: a later stop shows whether it did. Its arguments are the ones the call
 * gave, or, for a program started through `#!`, the interpreter's words, the path the call gave and the rest. */
static void startedYet(pid_t tid, pid_t tgid) {
  pthread_mutex_lock(&lock);
  struct starting **at = &startings;
  while (*at != NULL && (*at)->tgid != tgid) at = &(*at)->next;
  struct starting *s = *at;
  if (s == NULL) {
    pthread_mutex_unlock(&lock);
    return;
  }
  *at = s->next;
  pthread_mutex_unlock(&lock);
  char name[64];
  snprintf(name, sizeof name, "/proc/%d/cmdline", tgid);
  size_t capacity = s->argvLength + s->scriptLength + 8192;
  char *now = malloc(capacity);
  int same = 0;
  if (now != NULL) {
    int fd = open(name, O_RDONLY | O_CLOEXEC);
    if (fd >= 0) {
      size_t got = 0;
      ssize_t n;
      while (got < capacity && (n = read(fd, now + got, capacity - got)) > 0) got += (size_t)n;
      close(fd);
      same = (got == s->argvLength && memcmp(now, s->argv, got) == 0) ||
             (got > s->scriptLength && now[got - s->scriptLength - 1] == 0 &&
              memcmp(now + got - s->scriptLength, s->script, s->scriptLength) == 0);
    }
    free(now);
  }
  if (same) {
    struct text t = {0};
    puts_(&t, s->line);
    puts_(&t, " = 0");
    keep(s->id, 3, &t);
  } else if (tid != s->tid && tgid != s->tid) {
    /* Another thread of the process stopped first: the program may still be starting. */
    pthread_mutex_lock(&lock);
    s->next = startings;
    startings = s;
    pthread_mutex_unlock(&lock);
    return;
  }
  free(s->argv);
  free(s->script);
  free(s->line);
  free(s);
}

/* ---- openat2 with RESOLVE_* flags --------------------------------------------------------------------------- */

#ifndef RESOLVE_NO_XDEV
#define RESOLVE_NO_XDEV 0x01
#define RESOLVE_NO_MAGICLINKS 0x02
#define RESOLVE_NO_SYMLINKS 0x04
#define RESOLVE_BENEATH 0x08
#define RESOLVE_IN_ROOT 0x10
#define RESOLVE_CACHED 0x20
#endif
/* The flags a reader walks exactly (ObservedReads.resolveFlags). */
#define RESOLVE_FOLLOWED \
  (RESOLVE_NO_XDEV | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH | RESOLVE_IN_ROOT | RESOLVE_CACHED)

/* The first fields of `struct open_how`, which every openat2 passes. */
struct how {
  uint64_t flags, mode, resolve;
};

static void resolveNames(struct text *t, uint64_t resolve) {
  static const struct {
    uint64_t bit;
    const char *name;
  } names[] = {{RESOLVE_NO_XDEV, "RESOLVE_NO_XDEV"},         {RESOLVE_NO_MAGICLINKS, "RESOLVE_NO_MAGICLINKS"},
               {RESOLVE_NO_SYMLINKS, "RESOLVE_NO_SYMLINKS"}, {RESOLVE_BENEATH, "RESOLVE_BENEATH"},
               {RESOLVE_IN_ROOT, "RESOLVE_IN_ROOT"},         {RESOLVE_CACHED, "RESOLVE_CACHED"}};
  int first = 1;
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
    if (!(resolve & names[i].bit)) continue;
    if (!first) puts_(t, "|");
    puts_(t, names[i].name);
    first = 0;
  }
}

/* What a descriptor of this program names, as the kernel names it. 0 when it names no path. */
static int nameOf(int fd, char *out, size_t capacity) {
  char link[64];
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, out, capacity - 1);
  if (n <= 0) return 0;
  out[n] = 0;
  return out[0] == '/' && !(n > 10 && strcmp(out + n - 10, " (deleted)") == 0);
}

/*
 * An openat2 with RESOLVE_* flags walks its path by other rules than an open's: RESOLVE_IN_ROOT holds the walk inside
 * the directory it starts from, so `/x.txt` from `data` is `data/x.txt`. No path made absolute stands for that, so
 * the line is written as strace writes it: the directory with its descriptor, the path as the call named it, the
 * flags, and as its answer the file the kernel opens, which a reader holds its own walk against. That answer is the
 * kernel's own: this program asks the same question at the stop, from the same directory (opened through
 * `/proc/<thread>/fd/<n>`), with O_PATH, which opens no file and blocks on none, and the descriptor it gets names the
 * file. A file the call makes is named by its directory, asked the same way. Answers 1 when the line is kept.
 */
static int resolvedOpen(pid_t tid, pid_t tgid, uint64_t id, const struct seccomp_notif *req, const struct how *how,
                        struct text *t, const char **why) {
  if (how->resolve & ~(uint64_t)RESOLVE_FOLLOWED) {
    char reason[128];
    snprintf(reason, sizeof reason, "it reached a file in a way the recorder cannot follow: openat2 with 0x%llx",
             (unsigned long long)(how->resolve & ~(uint64_t)RESOLVE_FOLLOWED));
    unrecorded(reason);
    return 1;
  }
  char given[PATH_MAX + 1], base[PATH_MAX + 1], opened[PATH_MAX + 1], link[64];
  if (!stringAt(tid, req->data.args[1], given, sizeof given)) {
    *why = "address";
    return 0;
  }
  int dirfd = (int)req->data.args[0];
  if (dirfd == AT_FDCWD)
    snprintf(link, sizeof link, "/proc/%d/cwd", tid);
  else
    snprintf(link, sizeof link, "/proc/%d/fd/%d", tid, dirfd);
  int from = open(link, O_PATH | O_CLOEXEC);
  if (from < 0 || !placeOf(tid, dirfd, base, sizeof base) || base[0] != '/') {
    if (from >= 0) close(from);
    *why = "base";
    return 0;
  }
  struct how ours = {O_PATH | O_CLOEXEC | (how->flags & (O_NOFOLLOW | O_DIRECTORY)), 0,
                     how->resolve & ~(uint64_t)RESOLVE_CACHED};
  int error = 0, directory = 0;
  int fd = (int)syscall(SYS_openat2, from, given, &ours, sizeof ours);
  if (fd >= 0) {
    struct stat st;
    if (!nameOf(fd, opened, sizeof opened) || fstat(fd, &st) != 0) {
      close(fd);
      close(from);
      unrecorded("it reached a file in a way the recorder cannot follow: openat2 of a file with no name");
      return 1;
    }
    close(fd);
    directory = S_ISDIR(st.st_mode);
    int writing = (how->flags & O_ACCMODE) != O_RDONLY || (how->flags & O_CREAT);
    if ((how->flags & (O_CREAT | O_EXCL)) == (O_CREAT | O_EXCL))
      error = EEXIST;
    else if (S_ISLNK(st.st_mode) && !(how->flags & O_PATH))
      error = ELOOP; /* O_NOFOLLOW at a link */
    else if (directory && writing && (how->flags & O_TMPFILE) != O_TMPFILE)
      error = EISDIR;
  } else {
    error = errno;
    if (error == ENOENT && (how->flags & O_CREAT) && (how->flags & O_TMPFILE) != O_TMPFILE) {
      /* Nothing there: the call makes it in its directory, when that is there. */
      char parent[PATH_MAX + 1];
      snprintf(parent, sizeof parent, "%s", given);
      char *slash = strrchr(parent, '/');
      const char *name = slash == NULL ? parent : slash + 1;
      if (slash == NULL)
        snprintf(parent, sizeof parent, ".");
      else if (slash == parent)
        parent[1] = 0;
      else
        *slash = 0;
      char made[NAME_MAX + 1];
      snprintf(made, sizeof made, "%s", name);
      struct how up = {O_PATH | O_CLOEXEC | O_DIRECTORY, 0, ours.resolve};
      int dir = made[0] == 0 ? -1 : (int)syscall(SYS_openat2, from, parent, &up, sizeof up);
      if (made[0] == 0) {
        error = EISDIR;
      } else if (dir < 0) {
        error = errno;
      } else {
        struct stat st;
        if (fstatat(dir, made, &st, AT_SYMLINK_NOFOLLOW) == 0) {
          /* A link that leads nowhere: the call makes the file it names, by the rules of the walk. */
          close(dir);
          close(from);
          unrecorded("it reached a file in a way the recorder cannot follow: openat2 to make a file through a link");
          return 1;
        }
        char place[PATH_MAX + 1];
        /* A directory with no name was removed: nothing is made in it. */
        if (!nameOf(dir, place, sizeof place))
          error = ENOENT;
        else if (strlen(place) + 1 + strlen(made) >= sizeof opened)
          error = ENAMETOOLONG;
        else
          snprintf(opened, sizeof opened, "%s/%s", strcmp(place, "/") == 0 ? "" : place, made);
        close(dir);
      }
    }
  }
  close(from);
  begin(t, tgid, "openat2");
  if (dirfd == AT_FDCWD)
    puts_(t, "AT_FDCWD<");
  else
    printf_(t, "%d<", dirfd);
  puts_(t, base);
  puts_(t, ">, ");
  quotedz(t, given);
  puts_(t, ", {flags=");
  openFlags(t, how->flags);
  puts_(t, ", resolve=");
  resolveNames(t, how->resolve);
  puts_(t, "}, 24)");
  if (error != 0) {
    answer(t, error);
    keep(id, 2, t);
    return 1;
  }
  printf_(t, " = 0<%s>", opened);
  keep(id, 2, t);
  if (directory && (how->flags & (O_ACCMODE | O_CREAT | O_TMPFILE | O_PATH)) == O_RDONLY) {
    /* A directory opened is a directory listed, as an open's is. */
    struct text listed = {0};
    printf_(&listed, "%d getdents64(0<", tgid);
    puts_(&listed, opened);
    puts_(&listed, ">, {...}, 32768) = 0");
    keep(id, 3, &listed);
  }
  return 1;
}

static void serve(const struct seccomp_notif *req) {
  pid_t tid = (pid_t)req->pid;
  uint64_t id = req->id;
  settleMade(tid);
  if (req->data.arch != NATIVE_ARCH || (req->data.nr & (int)X32_BIT) != 0) {
    unrecorded("a program of another architecture ran, whose calls this recorder does not read");
    return;
  }
  const struct call *c = callOf(req->data.nr);
  if (c == NULL) return;
  pid_t tgid = tgidOf(tid);
  sendKept(tid, tgid);
  receivedCall(tid);
  startedYet(tid, tgid);
  char path[PATH_MAX + 1], other[PATH_MAX + 1];
  const char *why = NULL;
  struct text t = {0};
  /* A name this call makes, answered as missing with its directory, and where in the line the answer starts. */
  const char *made = NULL;
  size_t madeAt = 0;
  if (c->kind == K_MKDIR || c->kind == K_REMOVE || c->kind == K_RENAME || c->kind == K_LINK || c->kind == K_SYMLINK ||
      c->kind == K_CHANGE) {
    __atomic_add_fetch(&namesChanged, 1, __ATOMIC_ACQ_REL);
  }
  switch (c->kind) {
    case K_OPEN: {
      uint64_t flags = 0;
      if (c->nr == SYS_openat2) {
        if (!bytesAt(tid, req->data.args[2], &flags, sizeof flags)) flags = 0;
      } else if (c->flags >= 0) {
        flags = req->data.args[(int)c->flags];
      } else {
        flags = O_WRONLY | O_CREAT | O_TRUNC; /* creat */
      }
      int reading = (flags & (O_ACCMODE | O_CREAT | O_TRUNC | O_TMPFILE)) == O_RDONLY;
      if (c->nr == SYS_openat2) {
        struct how how = {0, 0, 0};
        if (req->data.args[3] < sizeof how || !bytesAt(tid, req->data.args[2], &how, sizeof how)) break;
        if (how.resolve != 0) {
          if (!reading) __atomic_add_fetch(&namesChanged, 1, __ATOMIC_ACQ_REL);
          if (resolvedOpen(tid, tgid, id, req, &how, &t, &why)) return;
          break;
        }
      }
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      int error, directory = 0, missing = 0;
      if (!reading) __atomic_add_fetch(&namesChanged, 1, __ATOMIC_ACQ_REL);
      if ((flags & O_TMPFILE) == O_TMPFILE) {
        /* An unnamed file in a directory: the directory is looked at, and no name is made. */
        error = look(path, 0);
      } else if (flags & O_CREAT) {
        error = look(path, 1);
        missing = error == ENOENT;
        if ((flags & O_EXCL) && error == 0) {
          error = EEXIST;
        } else if (error == ENOENT) {
          error = parentThere(path, 0, EISDIR); /* nothing there: made, when its directory is */
        } else if (error == 0) {
          error = look(path, (flags & O_NOFOLLOW) != 0);
        }
      } else {
        error = lookKind(path, (flags & O_NOFOLLOW) != 0, &directory);
      }
      if (reading && askedAgain(tgid, 2 | (flags << 2), path, error)) break;
      begin(&t, tgid, "openat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, ", ");
      openFlags(&t, flags);
      puts_(&t, ")");
      answerMaking(&t, error, missing, path, &made, &madeAt);
      if (error == 0 && directory && !pseudo(path)) {
        /* A directory opened is a directory listed: no listing is watched, and what is in it counts. */
        keep(id, 2, &t);
        t = (struct text){0};
        printf_(&t, "%d getdents64(0", tgid);
        angledz(&t, path);
        puts_(&t, ", {...}, 32768) = 0");
        keep(id, 3, &t);
        return;
      }
      break;
    }
    case K_LOOK: {
      int nofollow = c->nofollow;
      if (c->flags >= 0 && (req->data.args[(int)c->flags] & AT_SYMLINK_NOFOLLOW)) nofollow = 1;
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      int error = look(path, nofollow);
      if (askedAgain(tgid, (uint64_t)nofollow, path, error)) break;
      begin(&t, tgid, "newfstatat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, nofollow ? ", {...}, AT_SYMLINK_NOFOLLOW)" : ", {...}, 0)");
      answer(&t, error);
      break;
    }
    case K_EXEC: {
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      int error = look(path, 0);
      uint64_t argvAt = req->data.args[c->nr == SYS_execveat ? 2 : 1];
      struct text words = {0}, raw = {0};
      char given[PATH_MAX + 1];
      if (!stringAt(tid, req->data.args[c->path], given, sizeof given)) given[0] = 0;
      struct text script = {0};
      put(&script, given, strlen(given) + 1);
      puts_(&words, "[");
      for (int i = 0; argvAt != 0 && i < 100000; i++) {
        uint64_t word = 0;
        if (!bytesAt(tid, argvAt + 8u * (uint64_t)i, &word, sizeof word)) break;
        if (word == 0) break;
        char *buffer = malloc(131072);
        if (buffer == NULL) {
          words.failed = 1;
          break;
        }
        if (!stringAt(tid, word, buffer, 131072)) buffer[0] = 0;
        if (i > 0) puts_(&words, ", ");
        quotedz(&words, buffer);
        put(&raw, buffer, strlen(buffer) + 1);
        if (i > 0) put(&script, buffer, strlen(buffer) + 1);
        free(buffer);
      }
      puts_(&words, "]");
      if (words.failed || raw.failed || script.failed) {
        free(words.data);
        free(raw.data);
        free(script.data);
        t.failed = 1;
        break;
      }
      begin(&t, tgid, "execve");
      quotedz(&t, path);
      puts_(&t, ", ");
      puts_(&t, words.data);
      puts_(&t, ", 0x0 /* vars */)");
      free(words.data);
      if (error != 0) {
        answer(&t, error);
        free(raw.data);
        free(script.data);
        break;
      }
      rights(path);
      pthread_mutex_lock(&lock);
      unsigned *generation = generationOf(tgid);
      if (generation != NULL) *generation += 1;
      pthread_mutex_unlock(&lock);
      /* Looked at and started; what it starts as is known at a later stop. */
      struct starting *s = calloc(1, sizeof *s);
      if (s != NULL) {
        s->tgid = tgid;
        s->tid = tid;
        s->id = id;
        s->argv = raw.data;
        s->argvLength = raw.length;
        s->script = script.data;
        s->scriptLength = script.length;
        s->line = strdup(t.data == NULL ? "" : t.data);
        pthread_mutex_lock(&lock);
        s->next = startings;
        startings = s;
        pthread_mutex_unlock(&lock);
      } else {
        free(raw.data);
        free(script.data);
      }
      puts_(&t, " = ?");
      break;
    }
    case K_CHDIR: {
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      begin(&t, tgid, "chdir");
      quotedz(&t, path);
      puts_(&t, ")");
      answer(&t, look(path, 0));
      break;
    }
    case K_MKDIR: {
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      int there = look(path, 1);
      int error = there == 0 ? EEXIST : there == ENOENT ? parentThere(path, 1, 0) : there;
      begin(&t, tgid, "mkdirat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, ", 0777)");
      answerMaking(&t, error, there == ENOENT, path, &made, &madeAt);
      break;
    }
    case K_REMOVE: {
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      begin(&t, tgid, "unlinkat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, ", 0)");
      answer(&t, look(path, 1));
      break;
    }
    case K_CHANGE: {
      int nofollow = c->nofollow;
      if (c->flags >= 0 && (req->data.args[(int)c->flags] & AT_SYMLINK_NOFOLLOW)) nofollow = 1;
      if (c->nr == SYS_utimensat && req->data.args[1] == 0) {
        /* No path: the descriptor's own file. */
        if (!placeOf(tid, (int)req->data.args[0], path, sizeof path)) {
          why = "base";
          break;
        }
        printf_(&t, "%d utimensat(%d", tgid, (int)req->data.args[0]);
        angledz(&t, path);
        puts_(&t, ", NULL, NULL, 0) = 0");
        break;
      }
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      begin(&t, tgid, "fchmodat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, ", 0)");
      answer(&t, look(path, nofollow));
      break;
    }
    case K_CHANGE_FD: {
      if (!placeOf(tid, (int)req->data.args[0], path, sizeof path)) {
        why = "base";
        break;
      }
      printf_(&t, "%d %s(%d", tgid, c->name, (int)req->data.args[0]);
      angledz(&t, path);
      puts_(&t, ", 0) = 0");
      break;
    }
    case K_RENAME:
    case K_LINK: {
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      if (!pathOf(tid, req, c->dir2, c->path2, other, sizeof other, &why)) break;
      /* RENAME_NOREPLACE (1) fails where the new name is there; RENAME_EXCHANGE (2) swaps two names that are both
       * there; RENAME_WHITEOUT (4) moves as a rename does. The line names them, as strace does. */
      uint64_t renaming = c->nr == SYS_renameat2 ? req->data.args[(int)c->flags] : 0;
      if (renaming & ~(uint64_t)7) {
        char reason[128];
        snprintf(reason, sizeof reason, "it reached a file in a way the recorder cannot follow: renameat2 with 0x%llx",
                 (unsigned long long)(renaming & ~(uint64_t)7));
        unrecorded(reason);
        return;
      }
      int moving = 0, from = lookKind(path, 1, &moving), to = look(other, 1);
      /* A name that is there already is one the run found, whatever the call does to it. */
      if (to == 0 && !pseudo(other)) found(tgid, id, 0, other);
      int error = from != 0                                   ? from
                : (renaming & 2)                              ? (to == 0 ? 0 : to)
                : ((c->kind == K_LINK || (renaming & 1)) && to == 0) ? EEXIST
                : to != ENOENT                                ? 0
                : c->kind == K_LINK                           ? parentThere(other, 0, ENOENT)
                                                              : parentThere(other, moving, ENOTDIR);
      begin(&t, tgid, c->kind == K_RENAME ? "renameat2" : "linkat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, ", AT_FDCWD, ");
      quotedz(&t, other);
      if (renaming == 0) {
        puts_(&t, ", 0)");
      } else {
        static const char *names[] = {"RENAME_NOREPLACE", "RENAME_EXCHANGE", "RENAME_WHITEOUT"};
        puts_(&t, ", ");
        for (int bit = 0, first = 1; bit < 3; bit++) {
          if (!(renaming & (1u << bit))) continue;
          if (!first) puts_(&t, "|");
          puts_(&t, names[bit]);
          first = 0;
        }
        puts_(&t, ")");
      }
      answerMaking(&t, error, from == 0 && to == ENOENT, other, &made, &madeAt);
      break;
    }
    case K_SYMLINK: {
      if (!stringAt(tid, req->data.args[c->nr == SYS_symlinkat ? 0 : 0], other, sizeof other)) {
        why = "address";
        break;
      }
      if (!pathOf(tid, req, c->dir2, c->path2, path, sizeof path, &why)) break;
      int there = look(path, 1);
      if (there == 0 && !pseudo(path)) found(tgid, id, 0, path);
      int error = there == 0 ? EEXIST : there == ENOENT ? parentThere(path, 0, ENOENT) : there;
      begin(&t, tgid, "symlinkat");
      quotedz(&t, other);
      puts_(&t, ", AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, ")");
      answerMaking(&t, error, there == ENOENT, path, &made, &madeAt);
      break;
    }
    case K_CONNECT:
    case K_BIND: {
      settleBindings();
      struct sockaddr_storage a;
      memset(&a, 0, sizeof a);
      socklen_t length = (socklen_t)req->data.args[2];
      if (length > sizeof a) length = sizeof a;
      if (length < sizeof(sa_family_t) || !bytesAt(tid, req->data.args[1], &a, length)) break;
      begin(&t, tgid, c->name);
      printf_(&t, "%d, ", (int)req->data.args[0]);
      socketAddress(&t, &a, length);
      printf_(&t, ", %u)", (unsigned)length);
      if (c->kind == K_CONNECT) {
        int error = 0;
        if (a.ss_family == AF_UNIX) {
          const struct sockaddr_un *u = (const struct sockaddr_un *)&a;
          if (u->sun_path[0] != 0) {
            char name[sizeof u->sun_path + 1];
            snprintf(name, sizeof name, "%.*s", (int)sizeof u->sun_path, u->sun_path);
            char full[PATH_MAX + 1];
            if (name[0] == '/') {
              snprintf(full, sizeof full, "%s", name);
            } else if (placeOf(tid, AT_FDCWD, other, sizeof other)) {
              snprintf(full, sizeof full, "%s/%s", other, name);
            } else {
              full[0] = 0;
            }
            if (full[0] != 0 && look(full, 0) == ENOENT) error = ENOENT;
          }
        } else if (loopbackAddress(&a)) {
          unsigned port = a.ss_family == AF_INET ? ntohs(((struct sockaddr_in *)&a)->sin_port)
                                                 : ntohs(((struct sockaddr_in6 *)&a)->sin6_port);
          if (!listening(tid, port)) error = ECONNREFUSED;
        }
        answer(&t, error);
        break;
      }
      /* A bind is written at the end of the run, when the socket says it is bound. */
      int pidfd = (int)syscall(SYS_pidfd_open, tgid, 0);
      int copy = pidfd < 0 ? -1 : (int)syscall(SYS_pidfd_getfd, pidfd, (int)req->data.args[0], 0);
      int refused = copy < 0 && errno == EPERM;
      if (pidfd >= 0) close(pidfd);
      if (copy >= 0 && !t.failed) {
        struct binding *b = calloc(1, sizeof *b);
        if (b != NULL) {
          b->id = id;
          b->copy = copy;
          b->asked = a;
          b->askedLength = length;
          b->line = t.data;
          pthread_mutex_lock(&lock);
          b->next = bindings;
          bindings = b;
          pthread_mutex_unlock(&lock);
          return;
        }
        close(copy);
      } else if (copy >= 0) {
        close(copy);
      } else if (refused && !t.failed) {
        /* A process gone, or a descriptor that is no socket, binds nothing; a refusal would lose the line. */
        unrecorded("this machine refuses pidfd_getfd, which reads a socket the run bound; a container allows it with "
                   "CAP_SYS_PTRACE");
      }
      free(t.data);
      return;
    }
    case K_VIEW:
      unrecorded("it changed its view of the file system");
      return;
    case K_SPACE:
      unrecorded("it made a namespace of its own");
      return;
    case K_FORK: {
      uint64_t flags = SIGCHLD;
      if (c->nr == SYS_clone) flags = req->data.args[0];
#ifdef SYS_clone3
      if (c->nr == SYS_clone3 && !bytesAt(tid, req->data.args[0], &flags, sizeof flags)) return;
#endif
      if (flags & NEW_NAMESPACES) {
        unrecorded("it made a namespace of its own");
        return;
      }
      if (flags & CLONE_THREAD) return;
      struct forking *f = calloc(1, sizeof *f);
      if (f == NULL) return;
      f->parent = tgid;
      f->id = id;
      pthread_mutex_lock(&lock);
      unsigned *generation = generationOf(tgid);
      f->generation = generation == NULL ? 0 : *generation;
      f->next = forkings;
      forkings = f;
      pthread_mutex_unlock(&lock);
      return;
    }
    case K_RING: {
      /* A ring whose kernel thread takes what it is told with no call: nothing it does is seen. */
      uint32_t setup[3] = {0, 0, 0}; /* sq_entries, cq_entries, flags */
      if (!bytesAt(tid, req->data.args[1], setup, sizeof setup) || (setup[2] & 2u /* IORING_SETUP_SQPOLL */)) {
        unrecorded("it set up an io_uring whose kernel thread reads files with no call a trace shows");
      }
      return;
    }
    case K_RING_ENTER: {
      /* What the ring is about to do, as the kernel lists it: a call that names a path is one no line holds. */
      if (req->data.args[3] & 16u /* IORING_ENTER_REGISTERED_RING */) {
        unrecorded("it used an io_uring by a registered descriptor, whose requests cannot be read");
        return;
      }
      char name[64], buffer[16384];
      snprintf(name, sizeof name, "/proc/%d/fdinfo/%d", tid, (int)req->data.args[0]);
      int fd = open(name, O_RDONLY | O_CLOEXEC);
      if (fd < 0) return;
      ssize_t n = read(fd, buffer, sizeof buffer - 1);
      close(fd);
      if (n <= 0) return;
      buffer[n] = 0;
      static const char *paths[] = {"opcode:OPENAT,", "opcode:OPENAT2,", "opcode:STATX,", "opcode:RENAMEAT,",
                                    "opcode:UNLINKAT,", "opcode:MKDIRAT,", "opcode:SYMLINKAT,", "opcode:LINKAT,",
                                    "opcode:GETXATTR,", "opcode:SETXATTR,", "opcode:FILES_UPDATE,"};
      for (size_t i = 0; i < sizeof paths / sizeof paths[0]; i++) {
        if (strstr(buffer, paths[i]) != NULL) {
          unrecorded("it read files through io_uring, which a trace does not show");
          return;
        }
      }
      /* A list cut short by the buffer may hold more: what is not read is not known. */
      if ((size_t)n == sizeof buffer - 1) unrecorded("it gave io_uring more requests than the recorder reads");
      return;
    }
    case K_HANDLE:
      unrecorded("it opened a file by its handle, which names no path");
      return;
    case K_FILTER:
      if (req->data.args[0] == SECCOMP_SET_MODE_FILTER) unrecorded("it filtered its own system calls");
      return;
    case K_HANDLER: {
      int sig = (int)req->data.args[0];
      if (req->data.args[1] == 0) return;
      uint64_t act[2] = {0, 0}; /* the handler, the flags */
      if (!bytesAt(tid, req->data.args[1], act, sizeof act)) return;
      int fault = sig == SIGSEGV || sig == SIGBUS || sig == SIGFPE || sig == SIGILL || sig == SIGTRAP || sig == SIGSYS;
      if (act[0] > 1 /* neither SIG_DFL nor SIG_IGN */ && !fault && !(act[1] & SA_RESTART)) expose(tgid);
      return;
    }
  }
  if (why != NULL) {
    free(t.data);
    t = (struct text){0};
    /* A thread killed while its call waited here took the call with it: the call never ran, and its path and its
     * directory could not be read because the thread is gone. Nothing is written of it. */
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &id) != 0) return;
    if (strcmp(why, "up") == 0) {
      unrecorded("it named a path that goes back up inside /proc or /dev, which cannot be followed as it ran");
      return;
    }
    if (strcmp(why, "removed") == 0) {
      unrecorded("it reached a removed file through a link of a process");
      return;
    }
    if (strcmp(why, "address") == 0) {
      /* A path that cannot be read from the thread: strace writes its address, and the call fails on it. */
      printf_(&t, "%d openat(AT_FDCWD, 0x%llx, O_RDONLY) = -1 EFAULT (Bad address)", tgid,
              (unsigned long long)req->data.args[c->path >= 0 ? (int)c->path : 0]);
    } else {
      /* A relative path from a descriptor that names no directory: the line keeps the words, and a reader that
       * cannot tell where they start refuses the run, as it does with strace's line. */
      int dir = c->path2 >= 0 && c->dir2 >= 0 ? c->dir2 : c->dir;
      int at = c->path2 >= 0 && c->dir2 >= 0 ? c->path2 : c->path;
      char rel[PATH_MAX + 1];
      if (at < 0 || !stringAt(tid, req->data.args[at], rel, sizeof rel)) rel[0] = 0;
      printf_(&t, "%d openat(%d, ", tgid, dir >= 0 ? (int)req->data.args[dir] : -1);
      quotedz(&t, rel[0] == 0 ? "." : rel);
      puts_(&t, ", O_RDONLY) = -1 EBADF (Bad file descriptor)");
    }
  }
  if (t.data == NULL && !t.failed) return;
  long place = keep(id, 2, &t);
  if (made != NULL && why == NULL) awaitMade(tid, place, madeAt, made);
}

static void *serving(void *unused) {
  (void)unused;
  sigset_t all_;
  sigfillset(&all_);
  sigdelset(&all_, SIGUSR1);
  pthread_sigmask(SIG_SETMASK, &all_, NULL);
  struct seccomp_notif_sizes sizes;
  if (syscall(SYS_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &sizes) != 0) return NULL;
  struct seccomp_notif *req = calloc(1, sizes.seccomp_notif);
  struct seccomp_notif_resp *resp = calloc(1, sizes.seccomp_notif_resp);
  if (req == NULL || resp == NULL) {
    __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
    return NULL;
  }
  for (;;) {
    memset(req, 0, sizes.seccomp_notif);
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, req) != 0) {
      /* Woken to end, or a call whose thread ended or was interrupted before it was received. */
      if (__atomic_load_n(&stopping, __ATOMIC_ACQUIRE)) break;
      continue;
    }
    serve(req);
    memset(resp, 0, sizes.seccomp_notif_resp);
    resp->id = req->id;
    resp->flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
    /* A call whose thread ended or was interrupted meanwhile has no one to answer. */
    ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, resp);
  }
  free(req);
  free(resp);
  return NULL;
}

/* ---- Bound sockets ---------------------------------------------------------------------------------------------- */

/* Whether the copy of a socket says it is bound where the process asked. */
static int saysBound(const struct binding *b) {
  struct sockaddr_storage now;
  socklen_t length = sizeof now;
  memset(&now, 0, sizeof now);
  int bound = 0;
  {
    if (getsockname(b->copy, (struct sockaddr *)&now, &length) == 0 && now.ss_family == b->asked.ss_family) {
      if (now.ss_family == AF_UNIX) {
        /* A path is compared as a path, whatever length each side gave; an abstract name byte for byte. */
        const char *at = ((struct sockaddr_un *)&now)->sun_path, *asked = ((struct sockaddr_un *)&b->asked)->sun_path;
        size_t room = sizeof ((struct sockaddr_un *)&now)->sun_path;
        size_t nowLength = length > offsetof(struct sockaddr_un, sun_path) ? length - offsetof(struct sockaddr_un, sun_path) : 0;
        size_t askedLength = b->askedLength > offsetof(struct sockaddr_un, sun_path)
                               ? b->askedLength - offsetof(struct sockaddr_un, sun_path)
                               : 0;
        if (nowLength > 0 && at[0] != 0)
          bound = strncmp(at, asked, room) == 0;
        else
          bound = nowLength > 0 && nowLength == askedLength && memcmp(at, asked, nowLength) == 0;
      } else if (now.ss_family == AF_INET || now.ss_family == AF_INET6) {
        unsigned asked = now.ss_family == AF_INET ? ntohs(((struct sockaddr_in *)&b->asked)->sin_port)
                                                  : ntohs(((struct sockaddr_in6 *)&b->asked)->sin6_port);
        unsigned port = now.ss_family == AF_INET ? ntohs(((struct sockaddr_in *)&now)->sin_port)
                                                 : ntohs(((struct sockaddr_in6 *)&now)->sin6_port);
        bound = port != 0 && (asked == 0 || asked == port);
      }
    }
  }
  return bound;
}

/* Writes the line of a bind the socket says was made, and lets the copy go. */
static void written(struct binding *b, int bound) {
  close(b->copy);
  if (bound) {
    struct text t = {0};
    puts_(&t, b->line);
    puts_(&t, " = 0");
    keep(b->id, 2, &t);
  } else {
    free(b->line);
  }
  free(b);
}

/*
 * Lets go of the copy of every socket that already says it is bound, writing its line: called before a bind or a
 * connect goes on, so a port the run closed is free again for it, as it is unrecorded.
 */
static void settleBindings(void) {
  struct binding *settled = NULL;
  pthread_mutex_lock(&lock);
  for (struct binding **at = &bindings; *at != NULL;) {
    struct binding *b = *at;
    if (saysBound(b)) {
      *at = b->next;
      b->next = settled;
      settled = b;
    } else {
      at = &b->next;
    }
  }
  pthread_mutex_unlock(&lock);
  while (settled != NULL) {
    struct binding *next = settled->next;
    written(settled, 1);
    settled = next;
  }
}

/* ---- The end of the run --------------------------------------------------------------------------------------- */

static void boundSockets(void) {
  while (bindings != NULL) {
    struct binding *b = bindings;
    bindings = b->next;
    written(b, saysBound(b));
  }
}

static int byOrder(const void *a, const void *b) {
  const struct line *x = a, *y = b;
  if (x->id != y->id) return x->id < y->id ? -1 : 1;
  return x->sub < y->sub ? -1 : x->sub > y->sub ? 1 : 0;
}

static int writeLines(const char *file, struct lines *lines) {
  char written[PATH_MAX + 32];
  snprintf(written, sizeof written, "%s.writing", file);
  FILE *out = fopen(written, "we");
  if (out == NULL) return 0;
  setvbuf(out, NULL, _IOFBF, 1 << 20);
  qsort(lines->items, lines->count, sizeof *lines->items, byOrder);
  fprintf(out, "%d +++ smthrs-observe 1 +++\n", rootPid);
  for (size_t i = 0; i < lines->count; i++) {
    fwrite(lines->items[i].text, 1, lines->items[i].length, out);
    fputc('\n', out);
  }
  if (dropped) unrecorded("the recorder could not keep every line");
  for (int i = 0; i < reasonCount; i++) fprintf(out, "%d +++ unrecorded: %s +++\n", rootPid, reasons[i]);
  for (int i = 0; i < rightsCount; i++) fprintf(out, "%d +++ rights: %s +++\n", rootPid, rightsNeeded[i]);
  unsigned long stops = __atomic_load_n(&signalStops, __ATOMIC_RELAXED);
  if (stops > 0) fprintf(out, "%d +++ signal stops: %lu +++\n", rootPid, stops);
  fprintf(out, "%d +++ complete +++\n", rootPid);
  if (fflush(out) != 0 || ferror(out)) {
    fclose(out);
    unlink(written);
    return 0;
  }
  if (fclose(out) != 0) return 0;
  return rename(written, file) == 0;
}

static int writeTrace(const char *file) { return writeLines(file, &all); }

/* Takes every line kept so far, in the order of the calls, and leaves none kept. */
static struct lines takeLines(void) {
  pthread_mutex_lock(&lock);
  struct lines taken = all;
  all = (struct lines){0};
  pthread_mutex_unlock(&lock);
  qsort(taken.items, taken.count, sizeof *taken.items, byOrder);
  return taken;
}

static void freeLines(struct lines *taken) {
  for (size_t i = 0; i < taken->count; i++) free(taken->items[i].text);
  free(taken->items);
  *taken = (struct lines){0};
}

/* Writes `text` to `file` whole or not at all: through a file beside it, renamed into place. */
static int writeWhole(const char *file, const char *text) {
  char written[PATH_MAX + 32];
  snprintf(written, sizeof written, "%s.writing", file);
  FILE *out = fopen(written, "we");
  if (out == NULL) return 0;
  int ok = fputs(text, out) >= 0 && fflush(out) == 0 && !ferror(out);
  if (fclose(out) != 0) ok = 0;
  if (!ok) {
    unlink(written);
    return 0;
  }
  return rename(written, file) == 0;
}

/*
 * The trace of a step whose command has ended while what it left runs on (`--keep`): every line so far, sealed, and
 * then the command's exit status beside it, which ends the step.
 */
static int writeStep(const char *file, int code) {
  settleBindings();
  struct lines taken = takeLines();
  int ok = writeLines(file, &taken);
  freeLines(&taken);
  char status[64], statusFile[PATH_MAX + 32];
  snprintf(status, sizeof status, "%d %d\n", code, (int)getpid());
  snprintf(statusFile, sizeof statusFile, "%s.status", file);
  return writeWhole(statusFile, status) && ok;
}

/* The last request to have every line on disk that was answered (`.ask`, `.answered`). */
static long answered;

/*
 * Appends the lines made since the step's trace, or since the last time, to the trace file's name with `.kept`.
 * A reader that has to know every line made so far is on disk writes a number to the name with `.ask`: once the
 * lines are written, the number is written to the name with `.answered`.
 */
static void writeKept(const char *file) {
  char askFile[PATH_MAX + 32], text[64];
  snprintf(askFile, sizeof askFile, "%s.ask", file);
  long asked = 0;
  int fd = open(askFile, O_RDONLY | O_CLOEXEC);
  if (fd >= 0) {
    ssize_t n = read(fd, text, sizeof text - 1);
    close(fd);
    if (n > 0) {
      text[n] = 0;
      asked = strtol(text, NULL, 10);
    }
  }
  settleBindings();
  struct lines taken = takeLines();
  if (taken.count == 0) {
    freeLines(&taken);
    if (asked > answered) {
      char answeredFile[PATH_MAX + 32];
      snprintf(answeredFile, sizeof answeredFile, "%s.answered", file);
      snprintf(text, sizeof text, "%ld\n", asked);
      if (writeWhole(answeredFile, text)) answered = asked;
    }
    return;
  }
  char keptFile[PATH_MAX + 32];
  snprintf(keptFile, sizeof keptFile, "%s.kept", file);
  FILE *out = fopen(keptFile, "ae");
  if (out != NULL) {
    for (size_t i = 0; i < taken.count; i++) {
      fwrite(taken.items[i].text, 1, taken.items[i].length, out);
      fputc('\n', out);
    }
    fclose(out);
  }
  freeLines(&taken);
  if (asked > answered) {
    char answeredFile[PATH_MAX + 32];
    snprintf(answeredFile, sizeof answeredFile, "%s.answered", file);
    snprintf(text, sizeof text, "%ld\n", asked);
    if (writeWhole(answeredFile, text)) answered = asked;
  }
}

/* Every process of the run is this program's child once its parent ended: kill those still running. */
static void endLeft(void) {
  DIR *d = opendir("/proc");
  if (d == NULL) return;
  struct dirent *e;
  pid_t me = getpid();
  while ((e = readdir(d)) != NULL) {
    if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
    char name[64], buffer[512];
    snprintf(name, sizeof name, "/proc/%s/stat", e->d_name);
    int fd = open(name, O_RDONLY | O_CLOEXEC);
    if (fd < 0) continue;
    ssize_t n = read(fd, buffer, sizeof buffer - 1);
    close(fd);
    if (n <= 0) continue;
    buffer[n] = 0;
    char *end = strrchr(buffer, ')');
    if (end == NULL) continue;
    int parent = 0;
    if (sscanf(end + 2, "%*c %d", &parent) == 1 && parent == me) kill((pid_t)atoi(e->d_name), SIGKILL);
  }
  closedir(d);
}

/* Whether this machine lets the recorder run: the filter, and a copy of a descriptor of the filtered process (how a
 * bound socket is read). Where it does not, one line on standard error says what it refused, and it answers 126. */
static int probe(void) {
  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv) != 0) return 126;
  pid_t child = fork();
  if (child < 0) return 126;
  if (child == 0) {
    int fd = install();
    int said = fd >= 0 ? 0 : errno;
    (void)write(sv[1], &said, sizeof said);
    /* Held open until the supervisor has tried to copy it. */
    char go;
    (void)read(sv[1], &go, 1);
    _exit(said == 0 ? 0 : 1);
  }
  int said = -1;
  if (read(sv[0], &said, sizeof said) != (ssize_t)sizeof said) said = EIO;
  int copied = 0;
  if (said == 0) {
    int pidfd = (int)syscall(SYS_pidfd_open, child, 0);
    int copy = pidfd < 0 ? -1 : (int)syscall(SYS_pidfd_getfd, pidfd, sv[1], 0);
    copied = copy >= 0 ? 0 : errno;
    if (copy >= 0) close(copy);
    if (pidfd >= 0) close(pidfd);
  }
  (void)write(sv[0], "", 1);
  int status = 0;
  waitpid(child, &status, 0);
  if (said != 0) {
    fprintf(stderr, "smthrs-observe cannot run here: this machine refuses its system-call filter: %s\n", strerror(said));
    return 126;
  }
  if (copied != 0) {
    fprintf(stderr,
            "smthrs-observe cannot run here: this machine refuses pidfd_getfd, which reads a socket a step binds: %s; "
            "a container allows it with CAP_SYS_PTRACE\n",
            strerror(copied));
    return 126;
  }
  return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 126;
}

static void wake(int sig) { (void)sig; }

static volatile pid_t commandPid;
static void forward(int sig) {
  if (commandPid > 0) kill(commandPid, sig);
}

/* `--reap -- <command>`: runs the command as a child subreaper and records nothing. A step of a job that has no
 * process namespace to keep what it leaves running runs this way: whatever the step leaves, however it detached
 * (a double fork, `setsid`, `nohup ... &`), comes to this program when its parent ends, and once the command has
 * ended it is given a second to end, then stopped, as after a recorded run. Answers the command's exit status. */
static int reap(char **command) {
  prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
  pid_t self = getpid();
  pid_t child = fork();
  if (child < 0) return 125;
  if (child == 0) {
    /* The command ends with this program, and does not start if this program has already ended. */
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0 || getppid() != self) _exit(126);
    execvp(command[0], command);
    fprintf(stderr, "smthrs-observe: %s: %s\n", command[0], strerror(errno));
    _exit(errno == ENOENT ? 127 : 126);
  }
  commandPid = child;
  struct sigaction passOn;
  memset(&passOn, 0, sizeof passOn);
  passOn.sa_handler = forward;
  passOn.sa_flags = SA_RESTART;
  sigaction(SIGTERM, &passOn, NULL);
  sigaction(SIGINT, &passOn, NULL);
  sigaction(SIGHUP, &passOn, NULL);
  sigaction(SIGQUIT, &passOn, NULL);
  int code = 125, rootDone = 0;
  struct timespec deadline = {0, 0};
  for (;;) {
    int status = 0;
    pid_t pid = waitpid(-1, &status, WNOHANG);
    if (pid == child) {
      code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      rootDone = 1;
      clock_gettime(CLOCK_MONOTONIC, &deadline);
      deadline.tv_sec += 1;
      continue;
    }
    if (pid > 0) continue;
    if (pid < 0 && errno == ECHILD) break;
    if (rootDone) {
      struct timespec now;
      clock_gettime(CLOCK_MONOTONIC, &now);
      if (now.tv_sec > deadline.tv_sec || (now.tv_sec == deadline.tv_sec && now.tv_nsec >= deadline.tv_nsec)) endLeft();
    }
    struct timespec tick = {0, 5000000};
    nanosleep(&tick, NULL);
  }
  return code;
}

int main(int argc, char **argv) {
  /* `--probe --reap` answers 0: this program can reap (`--reap`), which needs nothing of the kernel but a child
   * subreaper. One built before it could refuses the pair; asked `--reap -- true`, it would record `true`. */
  if (argc == 3 && strcmp(argv[1], "--probe") == 0 && strcmp(argv[2], "--reap") == 0) return 0;
  if (argc >= 3 && strcmp(argv[1], "--reap") == 0 && strcmp(argv[2], "--") == 0) {
    if (argc == 3) {
      fprintf(stderr, "usage: smthrs-observe --reap -- <command> [<argument>...]\n");
      return 125;
    }
    return reap(argv + 3);
  }
  /* `--probe --keep` answers as `--probe` does: a build that asks it learns this program can follow what a step
   * leaves running (`--keep`), which one built before could not, and refused the pair. */
  if (argc >= 2 && argc <= 3 && strcmp(argv[1], "--probe") == 0 && (argc == 2 || strcmp(argv[2], "--keep") == 0))
    return probe();
  /* Names each program whose file asks for rights, one a line; answers 0. strace's reader asks this way. */
  if (argc >= 2 && strcmp(argv[1], "--rights") == 0) {
    for (int i = 2; i < argc; i++)
      if (asksRights(argv[i])) printf("%s\n", argv[i]);
    return fflush(stdout) == 0 ? 0 : 1;
  }
  int keepLeft = argc > 1 && strcmp(argv[1], "--keep") == 0;
  if (keepLeft) {
    argv++;
    argc--;
  }
  if (argc < 4 || strcmp(argv[2], "--") != 0) {
    fprintf(stderr, "usage: smthrs-observe [--keep] <trace file> -- <command> [<argument>...]\n");
    return 125;
  }
  const char *traceFile = argv[1];
  char **command = argv + 3;
  /* Every process the command leaves behind comes to this program when its parent ends. */
  prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv) != 0) return 125;
  pid_t child = fork();
  if (child < 0) return 125;
  if (child == 0) {
    /* The command ends with this program. A recorder killed after the command started would leave it running,
     * adopted by the nearest subreaper above, which can be the session's own service manager. The kernel kills the
     * command when this program ends; that holds across the exec below. Had this program ended before the line,
     * the read below finds the socket closed and the command never starts: this program sends its byte only after
     * this line has run. */
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) _exit(126);
    close(sv[0]);
    int fd = install();
    char c = 0;
    struct iovec io = {&c, 1};
    union {
      char buffer[CMSG_SPACE(sizeof(int))];
      struct cmsghdr align;
    } control;
    memset(&control, 0, sizeof control);
    struct msghdr m = {.msg_iov = &io, .msg_iovlen = 1};
    if (fd >= 0) {
      m.msg_control = control.buffer;
      m.msg_controllen = sizeof control.buffer;
      struct cmsghdr *h = CMSG_FIRSTHDR(&m);
      h->cmsg_level = SOL_SOCKET;
      h->cmsg_type = SCM_RIGHTS;
      h->cmsg_len = CMSG_LEN(sizeof(int));
      memcpy(CMSG_DATA(h), &fd, sizeof fd);
    }
    if (sendmsg(sv[1], &m, 0) != 1) _exit(126);
    if (fd < 0) _exit(126);
    close(fd);
    /* Starts the command once the supervisor serves: its first call is the start itself. */
    if (read(sv[1], &c, 1) != 1) _exit(126);
    close(sv[1]);
    execvp(command[0], command);
    fprintf(stderr, "smthrs-observe: %s: %s\n", command[0], strerror(errno));
    _exit(errno == ENOENT ? 127 : 126);
  }
  close(sv[1]);
  rootPid = child;
  commandPid = child;
  struct sigaction passOn;
  memset(&passOn, 0, sizeof passOn);
  passOn.sa_handler = forward;
  passOn.sa_flags = SA_RESTART;
  sigaction(SIGTERM, &passOn, NULL);
  sigaction(SIGINT, &passOn, NULL);
  sigaction(SIGHUP, &passOn, NULL);
  sigaction(SIGQUIT, &passOn, NULL);
  char c;
  struct iovec io = {&c, 1};
  union {
    char buffer[CMSG_SPACE(sizeof(int))];
    struct cmsghdr align;
  } control;
  struct msghdr m = {.msg_iov = &io, .msg_iovlen = 1, .msg_control = control.buffer,
                     .msg_controllen = sizeof control.buffer};
  if (recvmsg(sv[0], &m, 0) != 1 || CMSG_FIRSTHDR(&m) == NULL) {
    int status;
    waitpid(child, &status, 0);
    fprintf(stderr, "smthrs-observe: this host gives no seccomp listener\n");
    return 126;
  }
  memcpy(&listener, CMSG_DATA(CMSG_FIRSTHDR(&m)), sizeof listener);
  mainThread = pthread_self();
  sigset_t waits;
  sigemptyset(&waits);
  sigaddset(&waits, SIGCHLD);
  sigaddset(&waits, SIGUSR2);
  pthread_sigmask(SIG_BLOCK, &waits, NULL);
  struct sigaction woken;
  memset(&woken, 0, sizeof woken);
  woken.sa_handler = wake; /* no SA_RESTART: a receive it interrupts returns */
  sigaction(SIGUSR1, &woken, NULL);
  /* One serving thread: a call costs a thread switch either way, and more threads that take turns cost more
   * processor time for the same wall time (measured on click's pre-commit and typing steps). */
  int threads = 1;
  pthread_t serving_[1];
  for (int i = 0; i < threads; i++) pthread_create(&serving_[i], NULL, serving, NULL);
  if (write(sv[0], "g", 1) != 1) return 125;
  close(sv[0]);

  int status = 0, code = 125, rootDone = 0;
  struct timespec deadline = {0, 0};
  for (;;) {
    serveSeizes();
    pid_t pid;
    while ((pid = waitpid(-1, &status, __WALL | WNOHANG)) > 0) {
      if (WIFEXITED(status) || WIFSIGNALED(status)) {
        if (pid == child) {
          code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
          commandPid = 0;
          rootDone = 1;
          clock_gettime(CLOCK_MONOTONIC, &deadline);
          deadline.tv_sec += 1;
          /* A step of a job ends with its command: what it left runs on, and is followed. */
          if (keepLeft && !writeStep(traceFile, code)) fprintf(stderr, "smthrs-observe: could not write %s\n", traceFile);
        }
        setWatched(pid, 0);
        dropKept(pid);
        continue;
      }
      if (!WIFSTOPPED(status)) continue;
      int sig = WSTOPSIG(status), event = status >> 16;
      if (event == PTRACE_EVENT_STOP) {
        if (sig == SIGSTOP || sig == SIGTSTP || sig == SIGTTIN || sig == SIGTTOU) ptrace(PTRACE_LISTEN, pid, 0, 0);
        else ptrace(PTRACE_CONT, pid, 0, 0);
      } else if (event == PTRACE_EVENT_EXEC) {
        /* A new program starts with every handler at its default: nothing to watch until it sets one. */
        setWatched(pid, 0);
        ptrace(PTRACE_DETACH, pid, 0, 0);
      } else if (event == PTRACE_EVENT_EXIT) {
        /* A thread that starts to end is let go: once it ended, its parent reaps it, not this supervisor. */
        setWatched(pid, 0);
        dropKept(pid);
        ptrace(PTRACE_DETACH, pid, 0, 0);
      } else if (event == PTRACE_EVENT_FORK || event == PTRACE_EVENT_VFORK || event == PTRACE_EVENT_CLONE) {
        sendAfterFork(pid);
        ptrace(PTRACE_CONT, pid, 0, 0);
      } else if (event != 0) {
        ptrace(PTRACE_CONT, pid, 0, 0);
      } else {
        int give = atSignal(pid, sig);
        ptrace(PTRACE_CONT, pid, 0, give);
      }
    }
    if (pid < 0 && errno == ECHILD) break;
    /* Signals come faster than a recorded call completes: the run is stopped, and runs again unrecorded. */
    if (__atomic_load_n(&stormed, __ATOMIC_ACQUIRE)) endLeft();
    if (rootDone) {
      struct timespec now;
      clock_gettime(CLOCK_MONOTONIC, &now);
      /* A process the command left running is given a second to end, then stopped, as a sandbox stops it. */
      if (keepLeft) writeKept(traceFile);
      else if (now.tv_sec > deadline.tv_sec || (now.tv_sec == deadline.tv_sec && now.tv_nsec >= deadline.tv_nsec)) endLeft();
    }
    sendStale();
    struct timespec tick = {0, 5000000};
    sigtimedwait(&waits, NULL, &tick);
  }
  /* No process of the run is left, so no call waits: the serving threads end. */
  __atomic_store_n(&stopping, 1, __ATOMIC_RELEASE);
  for (int i = 0; i < threads; i++) pthread_kill(serving_[i], SIGUSR1);
  for (int i = 0; i < threads; i++) {
    /* A thread between two receives misses one signal: it is sent again until the thread ends. */
    struct timespec soon;
    clock_gettime(CLOCK_REALTIME, &soon);
    soon.tv_nsec += 20000000;
    if (soon.tv_nsec >= 1000000000) {
      soon.tv_sec += 1;
      soon.tv_nsec -= 1000000000;
    }
    while (pthread_timedjoin_np(serving_[i], NULL, &soon) != 0) {
      pthread_kill(serving_[i], SIGUSR1);
      clock_gettime(CLOCK_REALTIME, &soon);
      soon.tv_nsec += 20000000;
      if (soon.tv_nsec >= 1000000000) {
        soon.tv_sec += 1;
        soon.tv_nsec -= 1000000000;
      }
    }
  }
  close(listener);
  boundSockets();
  settleMade(0);
#ifdef STORM_STATS
  fprintf(stderr, "storm-stats: most stops %u over %ld ms\n", mostStops, longestMs);
#endif
  if (keepLeft && rootDone) {
    /* Every process it followed has ended and every line is written: any request is answered, now and later. */
    writeKept(traceFile);
    char answeredFile[PATH_MAX + 32];
    snprintf(answeredFile, sizeof answeredFile, "%s.answered", traceFile);
    writeWhole(answeredFile, "9223372036854775807\n");
  } else if (!writeTrace(traceFile)) {
    fprintf(stderr, "smthrs-observe: could not write %s\n", traceFile);
  }
  return code;
}
