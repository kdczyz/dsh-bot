---
name: room-completion
description: Evaluate Group Room task progress autonomously on multi-step tasks, keep teammates collaborating until verified and merged, and call room_finish_task to terminate the room once done.
whenToUse: Inside a Group Room on substantive multi-Bot engineering/ops tasks when tracking progress, consolidating deliverables, or deciding whether the group has completed the user goal.
---

# Group Room Autonomous Progress & Completion Skill

Follow this protocol on **multi-step collaborative tasks** (for simple Q&A or self-introductions, answer concisely and let the room settle naturally without creating heavy checklists):

## 1. Track Progress on Multi-Step Tasks (`room_task_progress`)
- On complex multi-Bot tasks, call `room_task_progress({ action: "update", goal, items: [{ id, title, owner, done, note }] })` to maintain a shared checklist of every deliverable required by the user.
- Call `room_task_progress({ action: "get" })` before closing to confirm zero open items remain.

## 2. Keep Teammates Moving — Never Prematurely `@user`
- While teammates still have genuine cross-checks, table merges, or unresolved subtasks, **address only the needed specialist with `@TeammateName`** and **do NOT write `@user` in the same message**.
- Only write `@user` alone (with zero teammate mentions) if the entire team is genuinely blocked on an irreversible decision or missing credential that cannot be resolved internally.
- If the user asked to "inspect / analyze / compile a plan for my review", delivering the **single merged, deduplicated final plan** IS completing the task — do NOT pause halfway after each Bot posts its separate draft.

## 3. Formal Completion Gate (`room_finish_task`)
Check these 4 conditions before closing a multi-step task:
1. Every requirement in the user's request has been fulfilled and cross-checked across teammates.
2. Overlapping or fragmented teammate outputs have been merged into one clear, final summary/deliverable.
3. All active `room_task_progress` checklist items and `claim_subtask` items are marked done/completed.
4. No teammate is still actively executing a blocking step.

Once all 4 conditions hold:
- Post the crisp consolidated final summary (if not already posted), and **immediately call `room_finish_task({ summary, deliverables, verification })`**.
- Calling `room_finish_task` is the **ONLY** way to formally terminate the Group Room in `completed` state; never rely on writing "task completed" in plain text.
- If you are not the Lead Bot in a Lead-assigned room, mark your subtask done and `@LeadName` to run final acceptance and invoke `room_finish_task`.
