# DS-Bot 与 Hermes Agent：两套「多机器人协作」实现对照

> 对象
> - **DS-Bot** — `Fei2411/DS-Bot`，HEAD 浅克隆于 2026-11-22。JS/Node，**DSH（DeepSeek Harness）插件**，`ds-bot/src/host/` 是服务端，`app/` 是 Electron 桌面壳，`mobile/` + `link/` 是手机/网页远程。
> - **Hermes Agent** — `NousResearch/hermes-agent`，HEAD `2de9f51`。Python，自带 agent runtime + gateway，Bot Mode 是内置桌面插件。
>
> 本文只谈「Bot 之间怎么协作」，不评产品好坏。

---

## 0. 一句话对照

| | Hermes | DS-Bot |
|---|---|---|
| Bot 的本质 | **一个 Hermes profile**（独立 home / 凭据 / 模型 / 技能 / 记忆，可脱离桌面用 CLI 打开） | **团队名册里的一条记录**（`state.json` 的 bot：name/role/instructions/model/workDir/private），会话托管在 DSH |
| 协作底座 | 自己的 gateway authority + 投递 receipt + 房间事件日志 | DSH 的 session/turn/tool 机制 + 插件自己的 ledger（jsonl）与轮次状态机 |
| 权力结构 | 没有运行时超管，Bot 之间平权；操作者是桌面/CLI 用户 | 有 **Main Bot**（Chief）超管：建人、改组、停别人的 turn |
| 防环思路 | **硬预算**：跳数 4、轮次 3、消息 10 | **无进展检测**：6 次无工具的互相客套就暂停，只有用户能解 |
| 委托 | 两条都保留：DM 给同事 + `delegate_task` 给下属 | **只允许同事**：显式禁用 DSH 的子代理/Teammates，改用 handoff 树 |
| 上下文 | 永久 Bot Chat + capability epoch + `/compact` | 会话分段 parts + steward 小模型判断 compact/switch + handoff note |

两者都把「多 Bot」做成了**同一宿主内的一组持久身份**，但一个做成平台（可编排、可跨机），一个做成产品（可理解、可管控）。

---

## 1. Bot 是什么，存在哪

### Hermes：profile 即 Bot

- `~/.hermes/profiles/<bot>/`：`config.yaml`（model / toolsets / skills 开关 / mcp）、`.env`、`auth.json`、`SOUL.md`、`profile.yaml`（`ui_meta['hermes-bots']`：title/description/avatar/section/hidden/groups）、`memories/`、`skills/`、`sessions/`、`state.db`、`cron/`。
- 创建 = `profiles.create` → `provision_profile`（`clone_from` / `soul` / `model`+`provider` / `mcp_servers` / `keep_skills` / `mirror_credentials`）；改 = `profiles.configure`（分段应用，`ui_meta` 带 revision CAS）——`hermes_cli/web_routers/profiles.py:766`、`tui_gateway/methods_profiles.py:387`。
- 每个 Bot 有**唯一一条** canonical 会话，身份是标题 `"Bot Chat"`，靠核心 `UNIQUE(title)` 定位，不用存 session id 指针（`apps/desktop/src/plugins/hermes-bots/canonical-chat.ts:1-20`）。
- 「这安装是 Bot Mode 管的」= 任意一个 profile 的 `profile.yaml` 带 `ui_meta['hermes-bots']`（`tools/bot_mode_probe.py:139`）。

**结果**：Bot 是可搬迁的（换机器复制目录）、可被外部工具当普通 profile 用、能跨网关；代价是"一个 Bot 的配置面"很宽，用户得懂 profile 概念。

### DS-Bot：名册条目 + DSH 会话

- 团队状态集中在 `<DSH_HOME>/<bot home>/state.json`：`{mainBotIds, bots, rooms, works, requests, questions, views, prefs, revision}`，加一把 `state.lock` 防止第二个 DSH 宿主同时写（`ds-bot/src/host/store.js:1-40`）。
- 一个 Bot 的字段：`name / role（2–4 字标签）/ instructions / model / effort / workDir / avatar / section / private`，外加 `sessionId / segments / openParts / tasks`（`src/host/threads.js:1-12`）。
- **工作单元是 DSH Session**：自己的聊天一条、每个群一条、进后台任务一条；上下文满了换新的 "part"，旧的归档仍可读。所有 turn 都走 DSH 正常 agent loop。
- 第一个 Bot 由首次启动自动建：`Chief`，`main: true`（`src/host/roster.js:1030`）。

