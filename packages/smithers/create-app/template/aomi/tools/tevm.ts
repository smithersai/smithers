/**
 * The chain tool: eight ordinary flow bindings over an in-memory EVM fork.
 *
 * A cell reaches every one of these with `ctx.call("tevm/<name>", input)`. The
 * handlers hold no chain logic of their own; each one calls the {@link Tevm}
 * service, whose method set mirrors the viem/tevm client the milestone-3
 * implementation wraps (`createMemoryClient` plus a fork transport).
 *
 * Money never crosses the boundary as a JSON number. A 256-bit wei value does
 * not fit in a float64, so every amount is a decimal string and every hash,
 * address, and calldata blob is a 0x-prefixed hex string.
 *
 * Two layers exist. {@link layerMock} answers with fixed data so the agent, the
 * panes, and the e2e fixtures run without a network. {@link layerTevm} is the
 * real one, built on `tevm`'s `createMemoryClient` over a fork transport.
 */
import * as Flow from "@smthrs/core/Flow"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { Abi, AbiFunction, MemoryClient } from "tevm"
import { createMemoryClient, decodeErrorResult, formatEther, http, parseAbi } from "tevm"
import { createCommon, mainnet } from "tevm/common"

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const Address = Schema.String.annotate({
  description: "20-byte account address, 0x-prefixed and hex encoded"
})

const Hex = Schema.String.annotate({
  description: "0x-prefixed hex string"
})

const Wei = Schema.String.annotate({
  description: "Amount in wei as a decimal string; a 256-bit value does not fit in a JSON number"
})

const BlockTag = Schema.String.annotate({
  description: "Block number as a decimal string, or one of latest, pending, safe, finalized, earliest"
})

const Quantity = Schema.String.annotate({
  description: "Unsigned integer as a decimal string"
})

/**
 * The one failure a chain call can report to a cell.
 *
 * Each binding explicitly opts its message into the public failure with
 * `publicError`. Keep messages model-facing and actionable; diagnostic causes
 * stay host-side.
 */
export class TevmError extends Schema.TaggedError<TevmError>()("aomi/tools/TevmError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

// ---------------------------------------------------------------------------
// Input and output schemas, one pair per binding
// ---------------------------------------------------------------------------

export const ForkInput = Schema.Struct({
  blockTag: Schema.optionalKey(BlockTag)
})
export type ForkInput = typeof ForkInput.Type

export const ForkOutput = Schema.Struct({
  chainId: Schema.Number,
  blockNumber: Quantity,
  blockHash: Hex
})
export type ForkOutput = typeof ForkOutput.Type

export const GetBalanceInput = Schema.Struct({
  address: Address,
  blockTag: Schema.optionalKey(BlockTag)
})
export type GetBalanceInput = typeof GetBalanceInput.Type

export const GetBalanceOutput = Schema.Struct({
  address: Address,
  wei: Wei,
  ether: Schema.String.annotate({ description: "The same amount rendered in ether, for display only" })
})
export type GetBalanceOutput = typeof GetBalanceOutput.Type

export const ReadContractInput = Schema.Struct({
  address: Address,
  abi: Schema.Array(Schema.String).annotate({
    description: "Human-readable ABI signatures, for example [\"function balanceOf(address) view returns (uint256)\"]"
  }),
  functionName: Schema.String.annotate({ description: "Name of the function to read" }),
  args: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Arguments as strings: addresses as hex, integers as decimal strings"
    })
  ),
  blockTag: Schema.optionalKey(BlockTag)
})
export type ReadContractInput = typeof ReadContractInput.Type

export const ReadContractOutput = Schema.Struct({
  value: Schema.String.annotate({ description: "Decoded return value rendered as a string" }),
  raw: Hex
})
export type ReadContractOutput = typeof ReadContractOutput.Type

export const CallInput = Schema.Struct({
  to: Address,
  data: Hex,
  from: Schema.optionalKey(Address),
  value: Schema.optionalKey(Wei),
  blockTag: Schema.optionalKey(BlockTag)
})
export type CallInput = typeof CallInput.Type

export const CallOutput = Schema.Struct({
  data: Hex,
  gasUsed: Quantity,
  reverted: Schema.Boolean,
  revertReason: Schema.optionalKey(Schema.String)
})
export type CallOutput = typeof CallOutput.Type

