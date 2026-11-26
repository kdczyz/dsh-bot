# BotScreen 虚拟屏系统 — 综合代码审查报告

> 审查日期：2026-11-26　|　审查方式：4 路并行分模块审查 + 主控逐行交叉验证
> 审查范围：`botscreen/*.py`、`packages/dsh-botmode/host/screen.js`、`web/index.html`、`install.sh`、`deploy/*`、`tools/*`、`BOTSCREEN.md`
> 所有结论均带 `文件:行号` 证据；已通过 `py_compile` 与 `node test/host.test.mjs`、`node test/screen.test.mjs`（通过）。

---

## 一、执行摘要

**综合评分：50 / 100（偏高风险，设计优秀但实现闭环不足）**

| 维度 | 分数 | 一句话 |
|---|---|---|
| 架构设计 | 8/10 | 四层分层清晰，`cgroup freeze + 磁盘租约/epoch + 双信号闲置 + fail-closed` 设计有想法 |
| 并发 / 状态机安全 | 4/10 | epoch 只校验不裁决、TOCTOU、状态可被非法降级/清除，核心互斥不变量被击穿 |
| 系统健壮性 | 5/10 | fd 泄漏、推流不探活、freeze 判据错误、cgroup 失败处理不一致 |
| 安全性 | 4/10 | 管理面默认全开、命令注入链、XSS、上传无上限、审计留存敏感画面 |
| 可维护性 | 5.5/10 | 注释详尽但端点样板重复严重、死代码与魔法数多、文档自相矛盾 |
| 可测试性 | 4/10 | 有独立测试文件却没进 `npm test`，mock 不验鉴权，关键路径零覆盖 |

**一句话结论**：这是一个**设计思想明显强于实现质量**的项目——顶层抽象（租约、epoch、freeze、人机互斥）都对，但多个"设计了却没接通/没闭环"的系统性断层（epoch 只写不读、signal 断裂、鉴权默认全开、测试没进 CI），使它在并发接管、中断、安全边界下表现为"看起来严密、实际 fail-open"。**P0 修复集中在互斥闭环与鉴权，投入约 1~2 人日即可把评分拉到 75+**。

---

## 二、实现方式综合分析

### 2.1 整体架构

```
接入层    控制台(web/index.html)  |  noVNC 接管(KasmVNC/Xvfb+x11vnc+websockify)
控制平面  Screen Gateway (FastAPI 6200)
          · REST 管理面  · Agent 操控面  · WS 推流代理 + 互斥锁
          · 状态机(ScreenLock)  · idle_reaper  · watchdog
实例层    Xvnc/Xvfb :100+N + WM + 桌面壳 × N（每 Bot 独立 HOME/cgroup）
底座层    cgroup v2 freeze → zram/reclaim → 共享 Xauthority / 目录隔离
```

编号映射：`bot_NN → DISPLAY 100+n / WS 6100+n / cgroup /sys/fs/cgroup/botscreen/{bot_id}`（由 `config.py:196-216` 的 slot 分配器保证 UUID Bot ID 也不撞号）。

### 2.2 几个做得好的设计点

1. **内核级冻结省内存**：`cgroup.freeze=1` 暂停进程树（CPU 严格 0），窗口/表单/标签页完整保留，唤醒 11~30ms（`screen.py:568-606`）。配套 `memory.reclaim` 把匿名页换出到 zram，冻结态内存 235MB→94MB。
2. **磁盘租约 + epoch + fail-closed**：`lease.json` 用 `flock` + 原子 `os.replace` 落盘，网关重启后按 DISPLAY/cgroup 接续（`screen.py:235-287`），租约损坏时按"人类持有"处理（`state.py:154-179`）——思路参照 Hermes，方向正确。
3. **双信号闲置判定**：Agent 调用与人类输入双时间戳 + `viewers==0` 才冻结（`state.py:292-302`），避免有人在观看时误冻。
4. **零视频流截屏**：python-xlib 直接抓 root window ZPixmap（5~8ms），绕开 mss 在 KasmVNC 上的 visual 校验问题（`driver.py:42-62`）。
5. **自研图标层绕开桌面信任机制**：单窗口合成 + `_NET_WM_WINDOW_TYPE_DESKTOP`，双击直接执行，无 gvfs trusted 确认框（`iconlayer.py`）。
6. **文档中详尽记录了踩坑**：mss/Xauthority/noVNC path/Reclaim 阻塞等，说明作者做过大量真机验证（`BOTSCREEN.md` §6）。

