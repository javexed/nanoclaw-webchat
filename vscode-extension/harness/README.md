# Editor harness

The inline review, run inside a **real** VS Code against the built extension.
The engine (inline-review.ts) has unit tests; this proves what they cannot
reach: edits landing in real documents, CodeLenses appearing, commands
resolving hunks, blocks following the developer's typing, decisions written to
disk, and conflict blocks a merged Apply leaves.

## Run

    npm run harness:editor

`harness/editor-docker.sh` runs it in a container image that has the GTK and
NSS libraries VS Code needs (`NANOCLAW_HARNESS_IMAGE`, e.g. an install's agent
image), against an Xvfb display on the host. Without Xvfb on the host, run Xvfb
inside the container instead: an image derived from it with `xvfb` installed,
and `Xvfb :99 & DISPLAY=:99 node harness/editor-review.mjs` as the command.

Exit 0 iff every scenario passes. The scenarios are in `editor-suite.cjs`.