export const SetAccountInput = Schema.Struct({
  address: Address,
  balance: Schema.optionalKey(Wei),
  nonce: Schema.optionalKey(Schema.Number),
  code: Schema.optionalKey(Hex)
})
export type SetAccountInput = typeof SetAccountInput.Type

export const SetAccountOutput = Schema.Struct({
  address: Address,
  balance: Wei,
  nonce: Schema.Number
})
export type SetAccountOutput = typeof SetAccountOutput.Type

export const MineInput = Schema.Struct({
  blocks: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })).annotate({
      description: "How many blocks to mine, from 1 to 256; default 1"
    })
  ),
  intervalSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86400 })).annotate({
      description: "Seconds between mined block timestamps, from 0 to 86400; default 12"
    })
  )
})
export type MineInput = typeof MineInput.Type

export const MineOutput = Schema.Struct({
  blockNumbers: Schema.Array(Quantity)
})
export type MineOutput = typeof MineOutput.Type

export const SimulateInput = Schema.Struct({
  calls: Schema.Array(Schema.Struct({
    to: Address,
    data: Hex,
    from: Schema.optionalKey(Address),
    value: Schema.optionalKey(Wei)
  })).check(Schema.isMaxLength(256)).annotate({
    description: "At most 256 calls applied in order against the same pending state"
  })
})
export type SimulateInput = typeof SimulateInput.Type

export const SimulateOutput = Schema.Struct({
  results: Schema.Array(Schema.Struct({
    data: Hex,
    gasUsed: Quantity,
    reverted: Schema.Boolean
  })),
  balanceChanges: Schema.Array(Schema.Struct({
    address: Address,
    before: Wei,
    after: Wei
  }))
})
export type SimulateOutput = typeof SimulateOutput.Type

export const GetBlockInput = Schema.Struct({
  blockTag: Schema.optionalKey(BlockTag)
})
export type GetBlockInput = typeof GetBlockInput.Type

export const GetBlockOutput = Schema.Struct({
  number: Quantity,
  hash: Hex,
  parentHash: Hex,
  timestamp: Quantity,
  gasUsed: Quantity,
  gasLimit: Quantity,
  baseFeePerGas: Wei,
  transactionCount: Schema.Number
})
export type GetBlockOutput = typeof GetBlockOutput.Type

// ---------------------------------------------------------------------------
// The Tevm service
// ---------------------------------------------------------------------------

/**
 * The chain port. One method per binding, named after the viem/tevm call it
 * wraps, so the milestone-3 implementation is a thin adapter over
 * `createMemoryClient`.
 */
export interface Service {
  /** Host-selected endpoint, used to scope the source's network capabilities. The mock has none. */
  readonly rpcUrl?: string
  readonly fork: (input: ForkInput) => Effect.Effect<ForkOutput, TevmError>
  readonly getBalance: (input: GetBalanceInput) => Effect.Effect<GetBalanceOutput, TevmError>
  readonly readContract: (input: ReadContractInput) => Effect.Effect<ReadContractOutput, TevmError>
  readonly call: (input: CallInput) => Effect.Effect<CallOutput, TevmError>
  readonly setAccount: (input: SetAccountInput) => Effect.Effect<SetAccountOutput, TevmError>
  readonly mine: (input: MineInput) => Effect.Effect<MineOutput, TevmError>
  readonly simulate: (input: SimulateInput) => Effect.Effect<SimulateOutput, TevmError>
  readonly getBlock: (input: GetBlockInput) => Effect.Effect<GetBlockOutput, TevmError>
}

/** Service tag for the in-memory EVM fork. */
export class Tevm extends Context.Service<Tevm, Service>()("aomi/tools/Tevm") {}

/** Options the real client needs; the mock ignores them. */
export interface TevmOptions {
  /** Overrides TEVM_FORK_RPC_URL; a model cannot select or replace this endpoint. */
  readonly rpcUrl?: string
  readonly blockTag?: string
}

// ---------------------------------------------------------------------------
// The mock implementation
// ---------------------------------------------------------------------------

