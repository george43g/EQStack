---
name: imsg-mcp-dev
description: Instructions for AI agents working on the imsg-mcp repository.
---

# imsg-mcp Development Skill

**Canonical source:** [`skills/imsg-mcp/SKILL.md`](../../../apps/imsg-mcp/skills/imsg-mcp/SKILL.md)

All skill documentation has been unified. See that file and `AGENTS.md` for full details.

## Quick reminder for cloud/remote agents

There is no Git LFS in this repo. `pnpm install` generates the synthetic
fixtures itself (its `prepare` step runs `pnpm fixtures`).

```bash
pnpm install
pnpm build
pnpm test
```
