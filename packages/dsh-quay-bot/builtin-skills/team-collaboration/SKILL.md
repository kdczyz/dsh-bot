---
name: team-collaboration
description: Hermes-style Group Room collaboration protocol: evaluate task-fit first, use @mentions strictly for intentional handoffs/joint analysis when a task does not fit your role, and prevent runaway ping-pong loops.
whenToUse: Every time you receive a message or task inside a Group Room before deciding whether to execute, hand off via @mention, or reply (pass).
---

# Group Room Task-Fit & `@mention` Collaboration Skill

Follow this 3-step decision flow on every Group Room turn:

## Step 1: Task-Fit Self-Assessment (先评估是否适合自己做)
Check the user's request against your role, permissions, and workspace:
1. **Core fit (我最合适)**: Execute directly with concise evidence and deliver the answer. Do not wake teammates unnecessarily.
2. **Cross-domain fit (需要联合分析)**: Complete your own domain's facts/checks first, then explicitly write `@SpecialistName` in prose with the exact question or handoff they need to analyze.
3. **Out of domain (不适合我做)**:
   - If the user did **not** address you directly: reply with exactly `(pass)` so the right specialist answers cleanly.
   - If the user **explicitly `@mentioned` you**: explain in 1–2 sentences why it falls outside your domain and immediately `@SpecialistName` to bring the right Bot into the discussion.

## Step 2: Scope Guard (严控问题边界，避免小题大做)
- If the user asks a simple question, greeting, status recap, or self-introduction (e.g. "介绍一下自己", "你们聊了什么"): answer **only** what was asked.
- Do **NOT** launch unrequested multi-round audits or create a heavy `room_task_progress` checklist for simple Q&A.

## Step 3: Strict Hermes Opt-In `@mention` Hygiene (防互相 `@` 死循环)
- In Hermes Bot Mode, Round 1+ is strictly **opt-in**: only Bots explicitly `@mentioned` in prose are woken for the next turn.
- Never put bare `@TeammateName` inside self-introductions, role-division tables, or "waiting for human approval" summaries unless you actually want that Bot to run another turn right now. Use plain names or `` `@TeammateName` `` for passive references.
- Never call `message_agent` inside a Group Room; coordinate directly in the room.
- Before modifying shared files concurrently, call `claim_subtask({ taskId, title, paths })` to lease paths and mark `status: "completed"` once finished.
- Once your part is answered and no teammate action is required, end without `@mentions` (or reply `(pass)` on subsequent follow-ups) so the room converges naturally.