/** 1234.5 ETH, the balance every mock account holds. */
const MOCK_WEI = "1234500000000000000000"
const MOCK_ETHER = "1234.5"
const MOCK_BLOCK = "20000000"
const MOCK_BLOCK_HASH = "0x9f2f0a3f0c0d2b8f4c1a6e7d5b3a9c8e7f6d5c4b3a2918070605040302010009"
const MOCK_PARENT_HASH = "0x8e1e0b2e0b0c1a7e3b0a5d6c4a2b8f7d6e5c4b3a2918070605040302010009f2"
const MOCK_TIMESTAMP = "1750000000"

const succeed = <A>(value: A): Effect.Effect<A, TevmError> => Effect.succeed(value)

/**
 * A deterministic fake chain.
 *
 * Every reply is a constant, so a fixture recorded against it stays valid and
 * a pane rendered from it looks the same on every run. Nothing here talks to a
 * network. `overrides` lets one test replace a single method.
 */
export const makeMock = (overrides: Partial<Service> = {}): Service =>
  Tevm.of({
    fork: () => succeed({ chainId: 1, blockNumber: MOCK_BLOCK, blockHash: MOCK_BLOCK_HASH }),
    getBalance: (input) => succeed({ address: input.address, wei: MOCK_WEI, ether: MOCK_ETHER }),
    readContract: () =>
      succeed({ value: MOCK_WEI, raw: `0x${(1234500000000000000000n).toString(16).padStart(64, "0")}` }),
    call: () => succeed({ data: "0x", gasUsed: "21000", reverted: false }),
    setAccount: (input) =>
      succeed({
        address: input.address,
        balance: input.balance ?? MOCK_WEI,
        nonce: input.nonce ?? 0
      }),
    mine: (input) =>
      Effect.try({
        try: () => {
          const blocks = input.blocks ?? 1
          const first = BigInt(MOCK_BLOCK) + 1n
          return { blockNumbers: Array.from({ length: blocks }, (_, index) => (first + BigInt(index)).toString()) }
        },
        catch: (cause) => new TevmError({ message: "mine failed.", cause })
      }),
    simulate: (input) =>
      Effect.try({
        try: () => ({
          results: input.calls.map(() => ({ data: "0x", gasUsed: "21000", reverted: false })),
          balanceChanges: input.calls.flatMap((entry) =>
            entry.from === undefined ? [] : [{ address: entry.from, before: MOCK_WEI, after: MOCK_WEI }]
          )
        }),
        catch: (cause) => new TevmError({ message: "simulate failed.", cause })
      }),
    getBlock: () =>
      succeed({
        number: MOCK_BLOCK,
        hash: MOCK_BLOCK_HASH,
        parentHash: MOCK_PARENT_HASH,
        timestamp: MOCK_TIMESTAMP,
        gasUsed: "12500000",
        gasLimit: "30000000",
        baseFeePerGas: "4200000000",
        transactionCount: 142
      }),
    ...overrides
  })

/** Provides the deterministic fake chain. */
export const layerMock = (overrides: Partial<Service> = {}): Layer.Layer<Tevm> =>
  Layer.succeed(Tevm)(makeMock(overrides))

// ---------------------------------------------------------------------------
// The real implementation
// ---------------------------------------------------------------------------

/** The named block tags a `BlockTag` field accepts besides a decimal number. */
const NAMED_TAGS = ["latest", "pending", "safe", "finalized", "earliest"] as const

type NamedTag = typeof NAMED_TAGS[number]

const isNamedTag = (value: string): value is NamedTag => (NAMED_TAGS as ReadonlyArray<string>).includes(value)

/**
 * A `BlockTag` field as tevm wants it.
 *
 * `BlockParam` is a named tag or a bigint, so a decimal string becomes a
 * bigint and anything else has to be one of the five names. A typo reaches the
 * model as a rejection that lists them rather than as a silent read of the
 * wrong block.
 */
const blockParam = (tag: string | undefined): NamedTag | bigint | undefined => {
  if (tag === undefined) return undefined
  if (isNamedTag(tag)) return tag
  if (/^\d+$/.test(tag)) return BigInt(tag)
  throw new TevmError({
    message: `blockTag ${JSON.stringify(tag)} is neither a decimal block number nor one of ${NAMED_TAGS.join(", ")}`
  })
}

