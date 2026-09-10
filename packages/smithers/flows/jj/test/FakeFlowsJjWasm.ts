/**
 * A hand-assembled wasm module speaking the frozen `flows_jj` ABI, for driving
 * `BrowserJj` without the real jj build.
 *
 * The real artifact cannot answer with a *chosen* response, so each test bakes
 * the response it wants into the module as a data segment. The module:
 *
 * - exports `memory`, `_initialize`, `flows_jj_alloc`, `flows_jj_free`,
 *   `flows_jj_call` — the exact frozen export surface;
 * - `_initialize` writes `INIT` to fd 2 through the imported WASI `fd_write`,
 *   so a test can observe that the reactor initializer ran exactly once (and
 *   that `BrowserJj` wired the shim's stderr sink);
 * - `flows_jj_call` echoes the request bytes to fd 2 — the only window a test
 *   has into what the host serialized — then returns `(64 << 32) | len`
 *   pointing at the canned response the data segments placed at offset 64;
 * - with `trap: true`, `flows_jj_call` instead calls the imported `proc_exit`,
 *   exercising the host's trap handling; with `openBeforeTrap` it first opens
 *   `/f` for reading through the imported `path_open` and never closes it, so
 *   a test can check the host releases what a trapped guest left open;
 * - with `packedResult`, `flows_jj_call` returns exactly `(ptr << 32) | len`
 *   without writing any response — for driving the host's handling of a
 *   corrupt answer whose buffer lies outside wasm memory.
 *
 * Memory map: `0..4` response length, `32..40` scratch iovec, `64..` canned
 * response, `1024..1028` the `INIT` marker, `1032..1036`/`1040..1044` the
 * `ALOC`/`FREE` markers (written to fd 2 when `logAllocs` is set, so a test
 * can assert the host's alloc/free pairing discipline), `1048..1049` the
 * path `/f`, `4096` the fixed allocation `flows_jj_alloc` returns.
 */

const encoder = new TextEncoder()

const uleb = (value: number): Array<number> => {
  const out: Array<number> = []
  let n = value
  do {
    let byte = n & 0x7f
    n >>>= 7
    if (n !== 0) byte |= 0x80
    out.push(byte)
  } while (n !== 0)
  return out
}

const sleb = (value: number): Array<number> => {
  const out: Array<number> = []
  let n = value
  for (;;) {
    const byte = n & 0x7f
    n >>= 7
    if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) {
      out.push(byte)
      return out
    }
    out.push(byte | 0x80)
  }
}

const str = (text: string): Array<number> => {
  const bytes = Array.from(encoder.encode(text))
  return [...uleb(bytes.length), ...bytes]
}

const vec = (items: Array<Array<number>>): Array<number> => [...uleb(items.length), ...items.flat()]

const section = (id: number, body: Array<number>): Array<number> => [id, ...uleb(body.length), ...body]

const i32c = (value: number): Array<number> => [0x41, ...sleb(value)]
const i64c = (value: number): Array<number> => [0x42, ...sleb(value)]
const I32_STORE = [0x36, 0x02, 0x00]
const I32_LOAD = [0x28, 0x02, 0x00]

/** locals-free function body, size-prefixed, `end` appended. */
const body = (instrs: Array<number>): Array<number> => {
  const content = [...uleb(0), ...instrs, 0x0b]
  return [...uleb(content.length), ...content]
}

/** `fd_write(2, iovec at 32 → {ptr, len}, 1, nwritten at 56)`, result dropped. */
const writeStderr = (ptr: Array<number>, len: Array<number>): Array<number> => [
  ...i32c(32),
  ...ptr,
  ...I32_STORE,
  ...i32c(36),
  ...len,
  ...I32_STORE,
  ...i32c(2),
  ...i32c(32),
  ...i32c(1),
  ...i32c(56),
  0x10,
  ...uleb(0), // call fd_write (import 0)
  0x1a // drop
]

export interface FakeFlowsJjWasmOptions {
  /** The canned JSON every `flows_jj_call` answers with. Defaults to `{"ok":{}}`. */
  readonly response?: string
  /** When set, `flows_jj_call` calls `proc_exit(7)` instead of answering. */
  readonly trap?: boolean
  /**
   * With `trap`, `flows_jj_call` first opens `/f` for reading through
   * `path_open` (fd 3, the preopen) and leaves it open, so the trap abandons a
   * live host descriptor the way a panicking guest does.
   */
  readonly openBeforeTrap?: boolean
  /**
   * When set, `flows_jj_call` returns exactly `(ptr << 32) | len` — a corrupt
   * packed answer the host must survive when it points outside wasm memory.
   * Both values must fit in an i32 (< 2^31).
   */
  readonly packedResult?: { readonly ptr: number; readonly len: number }
  /**
   * When set, `flows_jj_alloc` writes `ALOC` and `flows_jj_free` writes
   * `FREE` to fd 2, so a test can count the host's alloc/free pairing —
   * including on the trap path, where the request buffer must still be freed.
   */
  readonly logAllocs?: boolean
  /**
   * What `flows_jj_alloc` answers, defaulting to the fixed allocation at 4096.
   * `0` is what the real module returns when the guest is out of memory
   * (`crates/flows-jj/src/abi.rs`), which the host must refuse to write at.
   */
  readonly allocResult?: number
}