### 2.3 但实现有系统性问题

上述好设计在落地时普遍存在"最后一公里"断裂：

- epoch 在 host 层 `#epochs` **只写不读**（`screen.js:113,406,419,683,711`，全文件无 `get`），网关 `X-Expected-Epoch` 校验被完全绕过；
- agent 动作的 guard/epoch 检查与执行之间**无原子性**，await 让出事件循环后人类可接管，动作仍落地（TOCTOU）；
- 鉴权模型三套并存（agent token / admin token / VNC human token），admin token **默认空即全开**，且多个端点漏挂鉴权；
- 设计成 fail-closed 的互斥，在 `request_help`、`freeze`、租约字段非法等边界上变成 fail-open 或直接抛异常。

---

## 三、关键发现（Critical / High，按严重度）

### 🔴 Critical

**C1. Agent 动作 epoch TOCTOU：守卫与执行之间无原子性，人类接管后动作仍落地**
`botscreen/gateway.py:591-608`（click 为代表，type/scroll/drag/key/open_app 同构于 `626-641`、`660-669`、`689-706`、`723-733`、`765-776`）；`botscreen/state.py:262-281`
流程为 `guard_agent()` → `agent_epoch_header()` → `await worker.ensure_awake()` → 执行 → `touch_agent()`。`await ensure_awake()` 让出事件循环，此窗口内人类可 `takeover()`/`touch_human()` 切换控制权并递增 epoch，但动作照常执行、结尾直接返回当前 epoch，全程无二次校验。与 `state.py:11` 声明的 epoch 设计意图直接矛盾——epoch 被实现成"事后报告"而非"事后裁决"。
**影响**：人类点"接管"并输入凭据的同一瞬间，旧 epoch 的 Agent 键鼠/截图仍可注入，击穿人机互斥这一核心不变量。
**修复**：把校验+执行+提交包进同一临界区——`async with worker.lock.op_lock`；动作前重新 `guard_agent()` + `check_epoch(expected)`，动作后再次 `check_epoch`，变化即返回 409 且不 `touch_agent`；抽成统一 `@agent_action` 模板消除 7 处重复。

**C2. 管理面默认无鉴权，且多个端点完全未挂鉴权**
`botscreen/gateway.py:58`（`ADMIN_TOKEN` 默认 `""`）、`205-207`（空 token 直接放行）、`465-524`（`/audit`、`/audit/thumb`、`/files` GET/POST/DELETE 均无 `Depends(require_admin)`）。
**影响**：任何能到达 6200 端口者可列举/下载/删除/写入虚拟屏内文件，`upload`（`493-503`）无大小上限可写满磁盘；配合文档 `BOTSCREEN.md:455-456` 的公网 `port publish` 指引，风险外溢到公网。
**修复**：用 `APIRouter(dependencies=[Depends(require_admin)])` 统一覆盖所有 `/api/**`；启动时强制 `ADMIN_TOKEN` 非空（或显式 `--allow-anonymous`）；上传加 `Content-Length` + 流式累计上限（如 64MB）+ 临时文件原子落盘。

**C3. 前端 XSS + 令牌直拼 HTML，可导致管理控制台被接管**
`web/index.html:239-240`（`innerHTML` 拼入后端 `host.available_mb`/`host.blocker`）、`374-378`（token 拼入 `innerHTML`）、`379-381`（`window.open(res.stream_url)` 无协议白名单）、无 CSP（`173` 内联脚本）。
**影响**：后端字段或中间代理被注入即可在管理员浏览器执行任意 JS，拿到 token、调用 `/api/brake`、伪造全部管理 API。
**修复**：全面改 `textContent`/DOM 构造；URL 经 `new URL()` 校验 `http/https` + host 白名单；加 `Content-Security-Policy` 并把内联脚本外置。