/** Every value that crosses the boundary is a string, so bigints render here. */
const render = (value: unknown): string => {
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "string") return value
  if (Array.isArray(value)) return JSON.stringify(value.map(render))
  if (value !== null && typeof value === "object") {
    return JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, render(entry)])))
  }
  return String(value)
}

/**
 * String arguments coerced to what the ABI declares.
 *
 * Arguments arrive as strings because the binding schema is a
 * `Schema.Array(Schema.String)`: a uint256 does not survive a JSON number.
 * Each one is converted by the input type the parsed ABI gives, so
 * `balanceOf("0x...")` and `transfer("0x...", "1000")` both work.
 */
const coerceArgs = (abi: Abi, functionName: string, args: ReadonlyArray<string>): Array<unknown> => {
  const entry = abi.find((item): item is AbiFunction => item.type === "function" && item.name === functionName)
  if (entry === undefined) {
    const names = abi.filter((item) => item.type === "function").map((item) => (item as AbiFunction).name)
    throw new TevmError({
      message: `the abi has no function ${JSON.stringify(functionName)}; it declares ${names.join(", ") || "none"}`
    })
  }
  if (entry.inputs.length !== args.length) {
    throw new TevmError({ message: `${functionName} takes ${entry.inputs.length} argument(s), ${args.length} given` })
  }
  return args.map((arg, index) => {
    const type = entry.inputs[index]?.type ?? ""
    if (/^u?int\d*$/.test(type)) return BigInt(arg)
    if (type === "bool") return arg === "true"
    // Tuples and arrays arrive as JSON so they can nest; everything else
    // (address, bytes, string) is already the string viem wants.
    if (type.endsWith("]") || type === "tuple") return JSON.parse(arg)
    return arg
  })
}

/**
 * The revert reason as text, when the returned data carries one.
 *
 * A `require(false, "…")` revert returns an `Error(string)` payload. Decoding
 * it turns "revert" into the sentence the contract author wrote, which is the
 * difference between a model that retries blindly and one that fixes the call.
 */
const revertReason = (data: string, fallback: string): string => {
  if (data === "0x" || data.length < 10) return fallback
  try {
    const decoded = decodeErrorResult({ abi: parseAbi(["error Error(string)"]), data: data as `0x${string}` })
    const [reason] = decoded.args as ReadonlyArray<unknown>
    return typeof reason === "string" ? reason : fallback
  } catch {
    return fallback
  }
}

/** What a failed `tevmCall` or `tevmContract` put in `errors`. */
interface CallFailure {
  readonly _tag?: string
  readonly name?: string
  readonly shortMessage?: string
  readonly message?: string
}

/**
 * Whether a call failure is the contract rejecting the call.
 *
 * `tevmCall` reports one `errors` array for two unrelated things: the EVM
 * reverted, and the fork could not reach its endpoint. Only the first is a
 * `reverted: true` answer. Reporting a timed-out `eth_getStorageAt` as a revert
 * would tell a cell the contract said no, and it would rewrite a call that was
 * correct.
 */
const isRevert = (failure: CallFailure): boolean =>
  (failure._tag ?? failure.name ?? "").toLowerCase().includes("revert")

/** The failure as an `Error`, for the paths that cannot answer with one. */
const asError = (what: string, failure: CallFailure): Error =>
  new Error(`${what}: ${failure.message ?? failure.shortMessage ?? failure._tag ?? "unknown error"}`)

/**
 * The common the fork runs under.
 *
 * The chain id is read from the endpoint so the fork agrees with it; without
 * that, `blockFromRpc` rejects every forked block with a chain-id mismatch. The
 * hardfork schedule is mainnet's, so a fork of an L2 executes under mainnet
 * rules. Blob transactions are removed before Tevm rebuilds a forked block;
 * see {@link forkTransport}.
 */
const commonFor = (chainId: number) => createCommon({ ...mainnet, id: chainId, loggingLevel: "warn" })

/** A fork transport, plus the transaction count of each block it passed through. */
interface Fork {
  readonly request: (args: { method: string; params?: unknown }) => Promise<any>
  readonly counts: Map<string, number>
}

