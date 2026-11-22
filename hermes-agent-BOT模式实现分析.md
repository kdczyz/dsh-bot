# Hermes Agent 的「多机器人办公 / Bot Mode」实现分析

> 代码基线：`NousResearch/hermes-agent`，HEAD `2de9f51`（2026-11-20 clone）。
> 分析入口：`tools/bot_mode_*`、`gateway/session_bot*`、`gateway/hosted_room*`、`tools/delegate_tool*`、`apps/desktop/src/plugins/hermes-bots/`。

---

## 0. 先厘清一件事：没有「Office」这个核心模块

- 用户看到的「办公模式」= Desktop 应用侧栏里的 **Bots** 标签（Bot Mode），默认开启，是**内置桌面插件**。
- 社区插件 `hermes-office`（`plugin-catalog/hermes-office.yaml`）只是把 Bot Mode 的 roster **渲染成一个办公室视图**，不参与调度。
- 真正被复用的唯一原语只有一个：**Bot = 一个 Hermes profile**（独立 home 目录）。
  - `website/docs/user-guide/bot-mode.md:12` 明确写："A Bot **is** a Hermes profile … No core patches, no background daemons, no extra storage."
  - 所以 CLI 里 `hermes -p <bot> chat` 打开的是同一个 agent；Bot 的 routines 就是 `hermes cron list` 里的任务。

这个选择决定了后面所有实现：**没有新的 agent 类型、没有 per-bot 后端进程、没有第二套存储**。Bot Mode 是「profile + 会话命名约定 + 消息投递协议 + 房间编排」四层皮。

---

## 1. 协作形态：一共四种，不是一种

| 形态 | 发起方 | 对端是谁 | 生命周期 | 核心代码 |
|---|---|---|---|---|
| **DM（`message_agent`）** | Bot 自己 | 另一个 Bot（同机 / 另一连接 / peer 网关） | 对端一条持久会话；fire-and-forget，回复异步唤醒 | `tools/bot_mode_dm.py`、`gateway/session_bot.py` |
| **群聊房（hosted room）** | 用户发一条房消息 | 2–6 个 Bot 成员 | 网关持久驱动，Desktop 关了也继续 | `gateway/hosted_room_discussion.py`、`tui_gateway/hosted_room_driver.py` |
| **子代理（`delegate_task`）** | Bot 的当前 turn | 一次性 child agent（不是 Bot） | 只在父 turn 内/后台存活，结束即回收 | `tools/delegate_tool.py` |
| **例行任务（routines）** | cron | 该 Bot 自己的 Bot Chat | 定时 | `[bot:<name>]` 命名空间 |

前两种是「同事关系」，第三种是「下属关系」。用户说的「相互讨论」= DM + 群聊房，「相互委托」= DM 派活 + `delegate_task` 拆活，「子整体」= 每个 Bot 自己就是一个完整 agent（有独立 model / 记忆 / 技能 / cron / 会话），而不是一个大 agent 的 persona。

---

## 2. Bot 的定义与自定义（"手动自定义 BOT" 到底写在哪）

### 2.1 磁盘布局

一个 Bot 就是一个 profile 目录，identity 文件是 `config.yaml` / `.env` / `SOUL.md` / `profile.yaml` / `auth.json` / `state.db` 之一（`hermes_cli/profiles.py:260`、`website/docs/user-guide/profiles.md:11`）：

```
~/.hermes/                      # default profile（本身就是 Bot，handle = @hermes）
~/.hermes/profiles/<bot>/
  config.yaml     # model / provider / toolsets / skills 开关 / mcp_servers / tts …
  .env            # API keys
  auth.json       # 该 Bot 自己的 OAuth 登录（可选）
  SOUL.md         # 人格与常驻指令
  profile.yaml    # display_name + ui_meta['hermes-bots']（title/description/avatar/section/hidden/groups）
  memories/       # MEMORY.md / USER.md
  skills/         # 该 Bot 的技能
  sessions/ state.db  cron/  logs/ …
```