**结果**：用户不需要知道 profile，Bot 就是侧栏里一张卡；代价是团队绑在这台机器、这个插件上（有手机/网页/IM 入口，但团队本身不跨机）。

---

## 2. 权力模型：平权 vs 超管

| | Hermes | DS-Bot |
|---|---|---|
| 建 Bot | 桌面「New Agent」或 `hermes profile create`；**没有给 Bot 的一等公民工具**（模型只能 shell 出去） | `create_bot` 工具，**仅 Main Bot**（`tools.js:450-486`） |
| 改 Bot | `profiles.configure`（任意 UI/CLI 调用者） | `update_bot`：自己改自己；**改别人要 Main Bot**（`tools.js:488-535`） |
| 删 Bot | `profiles.delete`（桌面保护 default） | Main Bot 不能删，必须先摘掉 main 角色（`roster.js:947`） |
| 建群/改组 | 用户从桌面建，网关拥有房间 | `create_group` 仅 Main；`update_group` 允许 Main 或该群 admin（`tools.js:632,662`） |
| 停别人的 turn | 桌面 Stop / 网关 cancel | `stop_bot` 仅 Main，且必须给理由；被停的 Bot 会在新 turn 里被告知（`tools.js:415-448`） |

Hermes 把「谁能操作」放在**宿主之外**（桌面进程/CLI 的权限）；DS-Bot 把权限**写进模型可见的工具描述**里，由工具自己拒绝。前者更灵活，后者对模型更可解释（它会知道自己为什么被拒）。

---

## 3. 点对点协作

### Hermes `message_agent`

- **注入制**：不进 registry，只在「标题 = Bot Chat」+「安装是 managed」时把 schema 追加到工具表（`tools/bot_mode_dm.py:127-171`）；dispatch 再验一次。
- **目标解析优先级**：`peer/<agent>` → `handle@connection` → folder id → friendly name/@slug → relay → 报错；folder id 优先，歧义不猜（`bot_mode_dm.py:310-391`）。
- **fire-and-forget**：发送方立刻拿到 `status: queued + delivery_id`，回复以**完成通知**异步唤醒；最多 8 个目标 fan-out。
- **防环**：人说话开新链，每个 `message_agent` 一跳，`max_hops` 默认 4；同文重复拒；给"刚给你发消息的人"的回信自动降级 notify-only（`agent/bot_chain.py:139-178`）。
- **投递**：admit 进目标 profile 的网关 authority，receipt 四态 `queued/claimed/settled/ambiguous`，`settle` 证明"确实没发"；失败带 typed reason（`gateway/session_bot.py:850-999`）。
- **跨机**：Desktop relay、`hermes peer dm`、房间 room-link 三种传输。

### DS-Bot `message_bot`

- **参数即语义**（`tools.js:254-330`）：
  - `reply_to: me | user` —— 对方回你，还是**直接在你的聊天里回用户**（Hermes 没有这一档）；
  - `when: now | queue` —— `now` 是** steer**：对方如果正在跑，会把你的话插进它的下一步；`queue` 才是新任务（`delivery.js:173-183`）；
  - `request_id` —— 调用方自命名幂等键：同 id 同文只发一次，回放 receipt；同 id 异文直接拒。
- **组内约束**：在群会话里调 `message_bot`，等价于在群里写 `@Name`，**不会**跑到对方私聊（`tools.js:193-204`）；后台任务里禁止调，要求"在最终回复里 @Name"。
- **不绕圈**：如果目标正在**等你这条活的结果**（上游），直接拒，并解释"你的答案会在你结束 turn 后自动上卷"（`tools.js:225-252`）。
- **工作树**（`handoffs.js`）：每次请求开一个 work `{from, to, parent, open[], results[]}`；被委托者再委托出去的就挂在 `open[]` 下；**所有子活都回来了，答案才连同子结果一起上卷**（`answerText`，`handoffs.js:252-275`）。长结果落 `handoff-results/` 文件，`state.json` 只留头部。
- 重启前记 `inflight.json`，重启后按 DSH 的 durable log 结算：能读到的答复照送，读不到的明确说"unknown"，**绝不重发**（`resume.js:1-20`）。

### 差异要点