/**
 * The fork transport, with EIP-4844 blob transactions filtered out of every
 * block it returns.
 *
 * The `@tevm/block` version that `tevm` depends on rebuilds a
 * forked block by handing each transaction to ethereumjs `createTx`. A type-3
 * transaction needs `common.customCrypto.kzg`, and the common the factory is
 * given does not carry the one passed to `createMemoryClient`, so any fork of a
 * block holding a blob transaction fails with "A common object with
 * customCrypto.kzg initialized required to instantiate a 4844 blob tx". Most
 * mainnet blocks hold one, so this makes a `latest` fork fail most of the time.
 * The monorepo already fixes it in `packages/block/src/from-rpc.ts` by
 * installing the shim on the header's common; the fix is not in any published
 * build.
 *
 * Dropping the blob transactions here is what tevm already does one layer down
 * for transaction types it cannot rebuild (`@tevm/blockchain`, `asEthjsBlock`).
 * The forked block's transactions are never executed: the fork reads account
 * and storage state, and everything a cell runs is mined into a new block. The
 * one field that would go wrong is `tevm/getBlock`'s `transactionCount`, so the
 * count seen before filtering is kept and reported instead.
 */
const forkTransport = (rpcUrl: string): Fork => {
  const inner = http(rpcUrl)({})
  const counts = new Map<string, number>()
  return {
    counts,
    request: async (args) => {
      const result = await inner.request(args as never)
      if (args.method !== "eth_getBlockByNumber" && args.method !== "eth_getBlockByHash") return result
      const block = result as { hash?: string; transactions?: Array<unknown> } | null
      if (block?.transactions === undefined) return result
      if (typeof block.hash === "string") counts.set(block.hash, block.transactions.length)
      const kept = block.transactions.filter((tx) =>
        tx === null || typeof tx !== "object" || (tx as { type?: string }).type !== "0x3"
      )
      return kept.length === block.transactions.length ? result : { ...block, transactions: kept }
    }
  }
}

/** Builds a client forked at `rpcUrl`, ready to answer. */
const connect = async (
  rpcUrl: string,
  blockTag: string | undefined
): Promise<{ client: MemoryClient; fork: Fork }> => {
  const fork = forkTransport(rpcUrl)
  const chainId = Number(BigInt(await fork.request({ method: "eth_chainId" }) as string))
  const client = createMemoryClient({
    common: commonFor(chainId),
    fork: { transport: fork as never, blockTag: blockParam(blockTag) ?? "latest" },
    miningConfig: { type: "manual" }
  })
  await client.tevmReady()
  return { client, fork }
}

/**
 * The real client.
 *
 * One fork is held per layer. `tevm/fork` replaces it; every other binding
 * reads the one already open, or opens the configured endpoint on first use.
 * `options.rpcUrl` takes precedence over `TEVM_FORK_RPC_URL`. The model can
 * choose a block, but cannot replace the host's endpoint. A failed initial
 * connection is retried on the next call.
 *
 * Mining is manual. A cell that wants a transaction on-chain calls
 * `tevm/mine`, so nothing a simulation touches is committed by surprise.
 */
