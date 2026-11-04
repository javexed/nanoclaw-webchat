# Machines and workers

NanoClaw can run agent workloads (see [workloads.md](workloads.md)) on other
machines as well as on its own host ("central"). A machine joins over a TLS
listener of its own, and a machine with the worker role keeps one lasting,
mutually authenticated link to central. Central sends it the Compose files and
images of the stacks placed on it; the worker runs only a fixed set of jobs.

This page covers what keeps a workload on a worker from reaching the worker
itself, and how stacks get placed on workers.

## Turning it on

```bash
# .env on central
NANOCLAW_MACHINE_PORT=7443          # the machine listener (off when unset)
NANOCLAW_MACHINE_BIND=0.0.0.0       # default 127.0.0.1
NANOCLAW_MACHINE_ADDRESS=10.0.0.4   # what machines use to reach it
```

Admin → Scaling → Machines then offers **Add machine** (a one-line install
command, valid an hour, once) and **Join over SSH**.

## Host rules on a worker

Workload networks are Docker `--internal` networks, and Docker does not filter
traffic addressed to the host itself: from a workload container, every service
listening on the worker (SSH, a database, other software's published ports)
answers at the network's gateway address (`198.18.x.1`). Central's host has
the same problem and the same fix, the workload host rules
(`deploy/workloads-host-rules.sh`, [workloads.md §2](workloads.md#2-host-rules)).

The worker installer puts those rules on the worker too:

- central serves the same `workloads-host-rules.sh` it uses itself, and the
  installer checks it (and the worker service's own files) against the sha256
  central computed before using it;
- it installs `iptables` when missing and runs the script with
  `--install-unit`: the rules drop new connections arriving on any workload
  bridge (`ncw…`) or from `198.18.0.0/15`, IPv4 and IPv6, and
  `nanoclaw-workloads-firewall.service` puts them back at every boot, before
  Docker starts.

If the rules did not install, the installer says so and the worker takes no
workloads (below). To put them back by hand, on the worker:

```bash
sudo bash /usr/local/lib/nanoclaw-machine/worker/workloads-host-rules.sh --install-unit
```

A machine that joined before this needs the worker command from Admin →
Machines run once more; that also installs the rules.

## The isolation check

The worker checks that the rules work by trying, the way central's preflight
does: a throwaway container (the helper image central sends) on a probe
network shaped like a workload network (`nc-worker-probe`, bridge `ncwprobe`,
`198.19.255.0/24`, internal) asks a listener on the gateway address. An answer
means a workload could reach the machine.

- It runs when the worker service starts, every 30 minutes, and when central
  asks (when the worker links, and every 10 minutes while its result is
  missing or old).
- Each health report carries the result: `ok`, `open` or `unknown`, with its
  age.
- **Fail closed on the worker.** Until a check passes, the worker refuses
  `compose up`, `start` and `restart`. When a check gets through, it stops
  every running container of NanoClaw's Compose projects at once; central
  records those stacks as stopped and tells their agents.
- **Fail closed on central.** A worker is used for a stack only while its
  latest result is `ok` and less than 45 minutes old. Otherwise placement keeps
  a new stack on central and says why on the approval card ("worker *name*
  hasn't passed the isolation check"); a stack already on that worker is not
  started or redeployed until it passes.

The worker's link relay (how central's proxy and app gateway reach a stack on
a worker) carries a connection only to the address of a workload service that
runs there now, never to the gateway `.1`.

## Placement is opt-in

Workers are not used by themselves. A worker gets new stacks only when:

1. an owner turned **Run workloads here** on for it (Admin → Machines, per
   machine; off for every machine that joins), or
2. an owner pinned an agent's workloads to it:
   `ncl workloads pin --group <agent group> --node <machine id>`.

A pin counts even with the switch off, and reaches a draining machine; it
never counts while the isolation check has not passed (the stack is refused,
with the reason, rather than placed elsewhere). `--node local` pins an agent
to central; `--node none` removes the pin. Among switched-on workers, a stack
goes where the agent's other stacks run when they fit, else to the one with
the most free memory. The card's placement line says which rule decided:
"pinned to *name* by an owner" or "*name* (runs workloads, turned on by an
owner): …". Turning the switch off affects only new stacks; existing ones stay
where they are.

## Status

Admin → Machines shows one line per worker:

| Line | Meaning |
| --- | --- |
| Isolated | The latest check passed, recently. |
| Not isolated — host rules missing | The check got through; workloads there are stopped. The ⓘ shows the command to run on the worker. |
| Not checked yet | No result: the worker service is older, not linked, or could not run the check. |
| Not checked recently | The last pass is older than 45 minutes. |

From the host: `ncl workloads workers` lists each worker with its switch,
link, isolation result and stacks; `ncl workloads worker-set --id <m-…>
--workloads on|off` is the switch.