新建 profile 会自动建 `memories sessions skills skins logs plans workspace cron home` 等目录（`hermes_cli/profiles.py:40`）。

### 2.2 创建链路（Desktop「New Agent」）

1. `profiles.create` → `provision_profile(ProfileCreateRequest)`（`hermes_cli/web_routers/profiles.py:766`）。参数覆盖了 UI 上所有「Advanced」项：`clone_from` / `clone_all` / `no_skills` / `description` / `soul` / `model`+`provider` / `mcp_servers` / `keep_skills` / `mirror_credentials` / `share_auth`。
2. `profiles.configure` 做「编辑器保存」，**分段独立应用**：`ui_meta`（带 `ui_meta_expected_revisions` 做 CAS）、`soul`（写 SOUL.md）、`description`、`model`+`provider`、`disabled_skills`、`enabled_toolsets`、`enabled_mcp_servers`（`tui_gateway/methods_profiles.py:387`）。
3. 桌面插件写 `ui_meta['hermes-bots']`（title/avatar/…），用 revision CAS 合并，避免多端互相覆盖（`apps/desktop/src/plugins/hermes-bots/data.ts:380-410`）。
4. `createCanonicalChat(name, {kickoff:true})` 建那个**唯一的、永久存在的 Bot Chat 会话**，首条消息让 Bot 自我介绍。

### 2.3 关键设计：Bot Chat 用**标题**做身份，不用存 id

`apps/desktop/src/plugins/hermes-bots/canonical-chat.ts:1-20` 开头就是一段"别再改"的契约：

- 每个 Bot 只有一条 forever-chat，身份 = `(profile, title == "Bot Chat")`，依赖核心的 `UNIQUE(title)` 索引；
- 以前用 `ui_meta['hermes-bots'].chat` 存 session id 的指针方案被**移除**了 —— 注释直说"every lost-chat incident traced to a dangled or stolen pointer"；
- 归档 Bot Chat = 退役它，下次点 Bot 会新建一条成为新的 canonical；`/new` 在 Bot Chat 里被改成 `/compact`，避免分叉。

后端侧的两个 gate 都读这个标题：`BOT_CHAT_TITLE = "Bot Chat"`（`tools/bot_mode_probe.py:37`）。

### 2.4 "这个安装是 Bot Mode 管的" 怎么判定

`is_bot_mode_managed()`：扫所有 profile 的 `profile.yaml`，**任意一个**带 `ui_meta: {hermes-bots: {...}}` 就算（`tools/bot_mode_probe.py:124-143`）。这是"装过 Desktop、建过 Bot"的标记。所以纯 headless（gateway + Telegram）默认拿不到 `message_agent`，文档给了手写 `ui_meta` + 手建 `Bot Chat` 的绕法（bot-mode.md:217-230）。

### 2.5 永恒会话的 prompt 怎么不腐烂

Bot Chat 可能活几个月，配置却会变。解法是 **capability epoch**：把 skills、toolsets、MCP、SOUL、roster、peers、model capability 一起 hash 成 12 位指纹，嵌进 prompt；`conversation_loop` 只在存储的 epoch 与磁盘不一致时重建一次（`tools/bot_mode_probe.py:348-500`）。这是"永久会话 + 可变能力"的一个可复用技巧。

---

## 3. 通道一：Bot 间 DM（`message_agent`）

### 3.1 工具是"注入"的，不是注册的

- schema 不在 registry、不在任何 toolset 里，只在 turn 开始时对一个 agent 追加（`tools/bot_mode_dm.py:144`，调用点 `agent/turn_context.py:1337`）。
- 门禁两条同时成立才注入：① 会话标题**恰好** `Bot Chat`；② 安装是 Bot-Mode-managed（`message_agent_authorized`，`bot_mode_dm.py:127`）。
- dispatch 时再查一次门禁，伪造调用返回结构化错误。门禁是 session-stable 的，所以工具列表跨 turn 字节一致（prompt cache 友好）。
- 系统提示里的协议段只给 canonical Bot Chat（`agent/system_prompt.py:361`），普通会话、群房成员会话、CLI 会话都看不到。