export const layerTevm = (options: TevmOptions): Layer.Layer<Tevm> =>
  Layer.sync(Tevm)(() => {
    const rpcUrl = options.rpcUrl ?? (typeof process === "undefined" ? undefined : process.env["TEVM_FORK_RPC_URL"])
    let open: Promise<{ client: MemoryClient; fork: Fork }> | undefined

    const endpoint = (): string => {
      if (rpcUrl === undefined || rpcUrl === "") {
        throw new TevmError({
          message: "configure TevmOptions.rpcUrl or TEVM_FORK_RPC_URL, then call tevm/fork"
        })
      }
      return rpcUrl
    }

    /** Only host-authored TevmError messages are public; SDK diagnostics stay in cause. */
    const attempt = <A>(what: string, run: () => Promise<A>): Effect.Effect<A, TevmError> =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          cause instanceof TevmError ? cause : new TevmError({
            message: `${what} failed. Retry the call or use tevm/fork to reopen the configured fork.`,
            cause
          })
      })

    /** The open fork, opening the configured one if this is the first call. */
    const opened = (): Promise<{ client: MemoryClient; fork: Fork }> => {
      if (open !== undefined) return open
      const pending = connect(endpoint(), options.blockTag).catch((cause) => {
        // A concurrent explicit fork may already have replaced this attempt.
        if (open === pending) open = undefined
        throw cause
      })
      open = pending
      return pending
    }

    const client = async (): Promise<MemoryClient> => (await opened()).client

    /** Balance of `address` at `tag`, as a decimal string. */
    const balanceAt = async (chain: MemoryClient, address: string, tag: NamedTag): Promise<string> =>
      (await chain.getBalance({ address: address as `0x${string}`, blockTag: tag })).toString()

    return Tevm.of({
      ...(rpcUrl === undefined || rpcUrl === "" ? {} : { rpcUrl }),
      fork: (input) =>
        attempt("fork", async () => {
          const connected = await connect(endpoint(), input.blockTag ?? options.blockTag)
          open = Promise.resolve(connected)
          const chain = connected.client
          const block = await chain.getBlock({ blockTag: "latest" })
          return {
            chainId: await chain.getChainId(),
            blockNumber: block.number.toString(),
            blockHash: block.hash
          }
        }),

      getBalance: (input) =>
        attempt("getBalance", async () => {
          // The block tag is validated before the fork is opened, so a typo
          // costs a rejection rather than a connection.
          const at = blockAt(input.blockTag)
          const chain = await client()
          const wei = await chain.getBalance({ address: input.address as `0x${string}`, ...at })
          return { address: input.address, wei: wei.toString(), ether: formatEther(wei) }
        }),

      readContract: (input) =>
        attempt("readContract", async () => {
          const at = blockParam(input.blockTag)
          const abi = parseAbi([...input.abi]) as Abi
          const args = coerceArgs(abi, input.functionName, input.args ?? [])
          const chain = await client()
          const result = await chain.tevmContract({
            to: input.address as `0x${string}`,
            abi,
            functionName: input.functionName,
            args,
            ...(at === undefined ? {} : { blockTag: at }),
            throwOnFail: false
          })
          const failure = result.errors?.[0] as CallFailure | undefined
          if (failure !== undefined) {
            // A read has nowhere to report a revert, so both outcomes fail;
            // the message still says which one happened.
            if (!isRevert(failure)) throw asError(input.functionName, failure)
            throw new TevmError({ message: `${input.functionName} reverted.`, cause: failure })
          }
          return { value: render(result.data), raw: result.rawData }
        }),

      call: (input) =>
        attempt("call", async () => {
          const at = blockParam(input.blockTag)
          const chain = await client()
          const result = await chain.tevmCall({
            to: input.to as `0x${string}`,
            data: input.data as `0x${string}`,
            ...(input.from === undefined ? {} : { from: input.from as `0x${string}` }),
            ...(input.value === undefined ? {} : { value: BigInt(input.value) }),
            ...(at === undefined ? {} : { blockTag: at }),
            throwOnFail: false
          })
          const failure = result.errors?.[0] as CallFailure | undefined
          const gasUsed = (result.totalGasSpent ?? result.executionGasUsed).toString()
          if (failure === undefined) return { data: result.rawData, gasUsed, reverted: false }
          if (!isRevert(failure)) throw asError("call", failure)
          return {
            data: result.rawData,
            gasUsed,
            reverted: true,
            revertReason: revertReason(result.rawData, failure.shortMessage ?? failure.message ?? "revert")
          }
        }),

      setAccount: (input) =>
        attempt("setAccount", async () => {
          const chain = await client()
          const address = input.address as `0x${string}`
          await chain.tevmSetAccount({
            address,
            ...(input.balance === undefined ? {} : { balance: BigInt(input.balance) }),
            ...(input.nonce === undefined ? {} : { nonce: BigInt(input.nonce) }),
            ...(input.code === undefined ? {} : { deployedBytecode: input.code as `0x${string}` }),
            throwOnFail: true
          })
          // tevmSetAccount answers with an empty object, so the values that
          // landed are read back rather than echoed from the input.
          const account = await chain.tevmGetAccount({ address, throwOnFail: true })
          return { address: input.address, balance: account.balance.toString(), nonce: Number(account.nonce) }
        }),

      mine: (input) =>
        attempt("mine", async () => {
          const chain = await client()
          const result = await chain.tevmMine({
            blockCount: input.blocks ?? 1,
            interval: input.intervalSeconds ?? 12,
            throwOnFail: true
          })
          const hashes = result.blockHashes ?? []
          const blocks = await Promise.all(hashes.map((hash) => chain.getBlock({ blockHash: hash })))
          return { blockNumbers: blocks.map((block) => block.number.toString()) }
        }),

      simulate: (input) =>
        attempt("simulate", async () => {
          const chain = await client()
          // Each call goes to the mempool so the next one sees its effects,
          // which is what "the same pending state" means. The snapshot taken
          // first is restored at the end, and restoring drops the mempool too,
          // so a later tevm/mine cannot commit anything simulated here.
          const snapshot = await chain.snapshot()
          try {
            const senders = [...new Set(input.calls.flatMap((call) => call.from === undefined ? [] : [call.from]))]
            const before = await Promise.all(senders.map((address) => balanceAt(chain, address, "latest")))
            const results: Array<{ data: string; gasUsed: string; reverted: boolean }> = []
            for (const call of input.calls) {
              const result = await chain.tevmCall({
                to: call.to as `0x${string}`,
                data: call.data as `0x${string}`,
                ...(call.from === undefined ? {} : { from: call.from as `0x${string}` }),
                ...(call.value === undefined ? {} : { value: BigInt(call.value) }),
                addToMempool: true,
                throwOnFail: false
              })
              const failure = result.errors?.[0] as CallFailure | undefined
              if (failure !== undefined && !isRevert(failure)) throw asError("simulate", failure)
              results.push({
                data: result.rawData,
                gasUsed: (result.totalGasSpent ?? result.executionGasUsed).toString(),
                reverted: failure !== undefined
              })
            }
            const after = await Promise.all(senders.map((address) => balanceAt(chain, address, "pending")))
            return {
              results,
              balanceChanges: senders.map((address, index) => ({
                address,
                before: before[index] as string,
                after: after[index] as string
              }))
            }
          } finally {
            await chain.revert({ id: snapshot })
          }
        }),

      getBlock: (input) =>
        attempt("getBlock", async () => {
          const at = blockAt(input.blockTag)
          const { client: chain, fork } = await opened()
          const block = await chain.getBlock(at)
          return {
            number: (block.number ?? 0n).toString(),
            hash: block.hash ?? "0x",
            parentHash: block.parentHash,
            timestamp: block.timestamp.toString(),
            gasUsed: block.gasUsed.toString(),
            gasLimit: block.gasLimit.toString(),
            // A pre-London chain reports no base fee; zero is the honest
            // rendering of "this block was not priced by EIP-1559".
            baseFeePerGas: (block.baseFeePerGas ?? 0n).toString(),
            // A forked block reaches tevm with its blob transactions removed,
            // so the count the endpoint reported is the one to report back.
            transactionCount: fork.counts.get(block.hash ?? "") ?? block.transactions.length
          }
        })
    })
  })

