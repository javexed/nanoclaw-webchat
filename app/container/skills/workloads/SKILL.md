---
name: workloads
description: >-
  Workloads: run the apps you build (a Compose stack — web app, API, database)
  on NanoClaw itself with `ncl workloads`, and reach them from your own
  container. Use this skill whenever you need to deploy, run, host or test an
  app or service, think you need a server or VM for one, or bring an existing
  project's docker-compose.yml over. Covers the rules a stack must follow,
  converting a Compose project, builds, approvals, addresses, logs/exec, disk
  quota, backups and restore, and publishing an app to people.
---

# Workloads

A workload is a Docker Compose stack that NanoClaw runs **for you**, on its own
host: you write `compose.yml` in your workspace, NanoClaw checks it and runs
it. You do not get a Docker socket or a VM — `ncl workloads` is the interface.

Workloads are off unless an owner turned them on for this host. If a command
says "workloads are off on this host", tell the person: an owner turns them on
in **Admin → Publishing** (the Workloads switch), which also says what is
missing on the host and the command that fixes it. Do not try to work around
it.

## Deploy

1. Write the Compose file under `/workspace/agent/`.
2. `ncl workloads check --name myapp --file myapp/compose.yml` — lists what the
   rules refuse, the memory/CPU it will take, and what was `translated`. Fix
   every refusal and repeat.
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

`build:` works only where an owner turned on confined builds (**Admin →
Publishing**, the Confined builds switch); otherwise the check says so. Then
either tell the person that, or use a published image (configuration in
`environment`, data in a volume). Do not pack app code into environment
values or commands to get around a missing build: ask for builds instead.
Where builds are on:
- the build folder must be inside your workspace;
- app code in it may change freely; a changed Dockerfile or changed build
  args need `up` (a new card), and the Dockerfile is checked again right
  before each build;
- builds run with your own network access (plus any registries allowed for
  your builds) through `HTTP(S)_PROXY`, and get no credentials. Base images
  from Docker Hub (`FROM node:22`) need **Allow Docker Hub for builds**, which
  an admin of this agent turns on in **Agent → Apps** (an owner approves it).
  If a build is refused reaching a registry, tell the person that;
- tools that ignore the proxy (e.g. `pecl`, some installers) have no way out:
  fetch with `curl` first, then install from the file;
- builds never go through the credential gateway and never get your Secrets:
  a gateway answer such as `credential_not_found` says nothing about a build;
- private images (`FROM` or `image:` from a registry that needs a login) cannot
  be used: tell the person. Never work around one by vendoring its files,
  merging its Dockerfile into yours or rebuilding it;
