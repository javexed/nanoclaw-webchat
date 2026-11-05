# Agent deploy keys without the private key in the container

Status: proposal, for decision.

## The problem

Admin → agent → Deploy keys generates an ed25519 pair per agent on the host
and shows only the public half. Both halves are written to the agent's group
folder (`deploy_key_<name>`, `deploy_key_<name>.pub`). That folder is mounted
read-write into the agent's container, so **the agent can read the private
key**. Anything that steers the agent can make it print, upload or copy the
key. After that the key works from anywhere, with no audit and no expiry.

Proposed follow-ups make keys usable (`openssh-client` in the image, a managed
`.ssh/config` with `ssh <name>`, a ProxyCommand through the egress filter, a
pinned host key, a container skill). They all keep the key file in the
workspace. This doc picks a design where the private half never enters a
container, and keeps everything else from those follow-ups.

Goal: an agent can run `ssh <name>` (and `git` over SSH) to its key's target
and nowhere else. A compromised agent can use the key while its session runs,
only against that target, but can never take the key away.

## Options

| | How it works | A compromised agent can… | Cost |
|---|---|---|---|
| **(a) Host ssh-agent, destination-constrained** | The host keeps the private key outside the group folder and loads it into a per-agent `ssh-agent` with `ssh-add -h user@host` (OpenSSH destination constraints, 8.9+). The agent socket is mounted into that agent's containers only. | Log in to the key's target, as the key's user, while a session runs. It cannot sign for any other host: the agent checks the server's host key via `session-bind`. It cannot read the key. | Low. Stock OpenSSH on both sides; one socket mount; a small supervisor per agent group. |
| **(b) Host SSH relay** | The agent runs `ssh <name>` against a host relay. The relay holds the key, opens the real connection to the pinned target and relays the channel. It can restrict commands (for example only `git-upload-pack`/`git-receive-pack` for one repository) and log each one. | Run only the commands the relay allows, on that target. Every command is audited. | High. An SSH server and client in-process, channel relay, PTY and git edge cases, and its own attack surface. |
| **(c) Credential gateway injection** | The gateway injects credentials into HTTPS at the proxy. | — | Not possible for SSH: there is no HTTP request to inject into. For git hosts, an HTTPS token held by the gateway already does this today and is the better route. |
| **(d) Short-lived certificates** | A host CA signs a fresh container-generated key for minutes, with a principal and `force-command`/`source-address` options. | Keep a key that works until the certificate expires, against any server that trusts the CA. | Every target must trust the CA (`TrustedUserCAKeys`). Most hosted git services don't support this. The key is still in the container, briefly. |

## Recommendation: (a), with (b) kept as the upgrade path

(a) meets the goal with stock tooling. The key never enters a container, and
`ssh-add -h` makes the key useless against anything but its target. This holds
even if the agent tunnels to another host the egress filter allows. (b) adds
command-level limits and audit, which is worth building only if keys start
going to targets where "a shell as that user" is too much. (c) stays the answer
for git hosting: an HTTPS token, not an SSH key.

### Shape

- **Store.** Private halves move to a host-only directory outside every mount
  (`data/deploy-keys/<agent group>/`, 0700/0600). The `.pub` and the target stay
  where the UI reads them today. No API returns the private half, as today.
- **Agent per agent group.** The host starts one `ssh-agent` per agent group
  that has keys, with its socket under the session runtime directory. It adds
  each key with `-h <user>@<host>` and the pinned host key. A key's add, edit
  or delete re-adds or drops it at once.
- **Mount.** The container gets the socket read-only at a fixed path and
  `SSH_AUTH_SOCK`. No key files, and no `IdentityFile` lines.
- **Config.** The managed `.ssh/config` block from the follow-ups stays: `Host
  <name>`, `User`, `HostName`, the ProxyCommand through the egress filter,
  `IdentitiesOnly yes` and `IdentityAgent`. The pinned `known_hosts` is
  written by the host and mounted read-only, so an agent cannot accept a
  changed host key.
- **Egress.** The target `host:22` must be allowed by the egress filter. Scope
  it to the agent that holds the key, not install-wide. The proxy refuses SSH
  tunnels to anything else, and the destination constraint is the second line
  of defence.
- **What the agent sees.** The memory note lists each key as `ssh <name>`
  (user@host, fingerprint) and points to the deploy-keys skill: how to connect,
  what each SSH error means, and "you never see or need the private key".
- **Audit.** A thin host-side wrapper in front of the agent socket logs every
  sign request: agent group, key, bound host, time. A key's use shows in Admin
  next to the key.
- **Revocation.** Deleting a key removes it from the agent immediately and
  deletes both halves. A running session loses it on its next connection.
  Removing the public key from the target server remains the operator's step.

## Migration

1. Ship the store, agent and mount. On start, move each existing
   `deploy_key_<name>` private half out of the group folder into the store.
   Use the existing no-follow helpers: a planted link is refused, not
   followed.
2. **Treat every existing key as exposed.** Agents could read those files.
   Admin shows a "Rotate" action. It generates a new pair in place, keeps the
   name and target, and shows the new public key to install on the target.
3. Land the follow-ups' usability parts (`openssh-client`, the managed config,
   ProxyCommand, pinned host key, skill, memory note), changed to use the
   agent socket instead of key files.

## Open questions

- Per-agent egress allowlist entries for SSH targets, or keep the install-wide
  allowlist? Per-agent is tighter, but it's new UI.
- Force rotation of existing keys at upgrade, or offer it only?
- Is a shell as the key's user acceptable for current targets, or is (b) needed
  now for some of them?
- For git hosts: steer people to HTTPS tokens in the gateway and refuse SSH keys
  for known git hosts, or allow both?