### 3.2 Bot 怎么知道"同事是谁、能干什么"

协议段由 `_build_section` 拼（`tools/bot_mode_probe.py:288-334`），内容大意：

- 这个安装跑 Bot Mode，每个 profile 是一个 teammate，各自只有一条 canonical Bot Chat；
- `message_agent` 是 fire-and-forget：**它不返回回复**；发完就结束 turn，回复会以"后台进程完成通知"把你唤醒；
- 让你**自己组织语言**，不许把用户原话转发、不许泄露 1:1 私聊内容；
- 收到 `Message from 🤖 X (@x):` 开头的消息 = 同事在跟你说话，**把本轮最终答复当作回信**，不要再调 `message_agent` 回去；
- 没话说就回 `[SILENT]` / `NO_REPLY`；
- 最后附 **roster**：`- @handle — title — description`，每个 handle 的 role 来自 profile 的 title/description（`_profile_role`，`bot_mode_probe.py:156`）。所以"谁适合干这个活"是写在 profile 元数据里的，不是靠模型猜。

远程机器和 peer 网关会额外追加段落（`_remote_paragraph` / `_peer_paragraph`）。

### 3.3 目标解析优先级（防止串台）

`_dispatch` 的顺序（`tools/bot_mode_dm.py:310-391`）：

1. `peer/<agent>` 或已注册 peer 名 → 走 `hermes peer dm`（stdin 传文件，永不走 shell 插值）；
2. 含 `@` 且是 `handle@connection` → 走 Desktop relay；
3. **local profile folder id 精确匹配** → 本地投递；
4. friendly name / Desktop @slug（`Scribe`、`Dr. Foo` → `dr-foo`/`drfoo`）→ 本地；
5. 本地解析不到 → 再试 relay（同名 Bot 在另一台机器的场景）；
6. 都不行 → 报 roster 错误。

关键细节：
- **folder id 优先于 friendly name**，所以别的 Bot 改标题也抢不走 `@researcher`；
- 两个 Bot 共用一个 friendly name → 直接报歧义 + 返回 roster，不猜（`_resolve_local_name`）；
- 本地名与 peer 名冲突 → 拒绝，并同时给出两边的可达写法（`bot_mode_dm.py:329-341`）；
- 一次最多 8 个目标（`FAN_OUT_MAX`），一个合并 runner 收全部回复；单条消息上限 16000 字符。

### 3.4 链式护栏：两个 Bot 不能无限客套

这是 Bot Mode 里最值得抄的一段（`agent/bot_chain.py` + `gateway/bot_loop_guard.py`）：

- **人说话 = 新链**。人一条消息之后，每次 `message_agent` 算一跳，`gateway.bot_loop_guard.max_hops`（默认 4）封顶，超了直接拒发（`admit_send`，`bot_chain.py:139-178`）；
- **同一条消息重复发给同一个人**在同一链里被拒（sha256 归一化后比对）；
- **回复即终局**：给"刚给你发消息的那个 Bot"的回信自动降级成 notify-only（加 `[no reply needed]` 标记 + `wake="none"`），对方再回就拒（除非 `bot_replies_expect_reply: true`）；
- 跳数写在投递信封的 author 字段里（`hops`），**只有 runtime 能写**，模型改不了、压缩也擦不掉；
- 消息平台侧还有一套滑动窗口（20 条 / 5 分钟 → 冷却 10 分钟，`bot_loop_guard.py:28-35`），用于 Telegram 这类"两个 Hermes 互相回"的场景；
- `enabled: false` 全关。

### 3.5 投递：为什么不是简单的"调一下对方"

