# Agent templates in webchat

Upstream ships [agent templates](https://agent-plugins.org): a directory
carrying an agent's persona, skills, MCP servers and recurring tasks — no
provider, no secrets — that stamps into a working agent. Upstream reaches them
from `ncl groups create --template` and the setup wizard. This adds the whole
lifecycle to the web UI.

| Capability | Where |
|---|---|
| Create an agent from a template | Agents → **+ New agent** → Template |
| Import and manage the library | Agents → **Templates** |
| Update a stamped agent | Agent detail → **Check for updates** |
| Save an agent as a template | Agent detail → **Save as template…** |

All of it is owner / global admin — the same gate as agent import, because
stamping writes scheduled tasks and MCP servers, which a scoped admin cannot
otherwise touch.

## Where the library lives

Templates resolve from `NANOCLAW_TEMPLATES_DIR`, or `templates/` at the project
root by default.

**On a composed install, point it outside the git tree.** The deploy rsync ships
`templates/` empty, so an in-tree library is deleted on every deploy. `data/` is
excluded from that rsync, which makes `data/templates` the durable choice:

```bash
NANOCLAW_TEMPLATES_DIR=/path/to/nanoclaw/data/templates
```

It resolves once at host load, so changing it needs a restart. Both `ncl` and
webchat read the same setting, so they always see the same library.

## Sources

Fetching reads a list of GitHub repos, seeded with the public registry
(`nanocoai/nanoclaw-templates`). Upstream hardcodes that single URL in
`setup/templates.ts`; a list is what makes your OWN template repo possible,
which is what closes the loop with exporting.

Fetching uses the GitHub contents API — the same `githubFetch` the skills
registry uses (retry, rate-limit handling, token support) — rather than
`git clone`. A server process should not shell out to git, and the API path is
the one that works for a private repo with a token.

Built-in sources cannot be deleted: the row is code-seeded and would return on
the next migrate.

## Validation happens on arrival

Every fetched or exported template is staged and run through upstream's own
reader before it lands: containment, symlink refusal, size caps, secret lint,
manifest validity. A template that would fail at stamp time fails while you are
looking at it, and the library never holds a half-written one. Anything the
reader skips is named, never silently dropped.

## Updating a stamped agent

`Check for updates` renders the dry-run plan: every plugin-owned surface that
would change, with **local edits flagged** — applying resets those and the edits
are lost. Confirming is styled destructive only when there is actually something
to lose.

The plan is the reason this belongs in a UI. Upstream's docs note that when an
*agent* requests a restamp, the approval card shows only the command line and
tells the approver to run the dry run themselves.

Applying restarts the agent, because skill and MCP changes only take effect in a
fresh container.

Memory, conversations, wiring, self-authored skills and your own MCP servers are
never touched by an update.

## Saving an agent as a template

Not to be confused with **Export agent…**, which produces a migration tarball
(memory and conversations included) for moving one agent between installs. A
template is a blueprint meant to be shared.

Carried: persona, extra context, skills, MCP servers, recurring tasks.

**Not carried, and reported by name:**

- **packages** — the plugin format has no slot for them, so an agent stamped
  from this template will *not* have them installed. This is the one omission
  that silently changes behaviour, which is why it is named per package.
- provider and model — a template is runtime-neutral by design
- timezone, host mounts — install-specific
- memory and conversations — a blueprint, not a backup

Every `env` and `headers` value becomes the literal `"placeholder"`. The
credentials proxy holds the real value and injects it per request; a real key
here would be both wrong and rejected by the secret lint. A server that needs an
env var merely to boot still boots, because `"placeholder"` is the one value
that lint always accepts.

## What is deliberately not here

Stamping refuses a template a group already carries (409, naming the agent and
the CLI command) rather than quietly creating a duplicate — updating goes
through the plan above.