| 维度 | Hermes | DS-Bot |
|---|---|---|
| 消息落点 | 对端永久 Bot Chat（可被用户打开） | 对端当前/下一条 turn；组内则落在群会话 |
| 回信方式 | 完成通知 + 一句 outcome | 作为新消息进来；组内则贴在群里 |
| 中途干预 | 无（文档注明 live interrupt 是 future work） | `when=now` 直接 steer 进正在跑的 turn |
| 环检测 | 跳数预算 + 不去回信 | 上游集合 + "答案自动上卷" + 幂等 request_id |
| 跨机 | 有（relay / peer / room link） | 无（单机团队，另有手机/网页远程入口） |

---

## 4. 群聊：计划器 vs 轮次机

### Hermes：网关拥有、纯函数规划

- 权威在网关，Desktop 只是客户端；日志是 append-only 事件流（`message.user/member`、`turn.*`、`room.assignment/routed/activity/continued`…，`gateway/hosted_rooms.py:60-69`），带 `seq` 与 `authority_epoch`。
- `plan_next_task()` 是**纯函数**：重放日志 → 最多产出一个成员任务；重启后算出同一个 task_id（`gateway/hosted_room_discussion.py:823`）。
- 选人：round 0 = @谁就谁，没人/@all → 全员；`routing=lead` 先让 lead 路由（写 `room.assignment`），`routing=auto` 一次便宜模型调用（先写 `room.routed` 再规划）；round ≥1 只叫"被同事 @ 且之后没发言"的人（`hosted_room_discussion.py:846-890`）。
- 预算：2–6 人、3 轮、10 条；到顶 `bounded`，Continue 再给一份预算；全员 pass → `settled("silent_round")`。
- 每人一条隐藏 room session（`Group: <room_id>`），每轮只喂 24 行增量 + purpose/notes；执行器是 durable driver（lease 30s、轮询 5s/0.25s、最多 4 房、单 turn 1830s，`tui_gateway/hosted_room_driver.py:111,812`）。
- 跨网关成员：grant + catalog + **房东签发的 execution policy**（toolsets/approval/max_iterations 带 digest，`gateway/hosted_room_execution_policy.py:26`）；权威迁移要 fence + promote/demote。

### DS-Bot：组是一条会话，轮次是内存状态机

- 每个群有自己的 **DSH Session**，唯一工具是 `group_relay`——群会话的"嘴"：把用户消息投给被叫的成员并收集回复（`groups.js:1917-1950`）。
- 模式 `everyone | admin`（默认 **admin**，`roster.js:668`）：
  - **admin 模式**：普通消息只给 admin；admin 要么答，要么 `@Name` 叫人；
  - **everyone 模式**：普通消息全员答，**admin 先、其余串行**（"像点人数一样保持顺序"）；
  - **@mention**：被点的人**立刻并行**开始，不等别人（`openingCall`，`groups.js:2048-2075`）。
- 轮次容错（数字全在 `constants.js`）：
  - 成员 15s 后还在用工具 → 轮次继续走，不等（`ROOM_WORK_GRACE_MS`）；它做完会把结果**迟交**进群，由当时叫它的人接（late reply）；
  - 单成员回复最多等 240s（`ROOM_REPLY_TIMEOUT_MS`），超时轮次照走；
  - **空闲守卫**：连续 6 次 Bot 间往返且**没有任何工具调用**、内容只是致谢/待命/重复 → 暂停，**只有用户再说话才解**（`ROOM_IDLE_RELAY_LIMIT`，`groups.js:1-20`、`isIdleRelayText`）。
- 群有自己的 memory、working folder（`room.workDir`）、notice（共享指令）、todo、ledger（每会话一个 append-only jsonl，`ledger.js:1-12`）。
- **Goal**：群级的"一件事"——`group_goal` 由 admin 跑：对齐 → 拆 stage（≤20）→ 每 stage 有验收标准 → 逐段检查、打回、重做 → 完成归档（`goals.js:1-10`）。Hermes 没有对应物，最接近的是 cron + 用户自己盯。

### 差异要点

