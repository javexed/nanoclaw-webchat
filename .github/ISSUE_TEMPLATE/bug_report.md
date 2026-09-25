---
name: Bug report
about: Something behaves differently than documented
labels: bug
---

**What you ran**
<!-- The command, the UI action, or the message sent. -->

**What happened / what you expected**

**Install**
- Fresh `install.sh` or upgraded from an earlier version?
- Harness: claude (built-in) / opencode / pi / codex
- Model: cloud or local (which)?

**Logs**
<!-- Host: `journalctl --user -u nanoclaw` (--local installs),
     `journalctl -u nanoclaw` (root/system installs), or
     `journalctl --user -u 'nanoclaw-v2-*'` (deploy/install.sh).
     Agent: `docker logs <container>`.
     Redact tokens — an install's .env holds WEBCHAT_TOKEN. -->
