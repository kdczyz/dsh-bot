# @local/dsh-botmode

DeepSeek Harness 的 Bot 团队模式插件（Host + Web Client 双半区）。

- 每个 Bot 独立目录、SOUL/MEMORY、模型、工具白名单、审批策略、永久会话
- `message_agent` 异步队友消息（每 Bot FIFO，`expectReply` 回复回送，>16k 落盘）
- Group Room 2–6 人，`@`/lead/everyone 路由，预算暂停，`@user` 升级
- Host 持久 Routines：cron 解析 + 冷会话唤醒，定时器在 `ctx.effect()` 内
- Bot 审批桥：once / session / always / deny
- 侧边栏面板图标 + 底部切换按钮 + 独立 `botmode` 主面板

安装（桌面端）：

```bash
dsh plugin --profile desktop install /Users/a1412/Desktop/dsh-bot/packages/dsh-botmode
```

或使用 Plugin Manager 的 `install_bundle`，target 传本目录绝对路径。安装后 Host 行 `include:botmode`，Client 模块 `@local/dsh-botmode/client`。

状态根：`$DSH_HOME/botmode`。HTTP：`/botmode/api/state`、`/botmode/api/command`。

测试：

```bash
node test/host.test.mjs
```

完整架构、命令表与限制见仓库根目录 [README.md](../../README.md)。