### 🟠 High

**H1. `request_help` 可在人类接管态降级互斥锁** — `gateway.py:783-791` 未调 `guard_agent()`；`state.py:234-238,273-274`。Agent 持 token 即可在 `HUMAN_TAKEOVER` 下把状态改成 `NEED_HUMAN`，而 `NEED_HUMAN` 允许截图 → 绕过 fail-closed 重新开截图通道。**修复**：入口加 `guard_agent()`，并在 `ScreenLock.request_help()` 内部拒绝 `HUMAN_TAKEOVER` 迁移。

**H2. `mark_frozen` 无条件迁移，冻结清掉人类接管态** — `state.py:220-221`、`screen.py:568-585`、`gateway.py:345-347`。`freeze()` 不检查当前状态即 `mark_frozen()`，holder 由 human 翻转为 agent；`release()` 仅在两种 human 态回迁，此时条件不成立 → 人类锁被永久抹除，且 watchdog 解冻分支只处理 `AGENT_ACTIVE`（`gateway.py:154`），屏卡死在"人类接管但画面冻结"。**修复**：`freeze()` 对 human 态拒绝或 deferred，watchdog 解冻扩展到所有非 STOPPED 态，引入 `pre_freeze_state` 精确还原。

**H3. iconlayer 命令注入链** — `iconlayer.py:214-218` 双击执行 `Popen(cmd, shell=True)`，cmd 含 `f"pcmanfm {home}"`（`iconlayer.py:77`），home 路径含 bot_id；`gateway.py:83` 只过滤 `/` 和 `..`，未过滤 `;`、`` ` ``、`$()`、`|`。**修复**：改 argv 列表 + `shell=False`；bot_id 用 `^[A-Za-z0-9_-]+$` 白名单。

**H4. 租约恢复字段零校验，fail-closed 落空** — `state.py:175-177`：`int(data.get("epoch"))` / `float(data.get("since"))` 遇非法字符串抛 `ValueError`，不在 `163` 行捕获范围，异常沿 `attach()` 冒泡被 `gateway.py:177-179` 静默吞掉 → 屏停 STOPPED、状态与磁盘租约不一致。**修复**：整段解析包进 `try/except (ValueError, TypeError, OverflowError)`，非法字段走与损坏租约相同的 fail-closed 分支。

**H5. cgroup freeze 判据错误，等待循环形同虚设** — `cgroup.py:205-221`：写入 `cgroup.freeze=1` 后用 `is_frozen()` 轮询，而它读的正是 `cgroup.freeze`（请求态），首次即 return；真实冻结态在 `cgroup.events` 的 `frozen` 字段（`frozen_events()` 已实现却未被使用，`223-228`）。**影响**：freeze 返回时进程可能仍在跑，reclaim/watchdog 对账全拿到错误判据。**修复**：`freeze()`/`is_frozen()` 改用 `frozen_events()==1/0`。

**H6. 日志 fd 泄漏，反复 start/stop 耗尽句柄** — `screen.py:381,396,403,420,463,478,495` 与 `desktop.py:342,382`：`log=open(...)` 传给 `Popen(stdout=log)` 后父进程句柄从不关闭。每次 start 泄漏 3~7 个 fd，配合 watchdog 崩溃重启最终 `Too many open files`。**修复**：`with open(...) as log: Popen(...)` 或 Popen 后 `log.close()`。

**H7. host 层 epoch 与取消信号"设计了没接通"** — `packages/dsh-botmode/host/screen.js`：
- `#epochs`（`113`）在 `406/419/683/711` 写入、`515` 删除，**全文件无读取**，`X-Expected-Epoch` 请求头从不发送 → 网关 stale-lease 保护形同虚设；
- `#agentCall`（`622`）接收 `signal`，但真正发请求的 `#req`（`318-323`）只用 `AbortSignal.timeout()`，未合并外部 signal → Bot turn 取消后截图/点击等 HTTP 调用仍最长阻塞 45s 且照常产生副作用。
**修复**：`#req` 用 `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])` 并全链路透传；`#agentCall` 注入 `X-Expected-Epoch`，409 时刷新重试。

