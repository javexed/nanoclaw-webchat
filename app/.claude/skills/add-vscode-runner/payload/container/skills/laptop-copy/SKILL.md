---
name: laptop-copy
description: >-
  What your copy of a developer's project (the mcp__laptop__ tools) holds and
  leaves out, and what to tell the developer when a file or folder they name
  is not in it: a gitignored folder, unsaved edits, a secret, a dependency
  folder, a copy too large to take. Use whenever you work through mcp__laptop__
  tools and a path is missing, the copy looks nearly empty, or the developer
  asks why you cannot see something.
---

# The laptop copy

You work on a copy of the developer's project, taken on their machine. When a
path they name is not in it, find out why and tell them the one thing that
fixes it. Never guess ("it must be a different repo") without evidence.

## What the copy holds

- Tracked files as they are now, saved edits included.
- Untracked files that are not gitignored.
- Gitignored files only when the developer lists them in
  `nanoclaw.agentCopy.includeIgnored` (`*` there copies all of them).

Left out:

- Dependency and cache folders, unless tracked: `node_modules`, `vendor`,
  `.venv`, `venv`, `__pycache__`, `.cache`, `.gradle`, `.terraform`.
- `.git` folders and links.
- Anything named like a secret (`nanoclaw.agentCopy.exclude`) or found holding
  one by the secret scan, and untracked dumps and credential files.
- Unsaved editor changes.

A copy over 150,000 files or 3 GB (outside dependency folders) is refused.

## When it updates

- Taken again each time you start, in the background: your first tool call
  may wait while it is taken.
- Between starts it follows saved edits within seconds, but only while you
  have no unapplied changes. Your proposal holds it back until the developer
  applies or rejects it.
- A listed gitignored folder updates only at your next start, unless it is a
  git repository of its own, which is followed like the project.

## Find the cause

1. `mcp__laptop__Glob` the path, then `*` at the root. A root holding only a
   few files (a compose file, a Dockerfile) means most of the project is
   gitignored.
2. Read `.gitignore`. Is the path, or a folder above it, listed?
3. A config file that mounts or imports `./X` (compose volumes, build paths)
   shows that `X` lives in the project folder even though you cannot see it.

## What to tell the developer

Name the cause in one line, then the fix.

- **Gitignored folder**: "`X` is gitignored, so it isn't in my copy. To add
  it: in VS Code Settings (User), find `nanoclaw.agentCopy.includeIgnored`,
  Add Item `X`. Then run NanoClaw: Stop all agents and send your message again."
- **Not saved**: save the file. It reaches the copy within seconds.
- **Held back by your proposal**: apply or reject your proposed changes first.
- **Secret**: left out on purpose. If it holds no secret, they can list it in
  `nanoclaw.agentCopy.allowSecretsIn`. Never ask them to paste it.
- **Dependency folder**: left out on purpose. Read the manifest or lockfile
  instead.
- **Too large**: list big folders the agent does not need in
  `nanoclaw.agentCopy.exclude`.
- **Refused** (Restricted Mode, folder not allowed): the tool's error says
  why. Pass that on: trust the folder, or allow it when VS Code asks.
