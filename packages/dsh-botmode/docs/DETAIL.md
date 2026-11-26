# Bot mode (v0.6.0)

Bot mode adds a dedicated multi-Bot workspace in DeepSeek Harness alongside Harness mode. Each Bot owns an isolated directory (`bot.json`, `SOUL.md`, `MEMORY.md`, `.dsh/skills/team/SKILL.md`), a permanent primary chat Session, per-room hidden Group Sessions, optional pinned model & thinking level, and scoped access to a shared pluggable Team Memory Hub.

## Group Rooms (Hermes Base + Task-Driven Concurrent Actor Bus)

- **Shared Room Log + Per-Member Hidden Sessions + Optional Shared `workDir`**: Room messages carry monotonic `seq` numbers via CAS-capable `appendAtomic`, persist to `state.json`, and append to `$DSH_HOME/botmode/rooms/<roomId>.jsonl`. Each Bot runs group turns in its own hidden room session (`room.memberSessions[botId]`), using either a shared project folder (`room.workDir`) or its isolated Bot folder.
- **Event-Driven Concurrent `BotActor` Bus + Snapshot Watermark Anti-Miss**:
  - Idle `BotActor`s wake up concurrently on Room Log updates without slow-Bot head-of-line blocking; zero-token routing silently advances watermarks when messages exclusively `@mention` other teammates.
  - Watermarks advance strictly to the pre-turn `snapshotSeq` while recording `selfSentSeqs`, guaranteeing concurrent teammate replies and human Soft Steer interjections are never missed.
  - **Multi-Track Ephemeral UI**: Parallel active Bots render live reasoning, tool calls, and streaming text in isolated per-Bot tracks at the bottom of the room, solidifying into the upper Committed Log in deterministic `seq` arrival order upon completion.
- **3 Explicit Business Terminal States (No Hard Round Cutoff by Default)**:
  - `completed`: entered ONLY when an authorized Bot calls `room_finish_task({ summary, deliverables })` (never by plain-text regex).
  - `settled`: all active Bots converge via `(pass)` / `[NO_REPLY]` with zero running turns and zero pending approvals/questions.
  - `waiting_user`: local branch suspension on `approval/request` or `ask_user_question` (without blocking parallel teammates), or explicit `@user`/`@你` escalation; auto-resumes upon human reply/approval.
- **3 Pathological Soft-Pause Probes (`stalled` / `paused_error`)**:
  - `idle_spin`: 5 consecutive pure-text causal rounds with zero tool calls, zero file edits, and zero subtask claims soft-pause the room (`stalled`).
  - `paused_error`: 3 consecutive identical error fingerprints pause ONLY that Bot locally and broadcast a rescue alert to teammates.
  - `token_budget`: soft checkpoint at `tokenLimit` (default 1M tokens, `0` = off) preserving all sessions and watermarks; clicking **Continue** extends the checkpoint seamlessly.
- **Shared Task Board & File Write Soft-Locks**:
  - `claim_subtask({ taskId, title, paths, status })` coordinates subtask ownership and leases file/directory paths; DSH tool pre-execution/guard hooks block concurrent `write` / `edit` / `apply_patch` / `str_replace_editor` mutations on paths locked by a teammate.
- **Soft Steer vs Hard Stop**:
  - Sending a new human message mid-run increments `epoch`, immediately wakes idle Bots, fences stale pre-steer `@mentions`, and lets busy Bots finish their active tool step before automatically absorbing the new instruction via snapshot watermark; `/stop` or clicking **Stop** aborts all in-flight room sessions immediately.

## Team Memory Hub (Pluggable Hermes-style Memory Providers)

- **Single Active Provider, Per-Bot Isolation**: All Bots share one globally active memory provider plugin, scoped per Bot via `(team_id, agent_id = bot.id, user_id, session_id)`.
- **Built-in Providers**:
  - `memory_tencentdb` (default): Connects to the TencentDB Agent Memory v3 HTTP Gateway (`127.0.0.1:8420`) with parallel L1/L2/L3 `prefetch`, non-blocking L0 `syncTurn`, circuit breaker, and automatic local Node 22 SQLite FTS5 fallback when the Gateway is offline.
  - `local_sqlite`: Zero-dependency local SQLite FTS5 (trigram tokenizer for Chinese + English) memory store.
  - `builtin`: Lightweight file-only mode using each Bot's `MEMORY.md`.
- **Download & Swap Plugins**: Install external memory plugins into `$DSH_HOME/botmode/memory-plugins/<id>/` from curated catalog templates (`Mem0`, `Generic HTTP`), `npm:<pkg>`, Git URLs, `.tgz` archives or local plugin directories containing `plugin.json` + ESM `index.js`, and hot-switch at any time from the **Memory Hub** page or `/botmode memory`.
