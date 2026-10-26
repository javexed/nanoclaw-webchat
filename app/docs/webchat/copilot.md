# GitHub Copilot

Run an agent on a GitHub Copilot seat instead of a Claude or ChatGPT
subscription. The agent harness is the GitHub Copilot SDK; the seat's token is
held by the credential gateway and never enters an agent container.

**Status:** built and tested without a live seat. The parts that need a real
seat are listed under [What is verified](#what-is-verified).

Based on the upstream `/add-copilot` proposal by @barnuri (nanocoai/nanoclaw#3976).

## What to ask IT for

Copilot can be licensed through a GitHub Enterprise account even if your code
lives elsewhere (for example Azure DevOps). Ask for:

1. **A GitHub Enterprise account used for Copilot licensing.** If its users are
   managed by Microsoft Entra ID (Enterprise Managed Users), sign-in goes
   through Entra. No code has to move to GitHub.
2. **A Copilot Business seat** assigned to your user.
3. **The Copilot CLI policy enabled** for the enterprise/organization. The
   agent runs on the Copilot runtime the CLI uses; with that policy off,
   GitHub refuses the seat (403) even though Copilot works in an editor.
4. **No sign-in or network policy that blocks the machine running NanoClaw**:
   - no Entra Conditional Access policy that only allows company locations or
     compliant devices for the GitHub app, and
   - no GitHub IP allow list on the enterprise or organization — or one that
     includes the public IP of the machine running NanoClaw.

Sign-in happens at `github.com`; for Enterprise Managed Users it is handed to
the organization's Microsoft login, with no personal GitHub account involved.
No `ghe.com` tenant is needed.

## Install and connect

**From webchat (owner or admin):** Admin → Run setup wizard… → **GitHub
Copilot**. If it says *not installed*, **Install GitHub Copilot…** adds the
provider, rebuilds the agent image and restarts NanoClaw (a few minutes). Then
**Connect GitHub Copilot…** shows a code and a link: open the link on any
device, enter the code, and sign in with your work account. The card switches
to *Connected* with the plan and endpoint, and offers **Disconnect**. The same
install button is in Admin → Access & credentials.

**From a terminal on the host (works over SSH):**

```bash
pnpm exec tsx setup/index.ts --step provider-install copilot   # once
pnpm run build && ./container/build.sh                          # then restart NanoClaw
pnpm exec tsx scripts/copilot-login.ts                          # prints a link and a code
```

Both paths run the same helper: `copilot login --device-code` in a throwaway
container from the agent image, the token read once from that container's
temporary home, checked against GitHub, stored as two gateway connections, and
the temporary home deleted on every outcome. The token is never shown, logged,
or written anywhere else.

**Use it:** in an agent's settings set **Harness → GitHub Copilot**. To make it
the default for new agents, select GitHub Copilot as the engine in the setup
wizard once it is connected. From a terminal:
`ncl groups config update --id <group-id> --provider copilot`.

**Models.** The agent's model field picks the Copilot model; empty means
`auto`, where Copilot chooses a model the seat allows. The list of models a
seat may use is not fetched into webchat yet; type a model id the seat offers
(for example as shown in Copilot's own model picker), or leave it on `auto`.

**Premium requests.** Copilot Business includes a monthly allowance of premium
requests; each agent turn on a premium model uses them, and an agent works in
several requests per task. `auto` is the economical default. Usage shows on
GitHub under the seat's billing, not in webchat.

**Disconnect** deletes both stored secrets from the gateway, forgets their
recorded ids and removes `data/copilot/account.json`. Agents set to GitHub
Copilot stay set to it and fail with "reconnect Copilot in Settings" until the
next connect.

## How the credential is handled

| Where | What it holds |
|---|---|
| Credential gateway | the GitHub token, twice: for `api.github.com` **path `/copilot_internal/user` only** (`Authorization: token …`), and for the licensed Copilot API host GitHub reports, e.g. `api.business.githubcopilot.com` (`Authorization: Bearer …`) |
| `.env` | `COPILOT_API_URL` — the licensed API host, not a secret |
| `data/copilot/account.json` | login, plan, endpoint, connect time — not a secret |
| Agent container | a fixed placeholder token; the gateway swaps in the real one at the network boundary |

The GitHub token also carries repository scopes, which is why the gateway only
attaches it to that one path on `api.github.com`.

Egress: an agent on the GitHub Copilot harness may always reach its
provider's hosts (`*.githubcopilot.com`) and `api.github.com`, whatever its
network setting, the same way a Claude agent always reaches Anthropic.

## What is verified

Verified without a seat:

- the device-code prompt of the pinned Copilot CLI (`To authenticate, visit
  https://github.com/login/device and enter code XXXX-XXXX`), run headless
  from the agent image, and that cancelling removes the login container and
  its temporary home;
- the whole connect flow against a fake CLI: code streaming, token read,
  verification failures (401, 403, no seat, chat disabled, network), gateway
  failure, cancel, expiry, temp-dir deletion, and that the token appears in no
  output or log;
- the runtime's first call with the placeholder is `GET
  /copilot_internal/user` on `api.github.com` (observed through a TLS proxy),
  which is the path the gateway connection is scoped to;
- the agent image builds with the pinned SDK and CLI, and the provider's
  Copilot client starts inside it.

Needs a real seat (the live test):

- that the plaintext token lands in the CLI config where the helper reads it
  (the extractor accepts the known layouts and refuses to guess between two);
- that the licensed Copilot API host accepts the GitHub token directly. If it
  requires a per-session token exchange instead, turns fail with "GitHub
  Copilot did not accept the credential"; the fix is local to the provider
  and the login helper;
- that the runtime needs no other `api.github.com` path with the token (a 401
  on another path would show in the gateway log);
- that an EMU account's sign-in, the Copilot CLI policy and the network
  policies behave as described above.

## Known risks

- **Organization-managed CLI settings.** An enterprise can push managed
  Copilot CLI settings, for example forcing sign-in to particular
  organizations. Not seen yet; if a managed setting refuses the session, it
  will name the setting in the turn's error.
- **TLS inspection.** The gateway re-signs TLS with its own CA, which the agent
  container trusts. A future Copilot runtime that pins certificates would fail
  every request; nothing indicates it does today.
- **All of `api.github.com` is reachable.** The egress filter allows hosts,
  not paths, so the seat check's host is open in full, even on Model only. The
  token rides only `/copilot_internal/user`; other requests go without it but
  can still carry data out.
- **Telemetry.** The runtime reports telemetry to GitHub hosts. On an agent
  with a restricted network, telemetry hosts outside `*.githubcopilot.com` are
  blocked; that does not stop a turn.
- **Image size.** About 500 MB is added to the agent image, only on installs
  that added GitHub Copilot: the SDK's bundled runtime (Bun installs both the
  glibc and the musl build, about 160 MB each) and the Copilot CLI used for
  sign-in (about 190 MB).
- **Deploys.** The provider files are added by the `/add-copilot` skill, not
  shipped in the composed tree; a deploy that syncs a fresh tree must re-apply
  the skill before building, like the other optional providers.
