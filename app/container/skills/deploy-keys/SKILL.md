---
name: deploy-keys
description: >-
  SSH deploy keys: how this agent reaches servers and git remotes over SSH.
  Use this skill BEFORE concluding you have no SSH access, and whenever you
  need ssh, scp, rsync, a git remote over SSH, Docker over SSH, a deploy to a
  server, or when a user says they added a key or asks you to log in to a
  host. Covers the exact command to use, why there is no key file, and what
  each SSH error means.
---

# SSH deploy keys

A deploy key is an SSH key NanoClaw holds for you on its host. A person adds
one in **Agents → (this agent) → Deploy keys**, gives it a name and a target
(`user@host`), and installs the public half on the server.

**You never see the private key, and there is no key file to look for.** The
host signs logins for you, and only for that key's own server.

## Find your keys

- Your memory's **Credential access** section lists each key with its command,
  e.g. `ssh app-server` (deploy@192.0.2.10). Read it first.
- `ssh-add -l` lists the keys you can use right now.
- `ssh -G <name> | head` shows a key's user and host.
- An empty `~/.ssh` does not mean you have no key.

If a user says they added a key, a message labelled `[SSH keys changed]` in
this conversation names it. Your first key works from your next session;
later ones work at once. Say what you checked; do not conclude there is
none.

## Connect with the name

```bash
ssh <name>                          # e.g. ssh app-server
ssh <name> 'hostname; whoami'       # a quick check
scp ./file <name>:/tmp/             # copy
rsync -a ./dist/ <name>:/srv/app/   # sync
git clone <name>:path/repo.git      # a git remote over SSH
DOCKER_HOST=ssh://<name> docker ps  # Docker on the server, no exposed port
```

The name already carries the login user, the server's pinned host key and the
route out of your container. Do not run `ssh -i <file> user@host`: there is no
file, and a direct connection usually has no route.

For a git host, an HTTPS token in the credential vault works too: then plain
`git clone https://…` authenticates with no key at all.

## When it fails

| What you see | What it means | What to do |
|---|---|---|
| `Could not resolve hostname <name>` | No entry for that name | Check the name against your memory. The key may have no target yet, or its server's host key could not be checked: ask an admin |
| `Could not open a connection to your authentication agent` / `ssh-add -l` shows nothing | No key is loaded for you right now | Say so; an admin checks the key's target in Admin |
| `ssh-proxy: … is not open to this agent` | The network rules do not let you reach that host | Say so. A key's own target is open in Allowlist mode; in Model only it is not. Do not retry in a loop |
| `Permission denied (publickey)` | The server does not have this key's public half | Give the user the key's name and target and ask them to install its public key (Admin shows it) in that user's `~/.ssh/authorized_keys` |
| `agent refused operation` / `sign_and_send_pubkey: signing failed` | The host refused to sign: you are not talking to that key's server | Use `ssh <name>` exactly; the key works only for its own target |
| `Host key verification failed` / `REMOTE HOST IDENTIFICATION HAS CHANGED` | The server's key differs from the one pinned | **Stop.** Tell the user: the server was rebuilt, or something is in the way. An admin re-saves the key's target to pin the new one |

## Rules

- Never ask anyone for a private key, and never paste one into a message or a
  file. If someone sends you one, say it should be added in Admin instead.
- Do not make your own key pairs for servers. Ask the user to add a deploy key
  in Agents → Deploy keys.
- You cannot change the SSH config or known hosts: they are read-only, and a
  host-key error is the protection working.