/**
 * A `BlockTag` field as viem's public actions want it.
 *
 * viem splits what tevm keeps in one field: a number goes in `blockNumber` and
 * a name in `blockTag`.
 */
const blockAt = (tag: string | undefined): { blockNumber: bigint } | { blockTag: NamedTag } => {
  const param = blockParam(tag)
  if (param === undefined) return { blockTag: "latest" }
  return typeof param === "bigint" ? { blockNumber: param } : { blockTag: param }
}

// ---------------------------------------------------------------------------
// Flow declarations
// ---------------------------------------------------------------------------

const forkFlow = (capabilities: ReadonlyArray<string>) =>
  Flow.make({
    name: "tevm/fork",
    description:
      "Fork the host-configured chain into an in-memory EVM at a block. Call this once before any other tevm flow; every later call reads the forked state.",
    input: ForkInput,
    output: ForkOutput,
    capabilities,
    effects: undefined
  })

const getBalanceFlow = (capabilities: ReadonlyArray<string>) =>
  Flow.make({
    name: "tevm/getBalance",
    description:
      "Native token balance of an address on the fork. Returns wei as a decimal string plus an ether rendering.",
    input: GetBalanceInput,
    output: GetBalanceOutput,
    capabilities,
    effects: undefined
  })

const readContractFlow = (capabilities: ReadonlyArray<string>) =>
  Flow.make({
    name: "tevm/readContract",
    description:
      "Call a view or pure contract function on the fork and decode the result. Pass human-readable ABI signatures, not a JSON ABI.",
    input: ReadContractInput,
    output: ReadContractOutput,
    capabilities,
    effects: undefined
  })

