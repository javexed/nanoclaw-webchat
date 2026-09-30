---
name: add-vscode-runner
description: Add the VS Code runner to webchat — the server side of the NanoClaw VS Code extension. Pairs developer machines and gives a room's agent, running here, the project open on the paired machine through file tools the extension serves; serves the extension package. Use when someone wants to chat with NanoClaw from VS Code, or have an agent work on the code in their editor.
---

# Add the VS Code runner

The VS Code extension (`vscode-extension/` in this repo) talks to webchat over
a runner endpoint. This skill installs that endpoint and everything behind it:
machine pairing and approval, the laptop tools (an agent placed on a machine
runs here and reads and changes the project open there, in a copy the
developer reviews), the `fleet` session driver kind, and the routes that serve
the extension package.

Without it, webchat has none of this: no runner WebSocket, no pairing, no
Runners tab, and no VS Code steps in the UI. The database tables it uses are
created by webchat either way and stay empty until it is installed.

## Install the runner modules

```nc:copy
payload/scripts/publish-runner-extension.ts -> scripts/publish-runner-extension.ts
payload/src/channels/webchat/runner-chat.test.ts -> src/channels/webchat/runner-chat.test.ts
payload/src/channels/webchat/runner-chat.ts -> src/channels/webchat/runner-chat.ts
payload/src/channels/webchat/runner-client-config.test.ts -> src/channels/webchat/runner-client-config.test.ts
payload/src/channels/webchat/runner-client-config.ts -> src/channels/webchat/runner-client-config.ts
payload/src/channels/webchat/runner-extension.test.ts -> src/channels/webchat/runner-extension.test.ts
payload/src/channels/webchat/runner-extension.ts -> src/channels/webchat/runner-extension.ts
payload/src/channels/webchat/runner-mine.test.ts -> src/channels/webchat/runner-mine.test.ts
payload/src/channels/webchat/runner-pairing.test.ts -> src/channels/webchat/runner-pairing.test.ts
payload/src/channels/webchat/runner-pairing.ts -> src/channels/webchat/runner-pairing.ts
payload/src/channels/webchat/runner-persona.ts -> src/channels/webchat/runner-persona.ts
payload/src/channels/webchat/runner-register.ts -> src/channels/webchat/runner-register.ts
payload/src/channels/webchat/runner-registry.test.ts -> src/channels/webchat/runner-registry.test.ts
payload/src/channels/webchat/runner-registry.ts -> src/channels/webchat/runner-registry.ts
payload/src/channels/webchat/runner-signature-routes.test.ts -> src/channels/webchat/runner-signature-routes.test.ts
payload/src/channels/webchat/runner-tools.test.ts -> src/channels/webchat/runner-tools.test.ts
payload/src/channels/webchat/runner-tools.ts -> src/channels/webchat/runner-tools.ts
payload/src/channels/webchat/runner-transport.test.ts -> src/channels/webchat/runner-transport.test.ts
payload/src/channels/webchat/runner-transport.ts -> src/channels/webchat/runner-transport.ts
payload/src/channels/webchat/runner-ws.test.ts -> src/channels/webchat/runner-ws.test.ts
payload/src/channels/webchat/runner-ws.ts -> src/channels/webchat/runner-ws.ts
payload/src/channels/webchat/server/routes-runners.ts -> src/channels/webchat/server/routes-runners.ts
payload/src/drivers/fleet-driver.test.ts -> src/drivers/fleet-driver.test.ts
payload/src/drivers/fleet-driver.ts -> src/drivers/fleet-driver.ts
payload/src/drivers/fleet-fixture.ts -> src/drivers/fleet-fixture.ts
```

## Register the extension and the session driver

The extension's routes, WebSocket endpoint, laptop tools and sign-in settings
section attach through webchat's extension points.

```nc:append to:src/channels/webchat/extensions-installed.ts
import './runner-register.js';
```

The `fleet` session driver kind: sessions run through the docker driver here;
for a group placed on a machine it makes sure the laptop tools' relay is up.

```nc:append to:src/drivers/installed.ts
import './fleet-driver.js';
```

## Turn the runner endpoint on

```nc:env-set
WEBCHAT_RUNNER_ENABLED=true
```

## Retire the laptop container's files

Earlier versions ran a placed agent in a container on the developer's machine.
Their files are not in the copy list any more, and an upgrade leaves them
behind, where they no longer compile. Remove them.

```nc:run effect:refresh
rm -f src/channels/webchat/runner-image.ts src/channels/webchat/runner-image.test.ts src/channels/webchat/runner-image-download.test.ts src/channels/webchat/runner-image-policy.test.ts src/channels/webchat/runner-relay.ts src/channels/webchat/runner-relay.test.ts src/channels/webchat/runner-mailbox-endpoint.ts src/channels/webchat/runner-mailbox-endpoint.test.ts src/channels/webchat/runner-sessions-store.ts src/channels/webchat/runner-sessions-store.test.ts src/drivers/remote-spec.ts src/drivers/remote-spec.test.ts src/drivers/fleet-events.test.ts src/drivers/fleet-remote.test.ts
```

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/channels/webchat/runner-chat.test.ts src/channels/webchat/runner-client-config.test.ts src/channels/webchat/runner-extension.test.ts src/channels/webchat/runner-mine.test.ts src/channels/webchat/runner-pairing.test.ts src/channels/webchat/runner-registry.test.ts src/channels/webchat/runner-signature-routes.test.ts src/channels/webchat/runner-tools.test.ts src/channels/webchat/runner-transport.test.ts src/channels/webchat/runner-ws.test.ts src/drivers/fleet-driver.test.ts
```

## After installing

Restart the service. The Runners tab appears under Manage for owners and global
admins; the extension is offered under Settings and in an empty chat once a
package has been published (`pnpm exec tsx scripts/publish-runner-extension.ts`,
or upload a `.vsix` on the Runners tab). A machine that connects is held for
approval there before an agent can use it.

To remove it, follow `REMOVE.md`.
