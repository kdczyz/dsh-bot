---
name: scheduled-routines
description: Create, inspect, update, pause, resume, manually trigger, inspect run history, and remove persistent Host-level scheduled tasks (Routines) via the built-in `scheduled_tasks` tool backed by `host/scheduler/`.
whenToUse: Whenever the user asks to schedule recurring checks, daily reports, periodic monitoring, delayed one-shot reminders, or to inspect/fix/pause/delete existing automated routines.
---

# Automated Scheduled Tasks Skill (`scheduled_tasks`)

Bot Mode includes a persistent Host-level scheduler (`host/scheduler/`) that survives cold sessions and runs your tasks automatically even when no UI tab is open. Always use the `scheduled_tasks` tool — never hack system `crontab` unless the user explicitly asks for OS-level cron.

---

## 1. Check Current Tasks & Quotas First
Before creating a new schedule, call `scheduled_tasks({ action: "list" })` to inspect:
- Existing tasks (avoid duplicates!)
- Active quota limits returned in `limits` (`activeTasks / maxActiveTasks`, `runsToday / maxRunsPerDay`, `minIntervalMinutes`).

---

## 2. Supported Schedule Formats (`schedule` + optional `tz`)
Pass a friendly shorthand or standard 5-field cron expression plus optional IANA timezone (`tz`, e.g. `"Asia/Shanghai"`):
- **Interval (`every`)**: `"every 30m"`, `"every 2 hours"`, `"every 1d"` (must respect `minIntervalMinutes`).
- **Calendar shorthands**:
  - `"daily 09:00"`
  - `"weekdays 09:00"`
  - `"weekly mon 10:00"`
  - `"monthly 1 08:30"`
- **One-shot (`at`)**: `"at 2026-12-01 09:00"` or `"at 2026-12-01T09:00:00+08:00"`
- **Raw 5-field cron**: `"0 9 * * 1-5"`, `"*/30 * * * *"`

---

## 3. Writing High-Quality Unattended Routine Prompts
Every scheduled task runs unattended. Make `prompt` strictly self-contained and safe:
1. **Self-Contained**: State exact target URLs, file paths, commands, thresholds, and expected output format (the isolated run cannot see your current chat context).
2. **Idempotent**: Safe to retry on transient failures without double-sending destructive mutations.
3. **Noise Control (`[SILENT]`)**: For monitoring/watchdog jobs, explicitly instruct:
   *"If all checks pass and nothing requires user attention, reply with exactly `[SILENT]` so no notification noise is delivered."*
4. **Security Guardrails**:
   - The scheduler rejects prompts containing prompt-injection overrides, secret exfiltration, `curl|sh`, sensitive key reads (`.ssh`, `.env`), or `rm -rf /`.
   - Never attempt to create/modify schedules from inside a running routine (blocked by recursion guard).

---

## 4. CRUD & Operations Reference (`scheduled_tasks`)
- **Create**:
  ```json
  {
    "action": "create",
    "name": "每日磁盘与服务巡检",
    "schedule": "daily 09:00",
    "tz": "Asia/Shanghai",
    "prompt": "调用 system_info 检查根分区磁盘与内存占用。如磁盘 >85% 或内存 >90% 则输出结构化告警摘要；若一切正常仅回复 [SILENT]。",
    "policy": {
      "session": "fresh",
      "overlap": "skip",
      "deliver": { "kind": "primary" }
    }
  }
  ```
  - `policy.session`: `"fresh"` (default for Bot-created tasks, isolated clean run) | `"primary"` (runs in Bot's permanent chat) | `"named"` (reuses one dedicated routine session).
  - `policy.deliver`: `{ "kind": "primary" }` (post result into Bot chat) | `{ "kind": "room", "roomId": "<roomId>" }` (deliver into a Group Room) | `{ "kind": "inbox" }` | `{ "kind": "silent" }`.
- **Inspect / History**:
  - `scheduled_tasks({ action: "get", id: "<routineId>" })`
  - `scheduled_tasks({ action: "history", id: "<routineId>", limit: 10 })`
- **Update / Pause / Resume / Delete**:
  - `scheduled_tasks({ action: "update", id: "<routineId>", schedule: "...", prompt: "..." })` *(Note: human-created tasks are read-only unless `botEditUserTasks` is enabled; inform the user if `readOnly: true`.)*
  - `scheduled_tasks({ action: "pause", id: "<routineId>" })`
  - `scheduled_tasks({ action: "resume", id: "<routineId>" })`
  - `scheduled_tasks({ action: "remove", id: "<routineId>" })`
- **Verify Immediately**:
  - After creating or fixing a critical schedule, optionally offer or run `scheduled_tasks({ action: "run", id: "<routineId>" })` to smoke-test it immediately and confirm the first run succeeds.

---

## 5. Troubleshooting Auto-Paused or Failing Tasks
1. Call `scheduled_tasks({ action: "get", id })` and `history` to inspect `consecutiveFailures`, `pausedReason`, and `lastError`.
2. Fix the root cause (e.g. broken path, missing tool permission, bad threshold), update the prompt if editable, then `resume` and test with `run`.
3. Persist any newly created critical routine ID + purpose into long-term memory (`memory_save`) so you remember what automated jobs you own.
