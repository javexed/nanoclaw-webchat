# Scheduled-task failures

What happens when a scheduled task (`ncl tasks create …`) fails, and how its
owner hears about it.

## Which runs are retried

| What went wrong | What happens |
|---|---|
| The agent container could not start (gateway down, spawn error), or exited before the run's first model query | Retried at **+5, +15 and +30 minutes**. After the third retry fails, that run is given up and counts as one failure. A recurring task's next slot is scheduled as usual. |
| The run reached the model and then failed — an error result, the container dying mid-run, or the agent declaring failure | **Not retried.** The first attempt may already have sent messages or changed files; a second attempt could do it again. The run counts as one failure. |
| The pre-task script errored | Counts as a failure. Core's existing script backoff and auto-pause still apply. |
| The pre-task script said there was nothing to do (`wakeAgent: false`) | A normal run. It neither raises nor clears an alert. |

A due run that waits more than 3 minutes for its container — a slow spawn, or
the host not admitting new sessions — counts as a container that could not
start.

A slot missed while the host was down fires **once** when the host comes back —
there is no burst of catch-up runs — and the next slot follows the cron
schedule from then.

## Alerts

Consecutive failures of the same task with the same cause are one incident:

- the **first** failure sends one notice,
- later failures stay quiet, except a **reminder** once the reminder interval
  has passed since the last notice (default 24 hours),
- the first successful run sends a **recovery** notice.

A failure with a different cause (say the model errors, then the agent reports
bad data) is a new incident and gets its own notice.

Notices go to the chat the task was created from. A task created from the CLI
(or whose chat is gone) alerts the agent's approvers by DM instead: a scoped
admin, else a global admin, else the owner.

Set the reminder interval in hours in `.env`:

```
NANOCLAW_TASK_ALERT_REMINDER_HOURS=24
```

## The agent can fail its own run

Inside a task run the agent is told it can record a failure:

```
ncl tasks fail --reason "sales API returned 503 for every region"
```

The run is logged as failed with that reason and feeds the alerts above.
This needs the agent's `ncl` access (the default `cli_scope`); with
`cli_scope=disabled` the command is refused.

## Seeing the state

`ncl tasks get <id>` includes a `health` block: the current incident (cause,
failure count, when it opened and last alerted), the last finished run's
outcome, and a start retry that is waiting, if any. A task that will not run again
(a finished one-shot, or cancelled) closes its incident without a recovery
notice; its state then says how its last run went. The task's run log
(`tasks/<id>.md` in the agent's folder) records each retry, give-up, failed run
and notice sent.