**H8. `screen.test.mjs` 未纳入 `npm test`** — `packages/dsh-botmode/package.json:10` 的 test 脚本只跑 `host.test.mjs`，278 行的 `screen.test.mjs` 无任何 CI 入口。mock gateway 也不校验任何 token（`test/screen.test.mjs:20-151`），鉴权/401/409/423/取消/并发全部零覆盖。**修复**：`"test": "node test/host.test.mjs && node test/screen.test.mjs"`，强化 mock。

**H9. 默认后端 / 安装自检 / 文档三者矛盾** — `config.py:64-76` 检测到 `Xvfb+x11vnc+websockify` 时优先返回 `xvfb`；但 `install.sh:23-50` 始终强装 KasmVNC、`143-148` 自检 `Xvnc`，而 `BOTSCREEN.md:341` 称"默认已切换 Xvfb"、§1/§8 仍按 KasmVNC 写。**影响**：安装行为与文档不符，容量/排障指引失效。**修复**：自检按 `X_BACKEND` 分支，统一文档口径。

**H10. systemd 服务以 root 运行且无 hardening** — `deploy/botscreen.service:19` `User=root`，无 `NoNewPrivileges`/`ProtectSystem`/`PrivateTmp`/`CapabilityBoundingSet`；处理不可信 VNC 数据的网关 RCE 即 root；`After=network.target` 缺 `botscreen-cgroup-setup.service` 依赖且单元名（`botscreen@.service` 模板 vs 实际）不匹配。**修复**：叠加 systemd hardening，修依赖单元名，优先普通用户 + cgroup 委托。

---

## 四、中等问题精选（完整清单见附录思路）

- **鉴权与边界**：`X-Expected-Epoch: abc` 非法值触发 500（`gateway.py:251`）；`vnc_page` 用 `startswith` 判路径穿越有前缀缺陷（`943`，应改 `commonpath`）；MCP `agent_token()` bot_id 未校验可路径穿越（`mcp_server.py:119-122`）；`HumanInputBody` 坐标无 `Field` 约束（`gateway.py:379-390`）。
- **健壮性**：推流层 x11vnc/websockify 崩溃不检测不重启，僵尸进程累积（`screen.py:101,195-214`）；cgroup `reap` 失败处理不一致可导致整屏启动失败（`screen.py:394,448` vs `500-503`）；共享 XAUTHORITY 并发首启无锁（`screen.py:152-168`）；`descendants()` 用 `split()` 解析 `/proc/stat`，comm 含空格时 ppid 错位（`cgroup.py:169-171`）；`reclaim()` 同步写无超时（`cgroup.py:230-242`）；cgroup v1 误设 `available=True`（`cgroup.py:72-86`）。
- **数据治理**：`actions.jsonl` 无轮转 + `tail()` 全量 `readlines()`（`audit.py:57,82`）；缩略图 fail-closed 场景仍落盘敏感画面（`gateway.py:697`、`audit.py:45-53`）；upload 无类型/配额限制。
- **前端**：`URL.createObjectURL` 从不 `revoke`（`web/index.html:354,420-425`）；无 `visibilitychange` 暂停轮询；快速切换 bot 有旧响应覆盖竞态；无响应式/可访问性；控制台无文件上传下载 UI（后端已实现 `gateway.py:482-524`，前端全文无 `/files`）。
- **API 语义**：STOPPED/STARTING 被误映射为 423 "Human in control"（`gateway.py:217-232` + `state.py:269-270`），应区分 409。

---

