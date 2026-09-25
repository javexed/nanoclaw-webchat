# Releasing NanoClaw Webchat

Releases are cut on the public
[javexed/nanoclaw-webchat](https://github.com/javexed/nanoclaw-webchat) repo from
`main`. A release is a tag on `main`; installers compose from that tree with the
root `install.sh`.

```bash
gh release create v<VERSION> \
  --repo javexed/nanoclaw-webchat \
  --target main \
  --title "v<VERSION>" \
  --generate-notes
```

Check it resolves:

```bash
gh api repos/javexed/nanoclaw-webchat/releases/latest --jq .tag_name   # → v<VERSION>
```

If the Proxmox community-scripts entry pins its catalog logo to a tag, bump the
pin in its `json/nanoclaw.json` in the same change.
