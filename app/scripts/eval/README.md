# Agent-behaviour evals

Does the agent still *do the thing*, or has it started narrating instead?

A model swap, a prompt edit, a tool-description tweak, or a thinking-level change
can all leave an agent that answers fluently and acts less — and nothing in the
test suite notices, because every unit test passes. Each of these has happened
here: a `--system-prompt` override silently deleted a provider's tool
documentation and dropped a working agent to zero real tool calls while its
prose stayed confident, and a model announced "Creating hello.sh now" without
creating anything.

These cases send a prompt to a real room and check what the agent actually
called.

## Running

Needs a live install with the room wired to an agent.

```bash
pnpm exec tsx scripts/eval/run-evals.ts --room <room-id>
```

Exits non-zero if any case fails, so it can run on a timer.

The bundled cases name a room called `eval`; `--room` points them at whatever
you actually have. Run against a scratch room, not a room doing real work — the
cases write files into the agent's workspace and the prompts will appear in its
history.

`--token` (or `$WEBCHAT_TOKEN`) if the install uses bearer auth. On localhost
with no explicit auth configured, it is not needed.

### Getting in

The runner authenticates like any other client, so it depends on how the install
is fronted.

- **Bearer** is the simplest and works regardless of what sits in front, because
  it is checked before every other method: set `WEBCHAT_TOKEN` and pass
  `--token`.
- **Tailscale** installs reject loopback on purpose — once any explicit auth is
  configured the localhost auto-pass is off, so `127.0.0.1` returns 401. Connect
  over the tailnet address instead and the peer is identified by `whois`.
- **An identity-aware proxy** (Cloudflare Access, Entra/EasyAuth) terminates
  auth at the edge and injects an identity header the app trusts. Give the
  runner a service credential with `--header` and let the edge do its job:

  ```bash
  --header 'CF-Access-Client-Id: <id>' --header 'CF-Access-Client-Secret: <secret>'
  ```

  Reaching the origin directly and setting the identity header yourself also
  works, but only if the origin is in `WEBCHAT_TRUSTED_PROXY_IPS` — and if the
  origin port is reachable from anywhere else, that same header lets anyone
  claim any identity. Prefer the service credential.

## Writing a case

```json
{
  "name": "writes-a-script-and-makes-it-executable",
  "prompt": "Create a shell script at /workspace/agent/hello.sh …",
  "room": "eval",
  "expected": [
    { "tool": "Write", "targetPattern": "hello\\.sh" },
    { "tool": "Bash", "targetPattern": "chmod.*hello\\.sh" }
  ],
  "matchMode": "ordered_subset",
  "timeoutMs": 300000,
  "runs": 2
}
```

`target` matches the tool's target exactly; `targetPattern` is a regex against
it; neither means the tool alone counts. Prefer a pattern — an absolute path
that happens to be right today is a case that breaks on an unrelated rename.

`tool` names one tool; `toolPattern` is a regex for a step more than one tool
can legitimately perform. Reach for it when the tool depends on state rather
than on behaviour: "overwrite hello.sh" is a `write` on a fresh workspace and an
`edit` once the file exists, and both are correct. Demanding `write` scored a
correct run 0.50 and read as a model failure until the tool log was checked.

The pattern is matched against the **whole** tool name and case-insensitively.
Whole-name because tool names are a closed vocabulary, so a partial match would
let `read` accept a `thread_create`; case-insensitively because providers
disagree on casing (`Write` vs `write`) and comparing providers is the point.
An expectation naming neither `tool` nor `toolPattern` matches nothing — a case
that asserts nothing should fail, not silently pass.

Match modes: `ordered_subset` (each expectation appears in this relative order,
extra steps are fine) is the default and usually right. `exact` also asserts
there were no other calls — with an empty `expected`, that is how you say the
agent should not have used a tool at all. `subset` ignores order.
`contains_any` passes on one match, for "did it use *some* search tool".

`runs` above 1 runs the case repeatedly and requires every run to pass. Worth it
for the cases that matter: a local model that succeeds half the time is a
failing agent, and a single green run hides that.

Raise it for anything you have seen fail once and pass once. A single run
cannot tell a flake from a weakness, and reading one failure as the latter is
easy to do: the plain-question case failed a run by trying eight `bash` variants
to deliver an answer it already had, which read as a clear model limitation —
and then passed cleanly in 21 seconds on the next run, with nothing about it
changed. It runs three times now.

**Make a repeated case idempotent, or it measures two different tasks.** The
first version of the write case asked the agent to create a script; run 1
created it, and run 2 — finding it already there — sensibly ran it instead, and
scored zero for doing something reasonable. Say "overwrite … even if it already
exists" so every run faces the same task.

Cases run in file order and share one workspace, so a case that edits a file
depends on whatever created it. That is fine, but say so in the prompt ("the
file already exists") rather than leaving the agent to discover it — otherwise a
case run on its own with `--case` fails for a reason that has nothing to do with
the behaviour under test.

## Cases are isolated from each other

Before every run the runner posts `/clear` to the room — the same reset the
room's own "clear all" control sends — and a failure to do so fails the case
rather than being warned about.

That is not tidiness. Cases share a room, and a room's agent carries context
between turns: pi by replaying its entire transcript, Claude by resuming a
continuation server-side. Without the reset, case N is scored in a context built
by cases 1..N-1, and the later a case runs the less its result means.

It showed up as nonsense that looked like a model failure. A single 90-line pi
transcript had accumulated every case's prompt across two runs — six copies of
one, five of another — and a file-writing case answered mid-task with
`echo "6" > /tmp/ans.txt`, arithmetic bleeding in from a "what is 2 + 2" case
that had run earlier. The case was scored zero for a task it was never cleanly
asked.

`--no-clear` disables it, for debugging the runner itself. Results collected
that way are not comparable across cases.

## Why it is not in CI

It needs containers, credentials and a model, none of which CI has. What *is*
in CI is `match.ts` — the part that decides pass or fail — so the grading logic
is covered even though the grading cannot run there.
