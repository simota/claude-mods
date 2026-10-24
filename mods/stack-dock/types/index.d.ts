/** One line of `devrouter doctor`: `[LEVEL] name: message`, with the hint under it. */
export type Check = { level: 'ok' | 'warn' | 'error'; name: string; message: string; hint?: string }

/** What `devrouter doctor` said about the repository root, and what the root holds. */
export type Doctor = { isInstalled: boolean; checks: Check[]; hasConfig: boolean; hasCompose: boolean; hasWorkspace: boolean }

/** A service URL's answer through Traefik: a TLS failure and Traefik's own 404 are not taken for down. */
export type Http =
  | { kind: 'ok'; status: number }
  | { kind: 'bad'; text: string }
  | { kind: 'unrouted' }
  | { kind: 'tls' }
  | { kind: 'unchecked' }

/** `state` is the container's as `docker compose ps` says it (`running`, `exited`, ...), `missing` when it has none. */
export type Service = { name: string; url: string; composeService: string; state: string; exitCode?: number; http: Http; tail: string[] }

/** `lastUpAt` is devrouter's: when an up last succeeded, from anywhere. */
export type Stack = { id: string; name: string; composeFilePath: string; lastUpAt: string; services: Service[] }

export type Run = { startedAt: number; elapsedS: number; line: string; isBuild: boolean }

/** Why the last `devrouter up` failed (`at`, ms): its error line, doctor's findings after it, and the output's last lines. */
export type Failure = { at: number; error: string; checks: Check[]; tail: string[] }

declare module 'claude-code' {
  interface PluginState {
    'stack-dock': {
      /** The repository root (git's top level, else the cwd). */
      root: string | null
      doctor: Doctor | null
      /** The root's stack in devrouter's registry, with each service as last seen. */
      stack: Stack | null
      /** Set when the registry could not be read as expected. */
      registryNote: string | null
      run: Run | null
      failure: Failure | null
      /** The band key it was closed for: it stays down until the state changes. */
      hiddenFor: string | null
      /** What waits to go beside the next prompt. */
      feed: string | null
    }
  }
}