| 维度 | Hermes | DS-Bot |
|---|---|---|
| 权威 | 网关（关桌面也跑） | DSH + 插件（插件 reload 也能恢复，`resume.js`） |
| 编排形态 | 事件日志 + 纯函数计划器 | 会话 + 轮次 slot 状态机 |
| 默认"谁答" | everyone（可选 lead/auto） | admin（主管制） |
| 并发 | 逐成员串行（同 profile 加锁） | @ 立刻并行；everyone 模式普通消息串行 |
| 终止 | 3 轮 / 10 条硬顶 | 无硬顶，靠"无进展"暂停 + 用户停止 |
| 防刷屏 | pass + silent round | 致谢/待命词表 + 6 次暂停 + 停后只能用户解 |
| 成员上限 | 6 | 12 |
| 工作目标 | 无（讨论即结果） | Goal：分阶段 + 验收 + 打回 |

---

## 5. 委托：保留子代理 vs 只留同事

这是两份实现**最根本的分歧**。

### Hermes：两种关系都保留

- `delegate_task`（`tools/delegate_tool.py:1-16,853`）：一次性 child AIAgent，fresh conversation、自己的 task_id、父 toolset 减黑名单（默认把 `delegate_task` 拉黑）、默认后台、并发 10、深度默认 1；支持 `action: list/steer/stop/continue`、`group` 结果合并、`output_schema` 校验。
- 于是 Hermes 里同时存在"同事"（持久 Bot，DM）和"下属"（一次性 child），用户能选。

### DS-Bot：明确禁止子代理

`tools.js:33-40` 把 DSH 的 `subagent`、`subagent_fork`、`send_message`、`workflow`、`ralph`、`spawn_teammate`、`team_task_*` 全部从 Bot 的工具表里摘掉，并在 prompt 里给出拒绝语：

> "Bots do not start subagents, teammates or workflows. Do the work yourself, or hand it to another Bot with `message_bot`."

理由写在注释里：DSH 的子代理**用户看不见、停不了，而且随发起它的 conversation part 结束**。DS-Bot 用 **handoff 树**替代：

- 一个 Bot 的请求 = 一个 work；被委托者再委托的挂在它下面；
- 父活**等**子活，全部回来才把"我说的 + 子结果"一起上卷；
- 长结果落文件，`state.json` 只留前 2000 字；
- 给上游发消息会被拒——因为答案本来就会自动送上去。

**含义**：DS-Bot 里所有并行工作都发生在「用户能看见、能停、能插话的 Bot」之间；Hermes 允许一个 Bot 私下开一队 child 干活，只把摘要交回来。

---

## 6. 上下文与长会话

| | Hermes | DS-Bot |
|---|---|---|
| 结构 | 一条永久 Bot Chat（标题即身份）；压缩走 `/compact` 与会话 lineage；群房每成员一条隐藏 session，可单独 compress | 一条会话分多个 **part**；旧的整段归档仍可被 `read_own_chat` 搜到 |
| 何时换段 | 用户/系统压缩；capability epoch 只触发 prompt 重建 | 过了 check line 由 **context steward**（小模型）判断：活干完了→`switch` 新段 + handoff note/package；活没干完→`compact` 就地压缩（`steward.js:1-20`、`parts.js:1-15`） |
| 阈值 | 压缩预算 | 默认 window 500k、check 0.8、绝对上限 380k（`steward.js:11-16`） |
| 重启 | gateway 恢复、receipt 悬挂可 inspect、不自动重放 | `inflight.json` + 从 DSH durable log 结算；读不到就明说 unknown，不重发（`resume.js`） |

Hermes 的"永恒会话"靠**只重建 prompt、不换会话**；DS-Bot 的"长会话"靠**换段 + 交接包**。前者对缓存友好，后者对"工作阶段性"更敏感。

---

## 7. 安全、诚实、可观测

| | Hermes | DS-Bot |
|---|---|---|
| 隔离 | profile 目录 + 独立凭据；同机 roster 全可见 | **Private Bot**：关闭读文件的工具、检查 file/bash 路径、发消息/写外部要审批；不能当 Main、不能进群；删了也保留保护直到用户释放（`privacy.js:1-10`） |
| 审批 | gateway approvals（manual/smart/off）；房间里能直接点 | 审批 + permission preset + 浏览器 grant + 连接器授权 |
| 诚实性 | typed failure reason、`ambiguous` / settle、"do not resend" | **claims**：核对最终回复里的 Markdown 文件链接是否真存在、是否宣称在干活却没有工具/后台/委派在跑，只打标记不重试（`claims.js:1-10`） |
| 可观测 | room activity/attention、metrics、delivery receipt | ledger（每会话 append-only）、diagnostics、search index、`read_own_chat` 跨段检索 |
| 用户入口 | Desktop roster + 群 + routines + CLI 等价 | 侧栏 Bot/群 + **跟 Chief 说话建队** + IM（微信/飞书/钉钉/QQ/TG/Discord/Slack）+ 手机/网页 + MCP（外部 agent 调 Bot） |

