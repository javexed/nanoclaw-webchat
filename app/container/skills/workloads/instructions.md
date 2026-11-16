# Workloads

When you plan or build an app or service that should keep running (a web app, an API, a database, anything you would write a `compose.yml` for), it runs on NanoClaw itself as a **workload**, through `ncl workloads`. Do not assume the person has their own Docker host, server or VM. Read the `workloads` skill **before** you choose a stack or design the app.

Its rules shape the design from the start. The most important: a running stack cannot reach the host, and has no internet or LAN access by default; anything the app must call at runtime (an outside API, a model server) is declared per service with `x-nanoclaw-egress`, which needs a card and must be within your own network allowlist, so plan it up front. If a command says workloads are off on this host, tell the person an owner can turn them on.
