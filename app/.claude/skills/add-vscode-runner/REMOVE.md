# Remove the VS Code runner

First, on the Runners tab, clear every placement, so no agent group is left
pointing at a machine: a placed group cannot start once the `fleet` driver is
gone.

Then, from the install directory:

```bash
# The files this skill copied in (read from its own copy list).
sed -n 's/^payload\/[^ ]* -> //p' .claude/skills/add-vscode-runner/SKILL.md | xargs rm -f
# The two lines it appended, and the switch it set.
sed -i "/^import '.\/runner-register.js';$/d" src/channels/webchat/extensions-installed.ts
sed -i "/^import '.\/fleet-driver.js';$/d" src/drivers/installed.ts
sed -i '/^WEBCHAT_RUNNER_ENABLED=/d' .env
pnpm run build
```

Restart the service. The Runners tab and the VS Code steps disappear, and the
runner endpoint and its API are gone.

Paired machines, placements and published extension packages stay in the
database and on disk; reinstalling the skill picks them up again. VS Code
extensions on developers' machines stop connecting until it is reinstalled.
