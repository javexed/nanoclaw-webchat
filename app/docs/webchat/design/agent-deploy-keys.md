# Agent deploy keys without the private key in the container

Status: built (option (a) below).

## The problem

Admin → agent → Deploy keys generates an ed25519 pair per agent on the host
and shows only the public half. Both halves used to be written to the agent's
group folder (`deploy_key_<name>`, `deploy_key_<name>.pub`). That folder is
mounted read-write into the agent's container, so **the agent could read the
private key**. Anything that steers the agent could make it print, upload or
copy the key. After that the key works from anywhere, with no audit and no
expiry.

Goal: an agent can run `ssh <name>` (and `git` over SSH) to its key's targets
and nowhere else. A compromised agent can use the key while its session runs,
only against that target, but can never take the key away.

## Options considered

| | How it works | A compromised agent can… | Cost |
|---|---|---|---|
| **(a) Host ssh-agent, destination-constrained** | The host keeps the private key outside every mount and loads it into a per-agent `ssh-agent` with `ssh-add -h user@host` (OpenSSH destination constraints, 8.9+). Only a filtered socket reaches the container. | Log in to the key's target, as the key's user, while a session runs. It cannot sign for any other host: the agent checks the server's host key via `session-bind`. It cannot read the key. | Low. Stock OpenSSH on both sides; one socket mount; a small supervisor per agent. |
| **(b) Host SSH relay** | The agent runs `ssh <name>` against a host relay that holds the key, opens the real connection and relays the channel. It can restrict commands (for example only `git-upload-pack`/`git-receive-pack` for one repository) and log each one. | Run only the commands the relay allows, on that target. | High: an SSH server and client in-process, PTY and git edge cases, its own attack surface. |
| **(c) Credential gateway injection** | The gateway injects credentials into HTTPS at the proxy. | — | Not possible for SSH. For git hosts, an HTTPS token held by the gateway already works and is allowed alongside SSH keys. |
| **(d) Short-lived certificates** | A host CA signs a fresh container-generated key for minutes. | Keep a key that works until the certificate expires, against any server trusting the CA. | Every target must trust the CA; most hosted git services don't. The key is still in the container, briefly. |

(a) is built. (b) stays the upgrade path for targets where "a shell as that
user" is too much; a full shell as the key's user is accepted for now.

## What is built

- **Store.** Private halves live in `data/deploy-keys/<agent group>/`
  (0700/0600), outside every container mount: `<name>.key`, `<name>.pub`,
  `<name>.json` (`targets`, who set them, exposed, last use) and the group's
  pinned `known_hosts`. No API returns the private half. Keys stored before a
  key could have several targets carry a single `target`; it is still read,
  and the next change writes `targets`.
- **Several targets per key.** One key often logs in to several servers.
  `targets` is a list of `user@host`; a server reached through a jump host is
  written `user@host via jumpuser@jumphost`, and the jump must be listed
  earlier in the same key. "Who set them" covers the whole list: a scoped
  admin's edit makes every target public-only (see Egress).
- **Pinned host keys.** Creating or re-targeting a key scans each target's
  host key from the host and pins it. A target whose host key could not be
  fetched is not usable (nor is anything reached through it); the next spawn
  tries again, and Admin says "host key not checked yet". A server the host
  cannot reach (often one behind a jump host) is pinned from known_hosts lines
  the operator supplies: `ncl deploy-keys set-target … --known-hosts <file>`.
- **Agent per agent group.** When one of the group's containers spawns, the
  host starts `ssh-agent` with each key added as `ssh-add -h <target> [-h
  <target>…] -H <known_hosts>`: one destination constraint per distinct
  `user@host` with a pinned host key (ssh-add refuses the whole key if any
  `-h` has no host key, so unpinned targets are left out). It stops when the group has no running container (checked
  every minute) or no key left; any key change restarts it.
- **Filtered socket.** The container never reaches the real agent socket. A
  host-side relay in front of it passes only identity listing, signing and the
  `session-bind@openssh.com` / `query` extensions, and answers everything else
  (add, remove, lock) with a failure.
- **Audit.** The relay logs every signature: agent group, key name and the
  server the session was bound to (matched against the pinned host keys).
  Admin can show the key's last use.