本地投递只有一条路：**把消息 admit 进目标 profile 的网关 authority**（`_start_delivery` → `_admit_live_dm` → `deliver_to_live_owner`，`bot_mode_dm.py:566-660,786+`；`tools/bot_live_delivery.py:1-8` 写死"No authority means refusal"）。所以：

- Desktop 用 `hermes gateway ensure` 保证每个 profile 有网关在服务；没有 authority 就直接报 `runtime_unavailable`，**不会**偷偷起一个 CLI turn（模块 docstring 里那行 `hermes -p … chat -c "Bot Chat" -Q` 是历史/peer 路径的残留描述，代码里本地分支并不执行它）；
- 真正的 turn 在网关里跑；发送方的后台进程只负责**等**（`_wait_live_dm`，最多 30 分钟、每 300 秒一个窗口），退出时 stdout 就是完成通知的内容；
- 对方繁忙就排队（`queued/claimed`），不打断当前 turn；对方在等自己的审批/澄清时，ack 会带 `target_state: waiting_approval / waiting_clarify`，让发送方能对人解释"它在等它自己的用户"；

幂等与不确定性处理：
- 每条投递有 `delivery_id`（由 dm 文件路径派生），admission 前先写 **intent pin**；同一 id 的重试只回放、不重发；
- 状态四态里 `ambiguous` 是显式存在的：跨进程窗口里"可能已 admit"的记录就是 unknown，**告诉模型"不要重发"**，而不是假装失败；
- 失败带**类型化 reason**（`provider_auth_or_access`、`provider_quota_limit`、`rate_limit`、`context_overflow`、`runtime_offline`、`target_busy`、`delivery_timeout`…），发送方 agent 可以按码分支而不是读散文（bot-mode.md:254）。

### 3.6 回复怎么变成"回复"

- 对端的**本轮最终答复**就是回信（transport 抓 last assistant message）；模型不需要也不允许"再发一条 DM 当回复"。
- 对端如果只回了 silence token → 发送方收到空回复；
- 对端写在了工具调用旁边/试图用 `message_agent` 回给自己 → `forgotten_reply` 兜底，把"本轮最后可见的话"标记 `[no final reply; their last message this turn:]` 转发一次（`gateway/session_bot_outcome.py:27-52`）；
- 等待方是后台进程，结束时打印一句 **outcome**：`@beta answered.` / `@gamma never answered: <why>` + 能不能重发（`tools/bot_mode_dm_outcome.py:15`）。多目标 fan-out 只唤醒一次，每个同事一句。

---

## 4. 通道二：群聊房（多 Bot 讨论的核心）

### 4.1 权威在网关，不在桌面

群聊房的定位很明确：**gateway 拥有 log 和调度，Desktop 只是客户端**（`apps/desktop/docs/canonical-groups.md`）。所以关掉 Desktop 讨论还能继续；重开时按 log 追平。RPC 面在 `tui_gateway/methods_groups.py:21-28`：

```
groups.capabilities / list / create / state / send / log / rename / context
groups.stop / continue / retry / approve / discard / disband
groups.replicate / replica_state / promote / demote
groups.peer.invite / register / revoke
groups.attachment.upload / download
```

旧版有 Desktop 驱动的 "classic group chat"，现在**只读不新建**，新建一律是 gateway-owned。

### 4.2 数据模型：一条 append-only 事件日志

`gateway/hosted_rooms.py` 只管房间身份 + 事件日志（delivery、lease、turn 都在别处，避免出现第二个传输队列）。事件种类（`hosted_rooms.py:60-69`）：

- 用户/成员消息：`message.user`、`message.member`
- turn 生命周期：`turn.started`、`turn.settled`、`turn.failed`、`turn.cancelled`、`turn.deferred`、`turn.reassigned`
- 房间事件：`room.created`、`room.activity`（settled/bounded）、`room.assignment`（lead 指派）、`room.routed`（自动路由结果）、`room.continued`、`room.stop_requested`、`room.context_set`、`room.renamed`、`room.members_changed`、`room.disbanded`
- 权威：`authority.claimed` / `authority.lost`
- `member.unavailable`

