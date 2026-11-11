/**
 * The machines a workspace declares, offered to a flow's actions by name.
 *
 * A host that reads the workspace's `S.Remotes` provides {@link Remotes}. An
 * action asks it for a session on one remote, by the remote's name and a
 * session key. The host checks `remote:acquire:<name>` against the calling
 * action's capability ceiling before anything reaches the machine, and it
 * starts the remote's transport (an `ssh` prefix, an HTTP service) itself,
 * outside the confinement the action's own commands run under. The transport
 * is the operator's declared way to reach the machine; the machine is the
 * sandbox.
 *
 * This is the one place a remote is looked up by name. The machine contract
 * in `Sandbox` takes provider values and resolves no names.
 *
 * @since 1.0.0
 */

export * from "./make.ts"
