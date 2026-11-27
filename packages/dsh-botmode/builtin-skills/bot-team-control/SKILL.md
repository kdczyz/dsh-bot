---
name: bot-team-control
description: Manage Bot roster CRUD (create/update/delete/inspect Bots), orchestrate multi-Bot Group Rooms (create/update/send/control/delete rooms), and communicate asynchronously with teammates via message_agent.
whenToUse: When coordinating with other Bots, delegating tasks in 1:1 chats, scaling the Bot team (adding/updating/removing Bots), or creating and driving a multi-Bot Group Room.
---

# Bot Team Communication, Roster CRUD & Multi-Bot Group Orchestration

## 1. Inspect Before Mutating (Mandatory First Step)
Always inspect the current roster and rooms first so you never create duplicate Bots or duplicate Group Rooms:
- `bot_team({ action: "roster" })` — view all Bots, their roles, running/queued state, and whether they are in a room.
- `bot_team({ action: "me" })` — confirm your own id, name, role, session kind (`primary` vs `room`), and active room.
- `bot_team({ action: "rooms" })` or `room_manage({ action: "list" })` — inspect existing Group Rooms and members.

---

## 2. 1:1 Teammate Communication (`message_agent`)
*(Available ONLY in 1:1 primary chats — NEVER call `message_agent` inside a Group Room.)*

1. **Task-Fit First**: Handle tasks inside your own domain directly. Delegate only when another Bot's role/tools are clearly better suited.
2. **Self-Contained Payloads**: The target Bot cannot see your chat history. Include exact file paths, goal, constraints, and expected output format in `message`.
3. **Async Delivery & Reply Discipline**:
   - Fire-and-forget notification: `message_agent({ target: "<name or id>", message: "..." })`
   - Need an answer back: `message_agent({ target: "<name or id>", message: "...", expectReply: true })`
   - One request per handoff; respect the chain hop guard (`MAX_AGENT_HOPS`) and never ping-pong back to a teammate who just messaged you.
   - Never claim a teammate did work unless their reply actually appeared in your chat.

---

## 3. Controlling Bot Roster & Capacity (`bot_manage`)
Use `bot_manage` to scale and govern the Bot team responsibly:
- **List / Inspect**:
  - `bot_manage({ action: "list" })`
  - `bot_manage({ action: "get", botId: "<id or name>" })`
- **Create a New Specialist Bot**:
  - Only create a new Bot when the user explicitly requests it or when a distinct long-lived specialty does not exist on the roster.
  - Provide crisp `name`, `role`, and focused `instructions` (avoid bloated prompts; rely on built-in skills).
  - Example:
    ```json
    {
      "action": "create",
      "name": "QA测试官",
      "role": "接口与前端自动化回归测试",
      "instructions": "负责编写并执行可复现测试，输出明确通过/失败证据与缺陷定位。",
      "approvalPolicy": "ask"
    }
    ```
- **Update an Existing Bot**:
  - `bot_manage({ action: "update", botId: "<id or name>", role: "...", instructions: "...", approvalPolicy: "ask|always|never", model: { provider, model, reasoningEffort } })`
- **Delete a Bot** (High-Risk Guardrail):
  - Confirm the target Bot has no active running tasks and is explicitly approved for removal.
  - Self-deletion is blocked by the host (`cannot delete the calling Bot`).
  - `bot_manage({ action: "delete", botId: "<id or name>" })`

---

## 4. Multi-Bot Group Room Creation & Control (`room_manage`)
When a task genuinely requires multi-specialist collaboration (e.g. Ops + Dev + QA working in one shared workspace):
1. **Create a Group Room**:
   - Choose 2–6 complementary Bots (`memberIds` accepts Bot ids or exact Bot names).
   - Set `workDir` if all members should operate on the same project directory.
   - Pick `mode`:
     - `"auto"` (recommended): smart initial routing + opt-in `@mention` handoffs.
     - `"lead"`: `leadBotId` triages, delegates, verifies, and closes the task.
     - `"everyone"`: all members respond on round 0 (use sparingly to avoid noise).
   - Example:
     ```json
     {
       "action": "create",
       "name": "发布联调专项组",
       "purpose": "完成版本构建、回归测试与上线检查",
       "memberIds": ["服务器管理员", "QA测试官"],
       "mode": "lead",
       "leadBotId": "服务器管理员",
       "workDir": "/path/to/project"
     }
     ```
2. **Kick Off & Drive a Group Room**:
   - Send a task message into the room: `room_manage({ action: "send", roomId: "<id>", text: "请按分工检查..." })`
   - Pause / resume / stop an active room: `room_manage({ action: "control", roomId: "<id>", controlAction: "pause" | "resume" | "stop" })`
   - Update members/settings: `room_manage({ action: "update", roomId: "<id>", ... })`
   - Delete finished/obsolete room: `room_manage({ action: "delete", roomId: "<id>" })`
3. **Inside a Group Room**:
   - Follow `team-collaboration` (Task-Fit + strict bare `@Name` opt-in wake-up hygiene + `(pass)`) and `room-completion` (`claim_subtask`, `room_task_progress`, `room_finish_task`).
   - Record durable team topology changes (e.g. newly formed specialist squad or recurring room id) via `memory_save` when useful for future orchestration.
