/*
 * smthrs-observe: records the file-system calls of a command, as `strace -f -y` would write them, without
 * stopping the command's threads.
 *
 *     smthrs-observe [--keep] <trace file> -- <command> [<argument>...]
 *     smthrs-observe --probe
 *     smthrs-observe --rights <program>...
 *     smthrs-observe --reap -- <command> [<argument>...]
 *     smthrs-observe --probe --reap
 *     smthrs-observe --guard -- <command> [<argument>...]
 *
 * The command runs under a seccomp filter whose listener this program holds. The kernel hands each watched call
 * to one of the supervisor's threads; only the calling thread waits, and the call then goes on in the kernel as
 * the command made it (`SECCOMP_USER_NOTIF_FLAG_CONTINUE`). The supervisor never makes a call for the command. One
 * call is answered instead of let go: `io_uring_setup`, with `ENOSYS`, as strace answers it.
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
 * - The answer is the kernel's where nothing races: `rmdir` of a directory that holds a file is `ENOTEMPTY`, `unlink`
 *   of a directory `EISDIR`, a rename across devices `EXDEV`, and so on, each from one look at the name.
 * - Another thread or process of the run can change the name, or the directory it goes in, between the stop and the
 *   call. So a call that makes or removes a name (open with O_CREAT, mkdir, mknod, unlink, rmdir, rename, link,
 *   symlink, a socket bound to a path) is looked at again once it has surely ended: its thread stops again, or waits
 *   in another call (`/proc/<thread>/syscall`), or the step's lines are taken, or the run ends. The calls on one name
 *   between those moments are one group, looked at again when the last has ended, and each line is given the answer
 *   the look after shows (resolve()). Where it cannot show it (two threads made and removed the
 *   name at once), the run is unrecorded and says so. A lookup, an open to read or an exec under way with such a
 *   call is left out where the name changed: it may have found it either way, and the name is the run's own.
 * - A thread that changes its process's working directory while another names a path from it makes the run
 *   unrecorded: the line could name another directory than the one the call started from.
 * - A connection to a socket path or a local port is asked again once it has ended, through a copy of its socket
 *   taken at the stop and let go within a tick: `getpeername` and `TCP_INFO` say whether it connected (never
 *   `SO_ERROR`, which takes the error the program waits for).
 * - A send that names an address (`sendto`, `sendmsg`, `sendmmsg`) is written with its addresses alone and no answer
 *   (`= ?`): a reader counts it as reaching each, as a connection would. A `sendto` that names none goes where its
 *   socket is connected and passes the filter unseen.
 * - Before a call that writes a name that is already there (a rename, a link, a symlink, an exclusive create), a
 *   line notes that the run found it there.
 * - A program a process starts is written with no answer (`= ?`): it counts as looked at and started, and changes
 *   nothing a reader keeps about the process. A second line (`= 0`) follows once `/proc/<process>/cmdline` shows
 *   the program's arguments at a later stop of that process.
 * - A socket counts as bound only once the socket itself says so (`getsockname` on a copy taken at the stop). The
 *   copy is let go as soon as the socket says so, at the next stop of the run or within a tick, before a bind or
 *   connect goes on: held longer, it would keep the port of a socket the run closed in use, and a program that
 *   listens on a port again (a lock made of a port, as eliza's build lock is) would find it taken. A copy whose
 *   socket is not bound once its thread is past the call was a bind that failed, and is let go too. A socket bound
 *   to port 0 is written with the port the kernel gave it, which the socket itself says. Only a socket of a family
 *   a line is written for (a path, IPv4, IPv6) is copied.
 * - This program holds descriptors of its own (those copies, and files of `/proc` it reads). It raises its limit
 *   to the most it may have, and the command starts with the limit it was given. Where one of its own opens still
 *   fails for want of a descriptor, the run is unrecorded and says so: no such failure is read as an answer.
 *
 * What a line says is read from the caller's memory at the stop (a path, an address, the flags of an `openat2`),
 * and the call then goes on in the kernel, which reads that memory again. A program that changes the memory between
 * the two, from another thread or another process that shares it, makes a call its line does not name: a record
 * holds only for a run that does not race the arguments of its own calls. io_uring is refused for the same reason,
 * where the kernel reads requests from shared memory as a matter of course.
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
 * made, until every process of the run has ended or the job's end kills this program. A reason the run cannot be
 * recorded, or a program that asks for rights, made after the step's trace was sealed is written there too, as the
 * same line. A reader that needs every line so far on disk asks (`.ask`) and is answered (`.answered`) only once
 * they are: lines that could not be written are lost, and no request is answered until `.kept` says so.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/if_packet.h>
#include <linux/netlink.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
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
#include <sys/resource.h>
#include <sys/user.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
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
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE 2
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

/* How the supervisor writes a call: the kinds of src/internal/RecordedCalls.ts. */
enum kind {
  K_OPEN,      /* a path opened, with flags */
  K_LOOK,      /* a path looked at */
  K_EXEC,      /* a program started */
  K_CHDIR,     /* chdir */
  K_MKDIR,     /* a directory made */
  K_MAKE,      /* mknod, mknodat: another name made where none was */
  K_REMOVE,    /* a name taken away */
  K_CHANGE,    /* a file's mode, owner, times, size or attributes changed, by path */
  K_CHANGE_FD, /* fchmod, fchown: the descriptor's file */
  K_RENAME,    /* rename, renameat, renameat2 */
  K_LINK,      /* link, linkat */
  K_SYMLINK,   /* symlink, symlinkat */
  K_CONNECT,
  K_BIND,
  K_SEND,      /* sendto, sendmsg, sendmmsg: the addresses it sends to, which reach what is there as a connect does */
  K_SPACE,     /* unshare with a new namespace */
  K_FORK,      /* fork, vfork, clone, clone3: a process (a thread is its process's), or a new namespace */
  K_RING,      /* io_uring_setup: answered ENOSYS by this program, so the run never has a ring */
  K_RING_ENTER,/* io_uring_enter, io_uring_register: a ring the run was given */
  K_FILTER,    /* seccomp: a filter of the run's own */
  K_HANDLER,   /* rt_sigaction: a handler that lets a signal cut a waiting call short */
  K_REFUSED,   /* a file named in a way no record can hold */
};

/* Where a call's arguments are: `dir` is the argument index of a directory descriptor (-1: the working
 * directory), `path` of the path (-1: none); `dir2`/`path2` likewise for a second path; `flags` the index of the
 * flags (-1: none), of which `followed` holds every bit the recorder follows exactly. */
struct call {
  int nr;
  const char *name;
  enum kind kind;
  signed char dir, path, dir2, path2, flags;
  unsigned char nofollow; /* the call does not follow a link at the end of its path */
  uint64_t followed;
};

#define CWD -1
#define NONE -1
/* A flag's value on this machine, where x86_64 and aarch64 differ. */
#if defined(__x86_64__)
#define FLAGS(x86_64, aarch64) (x86_64)
#else
#define FLAGS(x86_64, aarch64) (aarch64)
#endif
/* The table: calls[], LAST_KNOWN, OPEN_FOLLOWED and RESOLVE_FOLLOWED, written by scripts/build-observe.mjs. */
#include "calls.h"
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
  struct sock_filter f[24 + 4 * NCALLS];
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
      /* The flags' low word holds every namespace flag, and CLONE_FS: a thread that takes a working directory of
       * its own. */
      J(BPF_JMP | BPF_JEQ | BPF_K, calls[i].nr, 0, 4);
      S(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
      J(BPF_JMP | BPF_JSET | BPF_K, NEW_NAMESPACES | CLONE_FS, 0, 1);
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
    if (calls[i].nr == SYS_sendto) {
      /* A send that names no address goes where its socket is connected, which its connect said: it passes. */
      J(BPF_JMP | BPF_JEQ | BPF_K, calls[i].nr, 0, 6);
      S(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[4]));
      J(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 2);
      S(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[4]) + 4);
      J(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
      S(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
      S(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
      continue;
    }
    J(BPF_JMP | BPF_JEQ | BPF_K, calls[i].nr, 0, 1);
    S(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
  }
  /* A call numbered past the table may name a file in any way. */
  J(BPF_JMP | BPF_JGT | BPF_K, LAST_KNOWN, 0, 1);
  S(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF);
  S(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
#undef S
#undef J
  struct sock_fprog prog = {.len = (unsigned short)n, .filter = f};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER,
                      SECCOMP_FILTER_FLAG_NEW_LISTENER | SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV, &prog);
}

/* ---- Lines ---------------------------------------------------------------------------------------------------- */

/* A line's `sub` with this bit is left out of the trace: what it said may not be what the call found. */
#define LEFT_OUT 0x80000000u

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
/* Held while a stop is served, and while lines are taken: the calls under way are the serving thread's. */
static pthread_mutex_t serving_lock = PTHREAD_MUTEX_INITIALIZER;
static int stopping;
static pid_t rootPid;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static struct lines all;
static int dropped;
/* How many times the lines were taken (writeStep, writeKept): a place among them holds only in its own taking. */
static uint64_t linesTaken;

/* Reasons the run cannot be recorded, each once. Written and read under `lock`; a reason is never freed, so one
 * read under the lock may be written out after it. The last place holds only `manyReasons`. */
#define REASONS 64
static char *reasons[REASONS];
static int reasonCount;
static const char *manyReasons = "it could not be recorded for more reasons than the recorder lists";

static void unrecorded(const char *reason) {
  pthread_mutex_lock(&lock);
  for (int i = 0; i < reasonCount; i++)
    if (strcmp(reasons[i], reason) == 0) {
      pthread_mutex_unlock(&lock);
      return;
    }
  if (reasonCount < REASONS) {
    char *copy = strdup(reasonCount == REASONS - 1 ? manyReasons : reason);
    /* No memory for the reason: the run is unrecorded all the same, as one whose line could not be kept. */
    if (copy == NULL) __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
    else reasons[reasonCount++] = copy;
  }
  pthread_mutex_unlock(&lock);
}

/*
 * This program's own opens (a file of /proc, a copy of a socket) fail with EMFILE or ENFILE when it, or the machine,
 * has no descriptor left. Such a failure says nothing of the run: read as an answer, a thread would count as gone, a
 * bind as never made. The run is unrecorded instead. Set without `lock`, which a caller may hold; the reason is
 * written with the lines (writeLines, writeKept).
 */
static int starved;
static const char *starvedReason = "the recorder ran out of descriptors";
static const char *droppedReason = "the recorder could not keep every line";

/* Whether `error` says this program had no descriptor left; notes it when so. */
static int starvedBy(int error) {
  if (error != EMFILE && error != ENFILE) return 0;
  __atomic_store_n(&starved, 1, __ATOMIC_RELAXED);
  return 1;
}

/* A run that reached a file in a way no record can hold: `form` names the call, and the flag or form of it
 * (ObservedReads.cannotFollow). */
static void refuse(const char *form) {
  char reason[256];
  snprintf(reason, sizeof reason, "it reached a file in a way the recorder cannot follow: %s", form);
  unrecorded(reason);
}

/*
 * Programs the run started whose file asks for rights a process with no new privileges never gets: set-user-id,
 * set-group-id, or file capabilities (`security.capability`). This program sets no new privileges for the run, so
 * each one ran without what its file asks for, as it would not on a CI runner. The mount the file is on is not
 * asked: a jail that holds this program mounts every path `nosuid` itself.
 */
static char **rightsNeeded;
static int rightsCount, rightsRoom;

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
  if (rightsCount == rightsRoom) {
    int room = rightsRoom == 0 ? 16 : rightsRoom * 2;
    char **grown = realloc(rightsNeeded, (size_t)room * sizeof *grown);
    if (grown != NULL) {
      rightsNeeded = grown;
      rightsRoom = room;
    }
  }
  char *copy = rightsCount < rightsRoom ? strdup(program) : NULL;
  /* A program that cannot be listed is one the record would not name: the run is unrecorded instead. */
  if (copy == NULL) __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
  else rightsNeeded[rightsCount++] = copy;
  pthread_mutex_unlock(&lock);
}

static long keepIn(uint64_t id, uint32_t sub, struct text *t, uint64_t *taking);

/* Keeps a line; answers its place among the lines, or -1 when it could not be kept. */
static long keep(uint64_t id, uint32_t sub, struct text *t) { return keepIn(id, sub, t, NULL); }

/* keep(), also saying in which taking of the lines the place holds. */
static long keepIn(uint64_t id, uint32_t sub, struct text *t, uint64_t *taking) {
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
      __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
      pthread_mutex_unlock(&lock);
      free(t->data);
      return -1;
    }
    all.items = items;
    all.capacity = capacity;
  }
  long place = (long)all.count;
  all.items[all.count++] = (struct line){id, sub, (uint32_t)t->length, t->data};
  if (taking != NULL) *taking = linesTaken;
  pthread_mutex_unlock(&lock);
  return place;
}

/* keepIn() for a line of the call that waits for this answer. What was read of the caller's memory is the call's only
 * while the call still waits (seccomp_unotify(2): SECCOMP_IOCTL_NOTIF_ID_VALID after reading it). A call that no
 * longer waits ended with its thread, or went on as nobody read it, and is received again if it starts again. Nothing
 * is written of it: the answer is -1, as for a line that could not be kept, and the run is not dropped for it. */
static long keepCallIn(uint64_t id, uint32_t sub, struct text *t, uint64_t *taking) {
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &id) != 0) {
    free(t->data);
    t->data = NULL;
    return -1;
  }
  return keepIn(id, sub, t, taking);
}

static long keepCall(uint64_t id, uint32_t sub, struct text *t) { return keepCallIn(id, sub, t, NULL); }

/* How many programs each process has been told to start, as a number no other process and no other program of the
 * run has: a process seen for the first time, one that starts a program, and one whose id an earlier process had
 * each take the next number. `started` is when the process began, as the kernel counts it, which tells a process
 * from an earlier one of the same id. Read and written under `lock`. */
#define GENERATIONS 8192
static struct generation {
  pid_t tgid;
  unsigned count;
  uint64_t started;
  uint32_t checked; /* when `started` was last read, in milliseconds */
} generations[GENERATIONS];
static unsigned lastGeneration;

/* The place of a process among them, made when it has none. Where the places near its own are all taken, as after a
 * run of many thousands of processes, it takes its own place from the process there, which is given a number again
 * when it is next seen: a number is never one another process had. Called with `lock` held. */
static struct generation *generationOf(pid_t tgid) {
  unsigned slot = (unsigned)tgid % GENERATIONS;
  struct generation *g = NULL;
  for (unsigned i = 0; i < 64 && g == NULL; i++) {
    unsigned at = (slot + i) % GENERATIONS;
    if (generations[at].tgid == tgid) return &generations[at];
    if (generations[at].tgid == 0) g = &generations[at];
  }
  if (g == NULL) g = &generations[slot];
  *g = (struct generation){tgid, ++lastGeneration, 0, 0};
  return g;
}

/* A process starts a program, or is another process than the one that had its id. Called with `lock` held. */
static void nextGeneration(pid_t tgid) { generationOf(tgid)->count = ++lastGeneration; }

/* When a process began, in the kernel's clock ticks since the machine started (`/proc/<pid>/stat`, field 22); 0 when
 * it cannot be read. */
static uint64_t startedAt(pid_t tgid) {
  char name[64], buffer[1024];
  snprintf(name, sizeof name, "/proc/%d/stat", tgid);
  int fd = open(name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    starvedBy(errno);
    return 0;
  }
  ssize_t n = read(fd, buffer, sizeof buffer - 1);
  close(fd);
  if (n <= 0) return 0;
  buffer[n] = 0;
  /* The program's name, which may hold any byte, ends at the last `)`; the state is field 3. */
  char *at = strrchr(buffer, ')');
  if (at == NULL) return 0;
  at++;
  for (int field = 3; field < 22; field++) {
    at = strchr(at + 1, ' ');
    if (at == NULL) return 0;
  }
  return strtoull(at + 1, NULL, 10);
}

/*
 * A thread's process. A thread id is not given again while the thread lives, but is once it ended: where ids wrap
 * (`kernel.pid_max` is 32768 on many machines, and a process namespace starts again at 1), a thread of another
 * process, or a new process, takes the id of a thread that ended. So what was read of a thread is held only while it
 * still is that thread:
 *
 * - A thread this program saw end (the main loop reaps it, or is told it starts to end) is forgotten then (forget).
 * - An id read `TGID_FRESH_MS` or longer ago is asked again: whether its process is still the one that began when
 *   it did, and the thread still one of its threads (`/proc/<process>/task/<thread>`). An id is given again only
 *   after every other id was, which takes far longer.
 * - A process read anew is held against when it began: another process than the one that had the id takes a new
 *   number, so nothing an earlier process asked counts as asked by it.
 *
 * A thread that ended keeps its slot until another thread needs it: where the slots near a thread's own are all
 * taken, as after a run started many thousands of threads, the thread takes its own slot. Without that, each call of
 * every later thread read /proc/<thread>/status again: 9 million reads, 38 s of shadcn-ui/ui's tests.
 */
#define TGIDS 8192
#define TGID_GONE (-1) /* a slot whose thread was forgotten: a search goes on past it */
static struct {
  pid_t tid, tgid;
  uint32_t checked; /* when it was last known to be so, in milliseconds */
} tgids[TGIDS];

static void bornOf(pid_t tgid, pid_t parent);
static void ownCwdEnded(pid_t tid);

#define TGID_FRESH_MS 10

/*
 * Whether a process is still the one known by its id: it began when the one known did. Another process than the one
 * that last had the id takes a new number, so it is another process to everything kept by process. What was read
 * less than `TGID_FRESH_MS` ago stands: the threads of one process, started by the thousand, read it once.
 */
static int sameProcess(pid_t tgid, uint32_t now) {
  pthread_mutex_lock(&lock);
  struct generation *g = generationOf(tgid);
  int fresh = g->started != 0 && now - g->checked < TGID_FRESH_MS;
  pthread_mutex_unlock(&lock);
  if (fresh) return 1;
  uint64_t started = startedAt(tgid);
  if (started == 0) return 0;
  pthread_mutex_lock(&lock);
  g = generationOf(tgid);
  int same = g->started == started;
  if (g->started != 0 && !same) g->count = ++lastGeneration;
  g->started = started;
  g->checked = now;
  pthread_mutex_unlock(&lock);
  return same;
}

static uint32_t nowMs(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint32_t)((uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_nsec / 1000000u);
}

