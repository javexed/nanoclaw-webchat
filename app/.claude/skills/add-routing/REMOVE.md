# Remove routing (shadow classifier)

Reverse of install. The base LiteLLM router keeps working throughout.

## 1. Unwire + restore the base container

```bash
# drop the callback line from the generated config
sed -i '/callbacks: router_hook.proxy_handler_instance/d' data/litellm/config.yaml
# re-running the base installer recreates the container WITHOUT the hook mounts
bash .claude/skills/add-litellm/resources/install-litellm.sh --hosts <your-hosts>
```

## 2. Remove the hook + routing state

```bash
rm -f data/litellm/router_hook.py
rm -rf data/litellm/routing        # includes routes.json AND the shadow log —
                                   # copy routing-shadow.jsonl out first if you
                                   # want to keep the collected decisions
```

## 3. (If installed) remove the nightly recalibration timer

```bash
systemctl --user disable --now nanoclaw-routing-recal.timer
rm -f ~/.config/systemd/user/nanoclaw-routing-recal.{service,timer}
systemctl --user daemon-reload
rm -f data/litellm/routing/recalibration-*.md data/litellm/routing/routing-shadow.archive.jsonl
```

## 4. (Optional) drop the classifier model from its Ollama host

```bash
curl -s -X DELETE http://<classifier-host>:11434/api/delete \
  -d '{"model":"hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M"}'
```

## 5. This skill's files

```bash
rm -rf .claude/skills/add-routing
```
