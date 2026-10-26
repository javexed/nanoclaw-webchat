---
name: add-copilot
description: Use GitHub Copilot as a NanoClaw agent provider through the GitHub Copilot SDK. Signs in with a device code from a headless Linux host or from webchat Settings; the token stays in the credential gateway and containers send only a non-secret placeholder. Per group via `ncl groups config update --provider copilot`.
---

# GitHub Copilot agent provider

Install GitHub Copilot as an optional NanoClaw runtime, driven by a Copilot
seat (Business or Enterprise, including Enterprise Managed Users signing in
through Microsoft Entra ID). The payload is included in this skill; it needs no
provider registry branch. Like the other fork-owned provider skills it
declares no `nanoclaw-provider` metadata, so the setup wizard does not offer
it before install; webchat's Settings installs it, and the image policy is the
default for a non-Claude provider (a local image build).

**Credit.** This skill is built on the upstream `/add-copilot` proposal by
@barnuri (nanocoai/nanoclaw#3976): the gateway credential design, the
container provider and its tests are theirs. This fork adds a Linux device-code
login that runs from a headless host and from webchat, in place of the macOS
keychain helper. It is fork-owned only until upstream merges that proposal; at
that point this copy is dropped in favour of upstream's and the Linux login
offered there.

## How the credential stays out of the container

The container constructs `CopilotClient` with a non-secret placeholder token,
`useLoggedInUser: false`, and `GH_TOKEN`, `GITHUB_TOKEN` and
`COPILOT_GITHUB_TOKEN` stripped from the SDK environment. The credential
gateway swaps the real token in at the network boundary, on two connections
saved with `provider: 'copilot'` (so a gateway that grants per agent gives them
to the groups running this provider):

| Host | Path | Header |
|---|---|---|
| `api.github.com` | `/copilot_internal/user` only | `Authorization: token {value}` |
| the licensed Copilot API host GitHub returns (`api.business.githubcopilot.com`, `api.enterprise.githubcopilot.com`, …) | all | `Authorization: Bearer {value}` |

The GitHub token also carries the account's repo scopes, which is why it is
limited to that one path on `api.github.com`. The selected gateway must support
path-scoped connections (OneCLI does).

## Install

Copy the payload to the matching project-root paths. They are skill-owned
files; overwrite them together when refreshing the skill.

```nc:copy
payload/container/agent-runner/src/providers/copilot.ts -> container/agent-runner/src/providers/copilot.ts
payload/container/agent-runner/src/providers/copilot-mcp.ts -> container/agent-runner/src/providers/copilot-mcp.ts
payload/container/agent-runner/src/providers/copilot.test.ts -> container/agent-runner/src/providers/copilot.test.ts
payload/container/agent-runner/src/providers/copilot-registration.test.ts -> container/agent-runner/src/providers/copilot-registration.test.ts
payload/container/agent-runner/src/providers/copilot.conformance.test.ts -> container/agent-runner/src/providers/copilot.conformance.test.ts
payload/container/agent-runner/src/provider-contracts/copilot.ts -> container/agent-runner/src/provider-contracts/copilot.ts
payload/src/providers/copilot.ts -> src/providers/copilot.ts
payload/src/providers/copilot-registration.test.ts -> src/providers/copilot-registration.test.ts
payload/src/provider-contracts/copilot.ts -> src/provider-contracts/copilot.ts
payload/scripts/copilot-login.ts -> scripts/copilot-login.ts
payload/scripts/copilot-login.test.ts -> scripts/copilot-login.test.ts
payload/setup/providers/copilot.ts -> setup/providers/copilot.ts
payload/setup/providers/copilot.test.ts -> setup/providers/copilot.test.ts
```

Append the self-registration import to each provider, setup, and contract
barrel. Keep all existing imports.

```nc:append to:src/providers/index.ts
import './copilot.js';
```

```nc:append to:src/provider-contracts/index.ts
import './copilot.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './copilot.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts
import './copilot.js';
```

```nc:append to:setup/providers/index.ts
import './copilot.js';
```

Install the pinned Copilot SDK in the runner's Bun package and add the pinned
Copilot CLI to the image manifest. Both pins are at least three days old when
chosen and move together: the SDK names the CLI release its bundled runtime
was built from (`copilotCliVersion` in its `package.json`). Do not add
`minimumReleaseAgeExclude` or `onlyBuiltDependencies` entries.

```nc:dep manager:bun cwd:container/agent-runner
@github/copilot-sdk@1.0.24
```

```nc:json-merge into:container/cli-tools.json key:name
{"name":"@github/copilot","version":"1.0.101"}
```

The SDK runs its own bundled runtime (its platform package; Bun installs both
the glibc and the musl build, about 160 MB each); the CLI (about 190 MB) is in
the image for the device-code sign-in. About 500 MB in all, only in the image
of an install that applied this skill.

Run the host build, runtime typecheck, provider contract verifier, and the
Copilot tests.

```nc:run effect:build
pnpm run build
```

```nc:run effect:build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

```nc:run effect:test
pnpm exec tsx scripts/provider-contract-verifier.ts --required-declared copilot
```

```nc:run effect:test
pnpm exec vitest run src/providers/copilot-registration.test.ts scripts/copilot-login.test.ts setup/providers/copilot.test.ts
```

```nc:run effect:test
cd container/agent-runner && bun test --isolate src/providers/copilot*.test.ts
```

Build the local image so the Copilot CLI and SDK are available to new provider
containers.

```nc:run effect:build
./container/build.sh build
```

## Authenticate

On the host (works over SSH; no browser needed on the host):

```nc:run effect:external
pnpm exec tsx scripts/copilot-login.ts
```

It prints a URL and a code. Open the URL on any device, enter the code, and
sign in with your work account (for an Entra-managed enterprise this goes
through your organization's Microsoft login). The helper then:

1. runs `copilot login --device-code` in a throwaway container from the agent
   image, with `COPILOT_HOME` on a fresh 0700 temp dir and the keyring
   disabled, so the token is written only there;
2. reads the token from that dir once, asks GitHub
   (`/copilot_internal/user`) which Copilot API endpoint and plan the account
   is licensed for, and refuses an account without a seat or with chat disabled;
3. saves both gateway connections, writes `COPILOT_API_URL` to `.env` and a
   non-secret `data/copilot/account.json` (login, plan, endpoint);
4. destroys the temp dir — on success, failure, cancel (Ctrl-C) and expiry.

The token is never printed, logged, passed in argv or env, or written anywhere
else. `--json` prints one JSON event per line instead of prose (webchat drives
the same helper this way). Re-run it to reconnect; it replaces both stored
values in place.

In webchat, an owner or admin can do the same from **Admin → Run setup
wizard… → GitHub Copilot → Connect GitHub Copilot…**, which shows the code and
link, and offers **Disconnect** afterwards.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider copilot
ncl groups restart --id <group-id>
```

In webchat, pick **GitHub Copilot** as the agent's harness.

Switching is an operator action; installing this skill does not change the
instance default provider. The agent's model (`--model`, or the webchat model
field) selects the Copilot model; `COPILOT_MODEL` in `.env` is the install-wide
fallback; otherwise the provider requests `auto`, so Copilot picks a model the
seat allows. Each request to a premium model counts against the seat's
premium-request allowance.