每条事件有单调 `seq`，房间有 `authority_gateway_id` + `authority_epoch`。

### 4.3 编排是一个**纯函数**：`plan_next_task`

这是整个群聊最漂亮的设计（`gateway/hosted_room_discussion.py`，模块 docstring：`Pure (no I/O, transport or model knowledge)`）：

- 输入：房间定义 + 完整事件日志（+ 可选 watermarks / room context）；
- 输出：**最多一个**下一个成员任务（`DiscussionDecision`），或 `idle` / `settled` / `bounded`；
- 因为纯函数，重启后重放日志能得到**同一个** task_id，不会重复执行 —— 再把已完成/已终结的 driver 行对账掉即可。

预算常量（`hosted_room_discussion.py:30-36`）：`MIN=2 / MAX=6` 成员、`MAX_ROUNDS=3`、`MAX_MESSAGES=10`、每轮 delta 最多 24 行、文本 64KB。

### 4.4 一轮讨论怎么选人

```
round 0:  @mention 命中谁 → 谁；@all/@everyone 或没人被点名 → 全员
          （scheduled post 例外：只叫被 @ 的；notice 不叫任何人）
          routing=lead → 先跑 lead 的路由 turn，产出 room.assignment
          routing=auto → 一次便宜的、无工具的模型调用，产出 room.routed（在建任何 task 之前落盘）
round 1+: 只叫"被别的 Bot 明确 @ 且之后还没发过言"的成员
```

要点：
- 后续轮是**opt-in** 的：A Bot 想拉人，就在回复里 `@name`，那个队友才进下一轮；
- 每个成员有**自己的 watermark**，只收到"上次发言之后"的增量，所以被点名晚的人也能拿到完整 delta 而不浪费 turn；
- 如果某一轮**没有任何成员发言** → `settled("silent_round")`，房间自然安静下来；
- 到 `MAX_MESSAGES` 或 `MAX_ROUNDS` → `bounded`，房间显示 "Paused after N messages"，用户 Continue 一次就**再给一整份预算**（`room.continued`，`hosted_room_router.py:62`；`plan_next_task` 里 `max_rounds * (continues+1)`）。

### 4.5 成员这一轮看到什么（prompt 拼装）

`_build_prompt`（`hosted_room_discussion.py:606`）生成的是**用户角色**的一段文本，不是 system prompt：

```
[Discussion: "<房间名>"] You are @handle, one participant with @b, @c and the user.
Room purpose (set by the user): …
Room notes (shared with every member …): …
New messages in this thread since your last turn (oldest first):
  <最多 24 行 delta，超了按字节截断并标注 [Earlier content omitted …]>
- The user directly addressed you. / The room lead @a gave the user's message to you. /
  The room picked you to answer … / The scheduled job "…" addressed you.
Reply with your answer, result, or concrete blocker.       ← 被点名时
  ……或者……
Reply with one conversational message only when you have something new worth adding.
If you have nothing new to add, reply with exactly "(pass)".   ← 没被点名时
Rules:
- Mention a teammate by handle to pull them into the next round; do not repeat points already made.
- Never reveal content from private conversations. Your reply is published verbatim.
```

- 沉默用 **`(pass)`** 字面表达，`is_pass_text()` 正则也接受空串（`hosted_room_discussion.py:341`）——比让模型输出 JSON 稳；
- 成员的**常驻上下文**是它自己的一条隐藏 room session（`Group: <room_id>`，`tui_gateway/hosted_room_driver.py:1245`；`gateway/session_hosted_rpc.py:65`），跟 DM 的 Bot Chat 完全隔离；
- 房间的 purpose / notes 由用户在房间设置里维护，**只进 user turn，不进 system prompt**（避免污染人格）。

