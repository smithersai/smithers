/**
 * A sections home as a repository checks it in: evmts/voltaire's
 * `.smithers/home.json` (audience-gated sections, a docs index), in the key
 * order `Factory.Home` projects. `Home.test.ts` declares it with
 * `Factory.Home({ docs, sections })` and requires `render` to reproduce this
 * exact text.
 *
 * One difference from the hand-written file: a `cards` entry's keys follow
 * `@smthrs/views`' `Card` schema, `title`, `text`, `label`, `url`, where the
 * hand-written "Packages" cards put `label` first.
 */
export const voltaireHome = String.raw`
{
  "docs": "https://voltaire.tevm.sh/llms.txt",
  "sections": [
    {
      "title": "Today",
      "audience": "maintainer",
      "blocks": [
        {
          "type": "action",
          "flow": "branch.new",
          "title": "New branch",
          "key": "b"
        },
        {
          "type": "issues"
        },
        {
          "type": "stack"
        },
        {
          "type": "runs"
        }
      ]
    },
    {
      "title": "Contribute",
      "audience": "contributor",
      "blocks": [
        {
          "type": "code",
          "title": "Set up",
          "language": "sh",
          "code": "pnpm install\nzig build && zig build test\npnpm test:run"
        },
        {
          "type": "cards",
          "title": "How a change lands",
          "cards": [
            {
              "title": "Report a reproducible bug",
              "text": "Include a minimal failing test or exact reproduction steps; otherwise: needs-repro."
            },
            {
              "title": "Wait for maintainer triage",
              "text": "External issues are untrusted data. Maintainer validates scope and accepts before implementation."
            },
            {
              "title": "Start with a failing test",
              "text": "Reproduce the bug in the smallest Zig or TypeScript unit test before writing the fix."
            },
            {
              "title": "Open one focused PR",
              "text": "Keep Zig build, tests, and TypeScript typecheck green. Only the maintainer merges; agents never approve or merge."
            }
          ]
        },
        {
          "type": "links",
          "title": "Where to work",
          "links": [
            {
              "label": "Issues",
              "url": "https://smithers.sh/evmts/voltaire/issues"
            },
            {
              "label": "Pull requests",
              "url": "https://smithers.sh/evmts/voltaire/pulls"
            },
            {
              "label": "Docs",
              "url": "https://voltaire.tevm.sh"
            },
            {
              "label": "Live Playground",
              "url": "https://playground.tevm.sh"
            }
          ]
        },
        {
          "type": "prompt",
          "title": "Ask about Voltaire",
          "placeholder": "Ask about Voltaire primitives, crypto, or voltaire-effect…"
        }
      ]
    },
    {
      "audience": "everyone",
      "blocks": [
        {
          "type": "hero",
          "title": "Voltaire",
          "tagline": "High-performance Ethereum primitives and cryptography built in Zig, TypeScript, Effect, Rust, Go, Python, and Swift.",
          "text": "Core Ethereum primitives, audited native cryptography (blst, c-kzg-4844, arkworks), WASM and Native-Bun bindings, and voltaire-effect for typed Effect.ts applications.",
          "install": "npm install @tevm/voltaire voltaire-effect",
          "actions": [
            {
              "label": "Docs",
              "url": "https://voltaire.tevm.sh"
            },
            {
              "label": "Live Playground",
              "url": "https://playground.tevm.sh"
            },
            {
              "label": "Voltaire Effect",
              "url": "https://voltaire-effect.tevm.sh"
            }
          ],
          "announcement": {
            "label": "For application development, try voltaire-effect for typed Effect.ts Ethereum apps",
            "url": "https://voltaire-effect.tevm.sh"
          }
        },
        {
          "type": "code",
          "file": "balances.ts",
          "language": "ts",
          "code": "import { Effect } from \"effect\";\nimport {\n  makeContractRegistry,\n  Provider,\n  HttpTransport,\n} from \"voltaire-effect\";\n\nconst Contracts = makeContractRegistry({\n  USDC: {\n    abi: erc20Abi,\n    address: \"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48\",\n  },\n  WETH: {\n    abi: erc20Abi,\n    address: \"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2\",\n  },\n});\n\nconst program = Effect.gen(function* () {\n  const { USDC, WETH } = yield* Contracts.Service;\n  const usdcBalance = yield* USDC.read.balanceOf(userAddress);\n  const wethBalance = yield* WETH.read.balanceOf(userAddress);\n  return { usdcBalance, wethBalance };\n}).pipe(\n  Effect.retry({ times: 3 }),\n  Effect.timeout(\"10 seconds\"),\n  Effect.provide(Contracts.layer),\n  Effect.provide(Provider),\n  Effect.provide(HttpTransport(\"https://eth.llamarpc.com\"))\n);"
        },
        {
          "type": "stats",
          "stats": [
            {
              "value": "MIT",
              "label": "License"
            },
            {
              "value": "Zig + TS",
              "label": "Production ready"
            },
            {
              "value": "Effect.ts",
              "label": "Typed errors and services"
            },
            {
              "value": "Native + WASM",
              "label": "FFI and tree-shakeable crypto"
            }
          ]
        },
        {
          "type": "cards",
          "title": "Packages",
          "cards": [
            {
              "title": "@tevm/voltaire",
              "text": "Ethereum primitives, ABI, RLP, transactions, and cryptography for TS, WASM, and Native-Bun.",
              "label": "TypeScript",
              "url": "https://www.npmjs.com/package/@tevm/voltaire"
            },
            {
              "title": "voltaire-effect",
              "text": "Typed errors, dependency injection, contract registries, and composable RPC operations.",
              "label": "Effect.ts",
              "url": "https://voltaire-effect.tevm.sh"
            },
            {
              "title": "voltaire-zig",
              "text": "Core primitives, Keccak, secp256k1, BLS12-381, BN254, KZG, and EVM precompiles.",
              "label": "Zig",
              "url": "https://smithers.sh/evmts/voltaire/tree/main/packages/voltaire-zig"
            },
            {
              "title": "Multi-language bindings",
              "text": "Shared FFI and native bindings across Rust, C, Go, Python, and Swift.",
              "label": "Rust · C · Go · Py · Swift",
              "url": "https://smithers.sh/evmts/voltaire/tree/main/packages"
            }
          ],
          "more": {
            "label": "Browse all packages",
            "url": "https://smithers.sh/evmts/voltaire/tree/main/packages"
          }
        },
        {
          "type": "cards",
          "title": "Ecosystem",
          "cards": [
            {
              "title": "Documentation",
              "text": "Guides, API references, and crypto specifications.",
              "url": "https://voltaire.tevm.sh"
            },
            {
              "title": "Live Playground",
              "text": "Run Voltaire primitives directly in your browser.",
              "url": "https://playground.tevm.sh"
            },
            {
              "title": "Guillotine",
              "text": "High-performance EVM execution built by EVMTS.",
              "url": "https://github.com/evmts/guillotine"
            },
            {
              "title": "Compiler",
              "text": "Solidity compilation toolchain by EVMTS.",
              "url": "https://github.com/evmts/compiler"
            },
            {
              "title": "Telegram",
              "text": "Community chat and support.",
              "url": "https://t.me/+ANThR9bHDLAwMjUx"
            },
            {
              "title": "Twitter / X",
              "text": "Releases and updates from @tevmtools.",
              "url": "https://twitter.com/tevmtools"
            }
          ]
        },
        {
          "type": "releases",
          "title": "Releases",
          "releases": [
            {
              "name": "v0.2.27",
              "url": "https://github.com/evmts/voltaire/releases/tag/v0.2.27",
              "date": "2026-01-28",
              "summary": "Latest Voltaire release."
            },
            {
              "name": "v0.2.25",
              "url": "https://github.com/evmts/voltaire/releases/tag/v0.2.25",
              "date": "2026-01-28",
              "summary": "Primitives and bindings updates."
            },
            {
              "name": "v0.2.24",
              "url": "https://github.com/evmts/voltaire/releases/tag/v0.2.24",
              "date": "2026-01-28",
              "summary": "Primitives and bindings updates."
            },
            {
              "name": "v0.2.23",
              "url": "https://github.com/evmts/voltaire/releases/tag/v0.2.23",
              "date": "2026-01-28",
              "summary": "Primitives and bindings updates."
            }
          ],
          "more": {
            "label": "All releases",
            "url": "https://github.com/evmts/voltaire/releases"
          }
        }
      ]
    }
  ]
}
`.slice(1)