Memory, standing instructions, skills, MCP servers, mounts, and workspace files
come from NanoClaw's provider-neutral surfaces. Continuation state is
provider-specific, so a group starts a Copilot session when it first wakes on
this provider.

## Deploys and refreshes

Like every optional provider, the files this skill writes are not part of the
composed tree, so a deploy that syncs a fresh tree over the install removes
them. Re-apply this skill after such a deploy (before building), as for the
other provider skills; it is idempotent. Gateway credentials and
`data/copilot/` are user data and survive.

To remove the provider, follow [REMOVE.md](REMOVE.md).

## Troubleshooting

- **`The selected gateway cannot limit a credential to one path`**: select a
  gateway whose credential store supports path-scoped connections (OneCLI does).
- **`GitHub refused Copilot for this account (403)`**: the account has no
  Copilot seat, the enterprise has the Copilot CLI policy disabled, or a
  Conditional Access location policy / GitHub IP allow list blocks this
  network. These are enterprise settings; see the webchat docs page
  "GitHub Copilot" for what to ask IT for.
- **The sign-in page says the app is not allowed**: the enterprise restricts
  OAuth apps; the Copilot CLI app must be allowed.
- **A turn fails with "GitHub Copilot did not accept the credential"**: the
  token was revoked or the seat removed. Reconnect (helper or Settings), then
  restart the affected group.
- **401 from `api.github.com` inside the container**: the Copilot runtime
  called a path other than `/copilot_internal/user`. Add that exact path as
  another connection in `scripts/copilot-login.ts`, then reconnect.
- **`Unknown provider: copilot`**: restart the NanoClaw host after installing so
  the provider barrels are loaded from the rebuilt host.
- **Organization-managed settings and TLS**: an enterprise can push managed
  CLI settings (for example forcing sign-in to particular organizations). The
  credential gateway terminates TLS with its own CA, which the container
  trusts; a managed policy that pins certificates would block it. Neither has
  been seen yet; report it if it happens.