### 4.6 执行：durable driver + 租约 + 逐成员串行

`tui_gateway/hosted_room_driver.py` 的 `HostedRoomRuntime`：

- 后台线程 `_worker_loop` 轮询（空闲 5s / 有活 0.25s），最多 **4 个房间**并发；
- 每个房间抢 **driver lease**（TTL 30s，`LeaseKeeper` 按 TTL/3 续），fencing 用 `execution_generation` / `cancel_generation`，防止"以为自己还是 owner"；
- 执行一个成员 turn：拿 `turn_lock(profile)`（**同一个 Bot 的 turn 串行**）→ `_resolve_or_create` 隐藏 room session → `transport.submit(prompt, task=identity, …)` → `_wait_for_terminal`（turn 超时 **1830s**）→ `settle_task`；
- 提交失败要区分"没 admit"（可 requeue，带退避 1s→30s）与"admit 后失联"（记 ambiguous，等 lease 过期后走恢复检查），**不猜**；
- 结束时把 `turn.settled` + `message.member` 写回房间日志，并触发"这个房间再排一次"。

Stop / Retry / Discard 的语义都是 typed 的：
- `Stop` 只在该网关**确认 run 结束**后才记 cancelled，否则记 deferred（不谎报）；
- `Retry` 用同一 idempotency key 问对端"那次到底跑了吗"，**绝不新起一次**；
- `Discard` 走"非 admit 的关闭"或"停掉已知 run"，副作用不回收所以要先确认。

### 4.7 跨网关成员（room link）

房间可以坐别的网关上的 Bot（`home` + `lender`）：

- home 负责日志、调度、授权；lender 只执行自己机器上的 turn；
- 授权链：lender 侧 `groups.peer.invite` 发**有作用域的 grant**（TTL 60s–24h，续期视野最长 30 天）→ home 侧 `groups.peer.register` 绑 grant + catalog + endpoint；`peer.revoke` 撤销；
- 每个远端 turn 带 **execution policy**：`{version, target_profile, enabled_toolsets, approval_mode, max_iterations, policy_digest}`（`gateway/hosted_room_execution_policy.py:26`）—— 也就是说"远端 Bot 在你这房间里能用什么工具、要不要审批、最多几轮"是**房东签发的**，不是房客自己说了算；
- 幂等键 `room:<task>:<generation>`，回复丢了就"不确定"，不重跑；
- 权威迁移是**运维恢复流程**：`groups.promote`（要求 `confirm:true` 且先 fence 旧 writer）+ `groups.demote`（要求拿到新 epoch 的证据），并明确写了"提升不等于自动合并历史，分叉了要保留两份"（bot-mode.md:456-518）。这套"epoch + fence + 不自动 merge"是很成熟的分布式口吻。

### 4.8 人在房间里的位置

- `@user` 是升级通道：Bot 拿不准就把问题抛给人，房间行出现 **needs you** 徽标；
- 命令审批卡片直接出现在房间里（`once/session/always/deny`），点了就发；
- `stop/halt/pause` 只有**紧挨着** @mention 时才当指令（`stop @bot`），正文里的同名词不算 —— 文档明确说是为了避开德语 `halt` 这种误伤（这条是 Desktop 侧文本解析，`bot-mode.md:114-132` 有描述，网关代码里没有对应解析器，按文档行为理解）；
- 成员在自己 Bot Chat 里跟用户的对话、cron 投递，也会被"补写"进房间一次（按 session 监视），所以房间不会漏掉成员在别处说的话（同上，文档行为，未逐行核对实现）。

---

## 5. 通道三：子代理（`delegate_task`）——用户说的"子整体"

`tools/delegate_tool.py:1-16` 的架构说明就是全部：

> Spawns child AIAgent instances with a fresh conversation, their own task_id …, the parent's toolsets minus child-blocked tools, and a focused system prompt. The parent only ever sees the delegation call and the summary result.

要点：