/* A thread ended: its id may be given to another. */
static void forget(pid_t tid) {
  unsigned slot = (unsigned)tid % TGIDS;
  pthread_mutex_lock(&lock);
  for (unsigned i = 0; i < 16; i++) {
    unsigned at = (slot + i) % TGIDS;
    if (tgids[at].tid == tid) tgids[at].tid = TGID_GONE;
  }
  pthread_mutex_unlock(&lock);
  ownCwdEnded(tid);
}

static pid_t tgidOf(pid_t tid) {
  unsigned slot = (unsigned)tid % TGIDS;
  uint32_t now = nowMs();
  pid_t held = 0;
  pthread_mutex_lock(&lock);
  for (unsigned i = 0; i < 16; i++) {
    unsigned at = (slot + i) % TGIDS;
    if (tgids[at].tid == tid) {
      pid_t tgid = tgids[at].tgid;
      if (now - tgids[at].checked < TGID_FRESH_MS) {
        pthread_mutex_unlock(&lock);
        return tgid;
      }
      held = tgid;
      break;
    }
    if (tgids[at].tid == 0) break;
  }
  pthread_mutex_unlock(&lock);
  char name[64], buffer[1024];
  if (held != 0) {
    /* Still a thread of the process it was, which began when it did: the id was not given again. */
    snprintf(name, sizeof name, "/proc/%d/task/%d", held, tid);
    if (sameProcess(held, now) && (held == tid || faccessat(AT_FDCWD, name, F_OK, 0) == 0)) {
      pthread_mutex_lock(&lock);
      for (unsigned i = 0; i < 16; i++) {
        unsigned at = (slot + i) % TGIDS;
        if (tgids[at].tid == tid && tgids[at].tgid == held) tgids[at].checked = now;
      }
      pthread_mutex_unlock(&lock);
      return held;
    }
    /* The thread it was has ended, and so has what was known of it. */
    forget(tid);
  }
  snprintf(name, sizeof name, "/proc/%d/status", tid);
  int fd = open(name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    starvedBy(errno);
    return tid;
  }
  ssize_t n = read(fd, buffer, sizeof buffer - 1);
  close(fd);
  if (n <= 0) return tid;
  buffer[n] = 0;
  char *at = strstr(buffer, "\nTgid:");
  pid_t tgid = at == NULL ? tid : (pid_t)strtol(at + 6, NULL, 10);
  char *parentAt = strstr(buffer, "\nPPid:");
  (void)sameProcess(tgid, now);
  if (tgid == tid && parentAt != NULL) bornOf(tgid, (pid_t)strtol(parentAt + 6, NULL, 10));
  pthread_mutex_lock(&lock);
  unsigned place = slot;
  int placed = 0;
  for (unsigned i = 0; i < 16 && !placed; i++) {
    unsigned at = (slot + i) % TGIDS;
    if (tgids[at].tid == tid) {
      place = at;
      placed = 1;
    }
    if (tgids[at].tid == 0) break;
  }
  for (unsigned i = 0; i < 16 && !placed; i++) {
    unsigned at = (slot + i) % TGIDS;
    if (tgids[at].tid == 0 || tgids[at].tid == TGID_GONE) {
      place = at;
      placed = 1;
    }
  }
  tgids[place].tid = tid;
  tgids[place].tgid = tgid;
  tgids[place].checked = now;
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
  char *path;   /* the program, as the line names it */
  uint64_t taking;
  long place;   /* the line's place, and where its answer starts */
  size_t at;
  int missing;  /* the look found no program: the line says ENOENT, until a later stop shows the program started */
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
  pthread_mutex_lock(&lock);
  unsigned generation = generationOf(tgid)->count;
  pthread_mutex_unlock(&lock);
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
    again = found->generation == generation && found->changed == changed && found->error == error;
    found->generation = generation;
    found->changed = changed;
    found->error = error;
  } else if (askedCount < ASKED_MOST) {
    size_t length = strlen(path) + 1;
    struct asked *made = malloc(sizeof *made + length);
    if (made != NULL) {
      *made = (struct asked){*bucket, tgid, generation, changed, error, how};
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
  pid_t tid, tgid;
  int nr, fd;
  int copy;
  struct sockaddr_storage asked, now; /* what the call asked for, and where the socket says it is bound */
  socklen_t askedLength;
  char *line; /* as the call asked; a port the kernel chose is written in its place (written) */
  struct binding *next;
};
static struct binding *bindings;
static void settleBindings(pid_t stopped);

/* ---- Reading the stopped thread ------------------------------------------------------------------------------ */

/*
 * A read of a thread's memory fails for an address the thread gave that is none of its own (`EFAULT`, `EIO`), which
 * the kernel refuses the call for too, or for a thread that is gone (`ESRCH`), whose call never runs. Any other
 * failure is the recorder's, not the call's: the kernel refuses the read (`EPERM`: the process set itself not
 * dumpable with `prctl(PR_SET_DUMPABLE, 0)`, runs a program no one may read, or took another user's id where this
 * program lacks CAP_SYS_PTRACE; `ENOSYS`: the machine has no such call). The call still goes on in the kernel and
 * reads its file, and no line can name it: the run is unrecorded. The same holds for where a thread is and what its
 * descriptors name (`/proc/<thread>/cwd`, `/proc/<thread>/fd/<n>`), which the kernel refuses with `EACCES`.
 */
static const char *blindMemory = "the recorder may not read the memory of a process of the run";
static const char *blindLinks =
  "the recorder may not read the working directory or the descriptors of a process of the run";

/* Notes a read of a thread's memory that failed with `error`, where that says nothing of the address. */
static void memoryRefused(int error) {
  if (error != EFAULT && error != EIO && error != ESRCH) unrecorded(blindMemory);
}

/* Whether a readlink of a process's link failed because this program may not read it; notes it when so. */
static int linkRefused(int error) {
  if (error != EACCES && error != EPERM) return 0;
  unrecorded(blindLinks);
  return 1;
}

/* A zero-ended string at `address` in the thread's memory; 0 when it cannot be read. */
static int stringAt(pid_t tid, uint64_t address, char *out, size_t capacity) {
  size_t got = 0;
  if (address == 0) return 0;
  while (got < capacity - 1) {
    size_t page = 4096 - ((address + got) & 4095);
    size_t want = page < capacity - 1 - got ? page : capacity - 1 - got;
    struct iovec local = {out + got, want}, remote = {(void *)(uintptr_t)(address + got), want};
    ssize_t n = process_vm_readv(tid, &local, 1, &remote, 1, 0);
    if (n < 0) memoryRefused(errno);
    if (n <= 0) return 0;
    if (memchr(out + got, 0, (size_t)n) != NULL) return 1;
    got += (size_t)n;
  }
  return 0; /* longer than any path */
}

static int bytesAt(pid_t tid, uint64_t address, void *out, size_t length) {
  struct iovec local = {out, length}, remote = {(void *)(uintptr_t)address, length};
  ssize_t n = process_vm_readv(tid, &local, 1, &remote, 1, 0);
  if (n < 0) memoryRefused(errno);
  return n == (ssize_t)length;
}

/* Where a directory descriptor (or the working directory, for AT_FDCWD) of the thread is. 0 when it has none, or
 * when this program may not read it, which makes the run unrecorded (linkRefused). */
static int placeOf(pid_t tid, int fd, char *out, size_t capacity) {
  char link[64];
  if (fd == AT_FDCWD)
    snprintf(link, sizeof link, "/proc/%d/cwd", tid);
  else
    snprintf(link, sizeof link, "/proc/%d/fd/%d", tid, fd);
  ssize_t n = readlink(link, out, capacity - 1);
  if (n < 0) linkRefused(errno);
  /* A name that fills the buffer may have been cut short. */
  if (n <= 0 || (size_t)n == capacity - 1) return 0;
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
 * goes back up (`..`) inside `/proc` or `/dev`, or its link leads to a file that was removed. `*linked`, when asked
 * for, is set where the path names such a link, followed or not.
 *
 * A link of a process named by its number is followed only for a process of the run (ofRun). One of a process the
 * run did not start leads wherever that process is or has open, which no line of the trace shows: followed, the line
 * would name the file as if the run had found it by its path, and a record would hold the file and never which file
 * the other process chose. Its path is left as the run named it, under `/proc/<pid>`, and the reader refuses it.
 */
static void rootedView(char *path);

/*
 * Whether a process is one of the run: this program is above it. The command is this program's child, and every
 * process it leaves comes to this program when its parent ends (a child subreaper), so the parents of a process of
 * the run lead here; those of any other process do not. A process that cannot be asked about is taken as not of the
 * run.
 */
static int ofRun(pid_t process) {
  pid_t self = getpid();
  for (int hop = 0; hop < 4096 && process > 1; hop++) {
    if (process == self) return hop > 0;
    char name[64], buffer[1024];
    snprintf(name, sizeof name, "/proc/%d/stat", process);
    int fd = open(name, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
      starvedBy(errno);
      return 0;
    }
    ssize_t n = read(fd, buffer, sizeof buffer - 1);
    close(fd);
    if (n <= 0) return 0;
    buffer[n] = 0;
    /* The program's name, which may hold any byte, ends at the last `)`; the state and the parent follow. */
    char *end = strrchr(buffer, ')');
    int parent = 0;
    if (end == NULL || sscanf(end + 1, " %*c %d", &parent) != 1) return 0;
    process = (pid_t)parent;
  }
  return 0;
}

static int stepViewed(pid_t tid, char *path, size_t capacity, const char **why, int *linked) {
  for (int hop = 0; hop < 40; hop++) {
    rootedView(path);
    const char *at = path;
    size_t n = partOf(&at);
    long process = -1, thread = -1, fd = -1;
    int numbered = 0; /* the path names its process by number */
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
      } else {
        numbered = 1;
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
    if (linked != NULL) *linked = 1;
    /* A link of a process outside the run: left as the run named it. */
    if (numbered && process != tgid && !ofRun((pid_t)process)) return 1;
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
    /* A link of the run this program may not read: the call may follow it all the same, so the run is unrecorded. */
    if (got < 0) linkRefused(errno);
    /* No such process or descriptor: the call fails as the kernel answers it, and reads nothing. */
    if (got <= 0) return 1;
    /* A name that fills the buffer may have been cut short. */
    if ((size_t)got >= sizeof target - 1) {
      *why = "long";
      return 0;
    }
    target[got] = 0;
    /* A pipe, a socket, an anonymous file the run made in memory: no file of the run. */
    if (target[0] != '/' || strncmp(target, "/memfd:", 7) == 0) return 1;
    snprintf(rest, sizeof rest, "%s", at);
    if (got > 10 && strcmp(target + got - 10, " (deleted)") == 0) {
      const char *after = rest;
      /* The descriptor's own file, which the run opened, or made with no name (O_TMPFILE): the path stays under
       * /proc, where no record looks. A path below it would go on from a directory that is gone. */
      if (partOf(&after) == 0) return 1;
      *why = "removed";
      return 0;
    }
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
    int written = *more == 0  ? snprintf(path, capacity, "%s", target)
                : length == 1 ? snprintf(path, capacity, "/%s", more)
                              : snprintf(path, capacity, "%s/%s", target, more);
    if (written < 0 || (size_t)written >= capacity) {
      *why = "long";
      return 0;
    }
  }
  *why = "up";
  return 0;
}

static int stepView(pid_t tid, char *path, size_t capacity, const char **why) {
  return stepViewed(tid, path, capacity, why, NULL);
}

/*
 * A path that goes up to the root before it names `/proc` or `/dev` (`/tmp/../proc/self/fd/3`, or
 * `../../proc/self/cwd/x` from a working directory) reaches the same links of a process, and looked at as written it
 * would be followed in this program's view, not the caller's. Where the names before `proc` or `dev` lead back to
 * the root, which one look at them says (they hold a link where they do not), the path is written from the root, and
 * stepView follows it. Each `proc` or `dev` after a `..` is asked about so, however deep the names before it seem:
 * a `..` after a link goes up from where the link leads, so counting names says nothing (`/x/link/../proc` is
 * `/proc` where `link` leads to `/a`), and names that do not lead to the root say nothing of a later `proc` that
 * does. A path with no `..` is left as it is, and so is one whose names lead elsewhere. A path that starts in
 * `/proc` or `/dev` is stepView's: its names are a process's links, which a look from here would follow as this
 * program's own.
 */
static void rootedView(char *path) {
  if (path[0] != '/' || strstr(path, "/..") == NULL) return;
  int up = 0, first = 1;
  const char *at = path;
  for (size_t n = partOf(&at); n > 0; at += n, n = partOf(&at)) {
    int kernel = partIs(at, n, "dev") || partIs(at, n, "proc");
    if (first && kernel) return;
    first = 0;
    if (partIs(at, n, "..")) {
      up = 1;
      continue;
    }
    if (!up || !kernel) continue;
    char before[PATH_MAX + 1];
    size_t length = (size_t)(at - path);
    if (length >= sizeof before) return;
    memcpy(before, path, length);
    before[length] = 0;
    struct stat root, reached;
    if (stat("/", &root) != 0) return;
    /* These names lead elsewhere: a later `proc` or `dev` may still be reached from the root. */
    if (stat(before, &reached) != 0 || root.st_dev != reached.st_dev || root.st_ino != reached.st_ino) continue;
    memmove(path + 1, at, strlen(at) + 1);
    return;
  }
}

/* A path a call names, made absolute from the directory it starts from, and followed in the caller's view through
 * any link the kernel makes for a process (stepView). `*empty` is set for an empty path, which names the
 * descriptor itself. Answers 0 with `why` when the path cannot be known. */
static void fromCwd(pid_t tid, pid_t tgid, int nr, const char *cwd);

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
  int placed = placeOf(tid, fd, base, sizeof base);
  /* An empty path names the descriptor itself. One that is no file of the file system, as a pipe or a socket, names
   * no path: the call looks at no file. `fstat` comes so from libuv, and from the C library where it is `newfstatat`
   * with an empty path (glibc 2.33 to 2.38). */
  if (placed && path[0] == 0 && fd != AT_FDCWD && base[0] != '/') {
    *why = "none";
    return 0;
  }
  if (!placed || base[0] != '/') {
    *why = "base";
    return 0;
  }
  if (fd == AT_FDCWD) fromCwd(tid, tgidOf(tid), req->data.nr, base);
  /* A path from a deep directory can be longer than one call takes: no later look can name its file. */
  int n = path[0] == 0              ? snprintf(out, capacity, "%s", base)
        : strcmp(base, "/") == 0    ? snprintf(out, capacity, "/%s", path)
                                    : snprintf(out, capacity, "%s/%s", base, path);
  if (n < 0 || (size_t)n >= capacity) {
    *why = "long";
    return 0;
  }
  return stepView(tid, out, capacity, why);
}

/*
 * Whether a path is the machine's state and no file of the run: under `/proc`, `/dev` or `/sys`. `/dev/shm` is not:
 * it holds files as any directory does (POSIX shared memory, and whatever a program writes there), which a step can
 * read as it reads any other input (ObservedReads.pseudo).
 */
static int pseudo(const char *path) {
  if (strncmp(path, "/dev/shm", 8) == 0 && (path[8] == 0 || path[8] == '/')) return 0;
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

/* ---- Calls that change a name, until they have surely ended ---------------------------------------------------- */

/*
 * A call that makes or removes a name gets its answer from a look at its stop, and goes on in the kernel after. The
 * look can be wrong: another thread may change the name, or the directory it goes in, before the call runs. So each
 * such call is looked at again once it has surely ended: when its thread stops again, when its thread is found
 * waiting in another call, or at the end of the run. Calls of the run on the same name between those two moments
 * make one group, looked at again together when the last of them has ended.
 *
 * - A call alone in its group: the look after says what the call did, and the line is given that answer.
 * - Calls together on one name that only make it (or only remove it): the look before the first and the look after
 *   the last say whether one of them made it (removed it). The line of the first that could have is given success,
 *   each other one the failure the kernel gives where the name is (is not). A line may so name the wrong one of two
 *   threads; what the run did to the name, and in what state it found and left it, is exact.
 * - Calls together that make and remove the name: the lines stand where, taken in order, they leave the name as it
 *   is; otherwise the run is not recorded, and says so.
 */

/* What is at a name: nothing, or a file of a kind with its identity. A file's number is given again soon after the
 * file is removed, so the time it was made is part of who it is, where the file system keeps one. */
struct ident {
  int there;
  dev_t dev;
  ino_t ino;
  mode_t type;
  int64_t born;
  uint32_t bornNs;
};

/* statx's answer, as linux/stat.h lays it out (the C library may lack it). */
struct statxAnswer {
  uint32_t mask, blksize;
  uint64_t attributes;
  uint32_t nlink, uid, gid;
  uint16_t mode, spare0;
  uint64_t ino, size, blocks, attributesMask;
  struct { int64_t sec; uint32_t nsec; int32_t spare; } atime, btime, ctime, mtime;
  uint32_t rdevMajor, rdevMinor, devMajor, devMinor;
  uint64_t spare2[14];
};
#ifndef SYS_statx
#if defined(__aarch64__)
#define SYS_statx 291
#else
#define SYS_statx 332
#endif
#endif

/* Looks at a name without following a link at its end: 0 when something is there, or the error. */
static int identify(const char *path, struct ident *out) {
  memset(out, 0, sizeof *out);
  if (pseudo(path)) {
    out->there = 1;
    return 0;
  }
  struct statxAnswer x;
  if (syscall(SYS_statx, AT_FDCWD, path, AT_NO_AUTOMOUNT | AT_SYMLINK_NOFOLLOW, 0x1 | 0x100 | 0x800 /* type, ino, btime */,
              &x) != 0)
    return errno;
  out->there = 1;
  out->dev = makedev(x.devMajor, x.devMinor);
  out->ino = x.ino;
  out->type = x.mode & S_IFMT;
  if (x.mask & 0x800) {
    out->born = x.btime.sec;
    out->bornNs = x.btime.nsec;
  }
  return 0;
}

static int sameIdent(const struct ident *a, const struct ident *b) {
  return a->there == b->there && (!a->there || (a->dev == b->dev && a->ino == b->ino && a->type == b->type &&
                                                a->born == b->born && a->bornNs == b->bornNs));
}

static int sameFile(const struct ident *a, const struct ident *b) {
  return a->there && b->there && a->dev == b->dev && a->ino == b->ino && a->born == b->born && a->bornNs == b->bornNs;
}

/* Whether a directory holds anything: what rmdir answers. */
static int holdsAnything(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    starvedBy(errno);
    return 0;
  }
  char buffer[4096];
  int any = 0;
  long n;
  while (!any && (n = syscall(SYS_getdents64, fd, buffer, sizeof buffer)) > 0) {
    for (long at = 0; at < n && !any;) {
      struct {
        uint64_t ino;
        int64_t off;
        unsigned short reclen;
        unsigned char type;
        char name[];
      } *d = (void *)(buffer + at);
      if (strcmp(d->name, ".") != 0 && strcmp(d->name, "..") != 0) any = 1;
      at += d->reclen;
    }
  }
  close(fd);
  return any;
}

/* The device of the directory a name goes in. */
static dev_t deviceAbove(const char *path) {
  char parent[PATH_MAX + 1];
  snprintf(parent, sizeof parent, "%s", path);
  size_t length = strlen(parent);
  while (length > 1 && parent[length - 1] == '/') parent[--length] = 0;
  char *slash = strrchr(parent, '/');
  if (slash == NULL) return 0;
  if (slash == parent) slash[1] = 0;
  else *slash = 0;
  struct stat st;
  return stat(parent, &st) == 0 ? st.st_dev : 0;
}

/* A line whose answer may be set again: its place among the lines and where its answer starts. Shared by the two
 * names of a rename. */
struct answered {
  uint64_t taking;
  long place;
  size_t at;
  int answer;     /* written: 0 or an errno */
  int settledBy;  /* how many of its names set it */
  int holders;
  char *suffix;   /* what follows an answer of 0, or NULL: the file an openat2 with RESOLVE_* flags opens */
};

static void freeAnswered(struct answered *a) {
  free(a->suffix);
  free(a);
}

enum effect { MAKES, REMOVES };

struct change {
  struct change *nextOfThread, *nextInGroup;
  struct group *group;
  struct answered *line;
  pid_t tid;
  int nr;
  enum effect effect;
  int exclusive;      /* fails where something is: mkdir, O_EXCL, link, symlink */
  int renaming;       /* a name of a rename; `moved` is the file it moves from `from` */
  struct ident moved;
  char *from;
  int sourceGone;     /* looked at once the rename ended: the moved file is no longer at `from` */
  int predicted;      /* the answer its look gave */
  int given;
  struct ident before;
  int form;           /* which call: mkdir, a create, unlink, rmdir, ... (one group's calls of one form agree) */
  mode_t makesType;   /* the kind of file it makes, or 0 when not known */
};

enum { F_CREATE = 1, F_EXCL, F_MKDIR, F_LINK, F_SYMLINK, F_UNLINK, F_RMDIR, F_RENAME, F_BIND, F_MKNOD };

static void formOf(struct change *c, int form, mode_t type) {
  if (c == NULL) return;
  c->form = form;
  c->makesType = type;
}

struct group {
  struct group *next;
  char *name;
  uint64_t since;        /* the directory renames noted before its first call */
  struct ident start;
  int open;
  int count;
  struct change *members; /* newest first */
  /* Lines of lookups made while a call of the group may still have been under way: what each found is the name as it
   * was at its look, which the call may since have changed. */
  struct { uint64_t taking; long place; } *uncertain;
  int uncertainCount, uncertainRoom;
};

/*
 * Directories the run renamed, in order: a name in one of them is at another path once the rename went on, so the
 * look after a call follows the renames noted since the call's group began. A rename that failed left the name where
 * it was: the name is looked for there first.
 */
#define MOVES 4096
static struct {
  char *from, *to;
} moves[MOVES];
static uint64_t moveCount;

static void keyOf(const char *name, char *out, size_t capacity);

static void movedDirectory(const char *from, const char *to) {
  unsigned at = (unsigned)(moveCount % MOVES);
  free(moves[at].from);
  free(moves[at].to);
  char key[PATH_MAX + 1];
  keyOf(from, key, sizeof key);
  moves[at].from = strdup(key);
  keyOf(to, key, sizeof key);
  moves[at].to = strdup(key);
  moveCount++;
}

#define GROUP_BUCKETS 4096
#define THREAD_BUCKETS 1024
static struct group *groups[GROUP_BUCKETS];
static struct change *openOf[THREAD_BUCKETS];

/* A name as groups know it: `.` parts, doubled slashes and a slash at the end left out (`a/./b//` is `a/b`). */
static void keyOf(const char *name, char *out, size_t capacity) {
  if (capacity == 0) return;
  size_t n = 0;
  for (const char *at = name; *at != 0 && n + 1 < capacity;) {
    if (*at == '/') {
      while (*at == '/') at++;
      if (at[0] == '.' && (at[1] == '/' || at[1] == 0)) {
        at++;
        continue;
      }
      if (*at == 0) break;
      out[n++] = '/';
      continue;
    }
    out[n++] = *at++;
  }
  if (n == 0 && name[0] == '/' && n + 1 < capacity) out[n++] = '/';
  out[n] = 0;
}

static uint64_t fullHash(const char *name) {
  uint64_t h = 1469598103934665603ull;
  for (const char *at = name; *at != 0; at++) h = (h ^ (unsigned char)*at) * 1099511628211ull;
  return h;
}

static unsigned nameHash(const char *name) { return (unsigned)(fullHash(name) % GROUP_BUCKETS); }

/*
 * Each thread's last lookup, while the thread may still be in it: a call that changes the name noted meanwhile makes
 * what the lookup found uncertain, as a lookup noted while such a call is under way is (busyOn).
 */
struct looking {
  struct looking *next; /* in its name's bucket */
  pid_t tid;
  int nr;
  uint64_t hash;
  uint64_t taking;
  long place, place2;
  int used;
};
#define LOOKINGS 4096
static struct looking lookings[LOOKINGS];
static struct looking *lookBuckets[GROUP_BUCKETS];

static void unlook(struct looking *l) {
  if (!l->used) return;
  for (struct looking **at = &lookBuckets[l->hash % GROUP_BUCKETS]; *at != NULL; at = &(*at)->next)
    if (*at == l) {
      *at = l->next;
      break;
    }
  l->used = 0;
}

/* A thread stopped again: its last lookup has ended. */
static void lookEnded(pid_t tid) {
  struct looking *l = &lookings[(unsigned)tid % LOOKINGS];
  if (l->used && l->tid == tid) unlook(l);
}

/* A thread looks up `name`: its line's place is noted once kept. */
static struct looking *lookStarts(pid_t tid, int nr, const char *spelled) {
  struct looking *l = &lookings[(unsigned)tid % LOOKINGS];
  unlook(l);
  char name[PATH_MAX + 1];
  keyOf(spelled, name, sizeof name);
  uint64_t h = fullHash(name);
  *l = (struct looking){lookBuckets[h % GROUP_BUCKETS], tid, nr, h, 0, -1, -1, 1};
  lookBuckets[h % GROUP_BUCKETS] = l;
  return l;
}

/* Whether a thread is surely past a call: it waits in another call, or it is gone. A thread that runs may still be
 * in it, and so may one this program could not ask about for want of a descriptor. */
static int pastCall(pid_t tid, int nr) {
  char name[64], text[64];
  snprintf(name, sizeof name, "/proc/%d/syscall", tid);
  int fd = open(name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return !starvedBy(errno);
  ssize_t n = read(fd, text, sizeof text - 1);
  close(fd);
  if (n <= 0) return 0;
  text[n] = 0;
  if (strncmp(text, "running", 7) == 0) return 0;
  return strtol(text, NULL, 10) != nr;
}

/* Writes `text` as the answer of the line at `place` of `taking`, from `at`; `text` NULL leaves the line out.
 * Answers 0 when the line was already written (the step it belongs to ended). */
static int setAnswer(uint64_t taking, long place, size_t at, const char *text) {
  if (place < 0) return 1;
  size_t length = text == NULL ? 0 : strlen(text);
  pthread_mutex_lock(&lock);
  if (taking != linesTaken || (size_t)place >= all.count) {
    pthread_mutex_unlock(&lock);
    return 0;
  }
  struct line *l = &all.items[place];
  if (text == NULL) {
    l->sub |= LEFT_OUT;
    pthread_mutex_unlock(&lock);
    return 1;
  }
  l->sub &= ~LEFT_OUT; /* what a later stop showed is certain */
  char *data = at <= l->length ? realloc(l->text, at + length) : NULL;
  if (data != NULL) {
    memcpy(data + at, text, length);
    l->text = data;
    l->length = (uint32_t)(at + length);
  } else {
    __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
  }
  pthread_mutex_unlock(&lock);
  return 1;
}

/* A line written before what it says was known: a call of a program the step left running, looked at again after
 * the step's lines were written. */
static const char *lateAnswer =
  "a call made while the step ended changed a name in a way its written line does not say";

/* Sets a line's answer, once for each name it holds; two names that set it otherwise make the run unrecorded. */
static void answerAgain(struct answered *a, int value) {
  if (a->settledBy > 0 && a->answer != value) {
    unrecorded("a rename's two names said otherwise of what it did, while other calls changed them at once");
    return;
  }
  a->settledBy++;
  if (a->answer == value) return;
  a->answer = value;
  if (a->place < 0) return;
  struct text t = {0};
  answer(&t, value);
  /* A line that says the call opened a file says which, as the line first written would have. */
  if (value == 0 && a->suffix != NULL) puts_(&t, a->suffix);
  if (t.failed) __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
  else if (!setAnswer(a->taking, a->place, a->at, t.data)) unrecorded(lateAnswer);
  free(t.data);
}

static void unknownChange(const char *name, const char *how) {
  char reason[PATH_MAX + 256];
  snprintf(reason, sizeof reason, "%s %s", name, how);
  unrecorded(reason);
}

static const char *failedUnseen =
  "was not changed by a call that the recorder saw would change it, for a reason the recorder cannot see";
static const char *changedUnseen = "was changed while the run ran by something the recorder does not see";

/* A rename's answer, from both its names once it has ended: it moved the file when the file is no longer at the old
 * name and is at the new one, or another rename onto the new name of the same group may have replaced it since. */
static int renameAnswer(const struct change *m, const struct ident *after, int renames) {
  if (!m->sourceGone) return m->predicted != 0 ? m->predicted : -1;
  if (sameFile(after, &m->moved)) return 0;
  /* Alone on the new name, which now holds another file than before: only the rename can have put it there (a file
   * copied up by an overlay file system gets a new number). */
  if (renames > 1 || (after->there && !sameIdent(&m->before, after))) return 0;
  /* Gone from the old name and not at the new one: another call took it first. */
  return ENOENT;
}

static void resolveIn(struct group *g, struct change **order, struct ident *afterNow);
static int ended(struct change *c);
static void settleName(const char *name);
static void whereNow(const struct group *g, struct ident *after);

/* Every call of a group has ended: `after` is what is at the name now. */
static void resolve(struct group *g) {
  struct ident after;
  whereNow(g, &after);
  /* The members, oldest first. */
  struct change **order = malloc((size_t)g->count * sizeof *order);
  if (order == NULL) {
    __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
    return;
  }
  resolveIn(g, order, &after);
  free(order);
  if (g->uncertainCount == 0) return;
  /* A lookup under way with a call that made, removed or replaced the name may have found it either way: its line is
   * left out. The name is then the run's own, which a record holds in either state. */
  int touched = !sameIdent(&g->start, &after);
  for (struct change *m = g->members; m != NULL && !touched; m = m->nextInGroup) {
    int value = m->line->settledBy > 0 ? m->line->answer : m->predicted;
    if (value == 0 && (m->renaming || (m->effect == MAKES ? !m->before.there : m->before.there))) touched = 1;
  }
  if (!touched) return;
  for (int i = 0; i < g->uncertainCount; i++)
    if (!setAnswer(g->uncertain[i].taking, g->uncertain[i].place, 0, NULL)) unrecorded(lateAnswer);
}

/* The group of calls on `name` still under way, once those surely past have ended; NULL when there is none. */
static struct group *busyOn(const char *spelled) {
  if (pseudo(spelled)) return NULL;
  char name[PATH_MAX + 1];
  keyOf(spelled, name, sizeof name);
  settleName(name);
  unsigned b = nameHash(name);
  struct group *g = groups[b];
  while (g != NULL && strcmp(g->name, name) != 0) g = g->next;
  return g != NULL && g->open > 0 ? g : NULL;
}

static void uncertainIn(struct group *g, uint64_t taking, long place) {
  if (g == NULL || place < 0) return;
  if (g->uncertainCount == g->uncertainRoom) {
    int room = g->uncertainRoom == 0 ? 8 : g->uncertainRoom * 2;
    void *grown = realloc(g->uncertain, (size_t)room * sizeof *g->uncertain);
    if (grown == NULL) {
      __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
      return;
    }
    g->uncertain = grown;
    g->uncertainRoom = room;
  }
  g->uncertain[g->uncertainCount].taking = taking;
  g->uncertain[g->uncertainCount].place = place;
  g->uncertainCount++;
}

/* Before the lines are taken (a step ended): each call surely past has ended, so its line says what it did. */
static void settlePast(void) {
  for (unsigned b = 0; b < THREAD_BUCKETS; b++) {
    for (struct change **at = &openOf[b]; *at != NULL;) {
      struct change *c = *at;
      if (!pastCall(c->tid, c->nr)) {
        at = &c->nextOfThread;
        continue;
      }
      *at = c->nextOfThread;
      ended(c);
      at = &openOf[b]; /* ended() may have freed others of this list's groups: start the list again */
    }
  }
}

static void resolveIn(struct group *g, struct change **order, struct ident *afterNow) {
  struct ident after = *afterNow;
  int n = 0;
  for (struct change *m = g->members; m != NULL; m = m->nextInGroup) order[n++] = m;
  for (int i = 0; i < n / 2; i++) {
    struct change *x = order[i];
    order[i] = order[n - 1 - i];
    order[n - 1 - i] = x;
  }
  int makes = 0, removes = 0, renames = 0;
  for (int i = 0; i < n; i++) {
    order[i]->effect == MAKES ? makes++ : removes++;
    renames += order[i]->renaming;
  }
  if (renames > 0) {
    /* A rename is answered at its new name, by the file it moved. Every other call is answered by its line when, taken
     * in order with the renames' answers, the lines agree with what each call's look found and leave the name as it
     * is now (uv makes a directory, fills it and renames it into place while the thread that made it runs on). */
    int state = g->start.there, agree = 1;
    for (int i = 0; i < n; i++) {
      struct change *m = order[i];
      int value = m->predicted;
      if (m->renaming && m->effect == MAKES) {
        value = renameAnswer(m, &after, renames);
        if (value < 0) {
          unknownChange(g->name, failedUnseen);
          return;
        }
        answerAgain(m->line, value);
      }
      if (m->before.there != state) agree = 0;
      if (value == 0 && !(m->effect == MAKES && !m->exclusive && m->before.there && !m->renaming))
        state = m->effect == MAKES ? 1 : 0;
    }
    if (renames < n && (!agree || state != after.there)) {
      /* A rename onto a name that was there all along leaves it there: a call that makes it finds it there. */
      int there = g->start.there && after.there;
      for (int i = 0; i < n && there; i++) {
        struct change *m = order[i];
        if (!m->renaming && (m->effect != MAKES || !m->before.there)) there = 0;
      }
      if (!there) {
        unknownChange(g->name, "was changed by a rename and another call of the run at once");
        return;
      }
      for (int i = 0; i < n; i++)
        if (!order[i]->renaming) answerAgain(order[i]->line, order[i]->exclusive ? EEXIST : 0);
      return;
    }
    for (int i = 0; i < n; i++)
      if (!order[i]->renaming) answerAgain(order[i]->line, order[i]->predicted);
    return;
  }
  if (n == 1) {
    struct change *m = order[0];
    int value = m->predicted;
    if (m->effect == MAKES) {
      if (!m->before.there && after.there) value = 0;
      else if (sameIdent(&m->before, &after)) {
        if (!m->before.there && value == 0) value = -1;
      } else value = -2;
    } else {
      if (m->before.there && !after.there) value = 0;
      else if (sameIdent(&m->before, &after)) {
        if (m->before.there && value == 0) value = -1;
      } else value = -2;
    }
    if (value == -1) unknownChange(g->name, failedUnseen);
    else if (value == -2) unknownChange(g->name, changedUnseen);
    else answerAgain(m->line, value);
    return;
  }
  int oneForm = 1;
  for (int i = 1; i < n; i++)
    if (order[i]->form != order[0]->form) oneForm = 0;
  if ((removes == 0 || makes == 0) && oneForm) {
    int making = makes > 0;
    int did = making ? (!g->start.there && after.there) : (g->start.there && !after.there);
    int none = sameIdent(&g->start, &after);
    if (!did && !none) {
      unknownChange(g->name, changedUnseen);
      return;
    }
    int given = 0;
    for (int pass = 0; pass < 2 && did && !given; pass++)
      for (int i = 0; i < n && !given; i++)
        if ((pass == 0) == (order[i]->predicted == 0)) {
          answerAgain(order[i]->line, 0);
          order[i]->given = given = 1;
        }
    for (int i = 0; i < n; i++) {
      struct change *m = order[i];
      if (m->given) continue;
      if (m->predicted != 0) {
        answerAgain(m->line, m->predicted);
      } else if (making && !m->exclusive) {
        answerAgain(m->line, 0); /* a plain create opens what is there */
      } else if (making ? (did || g->start.there) : (did || !g->start.there)) {
        answerAgain(m->line, making ? EEXIST : ENOENT);
      } else {
        unknownChange(g->name, failedUnseen);
        return;
      }
    }
    return;
  }
  /* Made and removed at once: the lines stand when each call's look found the name as the calls before it, taken
   * in order, left it, and the last leaves it as it is now. Otherwise a call went on after a later one looked. */
  int state = g->start.there, agree = 1;
  mode_t type = g->start.type;
  for (int i = 0; i < n; i++) {
    struct change *m = order[i];
    if (m->before.there != state || (state && type != 0 && m->before.type != type)) agree = 0;
    if (m->predicted != 0) continue;
    if (m->effect == REMOVES) {
      state = 0;
    } else if (!(m->form == F_CREATE && m->before.there)) {
      state = 1;
      type = m->makesType;
    }
  }
  if (!agree || state != after.there || (state && type != 0 && after.type != type)) {
    unknownChange(g->name, "was made and removed by calls of the run at the same moment, so which call did what "
                           "cannot be known");
    return;
  }
  for (int i = 0; i < n; i++) answerAgain(order[i]->line, order[i]->predicted);
}

static void freeChange(struct change *c) {
  if (--c->line->holders == 0) freeAnswered(c->line);
  free(c->from);
  free(c);
}

/* Notes a call that changes `name`: what its look found there and what its line says. */
static struct change *changing(pid_t tid, int nr, const char *spelled, enum effect effect, int exclusive,
                               const struct ident *before, struct answered *line) {
  if (pseudo(spelled)) return NULL;
  char name[PATH_MAX + 1];
  keyOf(spelled, name, sizeof name);
  struct change *c = calloc(1, sizeof *c);
  if (c == NULL) {
    __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
    return NULL;
  }
  c->tid = tid;
  c->nr = nr;
  c->effect = effect;
  c->exclusive = exclusive;
  c->predicted = line->answer;
  c->before = *before;
  c->line = line;
  line->holders++;
  unsigned b = nameHash(name);
  struct group *g = groups[b];
  while (g != NULL && strcmp(g->name, name) != 0) g = g->next;
  if (g == NULL) {
    g = calloc(1, sizeof *g);
    char *copy = strdup(name);
    if (g == NULL || copy == NULL) {
      free(g);
      free(copy);
      __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
      return c;
    }
    g->name = copy;
    g->since = moveCount;
    g->start = *before;
    g->next = groups[b];
    groups[b] = g;
  }
  c->group = g;
  c->nextInGroup = g->members;
  g->members = c;
  g->open++;
  g->count++;
  /* Another thread's lookup of the name that may not have run yet: what it found waits on this group. */
  uint64_t h = fullHash(name);
  for (struct looking **at = &lookBuckets[h % GROUP_BUCKETS]; *at != NULL;) {
    struct looking *l = *at;
    if (l->hash != h || l->tid == tid || l->place < 0 || pastCall(l->tid, l->nr)) {
      at = &l->next;
      continue;
    }
    uncertainIn(g, l->taking, l->place);
    uncertainIn(g, l->taking, l->place2);
    *at = l->next;
    l->used = 0;
  }
  return c;
}

/* The call went on: it waits for its thread to be past it. */
static void opened(struct change *c) {
  if (c == NULL) return;
  struct change **bucket = &openOf[(unsigned)c->tid % THREAD_BUCKETS];
  c->nextOfThread = *bucket;
  *bucket = c;
}

static void freeGroup(struct group *g) {
  unsigned b = nameHash(g->name);
  for (struct group **at = &groups[b]; *at != NULL; at = &(*at)->next)
    if (*at == g) {
      *at = g->next;
      break;
    }
  for (struct change *m = g->members; m != NULL;) {
    struct change *next = m->nextInGroup;
    freeChange(m);
    m = next;
  }
  free(g->uncertain);
  free(g->name);
  free(g);
}

/* A call has ended: its group is looked at again once all of its calls have. Answers whether the group was. */
/* What is at a group's name now, or where a directory rename since its first call took it. */
static void whereNow(const struct group *g, struct ident *after) {
  identify(g->name, after);
  if (after->there || g->since == moveCount) return;
  if (moveCount - g->since > MOVES) return;
  char path[PATH_MAX + 1];
  snprintf(path, sizeof path, "%s", g->name);
  for (uint64_t i = g->since; i < moveCount; i++) {
    const char *from = moves[i % MOVES].from, *to = moves[i % MOVES].to;
    if (from == NULL || to == NULL) continue;
    size_t length = strlen(from);
    if (strncmp(path, from, length) != 0 || path[length] != '/') continue;
    char moved[PATH_MAX + 1];
    if ((size_t)snprintf(moved, sizeof moved, "%s%s", to, path + length) >= sizeof moved) return;
    snprintf(path, sizeof path, "%s", moved);
  }
  if (strcmp(path, g->name) != 0) identify(path, after);
}

static int ended(struct change *c) {
  struct group *g = c->group;
  if (c->from != NULL) {
    struct ident source;
    identify(c->from, &source);
    c->sourceGone = !sameFile(&source, &c->moved);
  }
  if (g == NULL) {
    freeChange(c);
    return 0;
  }
  if (--g->open > 0) return 0;
  resolve(g);
  freeGroup(g);
  return 1;
}

/* A thread stopped again, so its last calls ended. With `tid` 0, the run ended, and every call did. */
static void settleChanges(pid_t tid) {
  for (unsigned b = tid == 0 ? 0 : (unsigned)tid % THREAD_BUCKETS; b < THREAD_BUCKETS; b++) {
    for (struct change **at = &openOf[b]; *at != NULL;) {
      struct change *c = *at;
      if (tid != 0 && c->tid != tid) {
        at = &c->nextOfThread;
        continue;
      }
      *at = c->nextOfThread;
      ended(c);
    }
    if (tid != 0) break;
  }
}

/* Before a call on `name` is looked at: each call on it whose thread is surely past it has ended. */
static void settleName(const char *spelled) {
  char name[PATH_MAX + 1];
  keyOf(spelled, name, sizeof name);
  unsigned b = nameHash(name);
  struct group *g = groups[b];
  while (g != NULL && strcmp(g->name, name) != 0) g = g->next;
  if (g == NULL) return;
  for (int again = 1; again;) {
    again = 0;
    for (struct change *m = g->members; m != NULL; m = m->nextInGroup) {
      struct change **at = &openOf[(unsigned)m->tid % THREAD_BUCKETS];
      while (*at != NULL && *at != m) at = &(*at)->nextOfThread;
      if (*at == NULL || !pastCall(m->tid, m->nr)) continue;
      *at = m->nextOfThread;
      if (ended(m)) return; /* the group is gone */
      again = 1;
      break;
    }
  }
}

/* ---- The working directory, shared by a process's threads ------------------------------------------------------ */

/*
 * A path named from the working directory is made absolute at the stop. Another thread of the process that changes
 * the directory between that stop and the call would put the call in another directory than its line names. So a
 * change of directory and a call from it that are under way at once, in one process, make the run unrecorded: which
 * directory the call started from cannot be known.
 */
struct place {
  pid_t tid, tgid;
  int nr;
  int moving;              /* a chdir, to `to` */
  char to[PATH_MAX + 1];
};
#define PLACES 1024
static struct place places[PLACES];
static int movingCount;

static const char *placeUnknown =
  "a thread changed its process's working directory while another thread named a path from it, so which directory "
  "that path was in cannot be known";

static void clearPlace(struct place *p) {
  if (p->tid != 0 && p->moving) movingCount--;
  p->tid = 0;
  p->moving = 0;
}

static int placeOpen(struct place *p) { return p->tid != 0 && !pastCall(p->tid, p->nr); }

/*
 * Threads that took a working directory of their own (`unshare(CLONE_FS)`): each is its own group of threads that
 * share one. (A thread started without CLONE_FS is not seen; pthreads and every runtime share it.)
 */
static pid_t ownCwds[PLACES];

static void ownCwd(pid_t tid) { __atomic_store_n(&ownCwds[(unsigned)tid % PLACES], tid, __ATOMIC_RELEASE); }

/* A thread ended (forget): one that is given its id shares its process's working directory again. */
static void ownCwdEnded(pid_t tid) {
  pid_t held = tid;
  __atomic_compare_exchange_n(&ownCwds[(unsigned)tid % PLACES], &held, 0, 0, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE);
}

/* Who shares `tid`'s working directory: its process, or itself alone. */
static pid_t cwdGroup(pid_t tid, pid_t tgid) {
  return __atomic_load_n(&ownCwds[(unsigned)tid % PLACES], __ATOMIC_ACQUIRE) == tid ? -tid : tgid;
}

/* A thread names a path from its working directory, which it found to be `cwd`. */
static void fromCwd(pid_t tid, pid_t process, int nr, const char *cwd) {
  pid_t tgid = cwdGroup(tid, process);
  if (movingCount > 0) {
    for (unsigned i = 0; i < PLACES; i++) {
      struct place *p = &places[i];
      if (p->tid == 0 || !p->moving || p->tgid != tgid || p->tid == tid) continue;
      if (strcmp(p->to, cwd) == 0 || !placeOpen(p)) clearPlace(p);
      else unrecorded(placeUnknown);
    }
  }
  struct place *mine = &places[(unsigned)tid % PLACES];
  if (mine->tid == 0 || mine->tid == tid || !placeOpen(mine)) {
    clearPlace(mine);
    *mine = (struct place){tid, tgid, nr, 0, {0}};
  }
}

/* A thread changes its process's working directory to `to`. */
static void movesCwd(pid_t tid, pid_t process, int nr, const char *to) {
  pid_t tgid = cwdGroup(tid, process);
  for (unsigned i = 0; i < PLACES; i++) {
    struct place *p = &places[i];
    if (p->tid == 0 || p->tgid != tgid || p->tid == tid) continue;
    if (!placeOpen(p)) clearPlace(p);
    else unrecorded(placeUnknown);
  }
  struct place *mine = &places[(unsigned)tid % PLACES];
  clearPlace(mine);
  *mine = (struct place){tid, tgid, nr, 1, {0}};
  snprintf(mine->to, sizeof mine->to, "%s", to);
  movingCount++;
}

/* A thread stopped again: its calls ended. */
static void settlePlace(pid_t tid) {
  struct place *mine = &places[(unsigned)tid % PLACES];
  if (mine->tid == tid) clearPlace(mine);
}

static void begin(struct text *t, pid_t tgid, const char *name) { printf_(t, "%d %s(", tgid, name); }

/* A line that says the run found a path there: a lookup that does not follow a link at its end. */
static void found(pid_t tgid, uint64_t id, uint32_t sub, const char *path) {
  struct text t = {0};
  begin(&t, tgid, "newfstatat");
  puts_(&t, "AT_FDCWD, ");
  quotedz(&t, path);
  puts_(&t, ", {...}, AT_SYMLINK_NOFOLLOW) = 0");
  keepCall(id, sub, &t);
}

static void openFlags(struct text *t, uint64_t flags) {
  int mode = (int)(flags & O_ACCMODE);
  puts_(t, mode == O_WRONLY ? "O_WRONLY" : mode == O_RDWR ? "O_RDWR" : "O_RDONLY");
  if (flags & O_CREAT) puts_(t, "|O_CREAT");
  if (flags & O_EXCL) puts_(t, "|O_EXCL");
  if (flags & O_TRUNC) puts_(t, "|O_TRUNC");
  if (flags & O_APPEND) puts_(t, "|O_APPEND");
  /* O_TMPFILE holds O_DIRECTORY's bit: it is written alone, as strace writes it. */
  if ((flags & O_DIRECTORY) && (flags & O_TMPFILE) != O_TMPFILE) puts_(t, "|O_DIRECTORY");
  if (flags & O_NOFOLLOW) puts_(t, "|O_NOFOLLOW");
  if ((flags & O_TMPFILE) == O_TMPFILE) puts_(t, "|O_TMPFILE");
  if (flags & O_PATH) puts_(t, "|O_PATH");
}

/* An address as strace writes it, for the families a reader asks about. `whole`, when not NULL, is a socket's path
 * made whole from the working directory, written in place of the path the address holds: a whole path can be
 * longer than an address holds (108 bytes), as one from a job's deep directory is. */
static void socketAddress(struct text *t, const struct sockaddr_storage *a, socklen_t length, const char *whole) {
  if (a->ss_family == AF_UNIX) {
    const struct sockaddr_un *u = (const struct sockaddr_un *)a;
    size_t n = length > offsetof(struct sockaddr_un, sun_path) ? length - offsetof(struct sockaddr_un, sun_path) : 0;
    if (n > sizeof u->sun_path) n = sizeof u->sun_path;
    puts_(t, "{sa_family=AF_UNIX, sun_path=");
    if (whole != NULL) {
      quotedz(t, whole);
    } else if (n > 0 && u->sun_path[0] == 0) {
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
  } else if (a->ss_family == AF_UNSPEC) {
    puts_(t, "{sa_family=AF_UNSPEC}");
  } else if (a->ss_family == AF_NETLINK) {
    const struct sockaddr_nl *l = (const struct sockaddr_nl *)a;
    printf_(t, "{sa_family=AF_NETLINK, nl_pid=%u, nl_groups=%08x}", l->nl_pid, l->nl_groups);
  } else if (a->ss_family == AF_PACKET) {
    const struct sockaddr_ll *l = (const struct sockaddr_ll *)a;
    printf_(t, "{sa_family=AF_PACKET, sll_protocol=htons(%u), sll_ifindex=%d}", ntohs(l->sll_protocol),
            l->sll_ifindex);
  } else {
    printf_(t, "{sa_family=%u}", (unsigned)a->ss_family);
  }
}

/*
 * A socket's path named from the working directory (`a` is such an address when this answers 1), made whole in
 * `whole` from the directory the thread is in. Answers 0 when the address names no such path, the directory cannot
 * be read, or the whole path is longer than any path: the path is then written as the call gave it.
 */
static int wholeSocketPath(pid_t tid, pid_t tgid, int nr, const struct sockaddr_storage *a, socklen_t length,
                           char *whole, size_t capacity) {
  const struct sockaddr_un *u = (const struct sockaddr_un *)a;
  if (a->ss_family != AF_UNIX || length <= offsetof(struct sockaddr_un, sun_path) || u->sun_path[0] == 0 ||
      u->sun_path[0] == '/')
    return 0;
  size_t n = length - offsetof(struct sockaddr_un, sun_path);
  if (n > sizeof u->sun_path) n = sizeof u->sun_path;
  char here[PATH_MAX + 1];
  if (!placeOf(tid, AT_FDCWD, here, sizeof here) || here[0] != '/') return 0;
  int written = snprintf(whole, capacity, "%s/%.*s", strcmp(here, "/") == 0 ? "" : here, (int)strnlen(u->sun_path, n),
                         u->sun_path);
  if (written < 0 || (size_t)written >= capacity) return 0;
  fromCwd(tid, tgid, nr, here);
  return 1;
}

/* The most addresses of one sendmmsg a line holds; a call that sends to more is not followed. */
#define SEND_ADDRESSES 16

/*
 * A send that names an address, written as strace writes it, with only what a reader asks about: the addresses,
 * each a socket's path made whole from the thread's working directory. A message that names none goes where its
 * socket is connected. Returns 0 when nothing is written: no address, or one that cannot be read, which the kernel
 * refuses too (`EFAULT`).
 */
static int sendLine(struct text *t, pid_t tid, pid_t tgid, const struct call *c, const struct seccomp_notif *req) {
  struct sockaddr_storage to[SEND_ADDRESSES];
  socklen_t lengths[SEND_ADDRESSES];
  int count = 0;
  if (c->nr == SYS_sendto || c->nr == SYS_sendmsg) {
    uint64_t name = req->data.args[4];
    socklen_t length = (socklen_t)req->data.args[5];
    if (c->nr == SYS_sendmsg) {
      struct msghdr m;
      if (!bytesAt(tid, req->data.args[1], &m, sizeof m)) return 0;
      name = (uint64_t)(uintptr_t)m.msg_name;
      length = m.msg_namelen;
    }
    if (length > sizeof to[0]) length = sizeof to[0];
    memset(&to[0], 0, sizeof to[0]);
    if (name == 0 || length < sizeof(sa_family_t) || !bytesAt(tid, name, &to[0], length)) return 0;
    lengths[count++] = length;
  } else {
    unsigned messages = (unsigned)req->data.args[2];
    if (messages > UIO_MAXIOV) messages = UIO_MAXIOV;
    for (unsigned i = 0; i < messages; i++) {
      struct mmsghdr m;
      if (!bytesAt(tid, req->data.args[1] + (uint64_t)i * sizeof m, &m, sizeof m)) break;
      socklen_t length = m.msg_hdr.msg_namelen;
      if (length > sizeof to[0]) length = sizeof to[0];
      struct sockaddr_storage a;
      memset(&a, 0, sizeof a);
      if (m.msg_hdr.msg_name == NULL || length < sizeof(sa_family_t) ||
          !bytesAt(tid, (uint64_t)(uintptr_t)m.msg_hdr.msg_name, &a, length))
        continue;
      int seen = 0;
      for (int j = 0; j < count && !seen; j++) seen = lengths[j] == length && memcmp(&to[j], &a, length) == 0;
      if (seen) continue;
      if (count == SEND_ADDRESSES) {
        unrecorded("it sent to more addresses in one call than the recorder reads");
        return 0;
      }
      to[count] = a;
      lengths[count++] = length;
    }
    if (count == 0) return 0;
  }
  char whole[PATH_MAX + 1];
  begin(t, tgid, c->name);
  printf_(t, "%d, ", (int)req->data.args[0]);
  if (c->nr == SYS_sendmmsg) puts_(t, "[");
  for (int i = 0; i < count; i++) {
    /* A socket's path from the working directory is written whole, as every other path is. */
    const char *named = wholeSocketPath(tid, tgid, c->nr, &to[i], lengths[i], whole, sizeof whole) ? whole : NULL;
    if (c->nr == SYS_sendto) {
      puts_(t, "\"\", 0, 0, ");
      socketAddress(t, &to[i], lengths[i], named);
      printf_(t, ", %u", (unsigned)lengths[i]);
    } else {
      puts_(t, i == 0 ? "" : ", ");
      puts_(t, c->nr == SYS_sendmmsg ? "{msg_hdr={msg_name=" : "{msg_name=");
      socketAddress(t, &to[i], lengths[i], named);
      printf_(t, ", msg_namelen=%u}", (unsigned)lengths[i]);
      if (c->nr == SYS_sendmmsg) puts_(t, "}");
    }
  }
  if (c->nr == SYS_sendmmsg) printf_(t, "], %u", (unsigned)req->data.args[2]);
  if (c->nr != SYS_sendto) printf_(t, ", %u", (unsigned)req->data.args[c->nr == SYS_sendmmsg ? 3 : 2]);
  puts_(t, ") = ?");
  return 1;
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

/*
 * A connection whose line says it found nothing to talk to (no socket at the path, nothing listening on the port):
 * a program that started meanwhile may have answered the call. Looked at again once the call has surely ended: when
 * the thread waits in another call or stops again, when a bind of the run is about to go on, or at the end of the
 * run. Something there by then may have answered: the run is not recorded.
 */
struct refused {
  struct refused *next;
  pid_t tid;
  int nr;
  unsigned port;    /* a local port, or 0 for `path` */
  int copy;         /* a copy of the socket, taken at the stop, or -1 */
  int inProgress;   /* a socket that does not wait: a connection it begins is answered EINPROGRESS */
  int predicted;    /* the answer written */
  uint64_t taking;  /* the line, and where its answer starts */
  long place;
  size_t at;
  char path[];
};
static struct refused *refusedCalls;

static int listening(pid_t tid, unsigned port);

static int setAnswer(uint64_t taking, long place, size_t at, const char *text);
static const char *lateAnswer;

/* Read socket identity and options from the copy already held for the recorded call. */
static int socketOptionIs(int fd, int level, int option, int expected) {
  int value = 0;
  socklen_t size = sizeof value;
  return fd >= 0 && getsockopt(fd, level, option, &value, &size) == 0 &&
         size == sizeof value && value == expected;
}

static int tcpSocket(int fd) {
  return socketOptionIs(fd, SOL_SOCKET, SO_TYPE, SOCK_STREAM) &&
         socketOptionIs(fd, SOL_SOCKET, SO_PROTOCOL, IPPROTO_TCP);
}

static void refusedEnded(struct refused *r) {
  if (r->copy >= 0) {
    /* The socket says whether the call connected it. */
    struct sockaddr_storage peer;
    socklen_t length = sizeof peer;
    int connected = getpeername(r->copy, (struct sockaddr *)&peer, &length) == 0, pending = 0;
    struct tcp_info info;
    socklen_t size = sizeof info;
    memset(&info, 0, sizeof info);
    if (!connected && r->port != 0 && getsockopt(r->copy, IPPROTO_TCP, TCP_INFO, &info, &size) == 0) {
      /* Still connecting, read from the connection's state: SO_ERROR would take the error the program waits for. */
      pending = r->inProgress && info.tcpi_state == 2 /* SYN_SENT */;
      /* A connection that ended before this look connected all the same: a refused one got one segment, the reset,
       * and no round trip was timed; one that was answered got the answer and another (its end, or a reset), and
       * the answer was timed. */
      connected = info.tcpi_segs_in > 1 || info.tcpi_rtt > 0;
    }
    close(r->copy);
    const char *text = NULL;
    if (connected || pending) {
      if (r->inProgress) text = " = -1 EINPROGRESS (Operation now in progress)";
      else if (r->predicted != 0) text = " = 0";
    } else if (r->predicted == 0) {
      /* Written as answered, and nothing answered: something was at the name, and did not listen yet. */
      text = r->port == 0 && look(r->path, 0) == ENOENT ? " = -1 ENOENT (No such file or directory)"
                                                         : " = -1 ECONNREFUSED (Connection refused)";
    }
    if (text != NULL && !setAnswer(r->taking, r->place, r->at, text)) unrecorded(lateAnswer);
  } else {
    int there = r->predicted != 0 && (r->port != 0 ? listening(r->tid, r->port) : look(r->path, 0) != ENOENT);
    if (there)
      unrecorded("a program it connected to started while it connected, so whether the connection was answered "
                 "cannot be known");
  }
  free(r);
}

/* Each refused connection whose thread is past it (`all`: every one) is looked at again. The list is read and
 * written with serving_lock held; the main thread also asks whether it holds anything before it takes the lock, so
 * each store to the list is one that question may be asked beside (as `bindings`). */
static void settleRefused(pid_t tid, int all) {
  if (refusedCalls == NULL) return;
  for (struct refused **at = &refusedCalls; *at != NULL;) {
    struct refused *r = *at;
    if (all || r->tid == tid || pastCall(r->tid, r->nr)) {
      __atomic_store_n(at, r->next, __ATOMIC_RELEASE);
      refusedEnded(r);
    } else {
      at = &r->next;
    }
  }
}

static struct refused *refusedCall(pid_t tid, int nr, unsigned port, const char *path) {
  size_t length = path == NULL ? 0 : strlen(path);
  struct refused *r = calloc(1, sizeof *r + length + 1);
  if (r == NULL) {
    __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
    return NULL;
  }
  r->copy = -1;
  r->place = -1;
  r->tid = tid;
  r->nr = nr;
  r->port = port;
  if (path != NULL) memcpy(r->path, path, length + 1);
  r->next = refusedCalls;
  __atomic_store_n(&refusedCalls, r, __ATOMIC_RELEASE);
  return r;
}

/* Whether an address is on this machine: its loopback, or the unspecified address (`0.0.0.0`, `::`), which Linux
 * connects to this machine itself (ObservedReads.loopback). */
static int loopbackAddress(const struct sockaddr_storage *a) {
  if (a->ss_family == AF_INET) {
    uint32_t host = ntohl(((const struct sockaddr_in *)a)->sin_addr.s_addr);
    return (host >> 24) == 127 || host == 0;
  }
  if (a->ss_family == AF_INET6) {
    const struct in6_addr *x = &((const struct sockaddr_in6 *)a)->sin6_addr;
    if (IN6_IS_ADDR_LOOPBACK(x) || IN6_IS_ADDR_UNSPECIFIED(x)) return 1;
    return IN6_IS_ADDR_V4MAPPED(x) &&
           (x->s6_addr[12] == 127 || (x->s6_addr[12] | x->s6_addr[13] | x->s6_addr[14] | x->s6_addr[15]) == 0);
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
  if (earliest == NULL || ambiguous || generationOf(parent)->count != generation) {
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

/* The main thread, for a process that ended or started another program. `watchedPids` is the serving thread's too
 * (expose), so every read and write of it holds `seizing`. */
static void unwatch(pid_t tgid) {
  pthread_mutex_lock(&seizing);
  setWatched(tgid, 0);
  pthread_mutex_unlock(&seizing);
}

/* Asks the main thread, which alone may trace, to watch a process: answered before the handler is set. Once the
 * run has ended (`stopping`) nothing is asked and no answer is waited for: the main thread serves no more requests,
 * and the process, killed while its call waited here, has no handler to set (endSeizes). */
static void expose(pid_t tgid) {
  pthread_mutex_lock(&seizing);
  if (!isWatched(tgid) && !__atomic_load_n(&stopping, __ATOMIC_ACQUIRE)) {
    seizeAsked = tgid;
    seizeServed = 0;
    pthread_kill(mainThread, SIGUSR2);
    while (!seizeServed && !__atomic_load_n(&stopping, __ATOMIC_ACQUIRE)) pthread_cond_wait(&seized, &seizing);
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

/*
 * The main thread, once the run has ended and `stopping` is set: a request to seize still waited for is answered
 * with nothing seized, and none is waited for after. `stopping` is set before `seizing` is taken here, and expose
 * reads it with `seizing` held: a serving thread either sees it and does not wait, or already waits and is woken.
 * Without this the serving thread, at the handler of a process killed just then, waited for good for a main thread
 * that had left its loop, and the main thread for the serving thread to end.
 */
static void endSeizes(void) {
  pthread_mutex_lock(&seizing);
  seizeServed = 1;
  seizeAsked = 0;
  pthread_cond_broadcast(&seized);
  pthread_mutex_unlock(&seizing);
}

/*
 * Takes serving_lock on the main thread. The serving thread holds it while it serves a call, and a call that sets a
 * handler waits there for the main thread to seize the process (expose): the main thread seizes while it waits, or
 * neither ever goes on, and every recorded thread waits in its call for good.
 */
static void lockServing(void) {
  while (pthread_mutex_trylock(&serving_lock) != 0) {
    serveSeizes();
    struct timespec pause = {0, 50000};
    nanosleep(&pause, NULL);
  }
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
  int nr;                /* the call it cut short */
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
static int cutShort(pid_t tid, int *fork, int *call) {
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
  *call = c->nr;
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
  int fork = 0, call = 0;
  if (cutShort(tid, &fork, &call)) {
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
        if (fork) k->nr = call;
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
    k->nr = call;
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
 * waits for the supervisor. One kept for a fork is sent at the fork's event; a fork that failed (no process left to
 * make, no memory) has no event, so its signal is sent once the thread is surely past the call: it waits in another
 * call. Without that the thread never got the signal, and each later one of its kind was dropped as kept already. */
static void sendStale(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  pthread_mutex_lock(&keeping);
  for (struct kept **at = &keptSignals; *at != NULL;) {
    struct kept *k = *at;
    long ms = (now.tv_sec - k->since.tv_sec) * 1000 + (now.tv_nsec - k->since.tv_nsec) / 1000000;
    if (!k->sent && ms >= 50 && (k->afterCall ? pastCall(k->tid, k->nr) : !waitingForUs(k->tid))) {
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

/*
 * A thread that started another program is let go (PTRACE_EVENT_EXEC), and no signal stop of it is seen after: none
 * of its signals stays kept. One kept as thread `was` and not sent again yet is sent now to `now`, the thread the
 * program runs as, so the program gets it as it would unrecorded; one sent already is the kernel's to deliver. Left
 * kept, each would be held for good, and what it first said given to a later signal of the process, were it watched
 * again.
 */
static void letGoKept(pid_t was, pid_t now) {
  pthread_mutex_lock(&keeping);
  for (struct kept **at = &keptSignals; *at != NULL;) {
    struct kept *k = *at;
    if (k->tid != was) {
      at = &k->next;
      continue;
    }
    if (!k->sent) syscall(SYS_tgkill, k->tgid, now, k->sig);
    *at = k->next;
    free(k);
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
    /* A program the look found missing was made before the call ran. */
    if (s->missing) {
      if (!setAnswer(s->taking, s->place, s->at, " = ?")) unrecorded(lateAnswer);
      pthread_mutex_lock(&lock);
      nextGeneration(tgid);
      pthread_mutex_unlock(&lock);
      /* Its file was not there to ask at the call: it is asked now whether it wants rights the run does not give. A
       * path that could not be kept is a program the record would not name. */
      if (s->path != NULL) rights(s->path);
      else __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
    }
    if (s->line == NULL) {
      /* No memory held the line: the one that says it started is lost, and the run says so. */
      __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
    } else {
      struct text t = {0};
      puts_(&t, s->line);
      puts_(&t, " = 0");
      keep(s->id, 3, &t);
    }
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
  free(s->path);
  free(s);
}

/* A call given flags the table does not follow: the first by its name, as strace prints it, or all by number. */
static void refuseFlags(const char *call, uint64_t bits) {
  char form[128];
  for (size_t i = 0; i < sizeof flagNames / sizeof flagNames[0]; i++) {
    if (!(bits & flagNames[i].bit)) continue;
    snprintf(form, sizeof form, "%s with %s", call, flagNames[i].name);
    refuse(form);
    return;
  }
  snprintf(form, sizeof form, "%s with 0x%llx", call, (unsigned long long)bits);
  refuse(form);
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
  /* A flag of the open and a flag of the walk are named apart: their bits are not one set. */
  if (how->flags & ~(uint64_t)OPEN_FOLLOWED) {
    refuseFlags("openat2", how->flags & ~(uint64_t)OPEN_FOLLOWED);
    return 1;
  }
  if (how->resolve & ~(uint64_t)RESOLVE_FOLLOWED) {
    char form[96];
    snprintf(form, sizeof form, "openat2 with 0x%llx",
             (unsigned long long)(how->resolve & ~(uint64_t)RESOLVE_FOLLOWED));
    refuse(form);
    return 1;
  }
  char given[PATH_MAX + 1], base[PATH_MAX + 1], reachedFile[PATH_MAX + 1], link[64];
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
  if (from < 0) starvedBy(errno);
  if (from < 0 || !placeOf(tid, dirfd, base, sizeof base) || base[0] != '/') {
    if (from >= 0) close(from);
    *why = "base";
    return 0;
  }
  /* The walk starts from the working directory: a thread that changes it meanwhile makes the run unrecorded. */
  if (dirfd == AT_FDCWD) fromCwd(tid, tgid, req->data.nr, base);
  /*
   * This program asks the walk's question itself below, and a reader walks the path again after the run. A path that
   * reaches a link the kernel makes for a process (`/proc/self/cwd/x`, `/dev/fd/3`) leads, for either of them, where
   * its own link leads and not the caller's, and followed here in the caller's view it would no longer be the walk
   * the call makes: no line can hold it. What is otherwise under `/proc`, `/dev` or `/sys` is the machine's state,
   * never looked at: its line names the path, as the walk would.
   */
  int machine = 0;
  if (given[0] != 0) {
    char whole[PATH_MAX + 1];
    int rooted = given[0] == '/' && !(how->resolve & RESOLVE_IN_ROOT), linked = 0;
    int length = rooted ? snprintf(whole, sizeof whole, "%s", given)
                        : snprintf(whole, sizeof whole, "%s/%s", strcmp(base, "/") == 0 ? "" : base, given);
    if (length < 0 || (size_t)length >= sizeof whole) {
      close(from);
      *why = "long";
      return 0;
    }
    if (!stepViewed(tid, whole, sizeof whole, why, &linked)) {
      close(from);
      return 0;
    }
    if (linked) {
      close(from);
      refuse("openat2 through a link of a process");
      return 1;
    }
    machine = pseudo(whole);
    if (machine) snprintf(reachedFile, sizeof reachedFile, "%s", whole);
  }
  struct how ours = {O_PATH | O_CLOEXEC | (how->flags & (O_NOFOLLOW | O_DIRECTORY)), 0,
                     how->resolve & ~(uint64_t)RESOLVE_CACHED};
  int unnamed = (how->flags & O_TMPFILE) == O_TMPFILE;
  int creates = (how->flags & O_CREAT) && !unnamed;
  int reading = (how->flags & (O_ACCMODE | O_CREAT | O_TRUNC)) == O_RDONLY && !unnamed;
  int error = 0, directory = 0, named = 0;
  struct ident before = {0};
  int fd = machine ? -1 : (int)syscall(SYS_openat2, from, given, &ours, sizeof ours);
  if (machine) {
    named = 1;
  } else if (fd >= 0) {
    struct stat st;
    if (!nameOf(fd, reachedFile, sizeof reachedFile) || fstat(fd, &st) != 0) {
      close(fd);
      close(from);
      refuse("openat2 of a file with no name");
      return 1;
    }
    close(fd);
    named = 1;
    directory = S_ISDIR(st.st_mode);
    int writing = (how->flags & O_ACCMODE) != O_RDONLY || (how->flags & O_CREAT);
    if ((how->flags & (O_CREAT | O_EXCL)) == (O_CREAT | O_EXCL))
      error = EEXIST;
    else if (S_ISLNK(st.st_mode) && !(how->flags & O_PATH))
      error = ELOOP; /* O_NOFOLLOW at a link */
    else if (directory && writing && !unnamed)
      error = EISDIR;
  } else {
    error = errno;
    if (starvedBy(error)) {
      close(from);
      return 1;
    }
    if (error == ENOENT && creates) {
      /* Nothing there: the call makes it in its directory, when that is there. The name it makes and the directory
       * are each a copy of their own: the path is cut in two, and neither half is the other's storage. */
      char parent[PATH_MAX + 1], made[NAME_MAX + 1];
      const char *slash = strrchr(given, '/');
      const char *name = slash == NULL ? given : slash + 1;
      size_t nameLength = strlen(name);
      if (slash == NULL)
        snprintf(parent, sizeof parent, ".");
      else if (slash == given)
        snprintf(parent, sizeof parent, "/");
      else
        snprintf(parent, sizeof parent, "%.*s", (int)(slash - given), given);
      if (nameLength < sizeof made) memcpy(made, name, nameLength + 1);
      struct how up = {O_PATH | O_CLOEXEC | O_DIRECTORY, 0, ours.resolve};
      if (nameLength == 0) {
        error = EISDIR;
      } else if (nameLength >= sizeof made) {
        /* A name longer than a directory holds is made nowhere: the line says so, and names no shorter one. */
        error = ENAMETOOLONG;
      } else {
        int dir = (int)syscall(SYS_openat2, from, parent, &up, sizeof up);
        if (dir < 0) {
          error = errno;
          if (starvedBy(error)) {
            close(from);
            return 1;
          }
        } else {
          struct stat st;
          if (fstatat(dir, made, &st, AT_SYMLINK_NOFOLLOW) == 0) {
            /* A link that leads nowhere: the call makes the file it names, by the rules of the walk. */
            close(dir);
            close(from);
            refuse("openat2 to make a file through a link");
            return 1;
          }
          char place[PATH_MAX + 1];
          /* A directory with no name was removed: nothing is made in it. */
          if (!nameOf(dir, place, sizeof place))
            error = ENOENT;
          else if (strlen(place) + 1 + nameLength >= sizeof reachedFile)
            error = ENAMETOOLONG;
          else {
            snprintf(reachedFile, sizeof reachedFile, "%s/%s", strcmp(place, "/") == 0 ? "" : place, made);
            named = 1;
            error = 0; /* made by the call */
          }
          close(dir);
        }
      }
    }
  }
  close(from);
  /* The file the walk ends at is a name as any other: a call that makes it is looked at again once it has ended, and
   * a lookup under way with such a call is uncertain, as an open's is. */
  struct group *busy = NULL;
  struct looking *looking = NULL;
  struct answered *line = NULL;
  struct change *change = NULL;
  if (named && creates) {
    settleName(reachedFile);
    identify(reachedFile, &before);
  } else if (named && !pseudo(reachedFile)) {
    busy = busyOn(reachedFile);
    if (reading) looking = lookStarts(tid, req->data.nr, reachedFile);
  }
  begin(t, tgid, "openat2");
  puts_(t, dirfd == AT_FDCWD ? "AT_FDCWD" : "");
  if (dirfd != AT_FDCWD) printf_(t, "%d", dirfd);
  /* Each path is written as a descriptor's is: a newline, `<` or `>` in a name would otherwise end the line or the
   * path, and a name could say what the run never did. */
  angledz(t, base);
  puts_(t, ", ");
  quotedz(t, given);
  puts_(t, ", {flags=");
  openFlags(t, how->flags);
  puts_(t, ", resolve=");
  resolveNames(t, how->resolve);
  puts_(t, "}, 24)");
  if (named && creates && (line = calloc(1, sizeof *line)) != NULL) {
    *line = (struct answered){0, -1, t->length, error, 0, 0, NULL};
    /* The file the call opens follows an answer of 0, whenever that answer is written: a call that was to find the
     * name there and made it after all (another thread removed it first) says which file it made. */
    struct text opens = {0};
    angledz(&opens, reachedFile);
    if (opens.failed) {
      __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
      free(opens.data);
    } else {
      line->suffix = opens.data;
    }
    change = changing(tid, req->data.nr, reachedFile, MAKES, (how->flags & O_EXCL) != 0, &before, line);
    formOf(change, (how->flags & O_EXCL) ? F_EXCL : F_CREATE, S_IFREG);
  }
  uint64_t taking = 0;
  long place, second = -1;
  if (error != 0) {
    answer(t, error);
    place = keepCallIn(id, 2, t, &taking);
  } else {
    puts_(t, " = 0");
    angledz(t, reachedFile);
    place = keepCallIn(id, 2, t, &taking);
    if (directory) {
      /* A directory reachedFile is a directory listed, as an open's is. */
      struct text listed = {0};
      printf_(&listed, "%d getdents64(0", tgid);
      angledz(&listed, reachedFile);
      puts_(&listed, ", {...}, 32768) = 0");
      second = keepCallIn(id, 3, &listed, &taking);
    }
  }
  uncertainIn(busy, taking, place);
  uncertainIn(busy, taking, second);
  if (looking != NULL) {
    looking->taking = taking;
    looking->place = place;
    looking->place2 = second;
  }
  if (line != NULL) {
    line->place = place;
    line->taking = taking;
    opened(change);
    if (line->holders == 0) freeAnswered(line);
  }
  return 1;
}

/* The error the call just served is answered with instead of going on (0: it goes on). */
static int refusedWith;

static void serve(const struct seccomp_notif *req) {
  pid_t tid = (pid_t)req->pid;
  uint64_t id = req->id;
  settleChanges(tid);
  settlePlace(tid);
  lookEnded(tid);
  settleRefused(tid, 0);
  /* The copy of a socket is let go before any call of the run goes on: a bind of this thread has ended. */
  if (__atomic_load_n(&bindings, __ATOMIC_ACQUIRE) != NULL) settleBindings(tid);
  if (req->data.arch != NATIVE_ARCH || (req->data.nr & (int)X32_BIT) != 0) {
    unrecorded("a program of another architecture ran, whose calls this recorder does not read");
    return;
  }
  const struct call *c = callOf(req->data.nr);
  if (c == NULL) {
    if (req->data.nr > LAST_KNOWN) {
      char form[96];
      snprintf(form, sizeof form, "a system call it does not know, numbered %d", req->data.nr);
      refuse(form);
    }
    return;
  }
  if (c->flags >= 0 && ((uint32_t)req->data.args[(int)c->flags] & ~c->followed)) {
    refuseFlags(c->name, (uint32_t)req->data.args[(int)c->flags] & ~c->followed);
    return;
  }
  pid_t tgid = tgidOf(tid);
  sendKept(tid, tgid);
  receivedCall(tid);
  startedYet(tid, tgid);
  char path[PATH_MAX + 1], other[PATH_MAX + 1];
  const char *why = NULL;
  struct text t = {0};
  /* The names this call makes or removes, looked at again once it has ended (settleChanges), and its line. */
  struct change *changes[2] = {NULL, NULL};
  struct answered *line = NULL;
  /* A program this call starts: its line's place is noted once the line is kept. */
  struct starting *starting = NULL;
  /* The calls under way on the name a lookup asks about, whose line holds only if none of them changed it. */
  struct group *busy = NULL;
  /* A connection written as refused, asked again once it ended. */
  struct refused *refusing = NULL;
  /* This lookup, while it may still be under way. */
  struct looking *looking = NULL;
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
      /* O_TMPFILE holds O_DIRECTORY's bit: only all of it makes an unnamed file. */
      int reading = (flags & (O_ACCMODE | O_CREAT | O_TRUNC)) == O_RDONLY && (flags & O_TMPFILE) != O_TMPFILE;
      if (c->nr == SYS_openat2) {
        struct how how = {0, 0, 0};
        if (req->data.args[3] < sizeof how || !bytesAt(tid, req->data.args[2], &how, sizeof how)) break;
        if (how.resolve != 0 || (how.flags & ~(uint64_t)OPEN_FOLLOWED)) {
          if (!reading) __atomic_add_fetch(&namesChanged, 1, __ATOMIC_ACQ_REL);
          if (resolvedOpen(tid, tgid, id, req, &how, &t, &why)) return;
          break;
        }
      }
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      int error, directory = 0, makes = 0;
      struct ident before = {0};
      if (!reading) __atomic_add_fetch(&namesChanged, 1, __ATOMIC_ACQ_REL);
      if ((flags & O_TMPFILE) == O_TMPFILE) {
        /* An unnamed file in a directory: the directory is looked at, and no name is made. */
        error = look(path, 0);
      } else if (flags & O_CREAT) {
        /* One look: a second one could see what another thread did in between. */
        settleName(path);
        error = identify(path, &before);
        if (error == 0) {
          error = (flags & O_EXCL) ? EEXIST
                : before.type == S_IFDIR ? EISDIR
                : before.type == S_IFLNK && (flags & O_NOFOLLOW) ? ELOOP
                : 0; /* opened; through a link that leads nowhere, the file it names is made */
          /* Opened where something is, or made by this call when another removes the name before it runs. */
          makes = 1;
        } else if (error == ENOENT) {
          error = parentThere(path, 0, EISDIR); /* nothing there: made, when its directory is */
          makes = 1;
        }
      } else {
        busy = busyOn(path);
        error = lookKind(path, (flags & O_NOFOLLOW) != 0, &directory);
        if (error == 0 && directory && (flags & O_ACCMODE) != O_RDONLY) error = EISDIR;
        else if (error == 0 && !directory && (flags & O_DIRECTORY) && !pseudo(path)) error = ENOTDIR;
      }
      if (reading && busy == NULL && askedAgain(tgid, 2 | (flags << 2), path, error)) break;
      if (reading && !pseudo(path)) looking = lookStarts(tid, c->nr, path);
      begin(&t, tgid, "openat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, ", ");
      openFlags(&t, flags);
      puts_(&t, ")");
      if (makes && (line = calloc(1, sizeof *line)) != NULL) {
        *line = (struct answered){0, -1, t.length, error, 0, 0};
        changes[0] = changing(tid, c->nr, path, MAKES, (flags & O_EXCL) != 0, &before, line);
        formOf(changes[0], (flags & O_EXCL) ? F_EXCL : F_CREATE, S_IFREG);
      }
      answer(&t, error);
      if (error == 0 && directory && !pseudo(path)) {
        /* A directory opened is a directory listed: no listing is watched, and what is in it counts. */
        uint64_t taking = 0;
        long first = keepCallIn(id, 2, &t, &taking);
        uncertainIn(busy, taking, first);
        t = (struct text){0};
        printf_(&t, "%d getdents64(0", tgid);
        angledz(&t, path);
        puts_(&t, ", {...}, 32768) = 0");
        long second = keepCallIn(id, 3, &t, &taking);
        uncertainIn(busy, taking, second);
        if (looking != NULL) {
          looking->taking = taking;
          looking->place = first;
          looking->place2 = second;
        }
        return;
      }
      break;
    }
    case K_LOOK: {
      int nofollow = c->nofollow;
      if (c->flags >= 0 && (req->data.args[(int)c->flags] & AT_SYMLINK_NOFOLLOW)) nofollow = 1;
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      busy = busyOn(path);
      int error = look(path, nofollow);
      if (busy == NULL && askedAgain(tgid, (uint64_t)nofollow, path, error)) break;
      if (!pseudo(path)) looking = lookStarts(tid, c->nr, path);
      begin(&t, tgid, "newfstatat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, nofollow ? ", {...}, AT_SYMLINK_NOFOLLOW)" : ", {...}, 0)");
      answer(&t, error);
      break;
    }
    case K_EXEC: {
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      busy = busyOn(path);
      int error = look(path, 0);
      /* Found missing: what the call found is uncertain while another call changes the program's name. */
      if (error == 0) busy = NULL;
      else if (!pseudo(path)) looking = lookStarts(tid, c->nr, path);
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
      if (error != 0 && error != ENOENT) {
        answer(&t, error);
        free(raw.data);
        free(script.data);
        break;
      }
      if (error == 0) rights(path);
      if (error == 0) {
        pthread_mutex_lock(&lock);
        nextGeneration(tgid);
        pthread_mutex_unlock(&lock);
      }
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
        s->path = strdup(path);
        s->place = -1;
        s->at = t.length;
        s->missing = error != 0;
        starting = s;
        pthread_mutex_lock(&lock);
        s->next = startings;
        startings = s;
        pthread_mutex_unlock(&lock);
      } else {
        free(raw.data);
        free(script.data);
      }
      if (error != 0) answer(&t, error);
      else puts_(&t, " = ?");
      break;
    }
    case K_CHDIR: {
      if (c->path < 0) {
        if (!placeOf(tid, (int)req->data.args[0], path, sizeof path)) {
          why = "base";
          break;
        }
      } else if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) {
        break;
      }
      int directory = 0, error = lookKind(path, 0, &directory);
      if (error == 0 && !directory && !pseudo(path)) error = ENOTDIR;
      if (error == 0) movesCwd(tid, tgid, c->nr, path);
      begin(&t, tgid, "chdir");
      quotedz(&t, path);
      puts_(&t, ")");
      answer(&t, error);
      break;
    }
    case K_MKDIR: {
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      settleName(path);
      struct ident before;
      int there = identify(path, &before);
      int error = there == 0 ? EEXIST : there == ENOENT ? parentThere(path, 1, 0) : there;
      begin(&t, tgid, "mkdirat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, ", 0777)");
      if ((line = calloc(1, sizeof *line)) != NULL) {
        *line = (struct answered){0, -1, t.length, error, 0, 0};
        changes[0] = changing(tid, c->nr, path, MAKES, 1, &before, line);
        formOf(changes[0], c->kind == K_MKDIR ? F_MKDIR : F_SYMLINK, c->kind == K_MKDIR ? S_IFDIR : S_IFLNK);
      }
      answer(&t, error);
      break;
    }
    case K_REMOVE: {
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      /* rmdir, or unlinkat with AT_REMOVEDIR, removes only an empty directory; unlink anything else. */
      int directoryOnly = 0;
#ifdef SYS_rmdir
      directoryOnly = c->nr == SYS_rmdir;
#endif
      if (c->nr == SYS_unlinkat && (req->data.args[2] & AT_REMOVEDIR)) directoryOnly = 1;
      settleName(path);
      struct ident before;
      int error = identify(path, &before);
      if (error == 0 && !pseudo(path)) {
        error = directoryOnly ? (before.type != S_IFDIR ? ENOTDIR : holdsAnything(path) ? ENOTEMPTY : 0)
                              : (before.type == S_IFDIR ? EISDIR : 0);
      }
      begin(&t, tgid, "unlinkat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, directoryOnly ? ", AT_REMOVEDIR)" : ", 0)");
      if ((line = calloc(1, sizeof *line)) != NULL) {
        *line = (struct answered){0, -1, t.length, error, 0, 0};
        changes[0] = changing(tid, c->nr, path, REMOVES, 0, &before, line);
        formOf(changes[0], directoryOnly ? F_RMDIR : F_UNLINK, 0);
      }
      answer(&t, error);
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
      busy = busyOn(path);
      int directory = 0, error = lookKind(path, nofollow, &directory);
      if (!pseudo(path)) looking = lookStarts(tid, c->nr, path);
      if (error == 0 && directory && c->nr == SYS_truncate && !pseudo(path)) error = EISDIR;
      /* Written by the call's own name, with each argument a reader asks about where the call has it: the
       * directory (the path is whole, so AT_FDCWD), the path, and whether a link at its end is followed. A reader
       * tells a call that changes what a file holds or whether it runs (chmod, truncate) from one that changes
       * only its times, owner or attributes by the name, as it does in strace's lines. */
      begin(&t, tgid, c->name);
      int last = c->path > c->flags ? c->path : c->flags;
      if (c->dir > last) last = c->dir;
      for (int i = 0; i <= last; i++) {
        if (i > 0) puts_(&t, ", ");
        if (i == c->path) quotedz(&t, path);
        else if (i == c->dir) puts_(&t, "AT_FDCWD");
        else if (i == c->flags) puts_(&t, nofollow ? "AT_SYMLINK_NOFOLLOW" : "0");
        else puts_(&t, "0");
      }
      puts_(&t, ")");
      answer(&t, error);
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
      settleName(path);
      settleName(other);
      /* RENAME_NOREPLACE (1) fails where the new name is there; RENAME_EXCHANGE (2) swaps two names that are both
       * there; RENAME_WHITEOUT (4) moves as a rename does. The line names them, as strace does. */
      uint64_t renaming = c->nr == SYS_renameat2 ? (uint32_t)req->data.args[(int)c->flags] : 0;
      struct ident source, target;
      int from = identify(path, &source), to = identify(other, &target);
      int moving = source.type == S_IFDIR;
      /* A name that is there already is one the run found, whatever the call does to it. */
      if (to == 0 && !pseudo(other)) found(tgid, id, 0, other);
      size_t pathLength = strlen(path);
      int error = from != 0 ? from
        : c->kind == K_LINK ? (to == 0 ? EEXIST : moving ? EPERM : to != ENOENT ? to : parentThere(other, 0, ENOENT))
        : (renaming & 2) ? (to == 0 ? 0 : to)
        : (renaming & 1) && to == 0 ? EEXIST
        : to == 0 && source.dev == target.dev && source.ino == target.ino ? 0
        : moving && strncmp(other, path, pathLength) == 0 && other[pathLength] == '/' ? EINVAL
        : to == 0 ? (moving && target.type != S_IFDIR ? ENOTDIR
                     : !moving && target.type == S_IFDIR ? EISDIR
                     : moving && holdsAnything(other) ? ENOTEMPTY
                     : 0)
        : to != ENOENT ? to
        : parentThere(other, moving, ENOTDIR);
      dev_t above = error == 0 && !pseudo(path) && !pseudo(other) ? deviceAbove(other) : 0;
      if (above != 0 && above != source.dev) error = EXDEV;
      /* A rename of a file onto another name of the same file does nothing and answers 0 (rename(2)): both names
       * stay, so no look after could show the file gone from the old one. Its line stands as written. */
      int onItself = c->kind == K_RENAME && !(renaming & 3) && from == 0 && to == 0 && sameFile(&source, &target);
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
      if (!(renaming & 2) && !onItself && (line = calloc(1, sizeof *line)) != NULL) {
        *line = (struct answered){0, -1, t.length, error, 0, 0};
        changes[0] = changing(tid, c->nr, other, MAKES, c->kind == K_LINK, &target, line);
        formOf(changes[0], c->kind == K_LINK ? F_LINK : F_RENAME, source.type);
        if (c->kind == K_RENAME) {
          if (moving && error == 0) movedDirectory(path, other);
          changes[1] = changing(tid, c->nr, path, REMOVES, 0, &source, line);
          formOf(changes[1], F_RENAME, 0);
          if (changes[0] != NULL) {
            changes[0]->renaming = 1;
            changes[0]->moved = source;
            changes[0]->from = strdup(path);
          }
          if (changes[1] != NULL) changes[1]->renaming = 1;
        }
      }
      answer(&t, error);
      break;
    }
    case K_SYMLINK: {
      if (!stringAt(tid, req->data.args[0], other, sizeof other)) {
        why = "address";
        break;
      }
      if (!pathOf(tid, req, c->dir2, c->path2, path, sizeof path, &why)) break;
      settleName(path);
      struct ident before;
      int there = identify(path, &before);
      if (there == 0 && !pseudo(path)) found(tgid, id, 0, path);
      int error = there == 0 ? EEXIST : there == ENOENT ? parentThere(path, 0, ENOENT) : there;
      begin(&t, tgid, "symlinkat");
      quotedz(&t, other);
      puts_(&t, ", AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, ")");
      if ((line = calloc(1, sizeof *line)) != NULL) {
        *line = (struct answered){0, -1, t.length, error, 0, 0};
        changes[0] = changing(tid, c->nr, path, MAKES, 1, &before, line);
        formOf(changes[0], c->kind == K_MKDIR ? F_MKDIR : F_SYMLINK, c->kind == K_MKDIR ? S_IFDIR : S_IFLNK);
      }
      answer(&t, error);
      break;
    }
    case K_CONNECT:
    case K_BIND: {
      settleBindings(tid);
      struct sockaddr_storage a;
      memset(&a, 0, sizeof a);
      socklen_t length = (socklen_t)req->data.args[2];
      if (length > sizeof a) length = sizeof a;
      if (length < sizeof(sa_family_t) || !bytesAt(tid, req->data.args[1], &a, length)) break;
      /* A socket's path: as the call gave it, zero-ended, and made whole from the working directory, as every other
       * path is written. A whole path longer than an address holds is written whole all the same. */
      const struct sockaddr_un *u = (const struct sockaddr_un *)&a;
      char name[sizeof u->sun_path + 1], full[PATH_MAX + 1];
      name[0] = full[0] = 0;
      int relative = 0;
      if (a.ss_family == AF_UNIX && length > offsetof(struct sockaddr_un, sun_path) && u->sun_path[0] != 0) {
        size_t n = length - offsetof(struct sockaddr_un, sun_path);
        if (n > sizeof u->sun_path) n = sizeof u->sun_path;
        snprintf(name, sizeof name, "%.*s", (int)strnlen(u->sun_path, n), u->sun_path);
        if (name[0] == '/') snprintf(full, sizeof full, "%s", name);
        else relative = wholeSocketPath(tid, tgid, c->nr, &a, length, full, sizeof full);
        if (name[0] != '/' && !relative) full[0] = 0;
      }
      begin(&t, tgid, c->name);
      printf_(&t, "%d, ", (int)req->data.args[0]);
      socketAddress(&t, &a, length, relative ? full : NULL);
      if (c->kind == K_CONNECT) {
        int error = 0;
        if (a.ss_family == AF_UNIX) {
          /* Nothing there, or no socket there: the kernel refuses the connection, and the run learns which. */
          struct stat st;
          if (full[0] != 0 && !pseudo(full)) {
            error = stat(full, &st) != 0 ? (errno == ENOENT ? ENOENT : 0) : S_ISSOCK(st.st_mode) ? 0 : ECONNREFUSED;
            refusing = refusedCall(tid, c->nr, 0, full);
          }
        } else if (loopbackAddress(&a)) {
          unsigned port = a.ss_family == AF_INET ? ntohs(((struct sockaddr_in *)&a)->sin_port)
                                                 : ntohs(((struct sockaddr_in6 *)&a)->sin6_port);
          if (!listening(tid, port)) error = ECONNREFUSED;
          refusing = refusedCall(tid, c->nr, port, NULL);
        }
        if (refusing != NULL) {
          /* A copy of the socket, to ask once the call has ended whether it connected. With no descriptor left to
           * copy it with, nothing could say a line written as refused was answered after all: the run is unrecorded. */
          int pidfd = (int)syscall(SYS_pidfd_open, tgid, 0);
          if (pidfd < 0) starvedBy(errno);
          refusing->copy = pidfd < 0 ? -1 : (int)syscall(SYS_pidfd_getfd, pidfd, (int)req->data.args[0], 0);
          if (pidfd >= 0 && refusing->copy < 0) starvedBy(errno);
          if (pidfd >= 0) close(pidfd);
          int flags = refusing->copy < 0 ? 0 : fcntl(refusing->copy, F_GETFL);
          refusing->inProgress = flags >= 0 && (flags & O_NONBLOCK) && a.ss_family != AF_UNIX;
          refusing->predicted = error;
        }
        if (refusing != NULL && a.ss_family != AF_UNIX && tcpSocket(refusing->copy)) {
          puts_(&t, " /* smthrs: tcp */");
        }
        printf_(&t, ", %u)", (unsigned)length);
        if (refusing != NULL) refusing->at = t.length;
        answer(&t, error);
        break;
      }
      printf_(&t, ", %u)", (unsigned)length);
      /* Only a socket bound to a path or to a port is written: its copy says once it is bound. A bind of another
       * family (netlink, as the C library's getaddrinfo and getifaddrs make one each call; a packet socket) writes
       * no line, so it is given no copy: held to the end of the run, thousands of them took every descriptor this
       * program may have. */
      if (a.ss_family != AF_UNIX && a.ss_family != AF_INET && a.ss_family != AF_INET6) {
        free(t.data);
        return;
      }
      /* A socket bound to a path makes that name: calls on the name at once are in one group with it. */
      if (full[0] != 0) {
        struct answered *making = calloc(1, sizeof *making);
        if (making != NULL) {
          settleName(full);
          struct ident before;
          identify(full, &before);
          /* Where nothing is, the bind makes the name when the directory it goes in is there. */
          *making = (struct answered){0, -1, 0, before.there ? EADDRINUSE : parentThere(full, 0, ENOENT), 0, 0};
          struct change *binding_ = changing(tid, c->nr, full, MAKES, 1, &before, making);
          formOf(binding_, F_BIND, S_IFSOCK);
          opened(binding_);
          if (making->holders == 0) freeAnswered(making);
        }
      }
      /* A path there already is one the run found: the bind fails on it. One not there is the run's once bound. */
      if (full[0] != 0 && !pseudo(full) && look(full, 1) == 0) found(tgid, id, 0, full);
      /* A bind is written once the socket says it is bound (settleBindings). */
      /* With no descriptor left for the copy the bind's line is lost: the run is unrecorded (starvedBy), never
       * short a line. */
      int pidfd = (int)syscall(SYS_pidfd_open, tgid, 0);
      if (pidfd < 0) starvedBy(errno);
      int copy = pidfd < 0 ? -1 : (int)syscall(SYS_pidfd_getfd, pidfd, (int)req->data.args[0], 0);
      int refused = pidfd >= 0 && copy < 0 && errno == EPERM;
      if (pidfd >= 0 && copy < 0) starvedBy(errno);
      if (pidfd >= 0) close(pidfd);
      if (copy >= 0 && !t.failed) {
        struct binding *b = calloc(1, sizeof *b);
        if (b != NULL) {
          b->id = id;
          b->tid = tid;
          b->tgid = tgid;
          b->nr = c->nr;
          b->fd = (int)req->data.args[0];
          b->copy = copy;
          b->asked = a;
          b->askedLength = length;
          b->line = t.data;
          pthread_mutex_lock(&lock);
          b->next = bindings;
          __atomic_store_n(&bindings, b, __ATOMIC_RELEASE);
          pthread_mutex_unlock(&lock);
          return;
        }
        /* No memory to hold the bind until its socket answers: its line is lost, and the run says so. */
        __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
        close(copy);
      } else if (copy >= 0) {
        close(copy);
      } else if (refused && !t.failed) {
        /* A process gone, or a descriptor that is no socket, binds nothing; a refusal would lose the line. */
        unrecorded("this machine refuses pidfd_getfd, which reads a socket the run bound; a container allows it with "
                   "CAP_SYS_PTRACE");
      }
      if (t.failed) __atomic_store_n(&dropped, 1, __ATOMIC_RELAXED);
      free(t.data);
      return;
    }
    case K_SEND:
      /* What the send was answered is not known when it is written; a reader counts it either way. */
      sendLine(&t, tid, tgid, c, req);
      break;
    case K_REFUSED:
      refuse(c->name);
      return;
    case K_MAKE: {
      if (!pathOf(tid, req, c->dir, c->path, path, sizeof path, &why)) break;
      settleName(path);
      struct ident before;
      int there = identify(path, &before);
      if (there == 0 && !pseudo(path)) found(tgid, id, 0, path);
      begin(&t, tgid, "mknodat");
      puts_(&t, "AT_FDCWD, ");
      quotedz(&t, path);
      puts_(&t, ", 0)");
      int error = there == 0 ? EEXIST : there == ENOENT ? parentThere(path, 0, ENOENT) : there;
      if ((line = calloc(1, sizeof *line)) != NULL) {
        *line = (struct answered){0, -1, t.length, error, 0, 0};
        changes[0] = changing(tid, c->nr, path, MAKES, 1, &before, line);
        formOf(changes[0], F_MKNOD, 0);
      }
      answer(&t, error);
      break;
    }
    case K_SPACE:
      if (req->data.args[0] & NEW_NAMESPACES) {
        unrecorded("it made a namespace of its own");
        return;
      }
      ownCwd(tid);
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
      f->generation = generationOf(tgid)->count;
      f->next = forkings;
      forkings = f;
      pthread_mutex_unlock(&lock);
      return;
    }
    case K_RING:
      /* A ring's requests are read by the kernel from memory the run shares with it, where this program cannot read
       * them as the kernel does: the run gets none, as in a container's default filter, and programs fall back. The
       * call is answered here, not let go, and its line says so: a step that fails without a ring is named. */
      begin(&t, tgid, c->name);
      printf_(&t, "%u, 0x%llx)", (unsigned)req->data.args[0], (unsigned long long)req->data.args[1]);
      answer(&t, ENOSYS);
      refusedWith = ENOSYS;
      break;
    case K_RING_ENTER: {
      /* RecordedCalls.ringUsed: a ring the run was given, since no run sets one up. */
      char reason[256];
      snprintf(reason, sizeof reason,
               "it used an io_uring (%s), whose requests the kernel reads from memory the step can change after any "
               "recorder looked",
               c->name);
      unrecorded(reason);
      return;
    }
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
    /* A call on a descriptor that names no file reads none: nothing is written of it. */
    if (strcmp(why, "none") == 0) return;
    if (strcmp(why, "up") == 0) {
      unrecorded("it named a path that goes back up inside /proc or /dev, which cannot be followed as it ran");
      return;
    }
    if (strcmp(why, "long") == 0) {
      refuse("a path longer than 4095 bytes");
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
  if (t.data == NULL && !t.failed) {
    if (line != NULL && line->holders == 0) freeAnswered(line);
    return;
  }
  uint64_t taking = 0;
  long place = keepCallIn(id, 2, &t, &taking);
  if (starting != NULL) {
    starting->place = place;
    starting->taking = taking;
  }
  uncertainIn(busy, taking, place);
  if (looking != NULL) {
    looking->taking = taking;
    looking->place = place;
  }
  if (refusing != NULL) {
    refusing->place = place;
    refusing->taking = taking;
  }
  if (line != NULL) {
    line->place = place;
    line->taking = taking;
    opened(changes[0]);
    opened(changes[1]);
    if (line->holders == 0) freeAnswered(line);
  }
}

/*
 * What the serving thread needs, made before the command is let go: a command whose first call waits for a thread
 * that never came to serve waits for good, and this program with it.
 */
static struct seccomp_notif_sizes notifSizes;
static struct seccomp_notif *servingReq;
static struct seccomp_notif_resp *servingResp;

static int readyToServe(void) {
  if (syscall(SYS_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &notifSizes) != 0) return 0;
  servingReq = calloc(1, notifSizes.seccomp_notif);
  servingResp = calloc(1, notifSizes.seccomp_notif_resp);
  return servingReq != NULL && servingResp != NULL;
}

static void *serving(void *unused) {
  (void)unused;
  sigset_t all_;
  sigfillset(&all_);
  sigdelset(&all_, SIGUSR1);
  pthread_sigmask(SIG_SETMASK, &all_, NULL);
  /* What it receives into and answers from was made before the command was let go (readyToServe). */
  struct seccomp_notif_sizes sizes = notifSizes;
  struct seccomp_notif *req = servingReq;
  struct seccomp_notif_resp *resp = servingResp;
  for (;;) {
    memset(req, 0, sizes.seccomp_notif);
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, req) != 0) {
      /* Woken to end, or a call whose thread ended or was interrupted before it was received. */
      if (__atomic_load_n(&stopping, __ATOMIC_ACQUIRE)) break;
      continue;
    }
    pthread_mutex_lock(&serving_lock);
    refusedWith = 0;
    serve(req);
    int error = refusedWith;
    pthread_mutex_unlock(&serving_lock);
    memset(resp, 0, sizes.seccomp_notif_resp);
    resp->id = req->id;
    resp->flags = error == 0 ? SECCOMP_USER_NOTIF_FLAG_CONTINUE : 0;
    resp->error = -error;
    /* A call whose thread ended or was interrupted meanwhile has no one to answer. */
    ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, resp);
  }
  return NULL;
}

/* ---- Bound sockets ---------------------------------------------------------------------------------------------- */

/* Whether the copy of a socket says it is bound where the process asked; `now` is then where it is bound. */
static int saysBound(const struct binding *b, struct sockaddr_storage *now) { /* `now` may be the binding's own */
  socklen_t length = sizeof *now;
  memset(now, 0, sizeof *now);
  if (getsockname(b->copy, (struct sockaddr *)now, &length) != 0 || now->ss_family != b->asked.ss_family) return 0;
  if (now->ss_family == AF_UNIX) {
    /* A path is compared as a path, whatever length each side gave; an abstract name byte for byte. */
    const char *at = ((struct sockaddr_un *)now)->sun_path, *asked = ((struct sockaddr_un *)&b->asked)->sun_path;
    size_t room = sizeof ((struct sockaddr_un *)now)->sun_path;
    size_t nowLength = length > offsetof(struct sockaddr_un, sun_path) ? length - offsetof(struct sockaddr_un, sun_path) : 0;
    size_t askedLength = b->askedLength > offsetof(struct sockaddr_un, sun_path)
                           ? b->askedLength - offsetof(struct sockaddr_un, sun_path)
                           : 0;
    if (nowLength > 0 && at[0] != 0) return strncmp(at, asked, room) == 0;
    return nowLength > 0 && nowLength == askedLength && memcmp(at, asked, nowLength) == 0;
  }
  if (now->ss_family == AF_INET || now->ss_family == AF_INET6) {
    unsigned asked = now->ss_family == AF_INET ? ntohs(((struct sockaddr_in *)&b->asked)->sin_port)
                                               : ntohs(((struct sockaddr_in6 *)&b->asked)->sin6_port);
    unsigned port = now->ss_family == AF_INET ? ntohs(((struct sockaddr_in *)now)->sin_port)
                                              : ntohs(((struct sockaddr_in6 *)now)->sin6_port);
    return port != 0 && (asked == 0 || asked == port);
  }
  return 0;
}

/*
 * Writes the line of a bind the socket says was made (`now`: where it is bound), and lets the copy go. A socket
 * asked to bind to port 0 is bound to a port the kernel chose: the line names that port, in the address the call
 * gave, as if the call had asked for it. A reader then knows the port as the run's own, and a connection to any
 * other local port as one to a program outside the run; told only `htons(0)`, it could tell neither.
 */
static void written(struct binding *b, const struct sockaddr_storage *now) {
  int dual = now != NULL && now->ss_family == AF_INET6 && b->asked.ss_family == AF_INET6 &&
            b->askedLength >= sizeof(struct sockaddr_in6) &&
            IN6_IS_ADDR_UNSPECIFIED(&((const struct sockaddr_in6 *)now)->sin6_addr) &&
            IN6_IS_ADDR_UNSPECIFIED(&((const struct sockaddr_in6 *)&b->asked)->sin6_addr) &&
            tcpSocket(b->copy) && socketOptionIs(b->copy, IPPROTO_IPV6, IPV6_V6ONLY, 0) &&
            socketOptionIs(b->copy, SOL_SOCKET, SO_REUSEPORT, 0);
  close(b->copy);
  if (now != NULL) {
    struct text t = {0};
    struct sockaddr_storage shown = b->asked;
    int chosen = 0;
    if (shown.ss_family == AF_INET && ((struct sockaddr_in *)&shown)->sin_port == 0) {
      ((struct sockaddr_in *)&shown)->sin_port = ((const struct sockaddr_in *)now)->sin_port;
      chosen = 1;
    } else if (shown.ss_family == AF_INET6 && ((struct sockaddr_in6 *)&shown)->sin6_port == 0) {
      ((struct sockaddr_in6 *)&shown)->sin6_port = ((const struct sockaddr_in6 *)now)->sin6_port;
      chosen = 1;
    }
    if (chosen || dual) {
      printf_(&t, "%d bind(%d, ", b->tgid, b->fd);
      socketAddress(&t, &shown, b->askedLength, NULL);
      if (dual) puts_(&t, " /* smthrs: tcp dual-stack */");
      printf_(&t, ", %u)", (unsigned)b->askedLength);
    } else {
      puts_(&t, b->line);
    }
    puts_(&t, " = 0");
    keep(b->id, 2, &t);
  }
  free(b->line);
  free(b);
}

/*
 * Lets go of the copy of every socket that already says it is bound, writing its line, and of every one whose bind
 * has surely ended without binding it (it failed: the port was taken, the path was there): called before a call of
 * the run goes on and at each tick, so a port the run closed is free again for it, as it is unrecorded, and a
 * socket it closed is closed. `stopped` is a thread that stopped again, whose binds have ended; 0 for none. Whether
 * a bind has ended is asked before its socket is: a bind that ends between the two is then seen bound.
 */
static void settleBindings(pid_t stopped) {
  struct binding *settled = NULL, *failed = NULL;
  pthread_mutex_lock(&lock);
  for (struct binding **at = &bindings; *at != NULL;) {
    struct binding *b = *at;
    int bound = saysBound(b, &b->now), over = 0;
    if (!bound && (b->tid == stopped || pastCall(b->tid, b->nr))) {
      over = 1;
      bound = saysBound(b, &b->now);
    }
    if (bound || over) {
      __atomic_store_n(at, b->next, __ATOMIC_RELEASE);
      struct binding **list = bound ? &settled : &failed;
      b->next = *list;
      *list = b;
    } else {
      at = &b->next;
    }
  }
  pthread_mutex_unlock(&lock);
  while (settled != NULL) {
    struct binding *next = settled->next;
    written(settled, &settled->now);
    settled = next;
  }
  while (failed != NULL) {
    struct binding *next = failed->next;
    written(failed, NULL);
    failed = next;
  }
}

/* ---- The end of the run --------------------------------------------------------------------------------------- */

static void boundSockets(void) {
  pthread_mutex_lock(&lock);
  struct binding *left = bindings;
  __atomic_store_n(&bindings, NULL, __ATOMIC_RELEASE);
  pthread_mutex_unlock(&lock);
  while (left != NULL) {
    struct binding *b = left;
    left = b->next;
    written(b, saysBound(b, &b->now) ? &b->now : NULL);
  }
}

static int byOrder(const void *a, const void *b) {
  const struct line *x = a, *y = b;
  if (x->id != y->id) return x->id < y->id ? -1 : 1;
  return x->sub < y->sub ? -1 : x->sub > y->sub ? 1 : 0;
}

/* A reason or a program, written on one line: a control byte in it (a name may hold a newline) would end the line,
 * and what followed could read as a line of its own. */
static void markerText(FILE *out, const char *text) {
  for (const unsigned char *at = (const unsigned char *)text; *at != 0; at++) {
    if (*at >= 0x20 && *at != 0x7f) fputc(*at, out);
    else fprintf(out, "\\x%02x", *at);
  }
}

/* How many reasons and programs that ask for rights were written already: a step's sealed trace holds them, and what
 * comes after (writeKept) holds only those made since. */
static int reasonsWritten, rightsWritten;

/*
 * Writes every reason the run cannot be recorded for and every program that asks for rights from `reasonsFrom` and
 * `rightsFrom` on, as lines; `*reasonsTo` and `*rightsTo` are how many there are now. The reasons include a line
 * that could not be kept and a descriptor this program lacked, each noted without the lock. What is written is read
 * under `lock`: the serving thread adds to both while a step's trace is written (`--keep`).
 */
static void writeMarkers(FILE *out, int reasonsFrom, int rightsFrom, int *reasonsTo, int *rightsTo) {
  if (__atomic_load_n(&dropped, __ATOMIC_RELAXED)) unrecorded(droppedReason);
  if (__atomic_load_n(&starved, __ATOMIC_RELAXED)) unrecorded(starvedReason);
  pthread_mutex_lock(&lock);
  int reasonsNow = reasonCount, rightsNow = rightsCount;
  char **theirs = rightsNow > rightsFrom ? malloc((size_t)(rightsNow - rightsFrom) * sizeof *theirs) : NULL;
  /* The list of programs may move when it grows: its strings never do. */
  int unlisted = theirs == NULL && rightsNow > rightsFrom;
  if (theirs != NULL) memcpy(theirs, rightsNeeded + rightsFrom, (size_t)(rightsNow - rightsFrom) * sizeof *theirs);
  else rightsNow = rightsFrom;
  pthread_mutex_unlock(&lock);
  /* No memory to list the programs: they are written the next time, and this trace says it is short. */
  if (unlisted) fprintf(out, "%d +++ unrecorded: %s +++\n", rootPid, droppedReason);
  for (int i = reasonsFrom; i < reasonsNow; i++) {
    fprintf(out, "%d +++ unrecorded: ", rootPid);
    markerText(out, reasons[i]);
    fputs(" +++\n", out);
  }
  for (int i = rightsFrom; i < rightsNow; i++) {
    fprintf(out, "%d +++ rights: ", rootPid);
    markerText(out, theirs[i - rightsFrom]);
    fputs(" +++\n", out);
  }
  free(theirs);
  *reasonsTo = reasonsNow;
  *rightsTo = rightsNow;
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
    if (lines->items[i].sub & LEFT_OUT) continue;
    fwrite(lines->items[i].text, 1, lines->items[i].length, out);
    fputc('\n', out);
  }
  int reasonsNow = 0, rightsNow = 0;
  writeMarkers(out, 0, 0, &reasonsNow, &rightsNow);
  unsigned long stops = __atomic_load_n(&signalStops, __ATOMIC_RELAXED);
  if (stops > 0) fprintf(out, "%d +++ signal stops: %lu +++\n", rootPid, stops);
  fprintf(out, "%d +++ complete +++\n", rootPid);
  if (fflush(out) != 0 || ferror(out)) {
    fclose(out);
    unlink(written);
    return 0;
  }
  if (fclose(out) != 0) return 0;
  if (rename(written, file) != 0) return 0;
  reasonsWritten = reasonsNow;
  rightsWritten = rightsNow;
  return 1;
}

static int writeTrace(const char *file) { return writeLines(file, &all); }

/* Takes every line kept so far, in the order of the calls, and leaves none kept. */
static struct lines takeLines(void) {
  pthread_mutex_lock(&lock);
  struct lines taken = all;
  all = (struct lines){0};
  linesTaken++;
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
  settleBindings(0);
  lockServing();
  settlePast();
  struct lines taken = takeLines();
  pthread_mutex_unlock(&serving_lock);
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
 * Lines of what the step left that never reached `.kept`: the file could not be opened, or a write to it failed. They
 * are gone, so what follows the step is unrecorded, and stays so: the reason is written to `.kept` as soon as a write
 * there succeeds (`lostWritten`), again after each later loss, and until then no request is answered. A reader that is told every line is on disk
 * either has them all or has the reason.
 */
static int keptLost, lostWritten;
static const char *lostReason = "the recorder could not write every line of what the step left running";

/*
 * Appends the lines made since the step's trace, or since the last time, to the trace file's name with `.kept`, and
 * with them every reason the run cannot be recorded and every program that asks for rights made since the step's
 * trace was sealed: a program the step left running that makes a namespace, uses a ring, or changes a name in a way
 * its written line does not say, is unrecorded where the steps after it read of it. A reader that has to know every
 * line made so far is on disk writes a number to the name with `.ask`: once the lines are written, the number is
 * written to the name with `.answered`, and never before they are. Answers whether everything made so far is
 * written, or is said to be lost.
 */
static int writeKept(const char *file) {
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
  } else {
    starvedBy(errno); /* a request that cannot be read waits, and the reason is written below */
  }
  settleBindings(0);
  lockServing();
  settlePast();
  struct lines taken = takeLines();
  pthread_mutex_unlock(&serving_lock);
  if (__atomic_load_n(&dropped, __ATOMIC_RELAXED)) unrecorded(droppedReason);
  if (__atomic_load_n(&starved, __ATOMIC_RELAXED)) unrecorded(starvedReason);
  pthread_mutex_lock(&lock);
  int news = reasonCount > reasonsWritten || rightsCount > rightsWritten;
  pthread_mutex_unlock(&lock);
  /* Lines were lost and the file does not say so yet: it is written to even when nothing else is new. */
  int owed = keptLost && !lostWritten;
  if (taken.count > 0 || news || owed) {
    char keptFile[PATH_MAX + 32];
    snprintf(keptFile, sizeof keptFile, "%s.kept", file);
    FILE *out = fopen(keptFile, "ae");
    int ok = out != NULL, reasonsNow = reasonsWritten, rightsNow = rightsWritten;
    if (out != NULL) {
      /* After a write that failed the file may end inside a line: what is written now starts on a line of its own.
       * The loss is said here, each time lines are lost, and not among the reasons kept (unrecorded): those are each
       * written once, so a second loss would never be said, and they hold only so many, so this one could find no
       * place. */
      if (owed) fprintf(out, "\n%d +++ unrecorded: %s +++\n", rootPid, lostReason);
      for (size_t i = 0; i < taken.count; i++) {
        if (taken.items[i].sub & LEFT_OUT) continue;
        fwrite(taken.items[i].text, 1, taken.items[i].length, out);
        fputc('\n', out);
      }
      writeMarkers(out, reasonsWritten, rightsWritten, &reasonsNow, &rightsNow);
      if (fflush(out) != 0 || ferror(out)) ok = 0;
      if (fclose(out) != 0) ok = 0;
    } else {
      starvedBy(errno);
    }
    if (ok) {
      /* What was written says that lines were lost before, when they were. */
      if (owed) lostWritten = 1;
      reasonsWritten = reasonsNow;
      rightsWritten = rightsNow;
    } else {
      /* These lines are lost, and the reasons with them are written again: the next write says so first. */
      keptLost = 1;
      lostWritten = 0;
    }
  }
  freeLines(&taken);
  /* Lines were lost and the file does not say so yet: no request is answered. */
  if (keptLost && !lostWritten) return 0;
  if (asked > answered) {
    char answeredFile[PATH_MAX + 32];
    snprintf(answeredFile, sizeof answeredFile, "%s.answered", file);
    snprintf(text, sizeof text, "%ld\n", asked);
    if (writeWhole(answeredFile, text)) answered = asked;
  }
  return 1;
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

/* Whether this machine lets the recorder run: the filter, a copy of a descriptor of the filtered process (how a
 * bound socket is read), and a read of that process's memory (how every path a call names is read). Where it does
 * not, one line on standard error says what it refused, and it answers 126. */
static const char probed[] = "smthrs-observe reads this of the process it probes";

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
  int copied = 0, readable = 0;
  if (said == 0) {
    int pidfd = (int)syscall(SYS_pidfd_open, child, 0);
    int copy = pidfd < 0 ? -1 : (int)syscall(SYS_pidfd_getfd, pidfd, sv[1], 0);
    copied = copy >= 0 ? 0 : errno;
    if (copy >= 0) close(copy);
    if (pidfd >= 0) close(pidfd);
    /* The child's memory is this program's own, copied: what is at `probed` there is what is at it here. */
    char word[sizeof probed];
    struct iovec local = {word, sizeof word}, remote = {(void *)(uintptr_t)probed, sizeof word};
    errno = 0;
    ssize_t n = process_vm_readv(child, &local, 1, &remote, 1, 0);
    if (n != (ssize_t)sizeof word || memcmp(word, probed, sizeof word) != 0) readable = n < 0 ? errno : EIO;
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
  if (readable != 0) {
    fprintf(stderr,
            "smthrs-observe cannot run here: this machine refuses process_vm_readv, which reads the paths a step "
            "names: %s; a container allows it with CAP_SYS_PTRACE\n",
            strerror(readable));
    return 126;
  }
  return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 126;
}

static void wake(int sig) { (void)sig; }

/* The most descriptors any process of the machine may have (`fs.nr_open`), or 0 when it cannot be read. */
static rlim_t mostOpen(void) {
  char text[64];
  int fd = open("/proc/sys/fs/nr_open", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t n = read(fd, text, sizeof text - 1);
  close(fd);
  if (n <= 0) return 0;
  text[n] = 0;
  return (rlim_t)strtoull(text, NULL, 10);
}

/*
 * Raises this program's limit of descriptors to the most it may have, once the command's process is made: that
 * process keeps the limit this program was given. Answers whether the limit was raised; `*given` is then the limit a
 * process this program makes after (the command started again, where no listener could be taken) is given back.
 *
 * The kernel refuses (`EPERM`) any limit whose hard part is above `fs.nr_open`, even one that leaves the hard part as
 * it is: where a machine gives an unlimited hard limit, the limit could not be raised at all, and a run that binds
 * many sockets left this program without descriptors. There the limit is raised to `fs.nr_open`, which is as many as
 * the kernel gives anyone. The hard part is lowered to it by that, and this program may not raise it again: `*given`
 * then says `fs.nr_open` for its hard part, the most a process made after can be given back, and no fewer
 * descriptors than it could have had.
 */
static int raiseLimit(struct rlimit *given) {
  if (getrlimit(RLIMIT_NOFILE, given) != 0 || given->rlim_cur >= given->rlim_max) return 0;
  struct rlimit most = {given->rlim_max, given->rlim_max};
  if (setrlimit(RLIMIT_NOFILE, &most) == 0) return 1;
  if (errno != EPERM) return 0;
  rlim_t open_ = mostOpen();
  if (open_ <= given->rlim_cur || open_ >= given->rlim_max) return 0;
  most.rlim_cur = most.rlim_max = open_;
  if (setrlimit(RLIMIT_NOFILE, &most) != 0) return 0;
  given->rlim_max = open_;
  return 1;
}

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
    /* Once the command is reaped its id is free: a process the command left, given that id later, is not the
     * command, and a signal passed on to the id would reach whatever has it by then. */
    if (pid == child && !rootDone) {
      code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      commandPid = 0;
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

/*
 * `smthrs-observe --guard -- <command>` runs a command strace records with a filter of its own that hands strace the
 * calls it would otherwise let by unseen. strace's filter lets through a call it has no name for once it is told to
 * trace as many calls as a recorded run is (strace 6.8: from 77), so a trace would never show `getxattrat`, or a call
 * newer than strace, and the record would say less than the run read. This filter sends strace every call numbered
 * from GUARD_FROM on, each call from 424 on that names a file (`guarded`, from the table), and every call of another
 * architecture; strace writes each, by its number where it has no name. A program strace has let go of, as a job
 * keeps one a step left running, gets ENOSYS from those calls alone: no call a running program depends on is among
 * them (`pidfd_open`, `clone3`, `close_range`, `epoll_pwait2` and the futex calls are not).
 */
static int guard(char **command) {
  struct sock_filter f[8 + sizeof guarded / sizeof guarded[0] * 2];
  int n = 0;
#define S(code, k) (f[n++] = (struct sock_filter)BPF_STMT(code, k))
#define J(code, k, t, e) (f[n++] = (struct sock_filter)BPF_JUMP(code, k, t, e))
  S(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  J(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0);
  S(BPF_RET | BPF_K, SECCOMP_RET_TRACE);
  S(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
  J(BPF_JMP | BPF_JGE | BPF_K, GUARD_FROM, 0, 1);
  S(BPF_RET | BPF_K, SECCOMP_RET_TRACE);
  for (size_t i = 0; i < sizeof guarded / sizeof guarded[0]; i++) {
    J(BPF_JMP | BPF_JEQ | BPF_K, guarded[i], 0, 1);
    S(BPF_RET | BPF_K, SECCOMP_RET_TRACE);
  }
  S(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
#undef S
#undef J
  struct sock_fprog prog = {.len = (unsigned short)n, .filter = f};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) != 0) {
    /* Unguarded, the record could say less than the run read: the run fails, and runs again unrecorded. */
    fprintf(stderr, "smthrs-observe: this machine refuses the filter strace needs to see every call: %s\n",
            strerror(errno));
    return 126;
  }
  execvp(command[0], command);
  fprintf(stderr, "smthrs-observe: cannot start %s: %s\n", command[0], strerror(errno));
  return 125;
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
  if (argc >= 4 && strcmp(argv[1], "--guard") == 0 && strcmp(argv[2], "--") == 0) return guard(argv + 3);
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
  /* This program holds descriptors of its own while the run goes on: it may have as many as it is allowed. Its
   * limit is raised once the command's process is made (raiseLimit), so the command starts with the limit this
   * program was given. */
  struct rlimit given;
  int limited = 0;
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
    /* The listener's number, which the supervisor copies (pidfd_getfd), as --probe does: a send of the descriptor
     * itself is a call the filter hands to a supervisor that has no listener yet. */
    int fd = install();
    if (write(sv[1], &fd, sizeof fd) != (ssize_t)sizeof fd || fd < 0) _exit(126);
    /* Starts the command once the supervisor serves: its first call is the start itself. */
    char c;
    if (read(sv[1], &c, 1) != 1) _exit(126);
    close(fd);
    close(sv[1]);
    execvp(command[0], command);
    fprintf(stderr, "smthrs-observe: %s: %s\n", command[0], strerror(errno));
    _exit(errno == ENOENT ? 127 : 126);
  }
  close(sv[1]);
  limited = raiseLimit(&given);
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
  int theirs = -1;
  if (read(sv[0], &theirs, sizeof theirs) != (ssize_t)sizeof theirs || theirs < 0) {
    int status;
    waitpid(child, &status, 0);
    fprintf(stderr, "smthrs-observe: this host gives no seccomp listener\n");
    return 126;
  }
  int pidfd = (int)syscall(SYS_pidfd_open, child, 0);
  listener = pidfd < 0 ? -1 : (int)syscall(SYS_pidfd_getfd, pidfd, theirs, 0);
  if (pidfd >= 0) close(pidfd);
  if (listener < 0) {
    /* Nothing can serve the filtered process: it is ended, and the command runs with no filter, unrecorded. */
    int status;
    kill(child, SIGKILL);
    waitpid(child, &status, 0);
    unrecorded("this machine refuses pidfd_getfd, which the recorder takes its own listener with; a container allows "
               "it with CAP_SYS_PTRACE");
    child = fork();
    if (child < 0) return 125;
    if (child == 0) {
      if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) _exit(126);
      close(sv[0]);
      if (limited && setrlimit(RLIMIT_NOFILE, &given) != 0) _exit(126);
      execvp(command[0], command);
      fprintf(stderr, "smthrs-observe: %s: %s\n", command[0], strerror(errno));
      _exit(errno == ENOENT ? 127 : 126);
    }
    rootPid = child;
    commandPid = child;
  }
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
  int threads = listener < 0 ? 0 : 1;
  pthread_t serving_[1];
  for (int i = 0; i < threads; i++) {
    if (readyToServe() && pthread_create(&serving_[i], NULL, serving, NULL) == 0) continue;
    /* Nothing would serve the command's calls: it is ended before it starts, and the step runs unrecorded. */
    int ended;
    kill(child, SIGKILL);
    waitpid(child, &ended, 0);
    fprintf(stderr, "smthrs-observe: cannot start the thread that serves the command's calls\n");
    return 126;
  }
  if (listener >= 0 && write(sv[0], "g", 1) != 1) return 125;
  close(sv[0]);

  int status = 0, code = 125, rootDone = 0;
  struct timespec deadline = {0, 0};
  for (;;) {
    serveSeizes();
    pid_t pid;
    while ((pid = waitpid(-1, &status, __WALL | WNOHANG)) > 0) {
      if (WIFEXITED(status) || WIFSIGNALED(status)) {
        /* Once the command is reaped its id is free, and a process it left may be given it: that one ending is not
         * the command ending again, and seals no trace and answers no status. */
        if (pid == child && !rootDone) {
          code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
          commandPid = 0;
          rootDone = 1;
          clock_gettime(CLOCK_MONOTONIC, &deadline);
          deadline.tv_sec += 1;
          /* A step of a job ends with its command: what it left runs on, and is followed. */
          if (keepLeft && !writeStep(traceFile, code)) fprintf(stderr, "smthrs-observe: could not write %s\n", traceFile);
        }
        unwatch(pid);
        dropKept(pid);
        forget(pid);
        continue;
      }
      if (!WIFSTOPPED(status)) continue;
      int sig = WSTOPSIG(status), event = status >> 16;
      if (event == PTRACE_EVENT_STOP) {
        if (sig == SIGSTOP || sig == SIGTSTP || sig == SIGTTIN || sig == SIGTTOU) ptrace(PTRACE_LISTEN, pid, 0, 0);
        else ptrace(PTRACE_CONT, pid, 0, 0);
      } else if (event == PTRACE_EVENT_EXEC) {
        /* A new program starts with every handler at its default: nothing to watch until it sets one. The thread
         * that started it runs on as the process's first, under that thread's id: the event says which it was. */
        unsigned long was = 0;
        if (ptrace(PTRACE_GETEVENTMSG, pid, 0, &was) != 0) was = 0;
        unwatch(pid);
        ptrace(PTRACE_DETACH, pid, 0, 0);
        letGoKept(pid, pid);
        if (was != 0 && (pid_t)was != pid) letGoKept((pid_t)was, pid);
      } else if (event == PTRACE_EVENT_EXIT) {
        /* A thread that starts to end is let go: once it ended, its parent reaps it, not this supervisor. */
        unwatch(pid);
        dropKept(pid);
        forget(pid);
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
      if (keepLeft) (void)writeKept(traceFile);
      else if (now.tv_sec > deadline.tv_sec || (now.tv_sec == deadline.tv_sec && now.tv_nsec >= deadline.tv_nsec)) endLeft();
    }
    sendStale();
    /* A socket that says it is bound, or whose bind failed, is let go within a tick: a socket the run closed is
     * closed then, and its peer is told. */
    if (__atomic_load_n(&bindings, __ATOMIC_ACQUIRE) != NULL) settleBindings(0);
    /* A connection asked again once its thread is past it: the copy of its socket is let go within a tick. */
    if (__atomic_load_n(&refusedCalls, __ATOMIC_ACQUIRE) != NULL) {
      lockServing();
      settleRefused(0, 0);
      pthread_mutex_unlock(&serving_lock);
    }
    struct timespec tick = {0, 5000000};
    sigtimedwait(&waits, NULL, &tick);
  }
  /* No process of the run is left, so no call waits: the serving threads end. */
  __atomic_store_n(&stopping, 1, __ATOMIC_RELEASE);
  endSeizes();
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
      endSeizes();
      pthread_kill(serving_[i], SIGUSR1);
      clock_gettime(CLOCK_REALTIME, &soon);
      soon.tv_nsec += 20000000;
      if (soon.tv_nsec >= 1000000000) {
        soon.tv_sec += 1;
        soon.tv_nsec -= 1000000000;
      }
    }
  }
  if (listener >= 0) close(listener);
  boundSockets();
  settleChanges(0);
  settleRefused(0, 1);
#ifdef STORM_STATS
  fprintf(stderr, "storm-stats: most stops %u over %ld ms\n", mostStops, longestMs);
#endif
  if (keepLeft && rootDone) {
    /* Every process it followed has ended. Once every line is written, with each reason the run cannot be recorded,
     * any request is answered, now and later; while they are not (the disk is full), none is, and a reader that
     * asks learns the lines are not there. */
    int everything = writeKept(traceFile);
    for (int again = 0; !everything && again < 40; again++) {
      struct timespec pause = {0, 50000000};
      nanosleep(&pause, NULL);
      everything = writeKept(traceFile);
    }
    char answeredFile[PATH_MAX + 32];
    snprintf(answeredFile, sizeof answeredFile, "%s.answered", traceFile);
    if (!everything || !writeWhole(answeredFile, "9223372036854775807\n"))
      fprintf(stderr, "smthrs-observe: could not write %s.kept\n", traceFile);
  } else if (!writeTrace(traceFile)) {
    fprintf(stderr, "smthrs-observe: could not write %s\n", traceFile);
  }
  return code;
}