- up to about 70 image layers (each `RUN`, `COPY`, `ADD` adds one, on top of
  the base image's); past that a step fails with an `overlay` mount `invalid
  argument`: join `RUN` steps with `&&`;
- at most 20 builds an hour without a card; a build may run up to 120 minutes.
  Saving very large layers is slow here, so keep big downloads and caches out
  of the image.

## Bringing in an existing project

To deploy a project that already has a `docker-compose.yml` (one people
also run locally), keep its files as they are, so local builds stay the
same:

1. `check` the project's own file, unchanged. Most of it is translated
   (see What a stack may contain); read what is still refused.
2. Put the changes in a copy beside it, `compose.workload.yml`, never in
   the original. Non-secret values may go in a `.env` beside it. Change only
   what `check` refuses, and tell the person each change and why.
3. Host-path mounts are the usual refusal. For each one:
   - the Dockerfile already copies that folder in → drop the mount;
   - data the app writes (uploads, backups, a database) → a named volume;
   - files the image doesn't carry (excluded by `.dockerignore`) → add the
     few the app needs with a `COPY` (and a `.dockerignore` exception), or
     a named volume; a small config file (≤64 KB) → `configs`.
4. Set `deploy.resources.limits` if the project sets none: the default
   (512 MB, 0.5 CPU) is too small for most web apps with a database.
5. Apps that check the host name (Drupal `trusted_host_patterns`, Django
   `ALLOWED_HOSTS`, Rails `hosts`, Vite `allowedHosts`) refuse other names:
   allow the service name, `198.18.*` addresses, and the app's published
   host name (from `ncl workloads routes`). "The provided host name is not
   valid" or a 400 on every page means this.
6. Secret values in the project's files (keys, connection strings,
   passwords) do not belong in a workload: use test values, never copy real
   ones into the copy or `.env`, and tell the person that a key that sat in
   a file in plain text should be rotated.
7. `check` again, show the person its output, then `up`.

A workload is a sandbox for the people who use you, not the project's
dev, test or production environment. Leave those where they are (their
servers, sign-in and deployments); never stop or change them unless the
person asks.

### Moving an existing deployment's data

When the person wants a running copy's data in the workload too:
- databases: dump and restore into the workload (`ncl workloads exec`
  into its database; `pg_dump | pg_restore`, `mysqldump | mysql`), then
  the app's own update step (`drush updb`, migrations);
- uploaded files: copy into the named volume that holds them;
- compare a few counts (rows, files) between the two copies, and tell the
  person;
- never run a step that resets settings from files (`drush cim`, fixtures,
  seeds) on migrated data: settings that live only in the database are lost.

## What a stack may contain

Allowed: `image`, `build` (see above), `command`, `entrypoint`, `environment`,
`depends_on`, `healthcheck`, `expose`, **named** volumes, `tmpfs`,
memory/CPU limits, labels, and `cap_add` from a short list (`CHOWN`,
`DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETUID`, `SETGID`, `NET_BIND_SERVICE`,
`KILL`) — every other capability is dropped. Databases that start as root and
switch user usually need `cap_add: [CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER]`.

A project's own `docker-compose.yml` usually works as it is: NanoClaw
translates what is safe and `check` lists every translation (the approval
card shows them too):

- `${VAR}` forms are filled from the `.env` next to the Compose file (never
  from anywhere else); unset ones are left empty and listed.
- `include`, `extends`, `env_file`, `configs` and `secrets` read files from
  your workspace only (ones that come from an environment variable are
  refused).
- `ports` become `expose` (nothing is published on the host); `networks`,
  `links` and `container_name` are dropped, and those names still reach the
  service; services with `profiles` are left out, as Compose does.
- Volume `name:` and `external` are dropped: the stack gets its own volume,
  which starts empty.

Still refused: host-path or socket volumes (`./data:/data`,
`/var/run/docker.sock`), `privileged`, other capabilities, `cap_drop`,
`devices`, `network_mode`, `pid`/`ipc`, `security_opt`, `gpus`, `dns`,
`extra_hosts`, `pull_policy`, `logging`, `build.additional_contexts`, YAML
anchors merged with `<<`, and YAML tags (`!something`). Images and labels may
not carry `nanoclaw*` or `com.docker.*` labels.

Limits: a service without one gets 512 MB and 0.5 CPU. All your stacks
together share your quota: `ncl workloads quota`. Small services rarely need
the default — set `deploy.resources.limits` (e.g. `cpus: "0.25"`,
`memory: 256M`) so more fits. Every stack that is not deleted holds its
approved size, stopped or not.

## Reaching your services

Each service gets a fixed address on your private network, shown by
`ncl workloads list` / `ps` (e.g. `web` → `198.18.0.12`). From your container:
`curl http://198.18.0.12:8080/`. Addresses stay the same across redeploys.
Go through the proxy your container is given (`HTTP_PROXY`/`http_proxy`;
curl uses it): a stack on another machine is reached only that way, so raw
sockets (`/dev/tcp`, `nc`, a database client) time out there.
Services reach each other by service name, as in any Compose project.
Stacks have **no internet access** and cannot reach the host — pulls and
builds happen at deploy time, so put dependencies in the image.

**Never** give a person a `198.18.…` address or a port as a link; those work
only from your own container. To let people open an app, publish it (below).

## Publishing an app to people

A published app gets its own address (e.g. `https://notes.<tailnet>.ts.net/`)
on a publishing route an owner turned on for this host, and only the people
its "who can open" rule allows get in; NanoClaw signs them in.

**An app meant for people: deploy and publish in one step.** Prefer this over
`up` followed by `expose` — the owner sees one card, not two:

- `ncl workloads up --name myapp --file myapp/compose.yml --publish tailnet --reason "<what people use it for>"`
  — the card shows what runs and where people open it. `--publish` is the
  route (`tailnet` or `cloudflare`). Options as for `expose`: `--who`,
  `--emails`, `--app`; `--service`/`--port` only when NanoClaw cannot tell
  (it serves the one service that declares an `expose:` port, on that port —
  so declare one, e.g. `expose: ["8080"]`).
- When it is approved you are told one line, e.g. `myapp is running · open it
  at https://myapp.<tailnet>.ts.net (only you)`: pass that link on as it is.
- If it says the route is not on, tell the person: an owner turns it on in
  Admin → Publishing. You can still deploy now without `--publish` and publish
  later with `expose`.

To publish a workload that already runs:

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

An app with its own sign-in (Entra/MSAL, OAuth) doesn't need it here: people
are already signed in to NanoClaw. If the project also runs elsewhere with
a real sign-in, add a switch only the workload sets (an environment value,
off by default) that skips it. When the switch is on, the app must check
`X-NanoClaw-Identity` (signature, its own hostname, expiry) and read the
person from that token, never trust `X-NanoClaw-User` alone; keep the real
sign-in for the other environments.

## Operating it

- `ncl workloads ps --name myapp` — services, state, address.
- `ncl workloads logs --name myapp [--service api] [--tail 500]`
- `ncl workloads exec --name myapp --service db --command '["psql","-U","app","-c","select 1"]'`
- `ncl workloads stop|start|down --name myapp` — `down` removes containers,
  keeps data. `start` runs the approved images and Dockerfiles.
- `ncl workloads delete --name myapp` — removes data too (approval).

A workload expires after 30 days and is stopped. A published app that people
opened in the last week is renewed automatically before then (you are not
told). Otherwise, a few days before, you get a `[System]` notice: tell the
people in the room. An admin of this agent
extends it in **Agent → Apps** (Extend, 30 days from that day), or you ask
with `ncl workloads extend --name myapp` (approval). After it stopped, extend
it and `start` it again. `ncl workloads list` shows `expires`.

## Sleeping when idle

A stack with no requests for 8 hours sleeps: its containers stop, its data,
addresses and size stay. The next request wakes it in a few seconds: people
opening its page see "Starting…" briefly; your own requests, `exec`, `start`
and `redeploy` wake it too. `ncl workloads list` shows it as `asleep`.

- A stack that works in the background (a job worker, a scheduled sync) must
  not sleep: `ncl workloads sleep --name myapp --after 0`.
- Another idle time: `--after <hours>`; back to the default: `--after default`.

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

Read the error before changing anything; each says what to fix. Don't
guess, and don't change the project's approach to get around one.

- `check` or `up` says "refused": read each line — it names the key to change.
- State `failed`: `ncl workloads list` shows the error; `logs` shows why.
- A build error starting **"Blocked during the build:"** names each host
  NanoClaw refused and why: not on your allowed hosts (ask an owner), or
  not reachable. Fix that first; the rest of the error follows from it.
- `Dockerfile:<line>` with a step's own output: that step failed; fix it.
- "timed out after 120 min": the build was too slow (usually very large
  layers); it names the steps that took the time. Make the image smaller.
- `overlay` mount `invalid argument`: too many layers (Builds).
- A build that ran twice: each `up`/`redeploy` is one build. Wait for its
  result message; never retry while one runs.
- "changed after the approval": the file, an image's version or a Dockerfile
  changed between the card and the owner's answer — run `up` again.
- Your curl gets 403 for another address: you can only reach your own services.
