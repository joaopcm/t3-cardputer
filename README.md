# t3-cardputer

a small relay between an M5Stack Cardputer ADV and T3 Code, so I can answer approvals, read replies and send voice prompts from a keyboard on my desk.

the relay is a Node/TS service on my homelab. it talks to T3 Code over MCP, shapes everything into screen-sized pages, and does speech to text locally with whisper.cpp.

design: docs/superpowers/specs/2026-10-20-t3-cardputer-design.md

```
cd relay
pnpm install
pnpm test
```

MIT licensed.
