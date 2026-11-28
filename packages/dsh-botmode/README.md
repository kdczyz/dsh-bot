# @local/dsh-botmode

DeepSeek Harness 的 Bot 团队模式插件（Host + Web Client 双半区，v0.6.0）。

- 每个 Bot 独立目录、SOUL/MEMORY、永久私聊会话，以及**按房间隔离的隐藏 Group Session**（支持配置房间共享工程目录 `workDir`）
- 每个 Bot 可单独绑定模型：DSH 默认（空绑定，下一轮重新读取）、provider/model、思考档位；模型目录标出是否支持图片输入
- Bot 聊天可发图片（PNG/JPEG/WebP/GIF），纯文本模型由 Host 在入队前拒绝
- `message_agent` 异步队友消息（会话级 FIFO、跳数护栏 `MAX_AGENT_HOPS=4`、同链去重、回信降级、>16k 落盘、群聊隐藏会话严格禁止）
- **Hermes 底座 + 终态驱动全异步 Actor 并发群聊（Group Room）**：
  - 2–6 人，支持 `auto`（并发协作 / `@` 接力）/ `everyone`（全员并发审阅）/ `lead`（Lead 统筹派工与验收）
  - **全异步 `BotActor` 总线 + 快照水位线防漏看**：空闲 Bot 并发响应消除慢 Bot 木桶效应；提交前锁定 `snapshotSeq` + `selfSentSeqs` 跳过集，杜绝并发漏看；精准 `@` 他人消息零 Token 推进水位线
  - **3 种显式业务终态（默认无回合数硬切）**：`completed`（仅显式调用 `room_finish_task` 触发，绝不靠正文正则误判）、`settled`（全员 `(pass)` 且无在途任务/待审批）、`waiting_user`（`@user` 询问，或局部挂起等待工具审批 / `ask_user_question`，不阻塞其他并行成员）
  - **3 个病态异常探针兜底**：连续 5 轮纯文本零工具/零改文件/零认领空转软暂停（`idle_spin`）、单 Bot 连续 3 次重复报错指纹局部暂停并广播排障求助（`paused_error`）、软 Token 预算检查点（`token_budget`，点继续无损续跑）
  - **共享任务板与文件软锁 + 分轨流式渲染**：`claim_subtask(taskId, paths)` 配合 DSH 工具拦截层软锁防并发覆写文件；前端底部按 `botId` 分轨实时流式展示思考与工具状态，完成后按 `seq` 到达顺序固化入主聊天流；人类中途发言采用 **Soft Steer 软插话**（不强杀在途脚本，仅 `Stop` / `/stop` 全局强停）
- **全局可插拔团队记忆库（Memory Hub）**：
  - 所有 Bot 共用一套全局激活的记忆库插件，按 `team_id` + `agent_id (= bot.id)` + `user_id` 严格隔离各 Bot 记忆
  - 默认内置 `memory_tencentdb`（对接 v3 HTTP Gateway `127.0.0.1:8420`，支持 L0–L3 并行预取与异步写入、熔断保护，网关未启动时自动回退至 Node 22 原生 SQLite FTS5）
  - 同时内置 `local_sqlite`（纯本地零依赖 SQLite FTS5）与 `builtin`（仅 `MEMORY.md`）
  - 支持在页面或 `/botmode memory install` 一键下载、安装、配置、热切换与卸载其他记忆库插件
- Host 持久 Routines：cron 解析 + 冷会话唤醒，定时器在 `ctx.effect()` 内
- Bot 审批与提问桥：`approval/request`（once / session / always / deny）与 `user-questions/request`（`ask_user_question`）同时覆盖私聊与隐藏群聊会话

安装（桌面端）：

```bash
dsh plugin --profile desktop install /path/to/dsh-bot/packages/dsh-botmode
```

状态根：`$DSH_HOME/botmode`。HTTP：`/botmode/api/state`、`/botmode/api/models`、`/botmode/api/memory`、`/botmode/api/image`、`/botmode/api/command`。

测试：

```bash
node packages/dsh-botmode/test/host.test.mjs
```

完整架构、命令表与限制见 [docs/BOTMODE.md](../../docs/BOTMODE.md)；项目总览见仓库根 [README.md](../../README.md)。