- **不是 Bot**：没有 profile、没有持久身份、没有自己的 cron；是父 agent 进程内/后台的一次性 child；
- schema（`tools/delegate_tool.py:853`）：`tasks[]`，每项 `goal` / `context` / `output_schema` / `images` / `group`；`minItems:1`，并发上限 `delegation.max_concurrent_children`（默认 **10**，`delegate_tool_config.py:19`）；
- 递归默认禁止：child 的 toolset 把 `delegate_task` 拉黑（`delegate_tool_toolsets.py:16`），深度默认 `MAX_DEPTH = 1`（父 0 → 子 1，`delegate_tool_config.py:23`）；
- **顶层委派永远后台跑**，模型不能选（`_model_background_value`）；orchestrator 子代理（depth>0）才同步等自己的 worker；
- `group` 决定交付桶：同组任务全部完成才合并成一条消息回来；
- `output_schema` 会校验子代理最终答案，失败给一次有界纠正重试，但原文仍作为 summary 返回（不丢内容）；
- 活体控制：`action: spawn | list | steer | stop | continue` —— 可以中途"打方向盘"（steer 把纠偏文本塞进子代理的下一个 tool result）、提前停止（仍返回部分结果）、或让已完成的子代理**继续它自己的会话**；
- 每个子代理有自己的 `task_id`（terminal session、file-ops cache），结果带 `subagent_id` / attribution，父只看到摘要。

**和 DM 的结构差异**（这点最容易混）：

| | `message_agent`（同事） | `delegate_task`（下属） |
|---|---|---|
| 对端实体 | 一个持久 Bot（profile） | 一次性 child agent |
| 会话 | 对端自己的 Bot Chat（永久） | 每次新建、结束即弃（continue 可续自己的） |
| 谁拥有对话 | 对端，可继续、可被用户打开 | 父 turn / 父的派发记录 |
| 返回 | 异步完成通知，一轮一句 | 同一次调用或后台汇总 |
| 能否再找它 | 能（有 roster / 名字） | 只能靠 `subagent_id`，且通常已结束 |
| 权限 | 对端自己的全部能力 | 父的 toolset 减去黑名单 |

---

## 6. 通道四：Routines

- Bot 的定时任务就是普通 cron job，命名 `[bot:<name>] <routine>`（`apps/desktop/src/plugins/hermes-bots/cron-jobs-view.test.ts:4`），新版网关额外带 `profile` 参数。
- 跑出来的 session 落在该 Bot 的历史里 → "结果就在你会跟它说话的地方"。
- 属于"自治"，不是"协作"，但它让 Bot 在没有用户输入时也会动，是"办公室"感的重要来源。

---

## 7. 多机 / 多网关（同一套机制的三种传输）

1. **Desktop relay**：Desktop 同时持有多个连接的 socket，作为 courier 转发 DM 信封；网关之间从不互见对方凭据。超过 ~26 分钟没回复才允许"再投一次"。
2. **`hermes peer`**：网关到网关直连（对端跑 `api_server` 平台 + `API_SERVER_KEY`），`peer dm` / `peer run` / `peer status` / `peer stop`，用 `--idempotency-key` 防重。
3. **room link**：第 4.7 节，房间跨机器。

共同点：**身份永远是 `bot:<profile>` 或 `bot:<connection>/<profile>`**，所有去重、跳数、路由都按这个 id 算。

---

## 8. 这套设计里最值得抄的 10 个决定

