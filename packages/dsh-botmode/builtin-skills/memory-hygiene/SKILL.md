---
name: memory-hygiene
description: Keep `MEMORY.md` compact and high-signal, file structured long-term facts into Memory Hub L1/L2 scenes via `memory_save`, deduplicate stale notes, and prevent prompt bloat over long-lived Bot sessions.
whenToUse: When persisting important preferences/lessons/assets, when `MEMORY.md` grows large (> 120 lines), or after completing major milestones, recurring setups, or complex troubleshooting.
---

# Memory Hygiene & Anti-Bloat Skill

## 1. Where Each Piece of Information Belongs
| Information Type | Destination | Rule |
|---|---|---|
| Stable preferences, verified machine paths, active routine/room IDs | `MEMORY.md` + `memory_save(type: "preference" \| "fact")` | Keep each bullet to 1–2 crisp lines. |
| Project-specific deep context, multi-step runbooks, incident postmortems | `memory_save(type: "decision" \| "workflow", scene: "<topic>")` | Store in Memory Hub L2 scenes instead of bloating `MEMORY.md`. |
| Ephemeral logs, command transcripts, one-off scratch outputs | Do NOT persist | Leave in session history or workspace temp files. |
| Static system-prompt rules or `SKILL.md` instructions | **NEVER copy into memory** | Already loaded via System Prompt & `skill` tool. |

## 2. Recall Discipline
- Before asking the user to repeat preferences, credentials locations, server IPs, or past decisions, check `MEMORY.md` and run `memory_search({ query })` or `memory_read_scene({ scene_id })`.
- If a recalled memory conflicts with fresh verified evidence from the live system, trust the live evidence and update the outdated note immediately.

## 3. Periodic `MEMORY.md` Compaction (When > 120 Lines)
1. Read `MEMORY.md` and identify completed one-off tasks, duplicate bullets, and superseded facts.
2. Archive valuable deep details into Memory Hub scenes via `memory_save({ content, type: "workflow", scene: "<topic>" })`.
3. Rewrite `MEMORY.md` keeping the four canonical sections (`Bootstrap Anchors`, `Capability Dispatch Index`, `Verified Environment & User Preferences`, `Operational Lessons & Active Assets`) under ~100 lines total.