DS-Bot 多出的两块是产品化的关键：**私人 Bot 边界**与**IM/手机入口**；Hermes 多出的是**跨机**与**协议层的幂等/审计**。

---

## 8. 数字对照（都来自代码常量）

| | Hermes | DS-Bot |
|---|---|---|
| 群成员 | 2–6 | ≤12 |
| 轮次 / 消息 | 3 轮 / 10 条（Continue 加预算） | 无硬顶；6 次无进展暂停 |
| 每轮上下文 | 24 行 delta、prompt ≤128KB | 首次 12 行、delta ≤24 行、log 最近 60 |
| 单成员等待 | 1800s 级（driver `turn_timeout` 1830s） | 240s 回复超时；15s 工作宽限 |
| DM 消息 | ≤16000 字、≤8 目标、跳数 4 | 文本截 2000 字保留、`request_id` 幂等 |
| 子代理 | 并发 10、深度 1 | 不允许 |
| 组目标 | 无 | ≤20 stage、≤12 task、留 5 个历史 goal |

---

## 9. 各自的长处与代价

**Hermes 路线（平台）**
- 长处：Bot 可搬、可 CLI、可跨机；投递有 receipt/幂等/typed reason；房间规划器可重放；跨网关有 grant + execution policy；子代理与同事并存，编排自由度高。
- 代价：概念多（profile / canonical chat / managed gate / hop / authority epoch），用户要理解"什么是 profile"；群聊默认全员答，容易吵，需要 pass/预算兜底。

**DS-Bot 路线（产品）**
- 长处：用户只需跟 Chief 说话；主管制群聊默认不吵；handoff 树让"谁在等谁"可见；组 Goal 把"讨论"变成"交付"；私人 Bot/IM/手机/MCP 都是成品功能；对"无进展空转"的检测比轮次硬顶更贴近真实工作。
- 代价：团队绑单机单插件；没有子代理，重活只能靠 Bot 间来回；没有跨机 Bot；Bot 的"配置面"被产品收窄（很多能力只能在设置里改）。

---

## 10. 如果要融合，取哪边

1. **底座用 Hermes 的**：delivery receipt（ambiguous/settle/不重发）、纯函数房间规划器、跨机传输与 execution policy——这三样是"多 Bot 会长期跑"的前提。
2. **产品层用 DS-Bot 的**：Main Bot 的权限工具化、handoff 树（可见的等待关系）、群 Goal 的分阶段验收、私人 Bot 边界、IM/手机入口。
3. **防环两边都拿**：Hermes 的跳数硬顶（防深度）+ DS-Bot 的无进展检测（防广度空转）。
4. **上下文两边都拿**：Hermes 的"只重建 prompt 不换会话"（缓存/永恒关系）+ DS-Bot 的"分段 + 交接包"（阶段感）。
5. **权限表达**：学 DS-Bot 把权限写进工具描述并由工具拒绝（模型可解释），底座仍用 Hermes 的 authority 做真正的强制。

---

## 11. 关键文件索引

**Hermes**
`tools/bot_mode_probe.py`（roster/协议/managed 判定）· `tools/bot_mode_dm.py`（message_agent）· `agent/bot_chain.py`（跳数）· `gateway/session_bot.py`（receipt）· `gateway/hosted_room_discussion.py`（规划器）· `tui_gateway/hosted_room_driver.py`（执行器）· `gateway/hosted_room_execution_policy.py`（远端策略）· `tools/delegate_tool.py`（子代理）· `apps/desktop/src/plugins/hermes-bots/`（UI 契约）

**DS-Bot**
`ds-bot/src/host/roster.js`（Bot/群/Main）· `tools.js`（team tools）· `delivery.js`（投递头/steer）· `handoffs.js`（work 树）· `groups.js`（轮次）· `goals.js`（组目标）· `privacy.js`（私人 Bot）· `claims.js`（诚实性）· `parts.js`/`steward.js`（上下文分段）· `resume.js`（重启恢复）· `ledger.js`（jsonl 账本）· `store.js`（state.json）