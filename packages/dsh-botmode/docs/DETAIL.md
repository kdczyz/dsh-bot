# Bot mode (v0.5.0)

Bot mode adds a dedicated multi-Bot workspace in DeepSeek Harness alongside Harness mode. Each Bot owns an isolated directory (`bot.json`, `SOUL.md`, `MEMORY.md`, `.dsh/skills/team/SKILL.md`), a permanent primary chat Session, per-room hidden Group Sessions, optional pinned model & thinking level, and scoped access to a shared pluggable Team Memory Hub.

## Group Rooms (Hermes-style deterministic state machine)

- **Shared Room Log + Per-Member Hidden Sessions**: Room messages carry monotonic `seq` numbers, persist to `state.json` and append to `$DSH_HOME/botmode/rooms/<roomId>.jsonl`. Each Bot runs group turns in its own hidden room session (`room.memberSessions[botId]`), completely isolated from its private chat.
- **Deterministic Routing + Serial Round-Robin**:
  - `auto` (default): explicit `@Member` schedules only those members; `@all`/`@everyone` or no mention enters all members in round-robin order (`round % len`); later rounds dynamically follow new directive `@mentions` or rotate for consensus until silent convergence.
  - `everyone`: serial round-robin across all members each round until a full silent round (`settled`) or budget cap (`capped`).
  - `lead`: starts with the lead Bot when unmentioned and relays strictly by `@mention`.
- **Directive Mention Parsing**: Strips fenced code blocks, inline code, blockquotes and quoted examples (`「...」`, `“...”`, `"..."`) before matching `@Name` or `@user`/`@你`, sorting longer names first so `@服务器管理员` never misfires `管理员`.
- **Per-Member Watermark / Delta Feed**: Captures `deliveredThrough = room.nextSeq` *before* submitting each turn so interjections during generation are never missed.
- **Silence Protocol & Natural Convergence**: Normalizes `(pass)`, `（pass）`, `[NO_REPLY]`, `[SILENT]` etc., hides them from chat bubbles, logs them in the room activity bar, and transitions immediately to `settled` once a full round passes silently.
- **Hard Caps, Stop & Epoch Supersession**: Configurable `maxRounds` / `maxMessages` per room mark `capped` (never disguised as `idle`/`settled`). `Stop` cancels the in-flight room Session turn immediately. Sending a new user message mid-run increments `epoch`, cancels the older epoch's remaining turns, and cleanly restarts on the latest user intent once the in-flight turn releases its session.

## Team Memory Hub (Pluggable Hermes-style Memory Providers)

- **Single Active Provider, Per-Bot Isolation**: All Bots share one globally active memory provider plugin, scoped per Bot via `(team_id, agent_id = bot.id, user_id, session_id)`.
- **Built-in Providers**:
  - `memory_tencentdb` (default): Connects to the TencentDB Agent Memory v3 HTTP Gateway (`127.0.0.1:8420`) with parallel L1/L2/L3 `prefetch`, non-blocking L0 `syncTurn`, circuit breaker, and automatic local Node 22 SQLite FTS5 fallback when the Gateway is offline.
  - `local_sqlite`: Zero-dependency local SQLite FTS5 (trigram tokenizer for Chinese + English) memory store.
  - `builtin`: Lightweight file-only mode using each Bot's `MEMORY.md`.
- **Download & Swap Plugins**: Install external memory plugins into `$DSH_HOME/botmode/memory-plugins/<id>/` from curated catalog templates (`Mem0`, `Generic HTTP`), `npm:<pkg>`, Git URLs, `.tgz` archives or local plugin directories containing `plugin.json` + ESM `index.js`, and hot-switch at any time from the **Memory Hub** page or `/botmode memory`.
