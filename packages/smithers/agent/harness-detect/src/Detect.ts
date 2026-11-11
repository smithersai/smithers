/**
 * The harness table for one host.
 *
 * @since 0.1.0
 */

import type { Harness } from "@smthrs/rpc/LocalApp"
import { type Detector, DETECTORS, type Signal } from "./Detectors.ts"
import { findBinary } from "./HarnessHost.ts"
import type { HarnessHost } from "./HarnessHost.ts"
import { isAbsoluteHostPath } from "./internal/Read.ts"
import { parseVersionLine } from "./Probe.ts"

const readSignal = (detector: Detector, host: HarnessHost): Signal => {
  try {
    return detector.signal(host)
  } catch {
    return { status: "binary-only", account: null }
  }
}

/**
 * Every harness id, in contract order, whether installed or not.
 *
 * A row with no binary is `unavailable` and is never probed, even when its
 * credentials are on disk. Version probes for the installed binaries run in
 * parallel, so a caller waits for the slowest CLI once rather than for the
 * sum of them.
 * Returned versions are parsed, stripped of controls and bounded even when
 * the host supplies raw probe output. A failed version probe returns a null
 * version; a failed credential read leaves that row binary-only. Neither
 * failure hides other harnesses. A relative home disables credential file
 * reads; installed binaries and environment API-key signals still work.
 *
 * @category detection
 * @since 0.1.0
 */
export const detectHarnessesWith = async (host: HarnessHost): Promise<Array<Harness>> => {
  const signalHost = isAbsoluteHostPath(host, host.home) ? host : { ...host, isFile: () => false, readText: () => null }
  const found = DETECTORS.map((detector) => ({ detector, binary: findBinary(detector.binary, host) }))
  const versions = await Promise.all(
    found.map(async ({ binary }) => {
      if (binary === null) return null
      try {
        return await host.version(binary)
      } catch {
        return null
      }
    })
  )
  return found.map(({ binary, detector }, index) => {
    const signal = binary === null ? null : readSignal(detector, signalHost)
    return {
      id: detector.id,
      displayName: detector.displayName,
      binary,
      version: versions[index] == null ? null : parseVersionLine(versions[index]),
      status: signal === null ? "unavailable" : signal.status,
      account: signal === null ? null : signal.account,
      launch: { argv: [...detector.launch] },
      ...(detector.models === undefined
        ? {}
        : { models: { suggestions: [...detector.models.suggestions], listable: detector.models.list !== undefined } })
    }
  })
}
