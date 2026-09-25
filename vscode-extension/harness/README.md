# Runner harness

An integration test of the **real** runner code against a **real** container,
on this host, before a VSIX is packaged. It wires the extension's own
`RunnerAgent` / `RunnerLink` / `SessionRelay` to a minimal central that uses the
real `runner-transport` and `runner-relay`, over a real localhost WebSocket,
with a real docker/podman container from the real agent image and a fake OneCLI
gateway standing in for egress.

It exists because the field bugs lived where unit tests do not reach: the
forwarder's port ownership inside the container, the mailbox helper scripts run
by `bun -e`, and a session left unsupervised after a reconnect.

## Run

    npm run harness                     # docker, default image
    node harness/runner-harness.mjs --runtime podman
    node harness/runner-harness.mjs --keep   # keep the temp workspace

Env: `NANOCLAW_HARNESS_IMAGE` (required: this install's agent image, `nanoclaw-agent-v2-<install slug>:latest`),
`NANOCLAW_STAGING` (default `/opt/nanoclaw/staging`, for the compiled central).

Exit 0 iff every scenario passes.

## What it covers

In the order the harness runs them:

1. link connect / welcome / approved, and a request round-trip
2. adoption + `start --attach` supervision + relay listening
3. a CONNECT tunnelling container → central → gateway, with the session credential
4. the network policy: an unlisted host is refused with a 403 the client can read; a listed host tunnels
5. a multi-megabyte transfer through the relay, intact (caught the split-line reader bug)
6. the exec pipe killed mid-transfer: the tunnel pauses and completes intact after re-attach (the reconnectable relay)
7. propose mode: the slot binds a clone, the developer's tree and uncommitted files are untouched, applying one file brings only it across
8. a plain-HTTP MCP call tunnels out of a network-less container to central's MCP relay and back (origin-form rewrite, token preserved, gateway not involved)
9. a placed session syncs its own mailbox with central over the relay (message in, answer out, wrong token refused)
10. files travel with the mailbox: an attachment comes down, a file the agent sends goes up, byte-exact
11. the container has no network: direct egress fails, the relay is the only way out
12. a real `prepare` binds the developer workspace slot rw into a network-less container; files visible both ways; `secrets/` and `.env` hidden (empty, read-only) while source stays writable
13. the relay refusing a stream for an unplaced session
14. a stale process holding the relay port is evicted when the daemon starts
15. re-adoption of a running container after a reconnect
16. the container runtime going away: the session is held, and resumes when the runtime answers
17. a resume never revives a container that stopped while the machine was away