/** A syntactically valid module exporting nothing — for missing-export tests. */
export const emptyWasmModule = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

export const fakeFlowsJjWasm = (options: FakeFlowsJjWasmOptions = {}): Uint8Array<ArrayBuffer> => {
  const response = Array.from(encoder.encode(options.response ?? "{\"ok\":{}}"))
  if (response.length > 900) throw new Error("canned response too large for the fake module's memory map")

  const openF = [
    ...i32c(3), // dirfd: the preopen
    ...i32c(0), // dirflags
    ...i32c(1048), // path ptr
    ...i32c(2), // path len
    ...i32c(0), // oflags
    ...i64c(2), // rights_base: fd_read
    ...i64c(0), // rights_inheriting
    ...i32c(0), // fdflags
    ...i32c(48), // fd out
    0x10,
    ...uleb(2), // call path_open (import 2)
    0x1a // drop the errno
  ]
  const callBody = options.trap === true
    ? [...(options.openBeforeTrap === true ? openF : []), ...i32c(7), 0x10, ...uleb(1), 0x00] // proc_exit(7); unreachable
    : options.packedResult !== undefined
    ? [
      ...i64c(options.packedResult.ptr),
      ...i64c(32),
      0x86, // i64.shl
      ...i64c(options.packedResult.len),
      0x84 // i64.or → (ptr << 32) | len
    ]
    : [
      ...writeStderr([0x20, 0x00], [0x20, 0x01]), // echo the request (local 0, local 1) to stderr
      ...i64c(64),
      ...i64c(32),
      0x86, // i64.shl
      ...i32c(0),
      ...I32_LOAD,
      0xad, // i64.extend_i32_u
      0x84 // i64.or → (64 << 32) | responseLength
    ]

  const bytes = [
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    // types: 0 fd_write, 1 (), 2 alloc, 3 free, 4 call, 5 proc_exit, 6 path_open
    ...section(
      1,
      vec([
        [0x60, ...vec([[0x7f], [0x7f], [0x7f], [0x7f]]), ...vec([[0x7f]])],
        [0x60, ...vec([]), ...vec([])],
        [0x60, ...vec([[0x7f]]), ...vec([[0x7f]])],
        [0x60, ...vec([[0x7f], [0x7f]]), ...vec([])],
        [0x60, ...vec([[0x7f], [0x7f]]), ...vec([[0x7e]])],
        [0x60, ...vec([[0x7f]]), ...vec([])],
        [0x60, ...vec([[0x7f], [0x7f], [0x7f], [0x7f], [0x7f], [0x7e], [0x7e], [0x7f], [0x7f]]), ...vec([[0x7f]])]
      ])
    ),
    ...section(
      2,
      vec([
        [...str("wasi_snapshot_preview1"), ...str("fd_write"), 0x00, ...uleb(0)],
        [...str("wasi_snapshot_preview1"), ...str("proc_exit"), 0x00, ...uleb(5)],
        [...str("wasi_snapshot_preview1"), ...str("path_open"), 0x00, ...uleb(6)]
      ])
    ),
    // defined functions (indices 3..6): _initialize, alloc, free, call
    ...section(3, vec([uleb(1), uleb(2), uleb(3), uleb(4)])),
    ...section(5, vec([[0x00, ...uleb(1)]])),
    ...section(
      7,
      vec([
        [...str("memory"), 0x02, ...uleb(0)],
        [...str("_initialize"), 0x00, ...uleb(3)],
        [...str("flows_jj_alloc"), 0x00, ...uleb(4)],
        [...str("flows_jj_free"), 0x00, ...uleb(5)],
        [...str("flows_jj_call"), 0x00, ...uleb(6)]
      ])
    ),
    ...section(
      10,
      vec([
        body(writeStderr(i32c(1024), i32c(4))),
        body(
          options.logAllocs === true
            ? [...writeStderr(i32c(1032), i32c(4)), ...i32c(options.allocResult ?? 4096)]
            : i32c(options.allocResult ?? 4096)
        ),
        body(options.logAllocs === true ? writeStderr(i32c(1040), i32c(4)) : []),
        body(callBody)
      ])
    ),
    ...section(
      11,
      vec([
        [
          0x00,
          ...i32c(0),
          0x0b,
          ...uleb(4),
          response.length & 0xff,
          (response.length >>> 8) & 0xff,
          0x00,
          0x00
        ],
        [0x00, ...i32c(64), 0x0b, ...uleb(response.length), ...response],
        [0x00, ...i32c(1024), 0x0b, ...str("INIT")],
        [0x00, ...i32c(1032), 0x0b, ...str("ALOC")],
        [0x00, ...i32c(1040), 0x0b, ...str("FREE")],
        [0x00, ...i32c(1048), 0x0b, ...str("/f")]
      ])
    )
  ]
  return new Uint8Array(bytes)
}