1. **不发明新原语**：Bot = 隔离 home。UI 只是 projection，CLI 完全等价。
2. **身份用唯一约束，不用指针**：`UNIQUE(title)` + `"Bot Chat"` 取代 stored id（`canonical-chat.ts` 的注释是血泪）。
3. **工具按会话注入，不注册进全局**：`message_agent` 只活在 canonical Bot Chat，schema 字节稳定 → 缓存友好、外泄面小。
4. **"回复 = 本轮最终答复"**：不为回信再发明一个 RPC，transport 抓最后一条 assistant 消息；配 silence token 与 forgotten-reply 兜底。
5. **跳数在运行时，不在 prompt**：hops 写进信封，模型改不动；重复问、回信再回都拒。
6. **不确定就是不确定**：`ambiguous` / `settle` / typed reason / "do not resend"，而不是把超时当失败。
7. **房间是纯函数 + 事件日志**：重启可重放、task_id 可复算、串行执行点只有一个。
8. **预算 + pass + silent round**：3 轮 / 10 条 / `(pass)` 让"多 agent 讨论"不会变成刷屏。
9. **权威有 epoch，迁移要 fence**：promote 需要人确认旧 writer 已停，且明确不自动 merge 分叉历史。
10. **远端执行策略由房东签发**：toolsets / approval / max_iterations 进 policy digest，不信任远端自报。

---

## 9. 如果要在别的系统里复刻（最小骨架）

```
1) 原语:  agent = {home_dir, config, soul, skills, memory, model}   # 一个目录一个 agent
2) 命名:  每个 agent 一条 canonical session，用唯一 title 定位
3) 目录:  从 profile 元数据生成 roster（name + role），拼进 system prompt
4) 通道A: message_agent(target, message, constraints, expecting, expects_reply)
           -> 解析目标 -> 链式护栏 -> 落盘信封 -> 后台投递 -> 完成通知带回 outcome
5) 通道B: room = {members, purpose, routing}; log = append-only events
           planner(log) -> 至多一个 task；执行器串行跑；pass/silent/rounds/messages 预算
6) 通道C: delegate_task(tasks[]) -> 一次性 child，父 toolset 减黑名单，默认后台
7) 预算:  hops<=4, fanout<=8, msg<=16k, room 3 轮/10 条, child<=10
```

---

## 10. 关键文件索引

| 关注点 | 文件 |
|---|---|
| Bot = profile / ui_meta / 创建 | `hermes_cli/profiles.py`、`hermes_cli/web_routers/profiles.py:766`、`tui_gateway/methods_profiles.py:387` |
| canonical Bot Chat（前端契约） | `apps/desktop/src/plugins/hermes-bots/canonical-chat.ts` |
| roster / 协议段 / managed 判定 | `tools/bot_mode_probe.py:86-334`、`:139`、`:348` |
| DM 工具与投递 | `tools/bot_mode_dm.py:70,127,253,310,786`、`tools/bot_mode_dm_chain.py` |
| 链式护栏 | `agent/bot_chain.py:139`、`gateway/bot_loop_guard.py:28,160` |
| 投递 receipt 状态机 | `gateway/session_bot.py:850,890,954`、`session_bot_mailbox.py`、`session_bot_state.py` |
| 回复/结果措辞 | `gateway/session_bot_outcome.py`、`tools/bot_mode_dm_outcome.py` |
| 房间事件与权威 | `gateway/hosted_rooms.py:60`、`hosted_room_driver.py`、`hosted_room_authority_history.py` |
| 房间编排（纯函数） | `gateway/hosted_room_discussion.py:30,341,606,823` |
| 路由（lead / auto） | `gateway/hosted_room_lead.py`、`gateway/hosted_room_router.py` |
| 房间执行器 | `tui_gateway/hosted_room_driver.py:111,812`、`hosted_room_service.py` |
| 跨网关成员 | `gateway/hosted_room_peer.py`、`hosted_room_execution_policy.py`、`tui_gateway/methods_groups.py:281-440` |
| 子代理 | `tools/delegate_tool.py`、`delegate_tool_config.py:19-23`、`delegate_tool_toolsets.py:16` |
| 跨机传输 | `tools/bot_relay.py`、`hermes_cli/subcommands/peer.py` |
| 官方说明（人读版） | `website/docs/user-guide/bot-mode.md`、`apps/desktop/docs/canonical-groups.md` |