const callFlow = (capabilities: ReadonlyArray<string>) =>
  Flow.make({
    name: "tevm/call",
    description:
      "Execute raw calldata against the fork without mining it. Reports gas used and, when the call reverts, the revert reason.",
    input: CallInput,
    output: CallOutput,
    capabilities,
    effects: undefined
  })

const setAccountFlow = (capabilities: ReadonlyArray<string>) =>
  Flow.make({
    name: "tevm/setAccount",
    description:
      "Overwrite an account's balance, nonce, or code on the fork. Use it to fund an address before a simulation.",
    input: SetAccountInput,
    output: SetAccountOutput,
    capabilities,
    effects: undefined
  })

const mineFlow = (capabilities: ReadonlyArray<string>) =>
  Flow.make({
    name: "tevm/mine",
    description: "Mine pending transactions into new blocks on the fork and return the block numbers produced.",
    input: MineInput,
    output: MineOutput,
    capabilities,
    effects: undefined
  })

const simulateFlow = (capabilities: ReadonlyArray<string>) =>
  Flow.make({
    name: "tevm/simulate",
    description:
      "Run a sequence of calls against the same pending state and report each result plus the balance changes they cause. Nothing is committed.",
    input: SimulateInput,
    output: SimulateOutput,
    capabilities,
    effects: undefined
  })

const getBlockFlow = (capabilities: ReadonlyArray<string>) =>
  Flow.make({
    name: "tevm/getBlock",
    description: "Header fields of one block on the fork: number, hashes, timestamp, gas, and base fee.",
    input: GetBlockInput,
    output: GetBlockOutput,
    capabilities,
    effects: undefined
  })

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * The chain flows, bound to the {@link Tevm} the host built.
 *
 * This mirrors `StandardFlows.filesystem`: the handler's requirement is the
 * host's to supply, so the source takes a `Context` slice and closes every
 * binding over it with `FlowBinding.provide`.
 */
export const tevmSource = (services: Context.Context<Tevm>): FlowBinding.Source => {
  const rpcUrl = Context.get(services, Tevm).rpcUrl
  // Every real handler can lazily open the fork, including mine/setAccount.
  // Derive the envelope from the service's actual endpoint, never model input.
  const capabilities = rpcUrl === undefined ? [] : [`net:post:${new URL(rpcUrl).origin}/*`]
  return FlowBinding.source("tevm", [
    FlowBinding.provide(
      FlowBinding.make({
        flow: forkFlow(capabilities),
        publicError: (error: TevmError) => error.message,
        handler: (input) => Effect.flatMap(Tevm, (chain) => chain.fork(input))
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: getBalanceFlow(capabilities),
        publicError: (error: TevmError) => error.message,
        handler: (input) => Effect.flatMap(Tevm, (chain) => chain.getBalance(input))
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: readContractFlow(capabilities),
        publicError: (error: TevmError) => error.message,
        handler: (input) => Effect.flatMap(Tevm, (chain) => chain.readContract(input))
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: callFlow(capabilities),
        publicError: (error: TevmError) => error.message,
        handler: (input) => Effect.flatMap(Tevm, (chain) => chain.call(input))
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: setAccountFlow(capabilities),
        publicError: (error: TevmError) => error.message,
        handler: (input) => Effect.flatMap(Tevm, (chain) => chain.setAccount(input))
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: mineFlow(capabilities),
        publicError: (error: TevmError) => error.message,
        handler: (input) => Effect.flatMap(Tevm, (chain) => chain.mine(input))
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: simulateFlow(capabilities),
        publicError: (error: TevmError) => error.message,
        handler: (input) => Effect.flatMap(Tevm, (chain) => chain.simulate(input))
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: getBlockFlow(capabilities),
        publicError: (error: TevmError) => error.message,
        handler: (input) => Effect.flatMap(Tevm, (chain) => chain.getBlock(input))
      }),
      services
    )
  ])
}

/**
 * The source TOOLS.ts composes: the chain flows over the deterministic mock,
 * for fixtures and tests. A Worker run replaces it with the real fork
 * (`worker/host.ts`).
 */
export const tevm: FlowBinding.Source = tevmSource(Context.make(Tevm, makeMock()))
