---
name: workloads
description: >-
  Workloads: run the apps you build (a Compose stack — web app, API, database)
  on NanoClaw itself with `ncl workloads`, and reach them from your own
  container. Use this skill whenever you need to deploy, run, host or test an
  app or service, or think you need a server or VM for one. Covers the rules a
  stack must follow, approvals, addresses, logs/exec, disk quota, backups and
  restore, and publishing an app to people.
---

# Workloads

A workload is a Docker Compose stack that NanoClaw runs **for you**, on its own
host: you write `compose.yml` in your workspace, NanoClaw checks it and runs
it. You do not get a Docker socket or a VM — `ncl workloads` is the interface.

Workloads are off unless the operator turned them on for this host. If a
command says "workloads are off on this host" (or names something missing on
the host), tell the person that; do not try to work around it.

## Deploy

1. Write the Compose file under `/workspace/agent/`.
2. `ncl workloads check --name myapp --file myapp/compose.yml` — lists what the
   rules refuse, and the memory/CPU it will take. Fix and repeat.
3. `ncl workloads up --name myapp --file myapp/compose.yml --reason "<what it is for, one line>"`
   — waits for an owner's approval card, which shows each image with the exact
   version (digest) it will run. You are told the result.
4. After a change: `ncl workloads redeploy --name myapp --file myapp/compose.yml`
   — no approval while the images, capabilities and size are the approved
   ones. A new image or tag, an added capability or more memory/CPU needs `up`
   (a new card).

An image runs at the version approved on the card, even if its tag moves
later: to take a newer version, run `up` again. Only public images can be
pulled (no registry logins).

The name is 2–30 lowercase letters, digits and hyphens.

## Builds

`build:` works only where the operator turned on confined builds; otherwise
the check says so — use a published image instead (configuration in
`environment`, data in a volume). Where builds are on:
- the build folder must be inside your workspace;
- app code in it may change freely; a changed Dockerfile or changed build
  args need `up` (a new card), and the Dockerfile is checked again right
  before each build;
- builds run with your own network access (plus any registries an owner
  allowed for your builds) through `HTTP(S)_PROXY`, and get no credentials;
- at most 20 builds an hour without a card.

## What a stack may contain

Allowed: `image`, `build` (see above), `command`, `entrypoint`, `environment`,
`depends_on`, `healthcheck`, `expose`, **named** volumes, `tmpfs`,
memory/CPU limits, labels, and `cap_add` from a short list (`CHOWN`,
`DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETUID`, `SETGID`, `NET_BIND_SERVICE`,
`KILL`) — every other capability is dropped. Databases that start as root and
switch user usually need `cap_add: [CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER]`.

Refused: `ports` (nothing is published on the host), host-path or socket
volumes (`./data:/data`, `/var/run/docker.sock`), `privileged`, other
capabilities, `cap_drop`, `devices`, `network_mode`, `networks`, `pid`/`ipc`,
`security_opt`, `env_file`, `secrets`/`configs`, `container_name`,
`pull_policy`, `logging`, external volumes, volume `name:`, `include`, YAML
anchors merged with `<<`, and YAML tags (`!something`). Write values out in
full. There is no `${VAR}` substitution: values are used exactly as written.
Images and labels may not carry `nanoclaw*` or `com.docker.*` labels.

Limits: a service without one gets 512 MB and 0.5 CPU. All your stacks
together share your quota: `ncl workloads quota`. Small services rarely need
the default — set `deploy.resources.limits` (e.g. `cpus: "0.25"`,
`memory: 256M`) so more fits. Every stack that is not deleted holds its
approved size, stopped or not.

## Reaching your services

Each service gets a fixed address on your private network, shown by
`ncl workloads list` / `ps` (e.g. `web` → `198.18.0.12`). From your container:
`curl http://198.18.0.12:8080/`. Addresses stay the same across redeploys.
Services reach each other by service name, as in any Compose project.
Stacks have **no internet access** and cannot reach the host — pulls and
builds happen at deploy time, so put dependencies in the image.

**Never** give a person a `198.18.…` address or a port as a link; those work
only from your own container. To let people open an app, publish it (below).

## Publishing an app to people

A published app gets its own address (e.g. `https://notes.<tailnet>.ts.net/`)
on a publishing route an owner turned on for this host, and only the people
its "who can open" rule allows get in; NanoClaw signs them in.

- `ncl workloads expose --name myapp --service web --port 8080 --reason "<what people use it for>"`
  — asks an owner (approval card). Options: `--app <name>` (the first part of
  its address; default the workload's name), `--route tailnet|cloudflare`
  (needed only when both are on), `--who only-me|agent-members|signed-in`
  (default `only-me`: the person who approves the card). On `cloudflare`
  also `--who specific --emails a@example.com,b@example.com` (named people,
  who must also be NanoClaw users signed in with that address).
- `ncl workloads routes` — your apps, their address, who can open them, and
  whether they are live. `ncl workloads list` shows the same per workload
  under `open`.
- `ncl workloads unexpose --app myapp` — stops publishing at once.

If `expose` says no publishing route is on, tell the person: an owner turns
one on in Admin → Publishing. Hand people the `url` from `routes`, never
anything else. An app takes up to a couple of minutes to come up after the
card (its state is `starting`); `url` stays empty until it is
live. A state starting `not reachable:` says what is wrong — pass it on.

Your app learns who is calling from request headers: `X-NanoClaw-User` (their
sign-in name), `X-NanoClaw-Name`, and `X-NanoClaw-Identity` (a signed token
for the app's own hostname, valid two minutes; the public key is at
`/.nanoclaw/jwks.json` on the app's address). It never receives the visitor's
own credentials or cookies from elsewhere. Serve plain HTTP on the port you
publish; the address is HTTPS for people.

## Operating it

- `ncl workloads ps --name myapp` — services, state, address.
- `ncl workloads logs --name myapp [--service api] [--tail 500]`
- `ncl workloads exec --name myapp --service db --command '["psql","-U","app","-c","select 1"]'`
- `ncl workloads stop|start|down --name myapp` — `down` removes containers,
  keeps data. `start` runs the approved images and Dockerfiles.
- `ncl workloads delete --name myapp` — removes data too (approval).

A workload expires after 30 days and is stopped; ask an owner to extend it.

## Disk, backups, restore

Disk use (volumes, container files, your images, your build cache and your
backups) counts against your quota. At 90% you get a `[System]` warning;
over 100% your stacks are stopped and cannot start until you free space.

Volumes are backed up nightly; the newest 3 are kept.
`ncl workloads backups --name myapp` lists them, `ncl workloads backup
--name myapp` takes one now (the stack pauses for a few seconds), and
`ncl workloads restore --name myapp --backup <stamp>` puts one back
(approval; current data is replaced).

## When something fails

- `check` or `up` says "refused": read each line — it names the key to change.
- State `failed`: `ncl workloads list` shows the error; `logs` shows why.
- "changed after the approval": the file, an image's version or a Dockerfile
  changed between the card and the owner's answer — run `up` again.
- Your curl gets 403 for another address: you can only reach your own services.