- **What the container sees.** A read-only directory at `/run/nanoclaw-ssh`:
  an SSH config with a `Host` entry per usable target, named `<name>` for a
  key's first target and `<name>.2`, `<name>.3`… for the rest (key names hold
  no dot, so these never collide with another key; a single-target key reads
  exactly as before), each with user, host,
  `IdentityAgent`, the public half as `IdentityFile`, `IdentitiesOnly`,
  pinned `known_hosts`, `StrictHostKeyChecking yes`), the public halves and
  the socket. The image includes that config from `/etc/ssh/ssh_config.d` and
  ships `openssh-client` (Debian bookworm: 9.2). `SSH_AUTH_SOCK` points at the
  socket. Only an agent with a key gets the mount and the variable, so an
  agent's first key works from its next session; later changes reach running
  sessions, since they land in the mounted directory.
- **Route out.** `ProxyCommand bun /app/src/ssh-proxy.ts %h %p` tries a direct
  connection briefly (an agent on the open network has a route), then
  `CONNECT`s through the proxy in `HTTPS_PROXY`.
- **Jump hosts.** A `via` target's entry has `ProxyJump <the jump's alias>`
  instead. The container's ssh then opens both connections itself: the first
  to the jump (through the route above), the second tunnelled inside it with
  `-W`. Each is an OpenSSH client connection that binds its session to the
  host key it reached, so each needs only a plain destination constraint for
  its own `user@host`. The `src>dst` form of `ssh-add -h` is for agent
  forwarding, which is never used here.
- **Egress, per agent.** In Allowlist mode the egress filter opens a direct
  tunnel to `<target host>:22` for every target of the agent's keys, and no
  other agent. A server reached through a jump host is listed too; when the
  container has no direct route to it the tunnel goes unused, and it is still
  only that agent's. When several keys name a host, an install admin's target
  decides whether a private address is allowed. A target set by an owner or global admin may resolve to a private
  address; one set by a scoped admin must be public, the same line the
  install allowlist draws for direct tunnels. Model only opens nothing. On the
  open network the filter is not in the path, and the destination constraint
  is what limits the key.
- **What the agent knows.** The memory note lists each target as `ssh
  <alias>` with its `user@host`, never a path. The `deploy-keys` container skill covers
  connecting, git, and what each error means. A running session gets a
  context-only notice when a key is added, re-targeted, rotated or removed.
- **Host CLI.** `ncl deploy-keys list [--group <id>]` shows keys, targets
  and the command for each (fingerprints, never key material). `ncl
  deploy-keys set-target --group <id> --key <name> --targets
  user@host[,user@host…] [--known-hosts <file>]` replaces a key's targets as
  an install admin's. Both, like `migrate`, are host-only: an agent cannot run
  them at any CLI scope.
- **Revocation.** Deleting a key removes it from the store and the agent at
  once. Removing the public key from the server remains the operator's step.

## Known limitation: OpenSSH clients only

A destination-constrained key signs only for a connection that has sent
`session-bind@openssh.com`, which proves the server's host key; ssh-agent
refuses a signing request on an unbound connection. OpenSSH's `ssh`, `scp`,
`sftp` (and `rsync`, `git` over them) bind; SSH libraries such as Node `ssh2`
or Python `paramiko` do not, so they cannot use these keys. Scripts call the
`ssh` binary instead. The filtered socket passes signing requests through
unchanged; the refusal comes from ssh-agent itself.

## Migration

`ncl deploy-keys migrate --dry-run` lists every private key found in agent
folders (deploy-key files, `.ssh/id_*`, and any other file that is a private
key; dependency trees and fixtures are skipped), with the name and target it
would get. Without `--dry-run` it:

1. imports each key into the store, with its target from the agent's own
   `.ssh/config` (or, for a key NanoClaw generated, its `.pub` comment),
   otherwise "target needed" in Admin;
2. marks each one **exposed**: agents could read those files. Admin shows an
   Exposed badge and a Rotate action, which replaces the pair (same name and
   target) and copies the new public key to put on the server;
3. backs the originals up to a 0600 tarball under `data/deploy-keys/backups/`,
   then removes them from the agent folders.

`--group <id>` limits a run (and its dry run) to one agent. `--targets
'{"<key name>": "user@host,user@host"}'` (with `--group`) gives a key's
targets by the name the dry run shows, replacing any found; a name the run
would not import is refused before anything moves.

Targets found by the migration come from files the agent could write, so they
are recorded as a scoped admin's (public addresses only, IP literals
included) unless the operator passes `--trust-targets` after reviewing the
dry run. Targets given with `--targets` or `set-target` are an install
admin's. An owner can also re-save targets in Admin.

Existing keys are not rotated automatically. Scripts that used `ssh -i
/workspace/agent/<file>` stop working: the memory note and the skill point
agents to `ssh <name>`.
