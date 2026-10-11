/**
 * Container runtime abstraction for the Extension Manager (RFC v2 §17, §19.5).
 *
 * The Manager is the ONLY component that may control container lifecycle, and
 * it does so exclusively through this narrow interface — never through a raw
 * Docker API passthrough. Two backends exist:
 *
 *  - DockerRuntimeBackend (docker-api.ts): talks to the Docker Engine API over
 *    the unix socket. Only usable where a daemon exists (never on Core).
 *  - LocalProcessRuntimeBackend (local-runtime.ts): dev/test backend that runs
 *    an extension entry as an OS process. Lets the FULL install → health →
 *    conformance → register → chat chain be exercised on machines without a
 *    Docker daemon, over real HTTP.
 *
 * Security invariants (enforced upstream in policy.ts, re-asserted here in
 * types): no privileged mode, no extra capabilities, no host paths, no
 * published ports, no docker.sock inside extension containers.
 */

export interface ImageRef {
  /** e.g. "ghcr.io/xiaonan-520/gateway-extension-fake" or "local/gateway-extension-fake" */
  repo: string
  /** immutable version tag (semver); "latest" is rejected by policy */
  tag: string
  /** sha256:… when pinned/recorded */
  digest?: string
}

/** A container specification that has passed sanitizeRuntime() — nothing else. */
export interface SanitizedContainerSpec {
  /** manager-controlled name: gw-ext-<extension_id> */
  name: string
  image: ImageRef
  /** ONLY the manager token + manifest-allowlisted env — nothing else */
  env: Record<string, string>
  labels: Record<string, string>
  /** the single internal network the container joins */
  network: string
  /** manifest.runtime.port — container-internal, never published */
  port: number
  /** named volumes only (name → container mount path) */
  volumes: Array<{ name: string; mountPath: string }>
  /** always 'ALL' */
  capDrop: 'ALL'
  /** always false */
  privileged: false
  readonlyRootfs: true
  tmpfs: string[]
  noNewPrivileges: true
  restartPolicy: 'unless-stopped'
  memoryBytes?: number
  nanoCpus?: number
}

export interface ContainerHandle {
  containerId: string
  /** address the extension listens on inside the manager network */
  endpointUrl: string
}

/**
 * Minimal lifecycle surface. Implementations MUST NOT accept arbitrary docker
 * parameters — the spec input is the sanitized product of policy.ts.
 */
export interface ContainerRuntime {
  /** resolve + record the immutable digest of an image */
  pullImage(image: ImageRef): Promise<{ digest: string }>
  createContainer(spec: SanitizedContainerSpec): Promise<ContainerHandle>
  start(containerId: string): Promise<void>
  stop(containerId: string, timeoutMs?: number): Promise<void>
  remove(containerId: string): Promise<void>
}