## 五、优化路线图（按 ROI 排序）

### P0 — 立刻做（1~2 人日，堵住核心不变量与安全面）
1. **互斥闭环**：agent 动作统一 `op_lock` + 动作前后双 `check_epoch`，抽 `@agent_action` 模板（C1）；host 层接通 epoch 注入与 409 处理（H7 上半）。
2. **鉴权收口**：`APIRouter` 统一覆盖 `/api/**`，强制非空 ADMIN_TOKEN，audit/files 补鉴权，上传限额（C2）；前端 innerHTML 改 textContent + CSP（C3）。
3. **状态机迁移收敛**：`request_help`/`freeze` 的合法性判断移入 `ScreenLock`，禁止 `HUMAN_TAKEOVER → NEED_HUMAN/FROZEN`（H1/H2）。
4. **消除命令注入**：iconlayer 改 argv + bot_id 白名单（H3）。

### P1 — 本迭代内（2~3 人日，恢复健壮性）
5. cgroup freeze 判据改 `cgroup.events`（H5）；所有 `Popen(stdout=log)` 改 `with open`（H6）。
6. 租约字段全类型校验走 fail-closed（H4）；`X-Expected-Epoch` 用 `Optional[int]` 声明；`vnc_page` 改 `commonpath`。
7. 推流进程纳入 `healthy()`/watchdog 并 wait 回收；`reap` 容错统一；共享 XAUTHORITY 加 flock。
8. 测试接入 CI：`package.json` 加 `screen.test.mjs`，mock 校验 token 并模拟 401/409/423/取消/并发（H8）。

### P2 — 体验与一致性（持续）
9. 前端：`revokeObjectURL`、`visibilitychange`、busy 禁用 + requestId 防竞态、响应式 + `aria-live`、补文件面板与审计缩略图。
10. host 生命周期：signal 全链路透传（H7 下半）、统一端口配置源、`ctx.effect` 注册网关进程 `shutdown()`、工具 schema 加坐标 clamp。
11. 文档与脚本：统一默认后端口径与性能表；`install.sh` 锁版本/校验和/增量构建/失败回滚；`botscreen.service` 加 hardening 与依赖；把"32/32 回归"改为可验证表述并固化 CI。

---

## 六、分模块评分明细

| 模块 | 评分 | 核心短板 |
|---|---|---|
| Python 控制平面（gateway/screen/state/config） | 52/100 | epoch TOCTOU、默认无鉴权、状态机迁移分散 |
| 底层执行与桌面壳（cgroup/driver/desktop/iconlayer/audit/mcp） | 54/100 | freeze 判据错误、shell 注入、fd 泄漏 |
| JS Host 集成（host/screen.js + index.js + 测试） | 60/100 | signal 断裂、epoch 只写不读、测试没进 CI |
| 前端控制台与部署（web/install/deploy/tools/文档） | 48/100 | innerHTML XSS、默认无鉴权、root 网关、文档漂移 |

> 四个模块短板高度同源（鉴权 + 互斥闭环 + 生命周期 + 测试覆盖），因此综合分取加权 50/100：架构设计拉高整体分，但横跨全栈的安全与并发缺陷把实际生产可用分压到中线以下。

---

## 七、总体评价

BotScreen 是一个**有想法、有实测、文档详尽**的项目：内核冻结省内存、磁盘租约恢复、fail-closed 互斥、零视频流截屏都是经过真机验证的扎实设计，1280×720 单屏 ~80MB、冻结 0 CPU、唤醒 11~30ms 的数字也经得起推敲。

但它目前的问题不是"功能缺失"，而是**"关键机制接了一半"**：epoch 写了不读、guard 与执行之间没锁、admin token 默认空、测试文件躺在仓库里没进 CI。这些断层单独看都是几行改动，叠加起来却让"人机互斥"这个最核心的产品承诺在竞态下失效。建议按 P0→P1 顺序推进，优先把互斥与鉴权两条主线闭环——这是从"能演示"走向"可生产"的分水岭。
