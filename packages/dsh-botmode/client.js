window.__ModuleLoader__.load({
  id: '@local/dsh-botmode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useMemo, useEffect, useRef, useSyncExternalStore } = React

    const PANEL_ID = 'botmode'
    const NS = 'botmode'
    const ROSTER_KEY = 'dsh.botmode.roster.v1'
    /* Team roster written on the Host inside the team workspace, so a Bot can
       add teammates that every browser picks up on its next load. */
    const HOST_ROSTER_FILE = 'bot-team.json'

    const COLORS = ['#4d6bfe', '#2f9e6e', '#d97706', '#c2410c', '#7c3aed', '#0e7490', '#be185d', '#4b5563']

    const DICT = {
      en: {
        'meta.title': 'Bot mode',
        'mode.label': 'Work mode',
        'mode.harness': 'Harness',
        'mode.bot': 'Bot',
        'mode.toBots': 'Switch to Bot mode',
        'mode.toHarness': 'Switch to Harness mode',
        'mode.currentBots': 'Current mode: Bot',
        'mode.currentHarness': 'Current mode: Harness',
        'page.eyebrow': 'Bot mode',
        'page.title': 'Bots',
        'host.loading': 'Loading the Bot roster from the Host…',
        'host.error': 'The Host did not answer',
        'host.retry': 'Retry',
        'page.subtitle': 'Named, long-lived assistants. Each Bot owns a folder, a persona, a memory and one permanent chat; the Host keeps the roster, Group Rooms and Routines.',
        'page.new': 'New bot',
        'page.empty.title': 'No Bots yet',
        'page.empty.body': 'Creating a Bot writes its folder, SOUL.md and MEMORY.md, opens its permanent chat, and registers it on the team roster so the other Bots can message it.',
        'page.empty.cta': 'Create the first Bot',
        'pane.bots': 'Bots',
        'pane.groups': 'Group chats',
        'pane.newGroup': 'New',
        'card.noPreview': 'No messages yet',
        'group.createTitle': 'New group chat',
        'group.editTitle': 'Group settings',
        'group.hint': 'Every member answers in the group; each reply is posted in the shared transcript.',
        'group.name': 'Name',
        'group.namePlaceholder': 'e.g. Research desk',
        'group.mode': 'Routing',
        'group.modeAuto': 'Lead first, then @mentions',
        'group.modeEveryone': 'Everyone each round',
        'group.lead': 'Lead Bot',
        'group.leadAuto': 'First member',
        'group.members': 'Members',
        'group.create': 'Create group',
        'group.delete': 'Delete group',
        'group.empty': 'No messages in the group yet.',
        'group.emptyPreview': 'No messages yet',
        'group.none': 'No group chat yet',
        'group.placeholder': 'Message the group…',
        'group.send': 'Send',
        'group.you': 'You',
        'group.membersCount': '{n} Bots',
        'group.noMembers': 'Add at least two Bots first.',
        'group.needName': 'Name the group first.',
        'group.needMembers': 'Pick at least two Bots.',
        'chat.reasoning': 'Reasoning',
        'chat.toolArgs': 'Arguments',
        'chat.toolOutput': 'Output',
        'chat.toolRunning': 'running',
        'chat.toolDone': 'done',
        'chat.toolError': 'failed',
        'chat.emptyTool': '(no output)',
        'chat.copy': 'Copy',
        'chat.copied': 'Copied',
        'chat.stopped': 'Stopped',
        'chat.tail': 'Thinking…',
        'chat.working': 'Working',
        'chat.idle': 'Idle',
        'chat.tab': 'Chat',
        'chat.tabTrajectory': 'Trajectory',
        'chat.detail': 'Bot details',
        'chat.back': 'Back to chat',
        'chat.completedTook': 'Completed in {duration}',
        'chat.turnWorked': 'Completed',
        'chat.turnFailed': 'Failed',
        'chat.deepDivingFor': 'Deep diving · {duration}',
        'chat.composerPlaceholder': 'Message or create a task, / for commands, @ for files or chats',
        'chat.modeCustom': 'Custom',
        'chat.defaultEffort': 'Default',
        'chat.voice': 'Voice input',
        'chat.statsCounts': '{turns} turns {steps} steps',
        'chat.statsCache': 'cache hit {percent}%',
        'chat.contextCreated': 'Created {date}',
        'chat.turnLabel': 'Turn {turn}',
        'chat.noTrajectory': 'No trajectory yet.',
        'chat.emptyTitle': 'What can I help with?',
        'chat.you': 'You',
        'chat.answer': 'Answer',
        'chat.reasoningShort': 'Thinking',
        'chat.toolShort': 'Tool',
        'chat.durationSeconds': '{seconds}s',
        'chat.durationMinutes': '{minutes}m {seconds}s',
        'chat.tool.bash': 'Run command',
        'chat.tool.read': 'Read file',
        'chat.tool.edit': 'Edit file',
        'chat.tool.search': 'Search code',
        'chat.tool.webSearch': 'Search web',
        'chat.tool.webFetch': 'Open page',
        'chat.tool.skill': 'Load skill',
        'chat.tool.team': 'Team',
        'chat.tool.message': 'Send message',
        'chat.tool.question': 'Ask',
        'chat.tool.plan': 'Update plan',
        'chat.tool.other': 'Tool',
        'chat.empty': 'Say something to {name}.',
        'chat.placeholder': 'Message {name}…',
        'chat.send': 'Send',
        'chat.stop': 'Stop',
        'chat.older': 'Load older messages',
        'chat.attach': 'Image',
        'chat.attachAdd': 'Attach an image',
        'chat.attachVisionOnly': 'This Bot uses a text-only model; pin a vision model to send images.',
        'chat.attachType': 'Only PNG, JPEG, WebP or GIF images are accepted.',
        'chat.attachSize': 'Each image must be 12 MB or smaller.',
        'chat.attachLimit': 'At most 6 images per message.',
        'chat.attachRemove': 'Remove',
        'chat.imageOnly': 'Image only',
        'detail.model': 'Model',
        'model.default': 'DSH default',
        'model.custom': 'Pinned',
        'model.unknown': 'not in the current catalog',
        'pane.title': 'Bots',
        'pane.search': 'Search Bots',
        'pane.empty': 'No matching Bot',
        'detail.workspace': 'Workspace',
        'detail.instructions': 'Standing instructions',
        'detail.sessions': 'Sessions in this workspace',
        'detail.noSessions': 'No session yet',
        'card.open': 'Open chat',
        'card.edit': 'Edit',
        'card.delete': 'Delete',
        'card.confirm': 'Delete this Bot? Its chat stays in Harness mode.',
        'card.cancel': 'Cancel',
        'card.ready': 'Chat ready',
        'card.working': 'Working',
        'card.missing': 'Chat missing',
        'card.workspace': 'Workspace',
        'card.migrate': 'Create workspace',
        'card.migrating': 'Creating…',
        'form.createTitle': 'New Bot',
        'form.editTitle': 'Edit Bot',
        'form.name': 'Name',
        'form.namePlaceholder': 'e.g. Researcher',
        'form.role': 'Role',
        'form.rolePlaceholder': 'e.g. Research and sources',
        'form.instructions': 'Standing instructions',
        'form.instructionsPlaceholder': 'What this Bot owns, how it should work, what it must not do.',
        'form.color': 'Colour',
        'form.hint': 'Creating a Bot gives it its own workspace folder named after it. Its persona and standing instructions are written into AGENTS.md, SOUL.md and .dsh/skills/team/SKILL.md there.',
        'form.cancel': 'Cancel',
        'form.create': 'Create Bot',
        'form.save': 'Save',
        'form.busy': 'Working…',
        'brief.title': 'Brief the team',
        'brief.body': 'Send one message to several Bots at once. Each answer arrives in that Bot’s own chat.',
        'brief.placeholder': 'What should the team look at?',
        'brief.send': 'Send brief',
        'brief.sent': 'Sent to {n} Bot(s). Their answers arrive in their chats.',
        'brief.pick': 'Pick at least one Bot.',
        'brief.needText': 'Write the brief first.',
        'foot.hint': 'Harness mode is the normal session list and conversation. Opening a Bot chat takes you there; the Bots row brings you back.',
        'foot.back': 'Back to Harness',
        'err.create': 'Could not create the Bot: {msg}',
        'err.update': 'Could not update the Bot: {msg}',
        'err.brief': 'Could not send the brief: {msg}',
        'err.session': 'This Bot has no chat session any more.',
        'form.section': 'Section',
        'form.provider': 'Model provider',
        'form.providerPlaceholder': 'leave empty for the default',
        'form.model': 'Model',
        'form.modelPlaceholder': 'leave empty for the default',
        'form.modelMode': 'Model source',
        'form.modelDefault': 'DSH default',
        'form.modelCustom': 'Pin a model',
        'form.modelDefaultHint': 'Follow the DSH default model. A later default change reaches this Bot on its next turn.',
        'form.modelDefaultNow': 'Current default: {model}',
        'form.modelLoading': 'Reading the DSH model catalog…',
        'form.modelError': 'The model catalog is unavailable: {msg}. You can still type a provider and model.',
        'form.modelProvider': 'Provider',
        'form.modelPick': 'Model',
        'form.modelPickPlaceholder': 'Choose a model',
        'form.reasoning': 'Thinking level',
        'form.reasoningDefault': 'Model default',
        'form.reasoningNone': 'This model exposes no thinking levels.',
        'form.vision': 'Vision',
        'form.visionYes': 'Image input',
        'form.visionNo': 'Text only',
        'form.visionUnknown': 'Not declared',
        'form.modelManual': 'Manual provider / model',
        'form.modelRefresh': 'Refresh catalog',
        'form.modelNeed': 'Choose both a provider and a model, or switch back to the DSH default.',
        'form.approval': 'Approval policy',
        'approval.ask': 'Ask me',
        'approval.allowAlways': 'Always allow',
        'approval.denyAlways': 'Always deny',
        'approval.once': 'Allow once',
        'approval.session': 'Allow this session',
        'approval.always': 'Always allow',
        'approval.deny': 'Deny',
        'form.tools': 'Allowed tools',
        'form.toolsPlaceholder': 'comma separated; empty means every tool',
        'section.new': 'Section',
        'section.namePrompt': 'Name the new Section',
        'detail.routines': 'Routines',
        'routine.new': 'New routine',
        'routine.none': 'No routines yet. A routine wakes this Bot on a cron schedule even when its chat is cold.',
        'routine.next': 'next',
        'routine.run': 'Run now',
        'routine.pause': 'Pause',
        'routine.resume': 'Resume',
        'routine.name': 'Name',
        'routine.cron': 'Cron (5 fields)',
        'routine.prompt': 'Instruction',
        'routine.promptPlaceholder': 'What should this Bot do when the routine fires?',
        'routine.hint': 'The Host evaluates this cron itself and wakes the Bot even after a restart. Example: 0 9 * * 1-5.',
        'routine.create': 'Create routine',
        'group.running': 'Routing…',
        'group.needsYou': 'needs you',
        'group.continue': 'Continue',
        'group.stop': 'Stop',
        'group.pausedBudget': 'The dispatch budget is spent. Continue with a fresh budget, or stop.',
        'group.pausedMention': 'A Bot asked for a human decision.',
      },
      zh: {
        'meta.title': 'Bot 模式',
        'mode.label': '工作模式',
        'mode.harness': 'Harness',
        'mode.bot': 'Bot',
        'mode.toBots': '切换到 Bot 模式',
        'mode.toHarness': '切换到 Harness 模式',
        'mode.currentBots': '当前模式：Bot',
        'mode.currentHarness': '当前模式：Harness',
        'page.eyebrow': 'Bot 模式',
        'page.title': 'Bot 团队',
        'host.loading': '正在从 Host 读取 Bot 名册…',
        'host.error': 'Host 没有响应',
        'host.retry': '重试',
        'page.subtitle': '有名字、长期在线的助手。每个 Bot 拥有自己的目录、人格、记忆和一个永久会话；名册、群聊与例程都由 Host 维护。',
        'page.new': '新建 Bot',
        'page.empty.title': '还没有 Bot',
        'page.empty.body': '创建 Bot 会生成它的目录、SOUL.md 和 MEMORY.md，打开永久会话，并登记到团队名册，其他 Bot 才能给它发消息。',
        'page.empty.cta': '创建第一个 Bot',
        'pane.bots': 'Bot',
        'pane.groups': '群聊',
        'pane.newGroup': '新建',
        'card.noPreview': '还没有消息',
        'group.createTitle': '新建群聊',
        'group.editTitle': '群聊设置',
        'group.hint': '每位成员都会在群里回复，所有消息落在同一个群记录里。',
        'group.name': '群名称',
        'group.namePlaceholder': '例如：调研小组',
        'group.mode': '路由方式',
        'group.modeAuto': 'Lead 先答，再按 @ 接力',
        'group.modeEveryone': '每轮所有人',
        'group.lead': 'Lead Bot',
        'group.leadAuto': '默认第一个成员',
        'group.members': '成员',
        'group.create': '创建群聊',
        'group.delete': '删除群聊',
        'group.empty': '群里还没有消息。',
        'group.emptyPreview': '还没有消息',
        'group.none': '还没有群聊',
        'group.placeholder': '发到群里…',
        'group.send': '发送',
        'group.you': '你',
        'group.membersCount': '{n} 个 Bot',
        'group.noMembers': '先至少加两个 Bot。',
        'group.needName': '先给群起个名字。',
        'group.needMembers': '至少选两个 Bot。',
        'chat.reasoning': '思考过程',
        'chat.toolArgs': '参数',
        'chat.toolOutput': '输出',
        'chat.toolRunning': '运行中',
        'chat.toolDone': '完成',
        'chat.toolError': '失败',
        'chat.emptyTool': '（无输出）',
        'chat.copy': '复制',
        'chat.copied': '已复制',
        'chat.stopped': '已停止',
        'chat.tail': '正在思考…',
        'chat.working': '工作中',
        'chat.idle': '空闲',
        'chat.tab': '对话',
        'chat.tabTrajectory': '轨迹',
        'chat.detail': 'Bot 详情',
        'chat.back': '返回对话',
        'chat.completedTook': '已完成，用时 {duration}',
        'chat.turnWorked': '已完成',
        'chat.turnFailed': '处理失败',
        'chat.deepDivingFor': '深度求索中，用时 {duration} ···',
        'chat.composerPlaceholder': '发消息或创建任务，/ 调用指令，@ 文件或对话',
        'chat.modeCustom': 'Custom',
        'chat.defaultEffort': 'Default',
        'chat.voice': '语音输入',
        'chat.statsCounts': '{turns} 轮 {steps} 步',
        'chat.statsCache': '缓存命中 {percent}%',
        'chat.contextCreated': '创建于 {date}',
        'chat.turnLabel': '第 {turn} 轮',
        'chat.noTrajectory': '还没有轨迹。',
        'chat.emptyTitle': '有什么可以帮忙的？',
        'chat.you': '你',
        'chat.answer': '回答',
        'chat.reasoningShort': '思考',
        'chat.toolShort': '工具',
        'chat.durationSeconds': '{seconds} 秒',
        'chat.durationMinutes': '{minutes} 分 {seconds} 秒',
        'chat.tool.bash': '运行命令',
        'chat.tool.read': '读取文件',
        'chat.tool.edit': '编辑文件',
        'chat.tool.search': '搜索代码',
        'chat.tool.webSearch': '搜索网页',
        'chat.tool.webFetch': '访问网页',
        'chat.tool.skill': '加载技能',
        'chat.tool.team': '团队',
        'chat.tool.message': '发送消息',
        'chat.tool.question': '提问',
        'chat.tool.plan': '更新计划',
        'chat.tool.other': '调用工具',
        'chat.empty': '跟 {name} 说点什么。',
        'chat.placeholder': '发消息给 {name}…',
        'chat.send': '发送',
        'chat.stop': '停止',
        'chat.older': '加载更早的消息',
        'chat.attach': '图片',
        'chat.attachAdd': '附加一张图片',
        'chat.attachVisionOnly': '这个 Bot 当前是纯文本模型；指定一个视觉模型后才能发图。',
        'chat.attachType': '只支持 PNG、JPEG、WebP、GIF 图片。',
        'chat.attachSize': '每张图片不超过 12 MB。',
        'chat.attachLimit': '每条消息最多 6 张图片。',
        'chat.attachRemove': '移除',
        'chat.imageOnly': '仅图片',
        'detail.model': '模型',
        'model.default': 'DSH 默认',
        'model.custom': '单独指定',
        'model.unknown': '不在当前模型目录里',
        'pane.title': 'Bot 会话',
        'pane.search': '搜索 Bot',
        'pane.empty': '没有匹配的 Bot',
        'detail.workspace': '工作区',
        'detail.instructions': '常驻指令',
        'detail.sessions': '这个工作区的会话',
        'detail.noSessions': '还没有会话',
        'card.open': '打开对话',
        'card.edit': '编辑',
        'card.delete': '删除',
        'card.confirm': '删除这个 Bot？它的对话会留在 Harness 模式里。',
        'card.cancel': '取消',
        'card.ready': '对话就绪',
        'card.working': '工作中',
        'card.missing': '对话已丢失',
        'card.workspace': '工作区',
        'card.migrate': '建立独立工作区',
        'card.migrating': '建立中…',
        'form.createTitle': '新建 Bot',
        'form.editTitle': '编辑 Bot',
        'form.name': '名字',
        'form.namePlaceholder': '例如：研究员',
        'form.role': '职责',
        'form.rolePlaceholder': '例如：调研与查资料',
        'form.instructions': '常驻指令',
        'form.instructionsPlaceholder': '这个 Bot 负责什么、怎么工作、不能做什么。',
        'form.color': '颜色',
        'form.hint': '创建后会为它建立一个同名的工作区文件夹；人格、职责与常驻指令会写进里面的 AGENTS.md、SOUL.md 和 .dsh/skills/team/SKILL.md。',
        'form.cancel': '取消',
        'form.create': '创建 Bot',
        'form.save': '保存',
        'form.busy': '处理中…',
        'brief.title': '给团队派活',
        'brief.body': '把一条消息同时发给多个 Bot。每只 Bot 的答复会出现在它自己的对话里。',
        'brief.placeholder': '团队要一起看什么？',
        'brief.send': '发送',
        'brief.sent': '已发给 {n} 个 Bot，答复会出现在各自的对话里。',
        'brief.pick': '至少选择一个 Bot。',
        'brief.needText': '先写内容。',
        'foot.hint': 'Harness 模式就是普通的会话列表与对话。打开某个 Bot 的对话会回到那里；点侧栏的 Bots 行就能回来。',
        'foot.back': '回到 Harness',
        'err.create': '创建 Bot 失败：{msg}',
        'err.update': '更新 Bot 失败：{msg}',
        'err.brief': '发送失败：{msg}',
        'err.session': '这个 Bot 已经没有对应的会话了。',
        'form.section': '分组',
        'form.provider': '模型提供方',
        'form.providerPlaceholder': '留空使用默认',
        'form.model': '模型',
        'form.modelPlaceholder': '留空使用默认',
        'form.modelMode': '模型来源',
        'form.modelDefault': 'DSH 默认',
        'form.modelCustom': '单独指定',
        'form.modelDefaultHint': '跟随 DSH 的默认模型；以后改默认模型，这个 Bot 下一轮就会用上。',
        'form.modelDefaultNow': '当前默认：{model}',
        'form.modelLoading': '正在读取 DSH 模型目录…',
        'form.modelError': '模型目录不可用：{msg}。仍可手动填写提供方与模型。',
        'form.modelProvider': '提供方',
        'form.modelPick': '模型',
        'form.modelPickPlaceholder': '选择一个模型',
        'form.reasoning': '思考档位',
        'form.reasoningDefault': '模型默认',
        'form.reasoningNone': '这个模型没有可调的思考档位。',
        'form.vision': '视觉',
        'form.visionYes': '支持图片输入',
        'form.visionNo': '仅文本',
        'form.visionUnknown': '未声明',
        'form.modelManual': '手动填写提供方 / 模型',
        'form.modelRefresh': '刷新目录',
        'form.modelNeed': '提供方和模型要一起选；否则切回 DSH 默认。',
        'form.approval': '审批策略',
        'approval.ask': '每次询问我',
        'approval.allowAlways': '总是允许',
        'approval.denyAlways': '总是拒绝',
        'approval.once': '允许一次',
        'approval.session': '本会话允许',
        'approval.always': '总是允许',
        'approval.deny': '拒绝',
        'form.tools': '允许的工具',
        'form.toolsPlaceholder': '用逗号分隔；留空表示全部工具',
        'section.new': '新建分组',
        'section.namePrompt': '给新分组起个名字',
        'detail.routines': '定时例程',
        'routine.new': '新建例程',
        'routine.none': '还没有例程。例程按 cron 在 Host 侧唤醒这个 Bot，即使对话已经冷却。',
        'routine.next': '下次',
        'routine.run': '立即运行',
        'routine.pause': '暂停',
        'routine.resume': '恢复',
        'routine.name': '名称',
        'routine.cron': 'Cron（5 段）',
        'routine.prompt': '指令',
        'routine.promptPlaceholder': '例程触发时这个 Bot 要做什么？',
        'routine.hint': 'Host 自己计算 cron，重启后也会唤醒 Bot。例如：0 9 * * 1-5。',
        'routine.create': '创建例程',
        'group.running': '调度中…',
        'group.needsYou': '需要你',
        'group.continue': '继续',
        'group.stop': '停止',
        'group.pausedBudget': '本轮调度预算已用完。可以按新预算继续，或停止。',
        'group.pausedMention': '有 Bot 请求人类决定。',
      },
    }

    function pickDict(lang) {
      const id = String(lang || '').toLowerCase()
      return id.startsWith('zh') ? DICT.zh : DICT.en
    }

    function interpolate(text, vars) {
      return String(text).replace(/\{(\w+)\}/g, (all, key) => (vars && key in vars ? String(vars[key]) : all))
    }

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function readRoster() {
      try {
        const raw = window.localStorage.getItem(ROSTER_KEY)
        const parsed = raw ? JSON.parse(raw) : []
        if (!Array.isArray(parsed)) return []
        return parsed.filter(bot => bot && typeof bot.id === 'string' && typeof bot.name === 'string'
          && typeof bot.sessionId === 'string')
      } catch (_error) {
        return []
      }
    }

    function writeRoster(list) {
      try {
        window.localStorage.setItem(ROSTER_KEY, JSON.stringify(list))
      } catch (_error) {
        /* storage full or unavailable: the in-memory roster still works this session */
      }
    }

    function newId() {
      const cryptoObj = window.crypto
      if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID()
      return `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    function initialOf(name) {
      const text = String(name || '').trim()
      return text === '' ? '?' : Array.from(text)[0].toUpperCase()
    }

    /* One catalog lookup shared by the Bot form, its detail page and the chat. */
    const EMPTY_MODEL = { provider: '', model: '', reasoningEffort: '' }

    function modelEntryOf(catalog, selection) {
      if (!catalog || !selection || !selection.provider || !selection.model) return undefined
      const group = (catalog.groups || []).find(item => item.id === selection.provider)
      return group ? (group.models || []).find(item => item.id === selection.model) : undefined
    }

    function effectiveModelOf(catalog, model) {
      if (model && model.provider && model.model) {
        return { provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) }
      }
      return catalog && catalog.default ? catalog.default : undefined
    }

    function modelLabelOf(catalog, selection) {
      if (!selection || !selection.provider || !selection.model) return ''
      const entry = modelEntryOf(catalog, selection)
      return entry ? entry.name : `${selection.provider}/${selection.model}`
    }

    function reasoningNameOf(catalog, selection) {
      if (!selection || !selection.reasoningEffort) return ''
      const entry = modelEntryOf(catalog, selection)
      const effort = entry && entry.reasoning ? entry.reasoning.efforts.find(item => item.id === selection.reasoningEffort) : undefined
      return effort ? effort.name : selection.reasoningEffort
    }

    function modelVisionOf(catalog, selection) {
      const entry = modelEntryOf(catalog, selection)
      return entry ? entry.vision : undefined
    }

    function describeModel(t, catalog, model, options = {}) {
      const selection = effectiveModelOf(catalog, model)
      if (!selection) return model && model.provider && model.model ? t('model.unknown') : t('model.default')
      if (options.optional && !catalog) return ''
      const label = modelLabelOf(catalog, selection)
      const source = model && model.provider && model.model ? t('model.custom') : t('model.default')
      const parts = [`${source} · ${selection.provider}/${selection.model}`]
      if (label && label !== selection.model) parts.push(label)
      const effort = reasoningNameOf(catalog, selection)
      if (effort) parts.push(effort)
      const vision = modelVisionOf(catalog, selection)
      if (vision === true) parts.push(t('form.visionYes'))
      else if (vision === false) parts.push(t('form.visionNo'))
      return parts.join(' · ')
    }

    function setupInChat(draft, team, lang, update = false) {
      const zh = String(lang || '').toLowerCase().startsWith('zh')
      const roster = team.length > 0 ? team.map(member => `- ${member.name}${member.role ? ` — ${member.role}` : ''}`).join('\n') : (zh ? '- （暂无其他 Bot）' : '- (no other Bots yet)')
      if (zh) {
        return `[Bot 初始化] 你是 ${draft.name}${draft.role ? `，职责：${draft.role}` : ''}。\n\n常驻指令：\n${draft.instructions || '（暂无）'}\n\n团队：\n${roster}\n\n请先做一件事：在**当前工作区**里建立你自己的设定文件（不存在才写，已存在就更新）：\n1. AGENTS.md：人格 + 职责 + 常驻指令 + 团队规则\n2. SOUL.md：与 AGENTS.md 相同的人格内容\n3. TEAM.md：团队成员名单\n4. .dsh/skills/team/SKILL.md：说明用团队留言板与队友沟通（读留言、发留言）\n\n然后用一句短话介绍自己，等指令。${update ? '（这是一次档案更新，不要重复自我介绍。）' : ''}`
      }
      return `[Bot setup] You are ${draft.name}${draft.role ? `, role: ${draft.role}` : ''}.\n\nStanding instructions:\n${draft.instructions || '(none)'}\n\nTeam:\n${roster}\n\nFirst, write your own setup files in **this workspace** (create them if missing, update them if present):\n1. AGENTS.md: persona + role + standing instructions + team rules\n2. SOUL.md: the same persona\n3. TEAM.md: the team roster\n4. .dsh/skills/team/SKILL.md: how to talk to teammates on the team board\n\nThen introduce yourself in one short sentence and wait.${update ? ' (This is a profile update; skip the introduction.)' : ''}`
    }

    function kickoff(name, lang) {
      const zh = String(lang || '').toLowerCase().startsWith('zh')
      return zh
        ? `[Bot 初始化] 你是 ${name}。你的职责、常驻指令和团队规则都写在当前工作区的 AGENTS.md 与 .dsh/skills/team/SKILL.md 里。先用一句短话介绍自己，然后等指令。`
        : `[Bot setup] You are ${name}. Your role, standing instructions and the team rules are in AGENTS.md and .dsh/skills/team/SKILL.md in this workspace. Introduce yourself in one short sentence, then wait.`
    }

    function profileUpdate(name, role, instructions, lang) {
      const zh = String(lang || '').toLowerCase().startsWith('zh')
      return zh
        ? `[你的档案已更新] 你现在是 ${name}。AGENTS.md 已写成最新版本，从现在起按它工作；如果这次改动对外有影响，用一句话说明。`
        : `[Your profile was updated] You are now ${name}. AGENTS.md holds the latest version; work from it from now on. If the change matters to the user, say so in one line.`
    }

    const CSS = `
      .bm-switch { display: inline-flex; align-items: center; gap: 2px; padding: 2px; box-sizing: border-box;
        height: 38px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-1); flex: none; }
      .bm-switch button { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12px; line-height: 16px; padding: 0 8px; height: 30px; border-radius: 6px; cursor: pointer;
        white-space: nowrap; }
      .bm-switch button[data-active='true'] { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary);
        box-shadow: inset 0 0 0 0.5px var(--dsw-alias-button-ghost-active-border); }
      .bm-switch button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-switch button[data-active='true']:hover { background: var(--dsw-alias-button-ghost-active-hover); }
      .bm-rail { appearance: none; width: 36px; height: 36px; padding: 0; display: inline-flex; align-items: center;
        justify-content: center; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); cursor: pointer; }
      .bm-rail:hover { background: var(--dsw-alias-button-floating-hover); }
      .bm-page { box-sizing: border-box; height: 100%; overflow: auto; padding: 40px 32px 64px;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
      .bm-inner { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
      .bm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .bm-eyebrow { font-size: 12px; line-height: 16px; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--dsw-alias-label-tertiary); margin-bottom: 6px; }
      .bm-title { margin: 0; font-size: 26px; line-height: 34px; font-weight: 600; }
      .bm-sub { margin: 6px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); max-width: 560px; }
      .bm-btn { appearance: none; font: inherit; font-size: 13px; line-height: 18px; height: 34px; padding: 0 14px;
        border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-border-l3); cursor: pointer;
        background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); }
      .bm-btn:hover { background: var(--dsw-alias-button-floating-hover); }
      .bm-btn.primary { background: var(--dsw-alias-button-primary-fill, #4d6bfe); color: var(--dsw-alias-label-primary-inverted, #fff); border-color: transparent; }
      .bm-btn.primary:hover { background: var(--dsw-alias-button-primary-hover); color: var(--dsw-alias-label-primary-inverted); }
      .bm-btn.danger { color: var(--dsw-alias-label-error); }
      .bm-btn:disabled { opacity: 0.55; cursor: default; }
      .bm-btn.small { height: 28px; padding: 0 10px; font-size: 12px; }
      .bm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
      .bm-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; box-sizing: border-box;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-card-fill); }
      .bm-card-top { display: flex; align-items: center; gap: 10px; }
      .bm-avatar { width: 36px; height: 36px; border-radius: 12px; display: inline-flex; align-items: center;
        justify-content: center; color: #fff; font-weight: 600; font-size: 15px; flex: none; }
      .bm-name { font-size: 14px; line-height: 20px; font-weight: 600; }
      .bm-role { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
      .bm-chip { margin-left: auto; font-size: 11px; line-height: 16px; padding: 1px 8px; border-radius: 999px;
        color: var(--dsw-alias-label-secondary); border: 0.5px solid var(--dsw-alias-border-l3); white-space: nowrap; }
      .bm-form-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .bm-dir { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-desc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 18px; }
      .bm-card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
      .bm-empty { border: 0.5px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg);
        padding: 28px 20px; text-align: center; background: var(--dsw-alias-bg-layer-1); }
      .bm-empty h2 { margin: 0 0 6px; font-size: 16px; line-height: 24px; }
      .bm-empty p { margin: 0 auto 14px; font-size: 13px; line-height: 20px; max-width: 480px;
        color: var(--dsw-alias-label-secondary); }
      .bm-form { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-card-fill); padding: 18px; display: flex; flex-direction: column; gap: 14px; }
      .bm-form h2 { margin: 0; font-size: 16px; line-height: 24px; }
      .bm-label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 16px;
        color: var(--dsw-alias-label-secondary); }
      .bm-input, .bm-area { font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-md); padding: 8px 10px; box-sizing: border-box; width: 100%; }
      .bm-input:focus, .bm-area:focus { outline: none; border-color: var(--dsw-alias-border-selected); }
      .bm-area { resize: vertical; min-height: 84px; }
      .bm-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .bm-swatches { display: flex; gap: 8px; flex-wrap: wrap; }
      .bm-swatch { width: 24px; height: 24px; border-radius: 8px; border: 2px solid transparent; cursor: pointer; padding: 0; }
      .bm-swatch[data-active='true'] { border-color: var(--dsw-alias-label-primary); }
      .bm-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .bm-model-box { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: var(--dsw-radius-md);
        border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
      .bm-model-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .bm-model-title { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
      .bm-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2);
        border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-seg button { appearance: none; border: 0; background: transparent; font: inherit; font-size: 11px; line-height: 16px;
        padding: 2px 9px; border-radius: 5px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .bm-seg button[data-active='true'] { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary); }
      .bm-model-head .bm-btn { margin-left: auto; }
      .bm-model-hint { font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }
      .bm-model-now { font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
      .bm-model-empty { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
      .bm-model-caps { display: flex; gap: 6px; flex-wrap: wrap; }
      .bm-cap { font-size: 10.5px; line-height: 16px; padding: 1px 7px; border-radius: 999px;
        border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
      .bm-cap[data-state='yes'] { color: var(--dsw-alias-label-success, #2f9e6e); border-color: color-mix(in srgb, #2f9e6e 45%, transparent); }
      .bm-cap[data-state='no'] { color: var(--dsw-alias-label-tertiary); }
      .bm-model-pill { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 10.5px; line-height: 16px; padding: 1px 8px; border-radius: 999px;
        color: var(--dsw-alias-label-tertiary); border: 0.5px solid var(--dsw-alias-border-l3); }
      .bm-error { font-size: 12px; line-height: 18px; padding: 8px 10px; border-radius: var(--dsw-radius-md);
        color: var(--dsw-alias-label-error); background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l3); }
      .bm-ok { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .bm-brief { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-layer-1); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
      .bm-brief h2 { margin: 0; font-size: 14px; line-height: 20px; }
      .bm-brief p { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .bm-picks { display: flex; flex-wrap: wrap; gap: 8px; }
      .bm-pick { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px;
        padding: 4px 10px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l3);
        color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }
      .bm-pick[data-on='true'] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-selected);
        background: var(--dsw-alias-button-ghost-active-fill); }


      .bm-section { display: flex; align-items: center; justify-content: space-between; gap: 6px;
        padding: 10px 6px 4px; font-size: 10px; line-height: 14px; letter-spacing: 0.04em;
        text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
      .bm-section-add { appearance: none; border: 0; background: transparent; font: inherit; font-size: 10px;
        color: var(--dsw-alias-label-tertiary); cursor: pointer; padding: 0 4px; }
      .bm-section-add:hover { color: var(--dsw-alias-label-primary); }
      .bm-frow { appearance: none; border: 0; background: transparent; font: inherit; width: 100%; box-sizing: border-box;
        display: flex; align-items: center; gap: 9px; padding: 7px 6px; border-radius: var(--dsw-radius-md);
        color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
      .bm-frow:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-frow[data-active='true'] { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-frow-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
      .bm-frow-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
      .bm-frow-name { font-size: 12px; line-height: 16px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-frow-time { margin-left: auto; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }
      .bm-frow-preview { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-unread { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-brand-primary); }
      .bm-msg-name { font-size: 10px; line-height: 14px; font-weight: 600; color: var(--dsw-alias-label-tertiary); margin-bottom: 3px; }
      .bm-page-split { display: flex; height: 100%; padding: 0; overflow: hidden; }
      .bm-pane { width: 296px; flex: none; box-sizing: border-box; display: flex; flex-direction: column;
        border-right: 0.5px solid var(--dsw-alias-border-l2); padding: 12px 8px; gap: 6px; overflow: hidden; }
      .bm-pane-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px 6px; }
      .bm-pane-title { font-size: 13px; line-height: 18px; font-weight: 600; }
      .bm-search { font: inherit; font-size: 12px; line-height: 18px; box-sizing: border-box; width: 100%;
        padding: 6px 9px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
      .bm-search:focus { outline: none; border-color: var(--dsw-alias-border-selected); }
      .bm-groups { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 1px; }
      .bm-group { display: flex; flex-direction: column; }
      .bm-grow { appearance: none; border: 0; background: transparent; font: inherit; width: 100%; box-sizing: border-box;
        display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 6px; border-radius: var(--dsw-radius-md);
        color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
      .bm-grow:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-grow[data-active='true'] { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-avatar-sm { width: 22px; height: 22px; border-radius: 7px; font-size: 10px; }
      .bm-avatar-lg { width: 40px; height: 40px; border-radius: 13px; font-size: 16px; }
      .bm-grow-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .bm-grow-name { font-size: 12px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-grow-role { font-size: 11px; line-height: 14px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-grow-count { margin-left: auto; font-size: 10px; line-height: 16px; min-width: 18px; text-align: center;
        border-radius: 999px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-1); }
      .bm-gsessions { display: flex; flex-direction: column; gap: 1px; padding: 1px 0 4px 28px; }
      .bm-srow { appearance: none; border: 0; background: transparent; font: inherit; display: flex; align-items: center;
        gap: 7px; height: 28px; padding: 0 6px; width: 100%; border-radius: var(--dsw-radius-md); cursor: pointer;
        color: var(--dsw-alias-label-secondary); text-align: left; }
      .bm-srow:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .bm-srow[data-primary='true'] { color: var(--dsw-alias-label-primary); }
      .bm-srow-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary); opacity: 0.5; }
      .bm-srow-dot[data-running='true'] { background: var(--dsw-alias-brand-primary); opacity: 1; }
      .bm-srow-title { font-size: 12px; line-height: 16px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-srow-time { font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
      .bm-pane-foot { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 8px; display: flex; }
      .bm-pane-empty { padding: 12px 8px; }
      .bm-detail-col { flex: 1; min-width: 0; overflow: auto; padding: 28px 32px 48px; }
      .bm-detail-col.bm-chat-col { display: flex; flex-direction: column; overflow: hidden; padding: 0; }
      .bm-detail { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
      .bm-dhead { display: flex; align-items: center; gap: 12px; }
      .bm-dhead-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .bm-name-lg { font-size: 18px; line-height: 24px; }
      .bm-dactions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .bm-confirm { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .bm-block { display: flex; flex-direction: column; gap: 6px; border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 14px; }
      .bm-block h3 { margin: 0; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-tertiary);
        text-transform: uppercase; letter-spacing: 0.03em; }
      .bm-block p { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
      .bm-slist { display: flex; flex-direction: column; gap: 2px; }
      .bm-muted { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
      .bm-detail-empty { max-width: 520px; margin: 48px auto; }

      .bm-chat { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%; }
      .bm-chat-head { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2); flex: none; }
      .bm-chat-title { display: flex; flex-direction: column; min-width: 0; }
      .bm-chat-title .bm-name { font-size: 13px; line-height: 18px; }
      .bm-chat-title .bm-role { font-size: 11px; line-height: 15px; }
      .bm-chat-status { margin-left: auto; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
      .bm-chat-status[data-running='true'] { color: var(--dsw-alias-brand-primary); }
      .bm-log { flex: 1; overflow: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
      .bm-msg { max-width: 78%; font-size: 13px; line-height: 20px; white-space: pre-wrap; word-break: break-word;
        padding: 8px 11px; border-radius: var(--dsw-radius-md); }
      .bm-msg-user { align-self: flex-end; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
        border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-msg-bot { align-self: flex-start; background: var(--dsw-alias-card-fill); color: var(--dsw-alias-label-primary);
        border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-msg-live { opacity: 0.85; }
      .bm-toolrow { align-self: flex-start; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
        padding: 2px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); }
      .bm-toolrow[data-error='true'] { color: var(--dsw-alias-label-error); }
      .bm-live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 6px;
        background: var(--dsw-alias-brand-primary); animation: bm-pulse 1.2s ease-in-out infinite; }
      @keyframes bm-pulse { 0%,100% { opacity: 0.25 } 50% { opacity: 1 } }
      .bm-log { gap: 18px; padding: 18px 22px 28px; }
      .bm-msg { max-width: 74%; font-size: 13.5px; line-height: 21px; white-space: pre-wrap; word-break: break-word;
        padding: 9px 12px; border-radius: 10px; }
      .bm-msg-user { align-self: flex-end; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
        border: 0.5px solid var(--dsw-alias-border-l2); border-bottom-right-radius: 4px; }
      .bm-turn { display: flex; flex-direction: column; gap: 6px; max-width: 880px; width: 100%; align-self: flex-start; }
      .bm-turn-who { display: flex; align-items: center; gap: 7px; }
      .bm-turn-name { font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
      .bm-avatar-xs { width: 18px; height: 18px; font-size: 9px; border-radius: 5px; }
      .bm-turn-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .bm-assistant-text { font-size: 13.5px; line-height: 22px; color: var(--dsw-alias-label-primary); word-break: break-word; }
      .bm-md { min-width: 0; }
      .bm-md-p { margin: 0 0 9px; white-space: pre-wrap; }
      .bm-md > :last-child { margin-bottom: 0; }
      .bm-md-heading { margin: 14px 0 6px; font-size: 14px; line-height: 20px; font-weight: 600; }
      .bm-md-list { margin: 0 0 9px; padding-left: 20px; }
      .bm-md-list li { margin: 2px 0; }
      .bm-md-quote { margin: 0 0 9px; padding: 2px 0 2px 10px; border-left: 2px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); white-space: pre-wrap; }
      .bm-md a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
      .bm-md a:hover { text-decoration: underline; }
      .bm-inline-code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px;
        padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-code { margin: 8px 0; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow: hidden;
        background: var(--dsw-alias-bg-layer-1); }
      .bm-code-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 10px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); font-size: 10.5px; }
      .bm-code-lang { text-transform: lowercase; letter-spacing: 0.02em; }
      .bm-code-copy { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary);
        font: inherit; cursor: pointer; padding: 1px 4px; border-radius: 4px; }
      .bm-code-copy:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .bm-code pre { margin: 0; padding: 10px 12px; overflow: auto; max-height: 420px; }
      .bm-code code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 12px; line-height: 18px; white-space: pre; color: var(--dsw-alias-label-primary); }
      .bm-cursor { display: inline-block; width: 7px; height: 15px; margin-left: 2px; vertical-align: -2px;
        border-radius: 1px; background: var(--dsw-alias-label-secondary); animation: bm-blink 1s step-end infinite; }
      @keyframes bm-blink { 0%,100% { opacity: 1 } 50% { opacity: 0 } }
      .bm-reason { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow: hidden;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent); max-width: 880px; }
      .bm-reason-head { display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 9px; border: 0;
        background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px;
        line-height: 17px; cursor: pointer; text-align: left; }
      .bm-reason-icon { display: inline-flex; color: var(--dsw-alias-label-tertiary); flex: none; }
      .bm-reason-icon[data-running='true'] { color: var(--dsw-alias-brand-primary); animation: bm-pulse 1.2s ease-in-out infinite; }
      .bm-reason-title { flex: none; color: var(--dsw-alias-label-secondary); }
      .bm-reason-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-label-tertiary); }
      .bm-reason-summary[data-shimmer='true'] { background: linear-gradient(90deg,
        var(--dsw-alias-label-tertiary) 0%, var(--dsw-alias-label-primary) 40%, var(--dsw-alias-label-tertiary) 80%);
        background-size: 220% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
        animation: bm-shimmer 1.8s linear infinite; }
      @keyframes bm-shimmer { from { background-position: 120% 0 } to { background-position: -120% 0 } }
      .bm-reason-body { border-top: 0.5px solid var(--dsw-alias-border-l1); padding: 9px 12px;
        color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 20px; max-height: 320px; overflow: auto; }
      .bm-reason-body .bm-md-p { white-space: pre-wrap; }
      .bm-tool { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow: hidden;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 45%, transparent); max-width: 880px; }
      .bm-tool-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 9px; border: 0;
        background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px;
        line-height: 17px; text-align: left; cursor: default; }
      .bm-tool-head[aria-expanded] { cursor: pointer; }
      .bm-tool-icon { display: inline-flex; color: var(--dsw-alias-label-tertiary); flex: none; }
      .bm-tool-name { flex: none; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11px; color: var(--dsw-alias-label-primary); }
      .bm-tool-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-mono, ui-monospace, monospace);
        font-size: 10.5px; }
      .bm-tool-state { flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
      .bm-tool[data-state='error'] { border-color: color-mix(in srgb, var(--dsw-alias-label-error) 35%, transparent); }
      .bm-tool[data-state='error'] .bm-tool-state { color: var(--dsw-alias-label-error); }
      .bm-tool[data-state='running'] .bm-tool-icon { color: var(--dsw-alias-brand-primary); }
      .bm-tool-chevron { flex: none; display: inline-block; transform: rotate(0deg); transition: transform .14s ease;
        opacity: 0.55; font-size: 13px; line-height: 1; }
      .bm-tool-chevron[data-open='true'] { transform: rotate(90deg); }
      .bm-tool-body { border-top: 0.5px solid var(--dsw-alias-border-l1); padding: 8px 10px;
        display: flex; flex-direction: column; gap: 8px; background: var(--dsw-alias-bg-layer-1); }
      .bm-tool-label { font-size: 9.5px; line-height: 14px; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--dsw-alias-label-tertiary); margin-bottom: 3px; }
      .bm-tool-body pre { margin: 0; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11px; line-height: 17px; white-space: pre-wrap; word-break: break-word; max-height: 300px;
        overflow: auto; color: var(--dsw-alias-label-secondary); }
      .bm-tool-empty { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .bm-spin { display: inline-block; width: 11px; height: 11px; border-radius: 50%; flex: none;
        border: 1.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
        border-top-color: var(--dsw-alias-brand-primary); animation: bm-spin .7s linear infinite; }
      @keyframes bm-spin { to { transform: rotate(360deg) } }
      .bm-tail { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-tertiary); padding: 2px 1px; }
      .bm-tail-text { animation: bm-pulse 1.6s ease-in-out infinite; }
      .bm-turn-error { max-width: 880px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-error);
        border: 0.5px solid color-mix(in srgb, var(--dsw-alias-label-error) 35%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-label-error) 8%, transparent);
        border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; }
      .bm-turn-notice { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
      .bm-compose { flex: none; border-top: 0.5px solid var(--dsw-alias-border-l2); padding: 10px 12px 12px;
        display: flex; gap: 8px; align-items: flex-end; }
      .bm-compose-col { flex-direction: column; align-items: stretch; }
      .bm-compose-row { display: flex; gap: 8px; align-items: flex-end; width: 100%; }
      .bm-compose-row textarea { flex: 1; }
      .bm-attach-btn { flex: none; height: 34px; }
      .bm-attach-list { display: flex; gap: 8px; flex-wrap: wrap; }
      .bm-attach-item { display: flex; align-items: center; gap: 6px; max-width: 220px; padding: 3px 6px;
        border-radius: 7px; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-attach-item img { width: 28px; height: 28px; object-fit: cover; border-radius: 5px; flex: none; }
      .bm-attach-name { font-size: 10.5px; line-height: 15px; color: var(--dsw-alias-label-secondary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-attach-remove { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary);
        font: inherit; font-size: 14px; line-height: 16px; cursor: pointer; padding: 0 2px; flex: none; }
      .bm-attach-remove:hover { color: var(--dsw-alias-label-error); }
      .bm-compose textarea { flex: 1; resize: none; min-height: 34px; max-height: 160px; font: inherit; font-size: 13px;
        line-height: 20px; padding: 7px 10px; box-sizing: border-box; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md); }
      .bm-compose textarea:focus { outline: none; border-color: var(--dsw-alias-border-selected); }
      .bm-chat-empty { margin: auto; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
      .bm-chat-error { margin: 0 16px 8px; }
      .bm-chat-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-chat-tabs button { appearance: none; border: 0; background: transparent; font: inherit; font-size: 11px;
        line-height: 16px; padding: 2px 8px; border-radius: 5px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .bm-chat-tabs button[data-active='true'] { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary); }
      .bm-foot { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 14px; display: flex;
        align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .bm-foot span { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); max-width: 620px; }
      .bm-approvals { display: flex; flex-direction: column; gap: 6px; padding: 10px 16px 0; }
      .bm-approval { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: var(--dsw-radius-md);
        border: 0.5px solid var(--dsw-alias-border-selected); background: var(--dsw-alias-bg-layer-1); }
      .bm-approval-text { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; font-size: 12px; }
      .bm-approval-name { font-weight: 600; }
      .bm-approval-tool { font-family: var(--dsw-alias-font-mono, monospace); font-size: 11px;
        padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); }
      .bm-approval-reason { color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px; }
      .bm-approval-actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
      .bm-bot-group { display: flex; flex-direction: column; gap: 1px; padding-bottom: 4px; }
      .bm-group-title { font-size: 10px; line-height: 14px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--dsw-alias-label-tertiary); padding: 6px 8px 2px; }
      .bm-block-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .bm-routine-list { display: flex; flex-direction: column; gap: 6px; }
      .bm-routine { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: var(--dsw-radius-md);
        border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
      .bm-routine-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
      .bm-routine-name { font-size: 12px; line-height: 16px; font-weight: 600; }
      .bm-routine-meta { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }
      .bm-routine-prompt { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary);
        overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .bm-routine-actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
      .bm-routine-form { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: var(--dsw-radius-md);
        border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
      .bm-room-alert { flex: none; display: flex; align-items: center; gap: 8px; margin: 10px 16px 0; padding: 8px 10px;
        border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-border-selected);
        background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .bm-room-alert span { flex: 1; }
      .bm-needs-you { font-size: 10px; line-height: 16px; padding: 1px 7px; border-radius: 999px;
        background: var(--dsw-alias-label-error); color: #fff; }
      .bm-foot-toggle:not([data-wide='true']) span { display: none; }
      .bm-foot-toggle { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12px; line-height: 16px; display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 8px; border-radius: var(--dsw-radius-md); cursor: pointer; width: 100%; text-align: left; }
      .bm-foot-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

      /* DSH conversation replica: the Bot chat uses the same flow geometry,
         typography, process rows, composer card and statistics strip as the
         Harness conversation. */
      .dc-chat { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
      .dc-head { flex: none; box-sizing: border-box; display: flex; flex-direction: column;
        min-height: 76px; padding: 10px 24px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
      .dc-head-row { display: flex; align-items: center; gap: 8px; min-height: 30px; }
      .dc-head-lead { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
      .dc-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 14px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); }
      .dc-running-dot { width: 6px; height: 6px; border-radius: 50%; flex: none;
        background: var(--dsw-alias-brand-primary); animation: bm-pulse 1.2s ease-in-out infinite; }
      .dc-head-actions { display: flex; align-items: center; gap: 4px; flex: none; }
      .dc-icon-btn { appearance: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
        background: transparent; color: var(--dsw-alias-label-tertiary); display: inline-flex;
        align-items: center; justify-content: center; cursor: pointer; flex: none; }
      .dc-icon-btn:hover, .dc-icon-btn[data-active='true'] { background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary); }
      .dc-tabs { display: flex; align-items: center; gap: 22px; margin-top: 4px; }
      .dc-tabs button { appearance: none; border: 0; background: transparent; font: inherit;
        font-size: 13px; line-height: 20px; padding: 5px 0 9px; color: var(--dsw-alias-label-tertiary);
        border-bottom: 2px solid transparent; cursor: pointer; }
      .dc-tabs button:hover { color: var(--dsw-alias-label-secondary); }
      .dc-tabs button[data-active='true'] { color: var(--dsw-alias-label-primary);
        border-bottom-color: var(--dsw-alias-brand-primary); }
      .dc-scroll { flex: 1; min-height: 0; overflow-x: clip; overflow-y: auto; padding: 16px 24px; }
      .dc-column { width: 100%; max-width: var(--dsh-chat-content-width, 748px); margin: 0 auto; display: flex; flex-direction: column;
        gap: 4px; }
      .dc-user-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
        margin-top: 12px; min-width: 0; }
      .dc-user-spacer { flex: 1; }
      .dc-user-main { display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
        min-width: 0; max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%); }
      .dc-user-bubble { max-width: 100%; box-sizing: border-box; padding: 9px 14px;
        border-radius: 14px; border-bottom-right-radius: 5px; background: var(--dsw-alias-bg-layer-2);
        border: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary);
        font-size: 14px; line-height: 22px; white-space: pre-wrap; word-break: break-word; }
      .dc-context-card { flex: none; width: 266px; max-width: 42%; box-sizing: border-box; display: flex;
        gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: 10px;
        border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-tertiary); }
      .dc-context-mark { display: none; }
      .dc-context-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .dc-context-name { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-primary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dc-context-path { font-size: 10.5px; line-height: 15px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dc-context-meta { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-caption); }
      .dc-user-meta { display: flex; align-items: center; gap: 8px; padding-right: 2px;
        color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
      .dc-user-copy { appearance: none; border: 0; background: transparent; padding: 0;
        display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
      .dc-user-copy:hover { color: var(--dsw-alias-label-primary); }
      .dc-turn { display: flex; flex-direction: column; width: 100%; margin-top: 16px; }
      .dc-turn-head { appearance: none; box-sizing: border-box; display: flex; align-items: center;
        width: 100%; height: 33px; padding: 0 0 8px; border: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2);
        background: none; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 14px;
        line-height: 24px; text-align: left; cursor: pointer; margin-bottom: 8px; }
      .dc-turn-head:hover { color: var(--dsw-alias-label-secondary); }
      .dc-turn-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dc-turn-chevron { width: 14px; height: 14px; margin-left: 4px; flex: none; opacity: 0.55;
        transition: transform 100ms ease; }
      .dc-turn-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .dc-turn-body > .dc-prose { margin-top: 12px; }
      .dc-turn-body > .dc-prose:first-child { margin-top: 0; }
      .dc-prose { min-width: 0; }
      .dc-proc { display: flex; flex-direction: column; min-width: 0; }
      .dc-proc-btn { appearance: none; box-sizing: border-box; display: flex; align-items: center;
        gap: 6px; width: 100%; min-height: 24px; padding: 0; border: 0; background: none;
        color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px; line-height: 20px;
        text-align: left; cursor: default; }
      .dc-proc-btn[aria-expanded] { cursor: pointer; }
      .dc-proc-btn:hover { color: var(--dsw-alias-label-secondary); }
      .dc-proc-icon { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center;
        justify-content: center; color: inherit; }
      .dc-proc[data-running='true'] .dc-proc-icon { color: var(--dsw-alias-brand-primary); }
      .dc-proc-title { flex: none; font-weight: 400; }
      .dc-proc-sep { flex: none; color: var(--dsw-alias-label-caption); margin: 0 4px; }
      .dc-proc-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; color: inherit; }
      .dc-proc-summary[data-shimmer='true'] { color: transparent;
        background: linear-gradient(90deg, var(--dsw-alias-label-tertiary) 0%,
          var(--dsw-alias-label-primary) 40%, var(--dsw-alias-label-tertiary) 80%);
        background-size: 220% 100%; -webkit-background-clip: text; background-clip: text;
        animation: bm-shimmer 1.8s linear infinite; }
      .dc-proc-chevron { flex: none; width: 14px; height: 14px; opacity: 0; transition: opacity 100ms ease; }
      .dc-proc-btn:hover .dc-proc-chevron, .dc-proc-btn:focus-visible .dc-proc-chevron { opacity: 0.55; }
      .dc-proc-failed { flex: none; color: var(--dsw-alias-label-error); font-size: 12px; }
      .dc-spin { display: inline-block; width: 12px; height: 12px; border-radius: 50%; flex: none;
        border: 1.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
        border-top-color: var(--dsw-alias-brand-primary); animation: bm-spin .7s linear infinite; }
      .dc-reason-body { padding: 0 0 8px 22px; max-height: 360px; overflow: auto; min-width: 0; }
      .dc-reason-body .dc-md-secondary { font-size: 13px; line-height: 22px;
        color: var(--dsw-alias-label-secondary); }
      .dc-tool-body { margin: 2px 0 8px 22px; padding: 8px 10px; display: flex; flex-direction: column;
        gap: 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1); max-height: 420px; overflow: auto; }
      .dc-tool-part { display: flex; flex-direction: column; gap: 3px; }
      .dc-tool-label { font-size: 9.5px; line-height: 14px; letter-spacing: 0.04em;
        text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
      .dc-tool-body pre, .dc-tool-part pre { margin: 0; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11px; line-height: 17px; white-space: pre-wrap; word-break: break-word;
        color: var(--dsw-alias-label-secondary); }
      .dc-tool-empty { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .dc-md { display: flex; flex-direction: column; gap: 16px; font-size: 14px; line-height: 24px;
        color: var(--dsw-alias-label-primary); word-break: break-word; }
      .dc-md .bm-md-p { margin: 0; white-space: pre-wrap; }
      .dc-md .bm-md-p + .bm-md-p { margin-top: 0; }
      .dc-md .bm-md-heading { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
      .dc-md h2.bm-md-heading { font-size: 24px; line-height: 32px; }
      .dc-md .bm-md-list { margin: 0; padding-left: 24px; }
      .dc-md .bm-md-list li { margin: 0; line-height: 24px; }
      .dc-md .bm-md-table-wrap { overflow-x: auto; max-width: 100%; }
      .dc-md .bm-md-table { border-collapse: collapse; width: 100%; font-size: 13px; line-height: 20px; }
      .dc-md .bm-md-table th, .dc-md .bm-md-table td { padding: 6px 10px; text-align: left;
        border: 0.5px solid var(--dsw-alias-border-l2); vertical-align: top; }
      .dc-md .bm-md-table th { background: var(--dsw-alias-bg-layer-1); font-weight: 600;
        color: var(--dsw-alias-label-primary); }
      .dc-md .bm-md-table td { color: var(--dsw-alias-label-secondary); }
      .dc-md .bm-md-quote { margin: 0; padding: 2px 0 2px 12px;
        border-left: 2px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
      .dc-md a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
      .dc-md a:hover { text-decoration: underline; }
      .dc-md .bm-inline-code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 12.5px; padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l2); }
      .dc-md .bm-code { margin: 0; border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: 8px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
      .dc-md .bm-code-head { display: flex; align-items: center; justify-content: space-between;
        padding: 4px 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-tertiary); font-size: 10.5px; line-height: 16px; }
      .dc-md .bm-code-copy { appearance: none; border: 0; background: transparent;
        color: var(--dsw-alias-label-tertiary); font: inherit; cursor: pointer; padding: 1px 4px;
        border-radius: 4px; }
      .dc-md .bm-code-copy:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .dc-md .bm-code pre { margin: 0; padding: 10px 12px; overflow: auto; max-height: 420px; }
      .dc-md .bm-code code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 12px; line-height: 18px; white-space: pre; color: var(--dsw-alias-label-primary); }
      .dc-running { display: flex; align-items: center; gap: 8px; margin-top: 12px;
        color: var(--dsw-alias-label-deep-diving, var(--dsw-alias-brand-primary));
        font-size: 13px; line-height: 22px; }
      .dc-running-mark { flex: none; display: inline-flex; color: inherit; }
      .dc-running-text { color: transparent; background: linear-gradient(90deg,
        var(--dsw-alias-label-deep-diving, var(--dsw-alias-brand-primary)) 0%,
        var(--dsw-alias-label-primary) 42%,
        var(--dsw-alias-label-deep-diving, var(--dsw-alias-brand-primary)) 82%);
        background-size: 220% 100%; -webkit-background-clip: text; background-clip: text;
        animation: bm-shimmer 1.8s linear infinite; }
      .dc-turn-error { margin-top: 8px; padding: 8px 10px; border-radius: 8px; font-size: 12px;
        line-height: 18px; color: var(--dsw-alias-label-error); white-space: pre-wrap;
        border: 0.5px solid color-mix(in srgb, var(--dsw-alias-label-error) 35%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-label-error) 8%, transparent); }
      .dc-hero { display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 8px; padding: 92px 16px; text-align: center; }
      .dc-hero-title { font-size: 24px; line-height: 32px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dc-hero-sub { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
      .dc-older { align-self: center; appearance: none; border: 0; background: transparent;
        color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; line-height: 18px;
        padding: 4px 8px; border-radius: 5px; cursor: pointer; margin: 4px 0 12px; }
      .dc-older:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .dc-composer { flex: none; display: flex; flex-direction: column; align-items: center;
        gap: 0; padding: 0 24px 4px; }
      .dc-card { box-sizing: border-box; width: 100%; max-width: calc(var(--dsh-chat-content-width, 748px) + 16px); display: flex; flex-direction: column;
        gap: 8px; padding: 8px 0 6px; border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: 16px; background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2));
        box-shadow: var(--dsw-elevation-soft, 0 4px 18px rgba(0, 0, 0, 0.14)); }
      .dc-input { box-sizing: border-box; width: 100%; min-height: 36px; max-height: 180px;
        resize: none; border: 0; outline: none; background: transparent; color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 14px; line-height: 24px; padding: 4px 16px 0; overflow-y: auto; }
      .dc-input::placeholder { color: var(--dsw-alias-label-caption); }
      .dc-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 2px 10px 0 12px; min-width: 0; }
      .dc-bar-left, .dc-bar-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .dc-bar-right { justify-content: flex-end; }
      .dc-round { appearance: none; width: 26px; height: 26px; padding: 0; border-radius: 50%;
        border: 0.5px solid var(--dsw-alias-border-l3); background: transparent;
        color: var(--dsw-alias-label-secondary); display: inline-flex; align-items: center;
        justify-content: center; cursor: pointer; flex: none; }
      .dc-round:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dc-round:disabled { opacity: 0.45; cursor: default; }
      .dc-mode { appearance: none; border: 0; background: transparent; font: inherit; font-size: 12px;
        line-height: 18px; color: var(--dsw-alias-label-secondary); display: inline-flex;
        align-items: center; gap: 4px; padding: 3px 5px; border-radius: 5px; cursor: pointer; flex: none; }
      .dc-mode:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dc-mode-chevron { width: 12px; height: 12px; opacity: 0.6; flex: none; }
      .dc-model { appearance: none; border: 0; background: transparent; font: inherit; font-size: 12px;
        line-height: 18px; color: var(--dsw-alias-label-tertiary); display: inline-flex;
        align-items: center; gap: 4px; padding: 3px 5px; border-radius: 5px; cursor: pointer;
        min-width: 0; max-width: 340px; }
      .dc-model:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
      .dc-model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dc-send { appearance: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%;
        background: var(--dsw-alias-button-primary-fill, #4d6bfe); color: var(--dsw-alias-label-primary-inverted, #fff);
        display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
      .dc-send:hover { background: var(--dsw-alias-button-primary-hover); }
      .dc-send:disabled { opacity: 0.4; cursor: default; }
      .dc-attach-list { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 12px 0; }
      .dc-attach-item { display: flex; align-items: center; gap: 6px; max-width: 220px; padding: 3px 6px;
        border-radius: 7px; background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l2); }
      .dc-attach-item img { width: 28px; height: 28px; object-fit: cover; border-radius: 5px; flex: none; }
      .dc-attach-name { font-size: 10.5px; line-height: 15px; color: var(--dsw-alias-label-secondary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dc-attach-remove { appearance: none; border: 0; background: transparent;
        color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 14px; line-height: 16px;
        cursor: pointer; padding: 0 2px; flex: none; }
      .dc-attach-remove:hover { color: var(--dsw-alias-label-error); }
      .dc-dock { box-sizing: border-box; min-height: 22px; display: flex; align-items: center;
        justify-content: center; gap: 10px; flex-wrap: wrap; padding-top: 4px;
        color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 20px; }
      .dc-stat { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px;
        border-radius: 4px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .dc-ring { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px;
        color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
      .dc-ring-track { fill: none; stroke: var(--dsw-alias-border-l3); stroke-width: 2; }
      .dc-ring-fill { fill: none; stroke: var(--dsw-alias-label-tertiary); stroke-width: 2;
        stroke-linecap: round; }
      .dc-detail-scroll { flex: 1; min-height: 0; overflow: auto; padding: 16px 24px 32px; }
      .dc-back { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary);
        font: inherit; font-size: 12px; line-height: 18px; padding: 4px 8px; border-radius: 6px;
        cursor: pointer; margin-bottom: 10px; }
      .dc-back:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dc-traj-column { gap: 0; }
      .dc-traj { display: flex; flex-direction: column; border-top: 0.5px solid var(--dsw-alias-border-l2); }
      .dc-traj-row { display: grid; grid-template-columns: 52px 86px minmax(0, 1fr); gap: 12px;
        padding: 7px 4px; border-bottom: 0.5px solid var(--dsw-alias-border-l1);
        font-size: 12.5px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
      .dc-traj-time { color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
      .dc-traj-type { color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; }
      .dc-traj-text { min-width: 0; overflow: hidden; text-overflow: ellipsis;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .dc-traj-row[data-tone='turn'] { color: var(--dsw-alias-label-primary); font-weight: 500;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 50%, transparent); }
      .dc-traj-row[data-tone='user'] .dc-traj-type { color: var(--dsw-alias-brand-primary); }
      .dc-traj-row[data-tone='tool'] .dc-traj-type { color: var(--dsw-alias-label-secondary); }
      .dc-empty { padding: 48px 16px; text-align: center; color: var(--dsw-alias-label-tertiary);
        font-size: 13px; line-height: 20px; }
      .dc-chat-error { margin: 0 24px 8px; }
      @media (max-width: 900px) {
        .dc-head { padding-inline: 16px; }
        .dc-scroll { padding: 12px 16px; }
        .dc-composer { padding-inline: 12px; }
        .dc-context-card { width: 210px; }
        .dc-traj-row { grid-template-columns: 44px 66px minmax(0, 1fr); gap: 8px; }
      }
    `

    return {
      inject: ['slots', 'layout', 'locale', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        const sessions = ctx.get('sessions')
        let workspaceStore
        try { workspaceStore = ctx.get('workspaces') } catch (_error) { workspaceStore = undefined }
        const locale = ctx.get('locale')
        const hostStore = createStore({ state: null, status: 'loading', error: '' })
        const modelStore = createStore({ status: 'idle', catalog: null, error: '' })
        const hostRequest = async (path, init) => {
          const response = await fetch(`/botmode/api/${path}`, {
            credentials: 'include', cache: 'no-store', ...init,
          })
          let payload
          try { payload = await response.json() } catch (_failure) { payload = null }
          if (!payload || payload.ok !== true) {
            throw new Error((payload && payload.error) || `Bot mode API answered ${response.status}`)
          }
          return payload
        }
        const refreshHost = async () => {
          try {
            const payload = await hostRequest('state')
            hostStore.set({ state: payload.state, status: 'ready', error: '' })
          } catch (error) {
            hostStore.set({
              state: hostStore.getSnapshot().state,
              status: 'error',
              error: error && error.message ? error.message : String(error),
            })
          }
        }
        const hostCommand = async (type, payload = {}) => {
          const response = await hostRequest('command', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type, ...payload }),
          })
          hostStore.set({ state: response.state, status: 'ready', error: '' })
          return response.result
        }
        let modelLoad = null
        const loadModels = async (force = false) => {
          if (modelLoad) return modelLoad
          modelStore.set({ ...modelStore.getSnapshot(), status: 'loading', error: '' })
          modelLoad = hostRequest(`models${force ? '?force=1' : ''}`)
            .then((payload) => {
              modelStore.set({ status: 'ready', catalog: payload.catalog, error: '' })
              return payload.catalog
            })
            .catch((error) => {
              modelStore.set({
                status: 'error',
                catalog: modelStore.getSnapshot().catalog,
                error: error && error.message ? error.message : String(error),
              })
              return undefined
            })
            .finally(() => { modelLoad = null })
          return modelLoad
        }
        // Components keep their old roster/groups props; both now read the Host
        // snapshot, so every browser and cold Bot sees the same data.
        // getSnapshot must return the SAME reference until the Host state object
        // changes; a fresh [] or a fresh map on every read makes React re-render
        // until it gives up ("Maximum update depth exceeded") and blanks the panel.
        const EMPTY_BOTS = []
        const roster = {
          getSnapshot: () => {
            const state = hostStore.getSnapshot().state
            return state && Array.isArray(state.bots) ? state.bots : EMPTY_BOTS
          },
          subscribe: listener => hostStore.subscribe(listener),
        }
        let groupCache = { state: undefined, value: EMPTY_BOTS }
        const groupStore = {
          getSnapshot: () => {
            const state = hostStore.getSnapshot().state
            if (!state || !Array.isArray(state.rooms)) return EMPTY_BOTS
            if (groupCache.state === state) return groupCache.value
            groupCache = {
              state,
              value: state.rooms.map(room => ({
                ...room,
                members: room.memberIds || [],
                messages: (room.transcript || []).map(item => ({
                  ...item,
                  at: Number.isFinite(Date.parse(item.at)) ? Date.parse(item.at) : Date.now(),
                })),
              })),
            }
            return groupCache.value
          },
          subscribe: listener => hostStore.subscribe(listener),
        }
        const writeRoster = () => {}
        const saveGroups = () => {}
        const appendGroupMessage = () => {}
        const markGroupSeen = () => {}
        ctx.effect(() => {
          void refreshHost()
          const timer = window.setInterval(() => {
            if (document.visibilityState !== 'hidden') void refreshHost()
          }, 3000)
          return () => window.clearInterval(timer)
        }, 'botmode: host state polling')
        // Both spaces share one Host session list and one Workspace registry, and
        // neither has a filter API. This plugin therefore narrows the snapshots the
        // Harness sidebar reads: Harness mode shows only non-Bot entries, Bot mode
        // only Bot entries. The raw snapshots stay private to this plugin, so the Bot
        // pane always sees everything it owns.
        const workspaceSvc = ctx.get('workspaces')
        const rawSessionSnapshot = sessions.list.getSnapshot.bind(sessions.list)
        const rawWorkspaceSnapshot = workspaceSvc.list.getSnapshot.bind(workspaceSvc.list)
        const botDirs = () => roster.getSnapshot().map(bot => bot.dir).filter(dir => typeof dir === 'string' && dir !== '')
        const botSessionIds = () => new Set(roster.getSnapshot().map(bot => bot.sessionId).filter(Boolean))
        const underBotDir = (path) => {
          if (typeof path !== 'string' || path === '') return false
          return botDirs().some(dir => path === dir || path.startsWith(`${dir}/`))
        }
        let botSpace = false
        let sessionCache = { source: null, mode: null, value: null }
        let workspaceCache = { source: null, mode: null, value: null }
        const filteredSessionSnapshot = () => {
          const state = rawSessionSnapshot()
          if (sessionCache.source === state && sessionCache.mode === botSpace) return sessionCache.value
          const ids = state.ids.filter((id) => {
            const bot = underBotDir(state.byId[id]?.cwd) || botSessionIds().has(id)
            return botSpace ? bot : !bot
          })
          let value = state
          if (ids.length !== state.ids.length) {
            const byId = {}
            for (const id of ids) byId[id] = state.byId[id]
            value = { ...state, ids, byId }
          }
          sessionCache = { source: state, mode: botSpace, value }
          return value
        }
        const filteredWorkspaceSnapshot = () => {
          const state = rawWorkspaceSnapshot()
          if (workspaceCache.source === state && workspaceCache.mode === botSpace) return workspaceCache.value
          const items = (state.items || []).filter((row) => {
            const bot = underBotDir(row && row.path)
            return botSpace ? bot : !bot
          })
          const value = items.length === (state.items || []).length ? state : { ...state, items }
          workspaceCache = { source: state, mode: botSpace, value }
          return value
        }
        const sessionListeners = new Set()
        const workspaceListeners = new Set()
        const rawSessionSubscribe = sessions.list.subscribe.bind(sessions.list)
        const rawWorkspaceSubscribe = workspaceSvc.list.subscribe.bind(workspaceSvc.list)
        sessions.list.getSnapshot = filteredSessionSnapshot
        workspaceSvc.list.getSnapshot = filteredWorkspaceSnapshot
        sessions.list.subscribe = (listener) => {
          sessionListeners.add(listener)
          const off = rawSessionSubscribe(listener)
          return () => {
            sessionListeners.delete(listener)
            off()
          }
        }
        workspaceSvc.list.subscribe = (listener) => {
          workspaceListeners.add(listener)
          const off = rawWorkspaceSubscribe(listener)
          return () => {
            workspaceListeners.delete(listener)
            off()
          }
        }
        const refresh = () => {
          for (const listener of [...sessionListeners]) {
            try { listener() } catch (_error) { /* one consumer's failure must not stop the rest */ }
          }
          for (const listener of [...workspaceListeners]) {
            try { listener() } catch (_error) { /* as above */ }
          }
        }
        const inBotSpace = () => {
          const panel = ctx.layout.panelInfo.getSnapshot()
          return Boolean(panel && panel.activePanelId === PANEL_ID)
        }
        ctx.effect(() => {
          botSpace = inBotSpace()
          refresh()
          return ctx.layout.panelInfo.subscribe(() => {
            const next = inBotSpace()
            if (next === botSpace) return
            botSpace = next
            sessionCache = { source: null, mode: null, value: null }
            workspaceCache = { source: null, mode: null, value: null }
            refresh()
          })
        }, 'botmode: space filter')
        ctx.effect(() => () => {
          sessions.list.getSnapshot = rawSessionSnapshot
          sessions.list.subscribe = rawSessionSubscribe
          workspaceSvc.list.getSnapshot = rawWorkspaceSnapshot
          workspaceSvc.list.subscribe = rawWorkspaceSubscribe
          sessionListeners.clear()
          workspaceListeners.clear()
        }, 'botmode: space filter restore')

        const registerLocales = () => {
          const disposeEn = locale.register(NS, { en: {
            'mode.label': 'Work mode',
            'mode.harness': 'Harness',
            'mode.bot': 'Bot',
          } })
          const disposeZh = locale.register(NS, { zh: {
            'mode.label': '工作模式',
            'mode.harness': 'Harness',
            'mode.bot': 'Bot',
          } })
          return () => { disposeEn(); disposeZh() }
        }
        ctx.effect(registerLocales, 'botmode: dictionaries')

        const useLang = () => useSyncExternalStore(
          listener => locale.subscribe(listener),
          () => locale.getLocale(),
        )

        const useT = () => {
          const snapshot = useLang()
          const dict = useMemo(() => pickDict(snapshot && snapshot.active), [snapshot && snapshot.active])
          return useMemo(() => (key, vars) => interpolate(dict[key] ?? DICT.en[key] ?? key, vars), [dict])
        }

        const useMainPanel = () => useSyncExternalStore(
          listener => ctx.layout.panelInfo.subscribe(listener),
          () => ctx.layout.panelInfo.getSnapshot(),
        )

        const openBot = (bot) => {
          if (!bot.sessionId) return
          ctx.layout.selectPanel(PANEL_ID)
        }

        const toBots = () => ctx.layout.selectPanel(PANEL_ID)
        const toHarness = () => ctx.layout.selectPanel(null)

        const promptBot = async (sessionId, text) => {
          const result = await sessions.using(sessionId, { source: 'botmode' }, (reference) => (
            reference.binding.session.prompt([{ type: 'text', text }], 'queue')
          ))
          return result
        }

        const uiWorkspace = ctx.get('uiWorkspace')
        const workspaces = ctx.get('workspaces')
        const ROOT_KEY = 'dsh.botmode.root.v1'

        const dirnameOf = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '').split('/').slice(0, -1).join('/')
        const safeDirName = (name) => {
          const cleaned = String(name || '').replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim()
          return cleaned === '' ? `bot-${Date.now().toString(36)}` : cleaned.slice(0, 60)
        }
        const ensureRoot = async () => {
          const saved = window.localStorage.getItem(ROOT_KEY)
          if (saved) return saved
          let root = ''
          try {
            const picked = await uiWorkspace.pickDirectory()
            if (picked) root = picked
          } catch (_error) { /* no native picker: derive below */ }
          if (root === '') {
            const items = rawWorkspaceSnapshot().items || []
            const plain = items.find(row => row && typeof row.path === 'string'
              && !row.path.includes('/DSH-Bots/') && !underBotDir(row.path))
            const base = plain ? dirnameOf(plain.path) : ''
            root = base === '' ? '' : `${base}/DSH-Bots`
          }
          root = root.replace(/\/(DSH-Bots)\/\1$/, '/$1')
          if (root === '') throw new Error('Choose a folder for the Bots first.')
          window.localStorage.setItem(ROOT_KEY, root)
          return root
        }
        const ensureRootDir = async (root) => {
          const parent = dirnameOf(root)
          const name = root.split('/').filter(Boolean).pop()
          if (parent === '' || name === undefined) return root
          try {
            await uiWorkspace.createDirectory(parent, name)
          } catch (error) {
            if (!/exist|EEXIST|already/i.test(String(error && error.message))) throw error
          }
          return root
        }
        const ensureDir = async (parent, name, full) => {
          try {
            return await uiWorkspace.createDirectory(parent, name)
          } catch (error) {
            if (/exist|EEXIST|already/i.test(String(error && error.message))) return full
            throw error
          }
        }
        const scaffold = async (sessionId, payload) => {
          try {
            const result = await sessions.using(sessionId, { source: 'botmode' }, (reference) => (
              reference.binding.session.command(`/botmode scaffold ${JSON.stringify(payload)}`)
            ))
            return Boolean(result && result.ok && result.value && result.value.matched === true)
          } catch (_error) {
            return false
          }
        }
        const teamList = () => roster.getSnapshot().map(bot => ({ name: bot.name, role: bot.role || '' }))

        // Roster mutations go to the Host, which owns the Bot directory, the
        // canonical Session and the identity files. The Client only renders.
        const createBot = async (draft) => {
          const result = await hostCommand('bot.save', { draft })
          return result.bot
        }

        const updateBot = async (bot, draft) => {
          const result = await hostCommand('bot.save', { botId: bot.id, draft })
          return result.bot
        }

        const deleteBot = async (bot) => {
          await hostCommand('bot.delete', { botId: bot.id })
        }

        const migrateBot = async (bot) => {
          await hostCommand('bot.save', { botId: bot.id, draft: { ...bot } })
        }

        const sessionOf = (state, bot) => (state && state.byId ? state.byId[bot.sessionId] : undefined)

        function BotForm(props) {
          const t = useT()
          const [draft, setDraft] = useState(props.initial)
          const [busy, setBusy] = useState(false)
          const [error, setError] = useState('')
          const models = props.models || { status: 'idle', catalog: null, error: '' }
          const catalog = models.catalog
          const groups = (catalog && Array.isArray(catalog.groups)) ? catalog.groups : []
          const current = draft.model || EMPTY_MODEL
          const mode = current.provider && current.model ? 'custom' : 'default'
          const group = groups.find(item => item.id === current.provider)
          const entry = group ? (group.models || []).find(item => item.id === current.model) : undefined
          const efforts = (entry && entry.reasoning && Array.isArray(entry.reasoning.efforts)) ? entry.reasoning.efforts : []
          const setModel = (patch) => setDraft({ ...draft, model: { ...EMPTY_MODEL, ...(draft.model || {}), ...patch } })
          const chooseMode = (next) => {
            if (next === 'default') {
              setModel({ provider: '', model: '', reasoningEffort: '' })
              return
            }
            const preferred = catalog && catalog.default && groups.some(item => item.id === catalog.default.provider)
              ? catalog.default
              : groups[0] ? { provider: groups[0].id, model: (groups[0].models[0] || {}).id } : undefined
            setModel({
              provider: preferred ? preferred.provider : '',
              model: preferred && preferred.model ? preferred.model : '',
              reasoningEffort: preferred && preferred.reasoningEffort ? preferred.reasoningEffort : '',
            })
          }
          const changeProvider = (providerId) => {
            const next = groups.find(item => item.id === providerId)
            setModel({ provider: providerId, model: next && next.models[0] ? next.models[0].id : '', reasoningEffort: '' })
          }
          const changeModel = (modelId) => setModel({ provider: current.provider, model: modelId, reasoningEffort: '' })
          const catalogReady = groups.length > 0
          const defaultSelection = catalog && catalog.default ? catalog.default : undefined
          const containerLabel = (item) => {
            const marker = item.vision === true ? ` · ${t('form.visionYes')}` : item.vision === false ? ` · ${t('form.visionNo')}` : ''
            return `${item.name}${marker}`
          }
          const modelFields = mode === 'default'
            ? h('div', { className: 'bm-model-default' },
              h('div', { className: 'bm-model-hint' }, t('form.modelDefaultHint')),
              defaultSelection
                ? h('div', { className: 'bm-model-now' }, t('form.modelDefaultNow', {
                  model: `${defaultSelection.provider}/${defaultSelection.model}${reasoningNameOf(catalog, defaultSelection) ? ` · ${reasoningNameOf(catalog, defaultSelection)}` : ''}`,
                }))
                : null,
              models.status === 'loading' ? h('div', { className: 'bm-model-hint' }, t('form.modelLoading')) : null,
              models.status === 'error'
                ? h('div', { className: 'bm-error' }, t('form.modelError', { msg: models.error || '' }))
                : null)
            : catalogReady
              ? h('div', { className: 'bm-model-custom' },
                h('div', { className: 'bm-row' },
                  h('label', { className: 'bm-label' }, t('form.modelProvider'),
                    h('select', {
                      className: 'bm-input', value: current.provider,
                      onChange: event => changeProvider(event.target.value),
                    },
                      groups.map(item => h('option', { key: item.id, value: item.id }, item.name)),
                      current.provider && !groups.some(item => item.id === current.provider)
                        ? h('option', { value: current.provider }, `${current.provider} (${t('model.unknown')})`)
                        : null)),
                  h('label', { className: 'bm-label' }, t('form.modelPick'),
                    h('select', {
                      className: 'bm-input', value: current.model,
                      onChange: event => changeModel(event.target.value),
                    },
                      h('option', { value: '' }, t('form.modelPickPlaceholder')),
                      (group ? group.models : []).map(item => h('option', { key: item.id, value: item.id }, containerLabel(item))),
                      current.model && (!group || !group.models.some(item => item.id === current.model))
                        ? h('option', { value: current.model }, `${current.model} (${t('model.unknown')})`)
                        : null))),
                h('div', { className: 'bm-row' },
                  h('label', { className: 'bm-label' }, t('form.reasoning'),
                    efforts.length === 0
                      ? h('div', { className: 'bm-model-empty' }, t('form.reasoningNone'))
                      : h('select', {
                        className: 'bm-input',
                        value: current.reasoningEffort || '',
                        onChange: event => setModel({ reasoningEffort: event.target.value }),
                      },
                        h('option', { value: '' }, t('form.reasoningDefault')),
                        efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name)),
                        current.reasoningEffort && !efforts.some(effort => effort.id === current.reasoningEffort)
                          ? h('option', { value: current.reasoningEffort }, current.reasoningEffort)
                          : null)),
                  h('div', { className: 'bm-label' }, t('form.vision'),
                    h('div', { className: 'bm-model-caps' },
                      h('span', {
                        className: 'bm-cap',
                        'data-state': entry && entry.vision === true ? 'yes' : entry && entry.vision === false ? 'no' : 'unknown',
                      }, entry && entry.vision === true
                        ? t('form.visionYes')
                        : entry && entry.vision === false ? t('form.visionNo') : t('form.visionUnknown'))))))
              : h('div', { className: 'bm-model-manual' },
                models.status === 'loading' ? h('div', { className: 'bm-model-hint' }, t('form.modelLoading')) : null,
                models.status === 'error'
                  ? h('div', { className: 'bm-error' }, t('form.modelError', { msg: models.error || '' }))
                  : null,
                h('div', { className: 'bm-model-hint' }, t('form.modelManual')),
                h('div', { className: 'bm-row' },
                  h('label', { className: 'bm-label' }, t('form.provider'),
                    h('input', {
                      className: 'bm-input', value: current.provider,
                      placeholder: t('form.providerPlaceholder'),
                      onChange: event => setModel({ provider: event.target.value }),
                    })),
                  h('label', { className: 'bm-label' }, t('form.model'),
                    h('input', {
                      className: 'bm-input', value: current.model,
                      placeholder: t('form.modelPlaceholder'),
                      onChange: event => setModel({ model: event.target.value }),
                    })),
                  h('label', { className: 'bm-label' }, t('form.reasoning'),
                    h('input', {
                      className: 'bm-input', value: current.reasoningEffort || '',
                      placeholder: t('form.reasoningDefault'),
                      onChange: event => setModel({ reasoningEffort: event.target.value }),
                    }))))
          const modelBox = h('div', { className: 'bm-model-box' },
            h('div', { className: 'bm-model-head' },
              h('span', { className: 'bm-model-title' }, t('form.modelMode')),
              h('div', { className: 'bm-seg' },
                h('button', {
                  type: 'button', 'data-active': mode === 'default',
                  onClick: () => chooseMode('default'),
                }, t('form.modelDefault')),
                h('button', {
                  type: 'button', 'data-active': mode === 'custom',
                  onClick: () => chooseMode('custom'),
                }, t('form.modelCustom'))),
              props.onReloadModels && (models.status === 'error' || catalogReady)
                ? h('button', {
                  type: 'button', className: 'bm-btn small',
                  onClick: () => props.onReloadModels(true),
                }, t('form.modelRefresh'))
                : null),
            modelFields,
            catalog && Array.isArray(catalog.failures) && catalog.failures.length > 0
              ? h('div', { className: 'bm-model-hint' }, catalog.failures.map(failure => `${failure.name}: ${failure.message}`).join(' · '))
              : null)
          const submit = async (event) => {
            event.preventDefault()
            if (busy) return
            const name = String(draft.name || '').trim()
            if (name === '') return
            const model = draft.model || EMPTY_MODEL
            if ((model.provider === '') !== (model.model === '')) {
              setError(t('form.modelNeed'))
              return
            }
            setBusy(true)
            setError('')
            try {
              const value = { ...draft, name }
              if (props.mode === 'create') await createBot(value, props.lang)
              else await updateBot(props.bot, value, props.lang)
              props.onDone()
            } catch (failure) {
              setError(interpolate(t(props.mode === 'create' ? 'err.create' : 'err.update'), {
                msg: failure && failure.message ? failure.message : String(failure),
              }))
            } finally {
              setBusy(false)
            }
          }
          return h('form', { className: 'bm-form', onSubmit: submit },
            h('h2', null, t(props.mode === 'create' ? 'form.createTitle' : 'form.editTitle')),
            props.mode === 'create' ? h('p', { className: 'bm-form-hint' }, t('form.hint')) : null,
            h('div', { className: 'bm-row' },
              h('label', { className: 'bm-label' }, t('form.name'),
                h('input', {
                  className: 'bm-input', value: draft.name, autoFocus: true,
                  placeholder: t('form.namePlaceholder'),
                  onChange: event => setDraft({ ...draft, name: event.target.value }),
                })),
              h('label', { className: 'bm-label' }, t('form.role'),
                h('input', {
                  className: 'bm-input', value: draft.role,
                  placeholder: t('form.rolePlaceholder'),
                  onChange: event => setDraft({ ...draft, role: event.target.value }),
                }))),
            h('label', { className: 'bm-label' }, t('form.instructions'),
              h('textarea', {
                className: 'bm-area', value: draft.instructions, rows: 4,
                placeholder: t('form.instructionsPlaceholder'),
                onChange: event => setDraft({ ...draft, instructions: event.target.value }),
              })),
            h('div', { className: 'bm-row' },
              h('label', { className: 'bm-label' }, t('form.section'),
                h('select', {
                  className: 'bm-input',
                  value: draft.sectionId || 'general',
                  onChange: event => setDraft({ ...draft, sectionId: event.target.value }),
                }, (props.sections && props.sections.length > 0 ? props.sections : [{ id: 'general', name: 'General' }]).map(section => h('option', { key: section.id, value: section.id },
                  section.nameZh || section.name)))),
              h('label', { className: 'bm-label' }, t('form.color'),
                h('div', { className: 'bm-swatches' }, COLORS.map(color => h('button', {
                  key: color, type: 'button', className: 'bm-swatch', title: color,
                  style: { background: color }, 'data-active': draft.color === color,
                  onClick: () => setDraft({ ...draft, color }),
                }))))),
            modelBox,
            h('label', { className: 'bm-label' }, t('form.approval'),
              h('select', {
                className: 'bm-input',
                value: draft.approvalPolicy || 'ask',
                onChange: event => setDraft({ ...draft, approvalPolicy: event.target.value }),
              },
                h('option', { value: 'ask' }, t('approval.ask')),
                h('option', { value: 'always' }, t('approval.allowAlways')),
                h('option', { value: 'never' }, t('approval.denyAlways')))),
            h('label', { className: 'bm-label' }, t('form.tools'),
              h('input', {
                className: 'bm-input',
                value: ((draft.tools && draft.tools.allow) || []).join(', '),
                placeholder: t('form.toolsPlaceholder'),
                onChange: event => setDraft({
                  ...draft,
                  tools: {
                    ...(draft.tools || {}),
                    allow: event.target.value.split(',').map(item => item.trim()).filter(Boolean),
                  },
                }),
              })),
            error ? h('div', { className: 'bm-error' }, error) : null,
            h('div', { className: 'bm-form-actions' },
              h('button', { type: 'button', className: 'bm-btn', onClick: props.onCancel }, t('form.cancel')),
              h('button', { type: 'submit', className: 'bm-btn primary', disabled: busy || String(draft.name).trim() === '' },
                busy ? t('form.busy') : t(props.mode === 'create' ? 'form.create' : 'form.save'))),
          )
        }

        function BriefBox(props) {
          const t = useT()
          const [text, setText] = useState('')
          const [picked, setPicked] = useState([])
          const [busy, setBusy] = useState(false)
          const [notice, setNotice] = useState('')
          const toggle = (id) => setPicked(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))
          const send = async () => {
            if (busy) return
            if (String(text).trim() === '') { setNotice(t('brief.needText')); return }
            const targets = props.bots.filter(bot => picked.includes(bot.id) && bot.sessionId)
            if (targets.length === 0) { setNotice(t('brief.pick')); return }
            setBusy(true)
            setNotice('')
            try {
              for (const bot of targets) {
                await props.onCommand('bot.dispatch', { botId: bot.id, text: `[Team brief from the user] ${String(text).trim()}` })
              }
              setText('')
              setNotice(t('brief.sent', { n: targets.length }))
            } catch (failure) {
              setNotice(interpolate(t('err.brief'), { msg: failure && failure.message ? failure.message : String(failure) }))
            } finally {
              setBusy(false)
            }
          }
          return h('section', { className: 'bm-brief' },
            h('h2', null, t('brief.title')),
            h('p', null, t('brief.body')),
            h('div', { className: 'bm-picks' }, props.bots.map(bot => h('label', {
              key: bot.id, className: 'bm-pick', 'data-on': picked.includes(bot.id),
            },
              h('input', {
                type: 'checkbox', checked: picked.includes(bot.id),
                onChange: () => toggle(bot.id),
              }),
              bot.name))),
            h('textarea', {
              className: 'bm-area', rows: 3, value: text, placeholder: t('brief.placeholder'),
              onChange: event => setText(event.target.value),
            }),
            h('div', { className: 'bm-form-actions' },
              notice ? h('span', { className: 'bm-ok', style: { marginRight: 'auto' } }, notice) : null,
              h('button', { type: 'button', className: 'bm-btn primary', disabled: busy, onClick: send },
                busy ? t('form.busy') : t('brief.send'))),
          )
        }

        function BotCard(props) {
          const t = useT()
          const [confirming, setConfirming] = useState(false)
          const [migrating, setMigrating] = useState(false)
          const bot = props.bot
          const migrate = async () => {
            if (migrating) return
            setMigrating(true)
            try {
              await props.onMigrate(bot)
            } catch (_error) { /* the card keeps its old record on failure */ } finally {
              setMigrating(false)
            }
          }
          const summary = props.summary
          return h('article', { className: 'bm-card' },
            h('div', { className: 'bm-card-top' },
              h('span', { className: 'bm-avatar', style: { background: bot.color || COLORS[0] } }, initialOf(bot.name)),
              h('div', null,
                h('div', { className: 'bm-name' }, bot.name),
                h('div', { className: 'bm-role' }, bot.role || '—')),
              h('span', { className: 'bm-chip' },
                !summary ? t('card.missing') : summary.running ? t('card.working') : t('card.ready'))),
            h('p', { className: 'bm-desc' }, bot.instructions || t('form.instructionsPlaceholder')),
            bot.dir
              ? h('div', { className: 'bm-dir', title: bot.dir }, `${t('card.workspace')} · ${bot.dir}`)
              : null,
            confirming
              ? h('div', { className: 'bm-card-actions' },
                h('span', { className: 'bm-ok', style: { width: '100%' } }, t('card.confirm')),
                h('button', { className: 'bm-btn small', onClick: () => setConfirming(false) }, t('card.cancel')),
                h('button', { className: 'bm-btn small danger', onClick: () => { props.onDelete(bot); setConfirming(false) } }, t('card.delete')))
              : h('div', { className: 'bm-card-actions' },
                !bot.dir
                  ? h('button', { className: 'bm-btn small', disabled: migrating, onClick: migrate },
                    migrating ? t('card.migrating') : t('card.migrate'))
                  : null,
                h('button', {
                  className: 'bm-btn small primary', disabled: !summary,
                  onClick: () => { if (summary) props.onOpen(bot) },
                }, t('card.open')),
                h('button', { className: 'bm-btn small', onClick: () => props.onEdit(bot) }, t('card.edit')),
                h('button', { className: 'bm-btn small danger', onClick: () => setConfirming(true) }, t('card.delete'))),
          )
        }

        function SessionRow(props) {
          const t = useT()
          const summary = props.summary
          const time = summary && typeof summary.updatedAt === 'number'
            ? new Date(summary.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : ''
          return h('button', {
            type: 'button',
            className: 'bm-srow',
            'data-primary': props.primary === true,
            onClick: props.onOpen,
          },
            h('span', { className: 'bm-srow-dot', 'data-running': Boolean(summary && summary.running) }),
            h('span', { className: 'bm-srow-title' }, props.title),
            time ? h('span', { className: 'bm-srow-time' }, time) : null)
        }

        function RoutineSection(props) {
          const t = useT()
          const [open, setOpen] = useState(false)
          const [name, setName] = useState('')
          const [cron, setCron] = useState('0 9 * * 1-5')
          const [prompt, setPrompt] = useState('')
          const [error, setError] = useState('')
          const [busy, setBusy] = useState(false)
          const routines = props.routines || []
          const act = (command, payload) => {
            setBusy(true)
            setError('')
            props.onCommand(command, payload)
              .catch((failure) => setError(failure && failure.message ? failure.message : String(failure)))
              .finally(() => setBusy(false))
          }
          const submit = async (event) => {
            event.preventDefault()
            if (busy) return
            setBusy(true)
            setError('')
            try {
              await props.onCommand('routine.save', {
                botId: props.bot.id,
                name: name.trim() || `${props.bot.name} routine`,
                cron: cron.trim(),
                prompt: prompt.trim(),
                enabled: true,
              })
              setName('')
              setPrompt('')
              setOpen(false)
            } catch (failure) {
              setError(failure && failure.message ? failure.message : String(failure))
            } finally { setBusy(false) }
          }
          const row = (routine) => h('div', { key: routine.id, className: 'bm-routine' },
            h('div', { className: 'bm-routine-text' },
              h('div', { className: 'bm-routine-name' }, routine.name),
              h('div', { className: 'bm-routine-meta' },
                `${routine.cron}${routine.nextAt ? ` · ${t('routine.next')} ${new Date(routine.nextAt).toLocaleString()}` : ''}`),
              h('div', { className: 'bm-routine-prompt' }, routine.prompt)),
            h('div', { className: 'bm-routine-actions' },
              h('button', {
                className: 'bm-btn small', disabled: busy,
                onClick: () => act('routine.run', { routineId: routine.id }),
              }, t('routine.run')),
              h('button', {
                className: 'bm-btn small', disabled: busy,
                onClick: () => act('routine.toggle', { routineId: routine.id, enabled: !routine.enabled }),
              }, routine.enabled ? t('routine.pause') : t('routine.resume')),
              h('button', {
                className: 'bm-btn small danger', disabled: busy,
                onClick: () => act('routine.delete', { routineId: routine.id }),
              }, t('card.delete'))))
          const form = open ? h('form', { className: 'bm-routine-form', onSubmit: submit },
            h('div', { className: 'bm-row' },
              h('label', { className: 'bm-label' }, t('routine.name'),
                h('input', {
                  className: 'bm-input', value: name, placeholder: `${props.bot.name} routine`,
                  onChange: event => setName(event.target.value),
                })),
              h('label', { className: 'bm-label' }, t('routine.cron'),
                h('input', {
                  className: 'bm-input', value: cron, placeholder: '0 9 * * 1-5',
                  onChange: event => setCron(event.target.value),
                }))),
            h('label', { className: 'bm-label' }, t('routine.prompt'),
              h('textarea', {
                className: 'bm-input', rows: 3, value: prompt,
                placeholder: t('routine.promptPlaceholder'),
                onChange: event => setPrompt(event.target.value),
              })),
            h('p', { className: 'bm-form-hint' }, t('routine.hint')),
            error ? h('div', { className: 'bm-error' }, error) : null,
            h('div', { className: 'bm-form-actions' },
              h('button', {
                type: 'submit', className: 'bm-btn primary',
                disabled: busy || prompt.trim() === '',
              }, t('routine.create')))) : null
          return h('section', { className: 'bm-block' },
            h('div', { className: 'bm-block-head' },
              h('h3', null, t('detail.routines')),
              h('button', { className: 'bm-section-add', onClick: () => setOpen(value => !value) }, t('routine.new'))),
            routines.length === 0 ? h('p', { className: 'bm-muted' }, t('routine.none')) : null,
            routines.length > 0 ? h('div', { className: 'bm-routine-list' }, routines.map(row)) : null,
            form)
        }

        function BotDetail(props) {
          const t = useT()
          const [confirming, setConfirming] = useState(false)
          const [migrating, setMigrating] = useState(false)
          const bot = props.bot
          const summary = props.summary
          const catalog = props.models && props.models.catalog
          const modelSelection = effectiveModelOf(catalog, bot.model)
          const vision = modelVisionOf(catalog, modelSelection)
          const migrate = async () => {
            if (migrating) return
            setMigrating(true)
            try { await props.onMigrate(bot) } catch (_error) { /* keep the record */ } finally { setMigrating(false) }
          }
          return h('div', { className: 'bm-detail' },
            h('header', { className: 'bm-dhead' },
              h('span', { className: 'bm-avatar bm-avatar-lg', style: { background: bot.color || COLORS[0] } }, initialOf(bot.name)),
              h('div', { className: 'bm-dhead-text' },
                h('div', { className: 'bm-name bm-name-lg' }, bot.name),
                h('div', { className: 'bm-role' }, bot.role || '—'),
                bot.dir ? h('div', { className: 'bm-dir', title: bot.dir }, `${t('detail.workspace')} · ${bot.dir}`) : null)),
            h('div', { className: 'bm-dactions' },
              h('button', { className: 'bm-btn primary', disabled: !bot.sessionId, onClick: () => bot.sessionId && props.onOpen(bot) }, t('card.open')),
              !bot.dir
                ? h('button', { className: 'bm-btn', disabled: migrating, onClick: migrate },
                  migrating ? t('card.migrating') : t('card.migrate'))
                : null,
              h('button', { className: 'bm-btn', onClick: () => props.onEdit(bot) }, t('card.edit')),
              confirming
                ? h('span', { className: 'bm-confirm' },
                  h('span', null, t('card.confirm')),
                  h('button', { className: 'bm-btn small', onClick: () => setConfirming(false) }, t('card.cancel')),
                  h('button', { className: 'bm-btn small danger', onClick: () => { props.onDelete(bot); setConfirming(false) } }, t('card.delete')))
                : h('button', { className: 'bm-btn danger', onClick: () => setConfirming(true) }, t('card.delete'))),
            h('section', { className: 'bm-block' },
              h('h3', null, t('detail.instructions')),
              h('p', null, bot.instructions || t('form.instructionsPlaceholder'))),
            h('section', { className: 'bm-block' },
              h('h3', null, t('detail.model')),
              h('p', null, describeModel(t, catalog, bot.model)),
              h('div', { className: 'bm-model-caps' },
                h('span', {
                  className: 'bm-cap',
                  'data-state': vision === true ? 'yes' : vision === false ? 'no' : 'unknown',
                }, vision === true ? t('form.visionYes') : vision === false ? t('form.visionNo') : t('form.visionUnknown')))),
            h('section', { className: 'bm-block' },
              h('h3', null, t('detail.sessions')),
              props.sessions.length === 0
                ? h('p', { className: 'bm-muted' }, t('detail.noSessions'))
                : h('div', { className: 'bm-slist' }, props.sessions.map(row => h(SessionRow, {
                  key: row.id,
                  title: row.title,
                  summary: row.summary,
                  primary: row.primary,
                  onOpen: () => props.onOpenSession(row.id),
                })))),
            h(RoutineSection, {
              bot,
              routines: props.routines,
              onCommand: props.onCommand,
            }),
            props.brief ? props.brief : null,
          )
        }

        function blocksText(blocks) {
          const parts = []
          for (const block of blocks || []) {
            if (!block || typeof block !== 'object') continue
            if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
            else if (block.type === 'tool-call') parts.push(`→ ${block.name || 'tool'}`)
            else if (block.type === 'image') parts.push('[image]')
            else if (block.type === 'file') parts.push(`[file${block.attachment && block.attachment.name ? `: ${block.attachment.name}` : ''}]`)
          }
          return parts.join('\n')
        }

        function normalizeAssistantBlocks(content) {
          const blocks = []
          for (const block of content || []) {
            if (!block || typeof block !== 'object') continue
            if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
              blocks.push({ kind: 'reasoning', text: block.text })
            } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
              blocks.push({ kind: 'text', text: block.text })
            } else if (block.type === 'tool-call') {
              blocks.push({
                kind: 'tool',
                callId: block.id || block.callId || '',
                name: block.name || 'tool',
                arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments || {}),
              })
            }
          }
          return blocks
        }

        function buildTranscript(entries) {
          const turns = []
          const calls = new Map()
          const live = { blocks: [], active: false, finished: false }
          const ensureLive = (index, type) => {
            if (!live.blocks[index] || live.blocks[index].kind !== type) {
              live.blocks[index] = type === 'tool'
                ? { kind: 'tool', callId: '', name: '', arguments: '', streaming: true }
                : { kind: type, text: '', streaming: true }
            }
            live.active = true
            return live.blocks[index]
          }
          const resetLive = () => {
            live.blocks = []
            live.active = false
            live.finished = false
          }
          const flushLive = () => {
            const blocks = live.blocks.filter(block => block && (block.kind === 'tool' || (block.text && block.text !== '')))
            if (blocks.length > 0) {
              turns.push({ kind: 'assistant', key: 'live', blocks, streaming: !live.finished })
            }
            live.blocks = []
            live.active = false
            live.finished = false
          }
          for (const entry of entries || []) {
            if (!entry || typeof entry !== 'object') continue
            if (entry.type === 'transient') {
              const chunk = entry.event && entry.event.data && entry.event.data.chunk
              if (!chunk) continue
              const index = Number.isFinite(chunk.index) ? chunk.index : 0
              if (chunk.type === 'block-start') {
                const blockType = chunk.blockType === 'reasoning' ? 'reasoning'
                  : chunk.blockType === 'tool-call' ? 'tool' : 'text'
                live.blocks[index] = blockType === 'tool'
                  ? { kind: 'tool', callId: '', name: '', arguments: '', streaming: true }
                  : { kind: blockType, text: '', streaming: true }
                live.active = true
              } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                ensureLive(index, 'text').text += chunk.text
              } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                ensureLive(index, 'reasoning').text += chunk.text
              } else if (chunk.type === 'tool-call-delta') {
                const block = ensureLive(index, 'tool')
                if (typeof chunk.id === 'string') block.callId = chunk.id
                if (typeof chunk.name === 'string' && chunk.name !== '') block.name = chunk.name
                if (typeof chunk.argumentsDelta === 'string') block.arguments += chunk.argumentsDelta
              } else if (chunk.type === 'block-end' && chunk.block) {
                const block = chunk.block
                if (block.type === 'reasoning' || block.type === 'text') {
                  live.blocks[index] = { kind: block.type, text: block.text || '', streaming: true }
                } else if (block.type === 'tool-call') {
                  live.blocks[index] = {
                    kind: 'tool',
                    callId: block.id || block.callId || '',
                    name: block.name || 'tool',
                    arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments || {}),
                    streaming: true,
                  }
                }
                live.active = true
              } else if (chunk.type === 'finish') {
                live.finished = true
              }
              continue
            }
            const event = entry.event
            if (!event || typeof event !== 'object') continue
            const data = event.data || {}
            if (event.type === 'user/message') {
              if (!data.source || data.source.kind !== 'user') continue
              const text = blocksText(data.content)
              if (text !== '') turns.push({ kind: 'user', key: `u${event.seq}`, text })
            } else if (event.type === 'assistant/message') {
              resetLive()
              const blocks = normalizeAssistantBlocks((data.message || {}).content)
              if (blocks.length > 0) turns.push({ kind: 'assistant', key: `a${event.seq}`, blocks, streaming: false })
            } else if (event.type === 'tool/call') {
              const callId = data.callId || ''
              if (callId !== '') {
                calls.set(callId, {
                  callId,
                  name: data.name || 'tool',
                  arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments || {}),
                  status: 'running',
                  output: '',
                  isError: false,
                })
              }
            } else if (event.type === 'tool/result') {
              const message = data.message || {}
              const callId = message.toolCallId || (message.source && message.source.callId) || ''
              if (callId !== '') {
                const existing = calls.get(callId) || { callId, name: message.name || 'tool', arguments: '', status: 'done', output: '', isError: false }
                existing.status = message.isError === true ? 'error' : 'done'
                existing.isError = message.isError === true
                existing.output = blocksText(message.content)
                calls.set(callId, existing)
              }
            } else if (event.type === 'turn/end') {
              flushLive()
              const reason = data.reason || {}
              if (reason.kind === 'error') {
                const text = reason.error && reason.error.message ? reason.error.message : 'The turn failed.'
                turns.push({ kind: 'error', key: `e${event.seq}`, text })
              } else if (reason.kind === 'aborted') {
                turns.push({ kind: 'notice', key: `n${event.seq}`, text: 'stopped' })
              }
            }
          }
          flushLive()
          const referenced = new Set()
          for (const turn of turns) {
            if (turn.kind !== 'assistant') continue
            turn.blocks = turn.blocks.map((block) => {
              if (block.kind !== 'tool') return block
              const call = calls.get(block.callId) || {
                callId: block.callId,
                name: block.name || 'tool',
                arguments: block.arguments || '',
                status: 'preparing',
                output: '',
                isError: false,
              }
              if (call.callId) referenced.add(call.callId)
              return { ...block, name: call.name || block.name, call }
            })
          }
          const extra = [...calls.values()].filter(call => !referenced.has(call.callId))
          if (extra.length > 0) {
            turns.push({
              kind: 'assistant',
              key: 'extra-tools',
              blocks: extra.map(call => ({ kind: 'tool', callId: call.callId, name: call.name, call })),
              streaming: false,
            })
          }
          return turns
        }

        function safeHref(value) {
          return /^https?:\/\//i.test(value) ? value : undefined
        }

        function inlineMarkdown(text, keyPrefix) {
          const nodes = []
          const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
          let cursor = 0
          let index = 0
          for (const match of text.matchAll(pattern)) {
            if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
            const token = match[0]
            const key = `${keyPrefix}-i${index++}`
            if (token.startsWith('**')) {
              nodes.push(h('strong', { key }, token.slice(2, -2)))
            } else if (token.startsWith('`')) {
              nodes.push(h('code', { key, className: 'bm-inline-code' }, token.slice(1, -1)))
            } else {
              const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
              const href = link === null ? undefined : safeHref(link[2])
              nodes.push(href
                ? h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, link[1])
                : token)
            }
            cursor = match.index + token.length
          }
          if (cursor < text.length) nodes.push(text.slice(cursor))
          return nodes
        }

        function MarkdownText(props) {
          const t = useT()
          const nodes = []
          const source = String(props.text || '')
          const fence = /```([^\n`]*)\n([\s\S]*?)```/g
          let cursor = 0
          let index = 0
          const pushProse = (prose) => {
            const paragraphs = prose.split(/\n{2,}/)
            for (const paragraph of paragraphs) {
              if (paragraph.trim() === '') continue
              const lines = paragraph.split('\n')
              const cellsOf = line => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim())
              if (lines.length >= 2 && lines[0].includes('|') && cellsOf(lines[1]).every(cell => /^:?-{2,}:?$/.test(cell))) {
                const header = cellsOf(lines[0])
                const body = lines.slice(2).filter(line => line.includes('|')).map(cellsOf)
                nodes.push(h('div', { key: `md-tw${index++}`, className: 'bm-md-table-wrap' },
                  h('table', { className: 'bm-md-table' },
                    h('thead', null, h('tr', null, header.map((cell, cellIndex) => h('th', { key: `th${cellIndex}` }, inlineMarkdown(cell, `th${index}-${cellIndex}`))))),
                    h('tbody', null, body.map((row, rowIndex) => h('tr', { key: `tr${rowIndex}` },
                      header.map((_cell, cellIndex) => h('td', { key: `td${cellIndex}` },
                        inlineMarkdown(row[cellIndex] || '', `td${index}-${rowIndex}-${cellIndex}`)))))))))
                continue
              }
              if (/^#{1,4}\s/.test(lines[0])) {
                const level = Math.min(4, (lines[0].match(/^#+/) || ['#'])[0].length)
                nodes.push(h(`h${level + 2}`, { key: `md-h${index++}`, className: 'bm-md-heading' },
                  inlineMarkdown(lines[0].replace(/^#{1,4}\s/, ''), `h${index}`)))
                continue
              }
              if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
                nodes.push(h('ul', { key: `md-ul${index++}`, className: 'bm-md-list' },
                  lines.map((line, lineIndex) => h('li', { key: `li${lineIndex}` },
                    inlineMarkdown(line.replace(/^\s*[-*]\s+/, ''), `li${index}-${lineIndex}`)))))
                continue
              }
              if (lines.every(line => /^\s*\d+[.)]\s+/.test(line))) {
                nodes.push(h('ol', { key: `md-ol${index++}`, className: 'bm-md-list' },
                  lines.map((line, lineIndex) => h('li', { key: `li${lineIndex}` },
                    inlineMarkdown(line.replace(/^\s*\d+[.)]\s+/, ''), `li${index}-${lineIndex}`)))))
                continue
              }
              if (lines.every(line => /^>\s?/.test(line))) {
                nodes.push(h('blockquote', { key: `md-bq${index++}`, className: 'bm-md-quote' },
                  inlineMarkdown(lines.map(line => line.replace(/^>\s?/, '')).join('\n'), `bq${index}`)))
                continue
              }
              const children = []
              lines.forEach((line, lineIndex) => {
                if (lineIndex > 0) children.push(h('br', { key: `br${lineIndex}` }))
                children.push(...inlineMarkdown(line, `p${index}-${lineIndex}`))
              })
              nodes.push(h('p', { key: `md-p${index++}`, className: 'bm-md-p' }, children))
            }
          }
          for (const match of source.matchAll(fence)) {
            if (match.index > cursor) pushProse(source.slice(cursor, match.index))
            const language = (match[1] || '').trim()
            const code = match[2] || ''
            nodes.push(h(CodeBlock, { key: `md-code${index++}`, language, code, t }))
            cursor = match.index + match[0].length
          }
          if (cursor < source.length) pushProse(source.slice(cursor))
          return h('div', { className: props.className || 'bm-md' }, nodes)
        }

        function CodeBlock(props) {
          const [copied, setCopied] = useState(false)
          const copy = async () => {
            try {
              await navigator.clipboard.writeText(props.code)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            } catch (_error) { /* clipboard unavailable */ }
          }
          return h('div', { className: 'bm-code' },
            h('div', { className: 'bm-code-head' },
              h('span', { className: 'bm-code-lang' }, props.language || 'text'),
              h('button', { type: 'button', className: 'bm-code-copy', onClick: copy },
                props.t(copied ? 'chat.copied' : 'chat.copy'))),
            h('pre', null, h('code', null, props.code)))
        }

        function ToolGlyph(props) {
          const name = String(props.name || '').toLowerCase()
          const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': true }
          if (name === 'bash' || name === 'shell') {
            return h('svg', common, h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }), h('path', { d: 'M4 6l2 2-2 2M8.5 10h3.5' }))
          }
          if (name === 'read' || name === 'write' || name === 'edit') {
            return h('svg', common, h('path', { d: 'M3 2h7l3 3v9H3z' }), h('path', { d: 'M9.5 2v3.5H13' }))
          }
          if (name === 'grep' || name === 'glob' || name === 'web_search') {
            return h('svg', common, h('circle', { cx: 7, cy: 7, r: 4.2 }), h('path', { d: 'M10.2 10.2L14 14' }))
          }
          if (name === 'web_fetch') {
            return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.8 }), h('path', { d: 'M2.4 8h11.2M8 2.2c2.8 3.4 2.8 8.2 0 11.6M8 2.2c-2.8 3.4-2.8 8.2 0 11.6' }))
          }
          if (name === 'skill' || name === 'bot_team' || name === 'message_agent') {
            return h('svg', common, h('path', { d: 'M8 1.8l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 10.6l-3.5 1.9.8-3.9L2.4 5.9l3.9-.5z' }))
          }
          return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.6 }), h('path', { d: 'M8 5.2v3.2l2.2 1.4' }))
        }

        function toolSummary(call) {
          const raw = String((call && call.arguments) || '').trim()
          if (raw === '') return ''
          try {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object') {
              for (const key of ['description', 'command', 'path', 'query', 'name', 'target', 'url']) {
                if (typeof parsed[key] === 'string' && parsed[key] !== '') return parsed[key]
              }
              const first = Object.values(parsed).find(value => typeof value === 'string')
              if (typeof first === 'string') return first
            }
          } catch (_error) { /* show raw below */ }
          return raw
        }

        function ToolCallRow(props) {
          const t = useT()
          const call = props.call || {}
          const [open, setOpen] = useState(false)
          const status = call.status || 'preparing'
          const summary = toolSummary(call)
          const output = String(call.output || '')
          const expandable = status !== 'preparing' && (String(call.arguments || '') !== '' || output !== '')
          return h('div', { className: 'bm-tool', 'data-state': status },
            h('button', {
              type: 'button', className: 'bm-tool-head', onClick: () => expandable && setOpen(value => !value),
              'aria-expanded': expandable ? open : undefined,
            },
              h('span', { className: 'bm-tool-icon' }, h(ToolGlyph, { name: call.name || props.name })),
              h('span', { className: 'bm-tool-name' }, call.name || props.name || 'tool'),
              summary !== '' ? h('span', { className: 'bm-tool-summary' }, summary) : null,
              status === 'running' || status === 'preparing'
                ? h('span', { className: 'bm-spin', 'aria-label': t('chat.toolRunning') })
                : h('span', { className: 'bm-tool-state' },
                  t(status === 'error' ? 'chat.toolError' : 'chat.toolDone')),
              expandable ? h('span', { className: 'bm-tool-chevron', 'data-open': open }, '›') : null),
            open && expandable ? h('div', { className: 'bm-tool-body' },
              String(call.arguments || '') !== ''
                ? h('div', { className: 'bm-tool-section' },
                  h('div', { className: 'bm-tool-label' }, t('chat.toolArgs')),
                  h('pre', null, String(call.arguments)))
                : null,
              h('div', { className: 'bm-tool-section' },
                h('div', { className: 'bm-tool-label' }, t('chat.toolOutput')),
                output === '' ? h('div', { className: 'bm-tool-empty' }, t('chat.emptyTool')) : h('pre', null, output))) : null)
        }

        function ReasoningRow(props) {
          const t = useT()
          const [open, setOpen] = useState(false)
          const text = String(props.text || '')
          const summary = (text.split(/\r?\n/).find(line => line.trim() !== '') || '').replaceAll('**', '').slice(0, 140)
          return h('div', { className: 'bm-reason', 'data-running': props.running === true },
            h('button', { type: 'button', className: 'bm-reason-head', onClick: () => setOpen(value => !value) },
              h('span', { className: 'bm-reason-icon', 'data-running': props.running === true }, h(ToolGlyph, { name: 'reasoning' })),
              h('span', { className: 'bm-reason-title' }, t('chat.reasoning')),
              summary !== '' && !open
                ? h('span', { className: 'bm-reason-summary', 'data-shimmer': props.running === true }, summary)
                : null,
              h('span', { className: 'bm-tool-chevron', 'data-open': open }, '›')),
            open ? h('div', { className: 'bm-reason-body' }, h(MarkdownText, { text })) : null)
        }

        function AssistantTurn(props) {
          const t = useT()
          return h('div', { className: 'bm-turn', 'data-streaming': props.turn.streaming === true },
            h('div', { className: 'bm-turn-who' },
              h('span', { className: 'bm-avatar bm-avatar-xs', style: { background: props.bot.color || COLORS[0] } }, initialOf(props.bot.name)),
              h('span', { className: 'bm-turn-name' }, props.bot.name)),
            h('div', { className: 'bm-turn-body' },
              props.turn.blocks.map((block, index) => block.kind === 'reasoning'
                ? h(ReasoningRow, { key: `r${index}`, text: block.text, running: props.turn.streaming === true && index === props.turn.blocks.length - 1 })
                : block.kind === 'tool'
                  ? h(ToolCallRow, { key: `t${index}`, call: block.call, name: block.name })
                  : h('div', { key: `x${index}`, className: 'bm-assistant-text' },
                    h(MarkdownText, { text: block.text }),
                    props.turn.streaming === true && index === props.turn.blocks.length - 1
                      ? h('span', { className: 'bm-cursor' })
                      : null))))
        }
        /* ------------------------------------------------------------------
           DSH conversation replica
           The Bot panel renders the same flow shape as the Harness conversation:
           one settled Turn header, reasoning and tool rows inside it, then the
           answer. Statistics come from the Session log, not from a separate
           Bot-only counter.
           ------------------------------------------------------------------ */
        function formatDurationText(ms, t) {
          const seconds = Math.max(1, Math.round((Number(ms) || 0) / 1000))
          if (seconds < 60) return t('chat.durationSeconds', { seconds })
          return t('chat.durationMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
        }

        function formatClockTime(time) {
          if (!Number.isFinite(time) || time <= 0) return ''
          const date = new Date(time)
          return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        }

        function formatDateText(value) {
          if (!value) return ''
          const date = new Date(value)
          if (Number.isNaN(date.getTime())) return ''
          return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        }

        function formatTokenCount(value) {
          if (!Number.isFinite(value) || value <= 0) return '0'
          if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
          if (value >= 1_000) return `${Math.round(value / 100) / 10}K`
          return String(Math.round(value))
        }

        function pathTail(value) {
          const clean = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
          return clean.split('/').filter(Boolean).pop() || ''
        }

        function toolLabelKey(name) {
          const lower = String(name || '').toLowerCase()
          if (lower === 'bash' || lower === 'shell' || lower === 'terminal') return 'chat.tool.bash'
          if (lower === 'read' || lower === 'read_file') return 'chat.tool.read'
          if (lower === 'write' || lower === 'edit' || lower === 'apply_patch') return 'chat.tool.edit'
          if (lower === 'grep' || lower === 'glob') return 'chat.tool.search'
          if (lower === 'web_search') return 'chat.tool.webSearch'
          if (lower === 'web_fetch') return 'chat.tool.webFetch'
          if (lower === 'skill') return 'chat.tool.skill'
          if (lower === 'bot_team') return 'chat.tool.team'
          if (lower === 'message_agent') return 'chat.tool.message'
          if (lower === 'ask_user_question') return 'chat.tool.question'
          if (lower === 'plan') return 'chat.tool.plan'
          return 'chat.tool.other'
        }

        function reasoningPreview(text, running) {
          const source = String(text || '')
          if (!running) return (source.split(/\r?\n/).find(line => line.trim() !== '') || '').replaceAll('**', '').trim()
          let best = ''
          let start = 0
          const paragraphs = /\r?\n(?:[\t ]*\r?\n)+/g
          for (let match = paragraphs.exec(source); match !== null; match = paragraphs.exec(source)) {
            const first = source.slice(start, match.index).split(/\r?\n/).find(line => line.trim() !== '')
            if (first && first.trim() !== '') best = first.trim()
            start = match.index + match[0].length
          }
          return best.replaceAll('**', '').trim()
        }

        function buildChatFlow(entries) {
          const items = []
          const turns = new Map()
          const calls = new Map()
          const turnStarts = new Map()
          const stepStarts = new Map()
          const stepCounts = new Map()
          let activeTurn = 0
          let stepCount = 0
          let live = { turn: 0, blocks: [], active: false, finished: false }
          let contextWindow = 0
          let latestUsage = null
          let lastRoute = null
          let firstUser = true
          const totals = { output: 0, total: 0, input: 0, cacheRead: 0, cacheWrite: 0, decodeMs: 0 }
          const liveItems = (turn) => {
            const rows = []
            live.blocks.forEach((block, index) => {
              if (!block) return
              if (block.kind === 'reason') rows.push({ kind: 'reason', text: block.text || '', key: `live-${turn}-r${index}`, running: true, time: 0 })
              else if (block.kind === 'text') {
                if ((block.text || '') !== '') rows.push({ kind: 'text', text: block.text, key: `live-${turn}-t${index}`, running: true, time: 0 })
              } else if (block.kind === 'tool') {
                rows.push({ kind: 'tool', callId: block.callId || '', name: block.name || '', key: `live-${turn}-c${index}`, running: true, time: 0 })
              }
            })
            return rows
          }
          const ensureTurn = (turn, time) => {
            let existing = turns.get(turn)
            if (existing) return existing
            existing = {
              kind: 'turn', key: `t${turn}`, turn, items: [], startTime: turnStarts.get(turn) ?? time,
              endTime: 0, reason: '', error: '', stopped: false, streaming: true,
              steps: stepCounts.get(turn) ?? 0, usage: null, liveItems: [],
            }
            turns.set(turn, existing)
            items.push(existing)
            return existing
          }
          for (const entry of entries || []) {
            if (!entry || typeof entry !== 'object') continue
            if (entry.type === 'transient') {
              const chunk = entry.event && entry.event.data && entry.event.data.chunk
              if (!chunk) continue
              const index = Number.isFinite(chunk.index) ? chunk.index : 0
              if (chunk.type === 'block-start') {
                const kind = chunk.blockType === 'reasoning' ? 'reason' : chunk.blockType === 'tool-call' ? 'tool' : 'text'
                live.blocks[index] = kind === 'tool'
                  ? { kind, callId: '', name: '', arguments: '' }
                  : { kind, text: '' }
                live.turn = activeTurn
                live.active = true
              } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                live.blocks[index] = live.blocks[index] || { kind: 'text', text: '' }
                live.blocks[index].text += chunk.text
                live.active = true
              } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                live.blocks[index] = live.blocks[index] || { kind: 'reason', text: '' }
                live.blocks[index].text += chunk.text
                live.active = true
              } else if (chunk.type === 'tool-call-delta') {
                live.blocks[index] = live.blocks[index] || { kind: 'tool', callId: '', name: '', arguments: '' }
                const block = live.blocks[index]
                if (typeof chunk.id === 'string') block.callId = chunk.id
                if (typeof chunk.name === 'string' && chunk.name !== '') block.name = chunk.name
                if (typeof chunk.argumentsDelta === 'string') block.arguments += chunk.argumentsDelta
                live.active = true
              } else if (chunk.type === 'block-end' && chunk.block) {
                const block = chunk.block
                if (block.type === 'reasoning') live.blocks[index] = { kind: 'reason', text: block.text || '' }
                else if (block.type === 'text') live.blocks[index] = { kind: 'text', text: block.text || '' }
                else if (block.type === 'tool-call') {
                  live.blocks[index] = {
                    kind: 'tool', callId: block.id || block.callId || '', name: block.name || 'tool',
                    arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments || {}),
                  }
                }
                live.active = true
              } else if (chunk.type === 'finish') live.finished = true
              continue
            }
            const event = entry.event
            if (!event || typeof event !== 'object') continue
            const data = event.data || {}
            if (event.type === 'request/context' && Number.isFinite(data.contextWindow)) contextWindow = data.contextWindow
            else if (event.type === 'turn/start') {
              activeTurn = data.turn
              turnStarts.set(data.turn, event.time)
              live = { turn: data.turn, blocks: [], active: false, finished: false }
            } else if (event.type === 'step/start') {
              stepCount += 1
              stepStarts.set(`${data.turn}:${data.step}`, event.time)
              stepCounts.set(data.turn, (stepCounts.get(data.turn) ?? 0) + 1)
              const turn = turns.get(data.turn)
              if (turn) turn.steps = stepCounts.get(data.turn)
            } else if (event.type === 'user/message') {
              if (!data.source || data.source.kind !== 'user') continue
              const text = blocksText(data.content)
              if (text !== '') {
                items.push({ kind: 'user', key: `u${event.seq}`, text, time: event.time, context: firstUser })
                firstUser = false
                if (activeTurn > 0) {
                  const turn = ensureTurn(activeTurn, event.time)
                  turn.streaming = true
                }
              }
            } else if (event.type === 'assistant/message') {
              const turnNumber = data.turn ?? activeTurn
              const turn = ensureTurn(turnNumber, event.time)
              const blocks = normalizeAssistantBlocks((data.message || {}).content)
              blocks.forEach((block, index) => {
                if (block.kind === 'reasoning' || block.kind === 'reason') turn.items.push({ kind: 'reason', text: block.text, key: `a${event.seq}-r${index}`, running: false, time: event.time })
                else if (block.kind === 'text') turn.items.push({ kind: 'text', text: block.text, key: `a${event.seq}-t${index}`, running: false, time: event.time })
                else if (block.kind === 'tool') turn.items.push({ kind: 'tool', callId: block.callId, name: block.name, key: `a${event.seq}-c${index}`, running: false, time: event.time })
              })
              if (data.usage) {
                latestUsage = data.usage
                totals.output += data.usage.outputTokens || 0
                totals.total += data.usage.totalTokens || 0
                totals.input += data.usage.inputTokens || 0
                totals.cacheRead += data.usage.cacheReadTokens || 0
                totals.cacheWrite += data.usage.cacheWriteTokens || 0
                turn.usage = data.usage
              }
              for (const part of data.stream || []) {
                if (!Array.isArray(part.dt)) continue
                for (const delta of part.dt) if (Number.isFinite(delta) && delta > 0) totals.decodeMs += delta
              }
              if (data.message && data.message.source) lastRoute = { provider: data.message.source.provider, model: data.message.source.model }
              live = { turn: turnNumber, blocks: [], active: false, finished: false }
            } else if (event.type === 'tool/call') {
              if (!data.callId) continue
              const previous = calls.get(data.callId) || {}
              calls.set(data.callId, {
                ...previous, callId: data.callId, name: data.name || previous.name || 'tool',
                arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments || {}),
                status: previous.status === 'error' ? 'error' : 'running',
                output: previous.output || '', startedAt: previous.startedAt ?? event.time, finishedAt: previous.finishedAt || 0,
              })
            } else if (event.type === 'tool/result') {
              const message = data.message || {}
              const callId = message.toolCallId || (message.source && message.source.callId) || ''
              if (!callId) continue
              const previous = calls.get(callId) || { callId, name: message.name || 'tool', arguments: '', startedAt: event.time }
              calls.set(callId, {
                ...previous, status: message.isError === true ? 'error' : 'done',
                output: blocksText(message.content), finishedAt: event.time,
              })
            } else if (event.type === 'turn/end') {
              const turnNumber = data.turn ?? activeTurn
              const turn = ensureTurn(turnNumber, event.time)
              turn.endTime = event.time
              turn.streaming = false
              const reason = data.reason || {}
              turn.reason = reason.kind || 'completed'
              turn.stopped = reason.kind === 'aborted' || reason.kind === 'interrupted'
              if (reason.kind === 'error') turn.error = reason.error && reason.error.message ? reason.error.message : 'The turn failed.'
              if (live.turn === turnNumber) live = { turn: turnNumber, blocks: [], active: false, finished: false }
            }
          }
          if (live.active) {
            const turn = turns.get(live.turn)
            if (turn) turn.liveItems = liveItems(live.turn)
          }
          const cacheDenominator = totals.input + totals.cacheRead + totals.cacheWrite
          const stats = {
            turns: turns.size,
            steps: stepCount,
            tps: totals.decodeMs > 0 ? totals.output / (totals.decodeMs / 1000) : 0,
            totalTokens: totals.total,
            cacheHit: cacheDenominator > 0 ? totals.cacheRead / cacheDenominator * 100 : null,
            contextPercent: contextWindow > 0 && latestUsage ? latestUsage.totalTokens / contextWindow * 100 : null,
            contextWindow, latestUsage, lastRoute,
          }
          return {
            items, calls, stats, activeTurn,
            runningStart: activeTurn ? (turnStarts.get(activeTurn) ?? 0) : 0,
          }
        }

        function useNow(active) {
          const [now, setNow] = useState(() => Date.now())
          useEffect(() => {
            if (!active) return undefined
            setNow(Date.now())
            const timer = window.setInterval(() => setNow(Date.now()), 1000)
            return () => window.clearInterval(timer)
          }, [active])
          return now
        }

        const GLYPH = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true }

        function ThinkGlyph() {
          return h('svg', GLYPH,
            h('path', { d: 'M6.2 13.2h3.6M6.7 15h2.6' }),
            h('path', { d: 'M8 1.5a4.3 4.3 0 0 0-2.7 7.65c.55.45.85 1.05.85 1.7v.95h3.7v-.95c0-.65.3-1.25.85-1.7A4.3 4.3 0 0 0 8 1.5z' }))
        }
        function PlusGlyph() {
          return h('svg', GLYPH, h('path', { d: 'M8 3.2v9.6M3.2 8h9.6' }))
        }
        function MicGlyph() {
          return h('svg', GLYPH,
            h('rect', { x: 5.2, y: 1.8, width: 5.6, height: 8, rx: 2.8 }),
            h('path', { d: 'M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2' }))
        }
        function SendGlyph() {
          return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M8 12.8V3.2M4.5 6.7L8 3.2l3.5 3.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))
        }
        function StopGlyph() {
          return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true },
            h('rect', { x: 1.8, y: 1.8, width: 8.4, height: 8.4, rx: 2, fill: 'currentColor' }))
        }
        function EllipsisGlyph() {
          return h('svg', GLYPH, h('circle', { cx: 3.2, cy: 8, r: 1.1, fill: 'currentColor', stroke: 'none' }),
            h('circle', { cx: 8, cy: 8, r: 1.1, fill: 'currentColor', stroke: 'none' }),
            h('circle', { cx: 12.8, cy: 8, r: 1.1, fill: 'currentColor', stroke: 'none' }))
        }
        function ChevronGlyph(props) {
          return h('svg', { ...GLYPH, className: props.className, style: props.open ? { transform: 'rotate(180deg)' } : undefined },
            h('path', { d: 'M4 6.2L8 10l4-3.8' }))
        }
        function ActivityGlyph() {
          return h('svg', { ...GLYPH, width: 13, height: 13 },
            h('path', { d: 'M2.2 8a5.8 5.8 0 1 0 1.8-4.2M2.2 2.2v3.2h3.2' }))
        }

        function FlowContextCard(props) {
          const t = useT()
          const bot = props.bot || {}
          const title = bot.name || pathTail(bot.dir) || ''
          const path = String(bot.dir || '')
          const created = formatDateText(bot.createdAt)
          if (title === '' && path === '') return null
          return h('div', { className: 'dc-context-card' },
            h('div', { className: 'dc-context-text' },
              h('div', { className: 'dc-context-name', title }, title),
              path !== '' ? h('div', { className: 'dc-context-path', title: bot.dir }, path) : null,
              created !== '' ? h('div', { className: 'dc-context-meta' }, t('chat.contextCreated', { date: created })) : null))
        }

        function CopyGlyph() {
          return h('svg', { ...GLYPH, width: 12, height: 12 },
            h('rect', { x: 5, y: 5, width: 8, height: 8, rx: 1.5 }),
            h('path', { d: 'M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2H11' }))
        }

        function FlowUser(props) {
          const t = useT()
          const [copied, setCopied] = useState(false)
          const copy = async () => {
            try {
              await navigator.clipboard.writeText(String(props.text || ''))
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            } catch (_error) { /* clipboard unavailable */ }
          }
          return h('div', { className: 'dc-user-row' },
            props.context ? h(FlowContextCard, { bot: props.bot }) : h('div', { className: 'dc-user-spacer' }),
            h('div', { className: 'dc-user-main' },
              h('div', { className: 'dc-user-bubble' }, String(props.text || '')),
              h('div', { className: 'dc-user-meta' },
                formatClockTime(props.time) !== ''
                  ? h('span', null, formatClockTime(props.time))
                  : null,
                h('button', {
                  type: 'button', className: 'dc-user-copy', title: t(copied ? 'chat.copied' : 'chat.copy'),
                  onClick: copy,
                }, h(CopyGlyph))))
          )
        }

        function FlowReasonRow(props) {
          const t = useT()
          const [open, setOpen] = useState(false)
          const text = String(props.text || '')
          const summary = reasoningPreview(text, props.running === true)
          const expandable = text.trim() !== ''
          return h('div', { className: 'dc-proc dc-reason', 'data-running': props.running === true ? 'true' : undefined },
            h('button', {
              type: 'button', className: 'dc-proc-btn',
              onClick: () => expandable && setOpen(value => !value),
              'aria-expanded': expandable ? open : undefined,
            },
              h('span', { className: 'dc-proc-icon' }, h(ThinkGlyph)),
              h('span', { className: 'dc-proc-title' }, t('chat.reasoning')),
              summary !== '' ? h('span', { className: 'dc-proc-sep', 'aria-hidden': true }, '·') : null,
              summary !== '' ? h('span', {
                className: 'dc-proc-summary', 'data-shimmer': props.running === true ? 'true' : undefined,
              }, summary) : null,
              expandable ? h(ChevronGlyph, { open, className: 'dc-proc-chevron' }) : null),
            open && expandable
              ? h('div', { className: 'dc-reason-body' },
                h(MarkdownText, { text, className: 'dc-md dc-md-secondary' }))
              : null)
        }

        function FlowToolRow(props) {
          const t = useT()
          const call = props.call || {}
          const [open, setOpen] = useState(false)
          const status = call.status || (props.running ? 'running' : 'preparing')
          const label = t(toolLabelKey(call.name || props.name))
          const summary = toolSummary(call)
          const output = String(call.output || '')
          const args = String(call.arguments || '')
          const expandable = status !== 'preparing' && (args !== '' || output !== '')
          const running = status === 'running' || status === 'preparing'
          return h('div', { className: 'dc-proc dc-tool', 'data-state': status },
            h('button', {
              type: 'button', className: 'dc-proc-btn',
              title: call.name || props.name || 'tool',
              onClick: () => expandable && setOpen(value => !value),
              'aria-expanded': expandable ? open : undefined,
            },
              h('span', { className: 'dc-proc-icon' }, running ? h('span', { className: 'dc-spin' }) : h(ToolGlyph, { name: call.name || props.name })),
              h('span', { className: 'dc-proc-title' }, label),
              summary !== '' ? h('span', { className: 'dc-proc-sep', 'aria-hidden': true }, '·') : null,
              summary !== '' ? h('span', { className: 'dc-proc-summary' }, summary) : null,
              status === 'error' ? h('span', { className: 'dc-proc-failed' }, t('chat.toolError')) : null,
              expandable ? h(ChevronGlyph, { open, className: 'dc-proc-chevron' }) : null),
            open && expandable
              ? h('div', { className: 'dc-tool-body' },
                args !== '' ? h('div', { className: 'dc-tool-part' },
                  h('div', { className: 'dc-tool-label' }, t('chat.toolArgs')),
                  h('pre', null, args)) : null,
                h('div', { className: 'dc-tool-part' },
                  h('div', { className: 'dc-tool-label' }, t('chat.toolOutput')),
                  output === '' ? h('div', { className: 'dc-tool-empty' }, t('chat.emptyTool')) : h('pre', null, output)))
              : null)
        }

        function FlowText(props) {
          return h('div', { className: 'dc-prose', 'data-streaming': props.running === true ? 'true' : undefined },
            h(MarkdownText, { text: props.text, className: 'dc-md' }))
        }

        function FlowTurn(props) {
          const t = useT()
          const [open, setOpen] = useState(true)
          const turn = props.turn
          const rows = [...(turn.items || []), ...(turn.liveItems || [])]
          if (rows.length === 0 && !turn.error) return null
          const processRows = rows.filter(row => row.kind !== 'text')
          const textRows = rows.filter(row => row.kind === 'text')
          const visible = open ? rows : textRows
          const duration = turn.startTime && turn.endTime ? Math.max(1000, turn.endTime - turn.startTime) : 0
          const label = turn.stopped ? t('chat.stopped')
            : turn.error ? t('chat.turnFailed')
              : duration > 0 ? t('chat.completedTook', { duration: formatDurationText(duration, t) })
                : t('chat.turnWorked')
          const header = !turn.streaming
            ? h('button', {
              type: 'button', className: 'dc-turn-head',
              onClick: () => setOpen(value => !value),
              'aria-expanded': open,
              'data-open': open ? 'true' : undefined,
            },
              h('span', { className: 'dc-turn-label' }, label),
              processRows.length > 0 ? h(ChevronGlyph, { open: !open, className: 'dc-turn-chevron' }) : null)
            : null
          return h('div', { className: 'dc-turn', 'data-streaming': turn.streaming ? 'true' : undefined },
            header,
            visible.length > 0
              ? h('div', { className: 'dc-turn-body' }, visible.map((row, index) => row.kind === 'reason'
                ? h(FlowReasonRow, { key: row.key, text: row.text, running: row.running })
                : row.kind === 'tool'
                  ? h(FlowToolRow, {
                    key: row.key, call: props.calls.get(row.callId), name: row.name, running: row.running,
                  })
                  : h(FlowText, { key: row.key, text: row.text, running: row.running })))
              : null,
            turn.error ? h('div', { className: 'dc-turn-error' }, turn.error) : null)
        }

        function FlowRunning(props) {
          const t = useT()
          const elapsed = props.startTime > 0 ? Math.max(0, props.now - props.startTime) : 0
          return h('div', { className: 'dc-running' },
            h('span', { className: 'dc-running-mark' }, h('span', { className: 'dc-spin' })),
            h('span', { className: 'dc-running-text' },
              elapsed > 0 ? t('chat.deepDivingFor', { duration: formatDurationText(elapsed, t) }) : t('chat.deepDiving')))
        }

        function ContextRing(props) {
          const percent = Number.isFinite(props.percent) ? Math.max(0, Math.min(100, props.percent)) : 0
          const radius = 5.5
          const circumference = 2 * Math.PI * radius
          return h('span', { className: 'dc-ring', title: `${percent}%` },
            h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true },
              h('circle', { className: 'dc-ring-track', cx: 7, cy: 7, r: radius }),
              h('circle', {
                className: 'dc-ring-fill', cx: 7, cy: 7, r: radius,
                strokeDasharray: `${circumference * percent / 100} ${circumference}`,
                transform: 'rotate(-90 7 7)',
              })),
            h('span', null, `${Math.round(percent)}%`))
        }

        function FlowStats(props) {
          const t = useT()
          const stats = props.stats || {}
          const bits = []
          if (stats.turns > 0) bits.push(t('chat.statsCounts', { turns: stats.turns, steps: stats.steps }))
          if (stats.tps > 0) bits.push(`${stats.tps >= 10 ? Math.round(stats.tps) : Math.round(stats.tps * 10) / 10} tok/s`)
          if (stats.totalTokens > 0) bits.push(`${formatTokenCount(stats.totalTokens)} tok`)
          if (stats.cacheHit !== null && stats.cacheHit !== undefined) {
            bits.push(t('chat.statsCache', { percent: Math.round(stats.cacheHit) }))
          }
          if (bits.length === 0 && stats.contextPercent === null) return null
          return h('div', { className: 'dc-dock' },
            h('span', { className: 'dc-stat' }, h(ActivityGlyph), h('span', null, bits.join(' · '))),
            stats.contextPercent !== null && stats.contextPercent !== undefined
              ? h(ContextRing, { percent: stats.contextPercent })
              : null)
        }

        function FlowTrajectory(props) {
          const t = useT()
          const rows = []
          const clipped = (text, size) => {
            const value = String(text || '').replace(/\s+/g, ' ').trim()
            return value.length > size ? `${value.slice(0, size)}…` : value
          }
          for (const item of props.flow.items) {
            if (item.kind === 'user') {
              rows.push({ key: item.key, time: item.time, type: t('chat.you'), tone: 'user', text: item.text })
              continue
            }
            if (item.kind !== 'turn') continue
            rows.push({
              key: `${item.key}-head`, time: item.startTime, type: t('chat.turnLabel', { turn: item.turn }), tone: 'turn',
              text: item.error ? item.error : item.stopped ? t('chat.stopped') : item.streaming
                ? t('chat.deepDiving')
                : item.endTime ? t('chat.completedTook', { duration: formatDurationText(Math.max(1000, item.endTime - item.startTime), t) }) : t('chat.turnWorked'),
            })
            const turnRows = [...(item.items || []), ...(item.liveItems || [])]
            for (const row of turnRows) {
              if (row.kind === 'reason') rows.push({ key: row.key, time: row.time, type: t('chat.reasoningShort'), tone: 'reason', text: clipped(row.text, 320) })
              else if (row.kind === 'text') rows.push({ key: row.key, time: row.time, type: t('chat.answer'), tone: 'text', text: clipped(row.text, 320) })
              else if (row.kind === 'tool') {
                const call = props.flow.calls.get(row.callId)
                const title = t(toolLabelKey((call && call.name) || row.name))
                const summary = toolSummary(call || {})
                const status = call && call.status === 'error' ? ` · ${t('chat.toolError')}` : call && call.status === 'running' ? ` · ${t('chat.toolRunning')}` : ''
                rows.push({
                  key: row.key, time: (call && call.startedAt) || row.time, type: t('chat.toolShort'), tone: 'tool',
                  text: `${title}${summary ? ` · ${summary}` : ''}${status}`,
                })
              }
            }
          }
          if (rows.length === 0) return h('div', { className: 'dc-empty' }, t('chat.noTrajectory'))
          return h('div', { className: 'dc-traj' }, rows.map(row => h('div', {
            key: row.key, className: 'dc-traj-row', 'data-tone': row.tone,
          },
            h('span', { className: 'dc-traj-time' }, formatClockTime(row.time)),
            h('span', { className: 'dc-traj-type' }, row.type),
            h('span', { className: 'dc-traj-text' }, row.text))))
        }

        function ChatPane(props) {
          const t = useT()
          const [view, setView] = useState('chat')
          const [text, setText] = useState('')
          const [error, setError] = useState('')
          const [busy, setBusy] = useState(false)
          const [images, setImages] = useState([])
          const imagesRef = useRef([])
          imagesRef.current = images
          const attachRef = useRef(null)
          const inputRef = useRef(null)
          const catalog = props.models && props.models.catalog
          const selection = effectiveModelOf(catalog, props.bot.model)
          const vision = modelVisionOf(catalog, selection)
          const modelName = modelLabelOf(catalog, selection)
            || (selection && selection.model ? selection.model : t('model.default'))
          const effortName = selection && selection.reasoningEffort
            ? (reasoningNameOf(catalog, selection) || selection.reasoningEffort)
            : t('chat.defaultEffort')
          const releaseImages = (list) => {
            for (const item of list) {
              try { URL.revokeObjectURL(item.url) } catch (_error) { /* the browser may already have released it */ }
            }
          }
          useEffect(() => () => releaseImages(imagesRef.current), [])
          useEffect(() => {
            const node = inputRef.current
            if (!node) return
            node.style.height = 'auto'
            node.style.height = `${Math.min(180, Math.max(24, node.scrollHeight))}px`
          }, [text])
          const addFiles = (fileList) => {
            const accepted = []
            let notice = ''
            for (const file of Array.from(fileList || [])) {
              if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { notice = t('chat.attachType'); continue }
              if (file.size > 12 * 1024 * 1024) { notice = t('chat.attachSize'); continue }
              accepted.push({ id: newId(), file, url: URL.createObjectURL(file), name: file.name || 'image' })
            }
            const room = Math.max(0, 6 - imagesRef.current.length)
            if (accepted.length > room) notice = t('chat.attachLimit')
            setImages(current => [...current, ...accepted.slice(0, room)])
            if (notice) setError(notice)
          }
          const removeImage = (id) => {
            setImages((current) => {
              const item = current.find(image => image.id === id)
              if (item) releaseImages([item])
              return current.filter(image => image.id !== id)
            })
          }
          const uploadImage = async (file) => {
            const response = await fetch('/botmode/api/image', {
              method: 'POST',
              credentials: 'include',
              headers: {
                'content-type': file.type,
                'x-botmode-image-name': encodeURIComponent(file.name || 'image'),
              },
              body: await file.arrayBuffer(),
            })
            let payload
            try { payload = await response.json() } catch (_error) { payload = null }
            if (!payload || payload.ok !== true) {
              throw new Error((payload && payload.error) || `Image upload answered ${response.status}`)
            }
            return payload.attachment
          }
          const logRef = useRef(null)
          const reference = useMemo(() => {
            try {
              return sessions.retain(props.sessionId, { source: 'botmode.chat' })
            } catch (_failure) {
              return null
            }
          }, [props.sessionId])
          useEffect(() => () => { if (reference) reference.release() }, [reference])
          const binding = reference ? reference.binding : null
          const session = binding ? binding.session : null
          const snapshot = useSyncExternalStore(
            listener => (session ? session.subscribe(listener) : () => {}),
            () => (session ? session.getSnapshot() : { running: false, openState: 'error', hasMore: false }),
          )
          const events = useSyncExternalStore(
            listener => (binding ? binding.eventSource.subscribe(listener) : () => {}),
            () => (binding ? binding.eventSource.getSnapshot() : { entries: [], hasMore: false, revision: 0 }),
          )
          const flow = useMemo(() => buildChatFlow(events.entries), [events])
          const now = useNow(snapshot.running)
          const stickRef = useRef(true)
          useEffect(() => {
            const node = logRef.current
            if (node && stickRef.current) node.scrollTop = node.scrollHeight
          }, [events.revision, snapshot.running, view])
          useEffect(() => {
            if (props.onSeen) props.onSeen()
          }, [props.sessionId])
          useEffect(() => {
            if (!props.onActivity) return
            const lastTurn = [...flow.items].reverse().find(item => item.kind === 'turn')
            if (!lastTurn) return
            const value = [...lastTurn.items, ...lastTurn.liveItems].filter(item => item.kind === 'text').map(item => item.text).join('\n')
            if (value !== '') props.onActivity(value)
          }, [events.revision])
          const send = async (event) => {
            event.preventDefault()
            const value = text.trim()
            if (busy || session === null) return
            if (value === '' && images.length === 0) return
            setBusy(true)
            setError('')
            try {
              const attachments = []
              for (const image of images) attachments.push(await uploadImage(image.file))
              // Every Bot turn goes through the Host FIFO so a teammate message
              // or Routine can never write the same Session concurrently.
              await hostCommand('bot.dispatch', {
                botId: props.bot.id,
                text: value,
                ...attachments.length > 0 ? { images: attachments } : {},
              })
              releaseImages(images)
              setImages([])
              setText('')
            } catch (failure) {
              setError(failure && failure.message ? failure.message : String(failure))
            } finally {
              setBusy(false)
            }
          }
          const stop = async () => {
            if (session === null) return
            try { await hostCommand('bot.stop', { botId: props.bot.id }) } catch (_failure) { /* the turn may already be settling */ }
          }
          const head = h('header', { className: 'dc-head' },
            h('div', { className: 'dc-head-row' },
              h('div', { className: 'dc-head-lead' },
                h('span', {
                  className: 'dc-title',
                  title: props.bot.name ? `${props.bot.name} · ${props.sessionId}` : props.sessionId,
                }, props.sessionId || props.bot.name),
                snapshot.running ? h('span', { className: 'dc-running-dot', 'aria-label': t('chat.working') }) : null),
              h('div', { className: 'dc-head-actions' },
                h('button', {
                  type: 'button', className: 'dc-icon-btn', 'data-active': view === 'detail' ? 'true' : undefined,
                  title: view === 'detail' ? t('chat.back') : t('chat.detail'),
                  onClick: () => setView(view === 'detail' ? 'chat' : 'detail'),
                }, h(EllipsisGlyph)))),
            h('div', { className: 'dc-tabs' },
              h('button', { type: 'button', 'data-active': view === 'chat' ? 'true' : undefined, onClick: () => setView('chat') }, t('chat.tab')),
              h('button', { type: 'button', 'data-active': view === 'trajectory' ? 'true' : undefined, onClick: () => setView('trajectory') }, t('chat.tabTrajectory'))))
          if (view === 'detail') {
            return h('div', { className: 'dc-chat' },
              head,
              h('div', { className: 'dc-detail-scroll' },
                h('button', { type: 'button', className: 'dc-back', onClick: () => setView('chat') }, `← ${t('chat.back')}`),
                props.detail))
          }
          const composer = h('div', { className: 'dc-composer' },
            h('form', { className: 'dc-card', onSubmit: send },
              images.length > 0
                ? h('div', { className: 'dc-attach-list' }, images.map(image => h('div', { key: image.id, className: 'dc-attach-item' },
                  h('img', { src: image.url, alt: image.name }),
                  h('span', { className: 'dc-attach-name' }, image.name),
                  h('button', {
                    type: 'button', className: 'dc-attach-remove', title: t('chat.attachRemove'),
                    onClick: () => removeImage(image.id),
                  }, '×'))))
                : null,
              h('textarea', {
                ref: inputRef, className: 'dc-input', value: text, rows: 1,
                placeholder: t('chat.composerPlaceholder'),
                onChange: event => setText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event) }
                },
              }),
              h('div', { className: 'dc-bar' },
                h('div', { className: 'dc-bar-left' },
                  h('button', {
                    type: 'button', className: 'dc-round',
                    disabled: vision === false || busy,
                    title: vision === false ? t('chat.attachVisionOnly') : t('chat.attachAdd'),
                    onClick: () => { if (attachRef.current) attachRef.current.click() },
                  }, h(PlusGlyph)),
                  h('input', {
                    ref: attachRef, type: 'file', hidden: true, multiple: true,
                    accept: 'image/png,image/jpeg,image/webp,image/gif',
                    onChange: (event) => { addFiles(event.target.files); event.target.value = '' },
                  }),
                  h('button', {
                    type: 'button', className: 'dc-mode',
                    title: describeModel(t, catalog, props.bot.model),
                    onClick: () => setView('detail'),
                  }, h('span', null, t('chat.modeCustom')), h(ChevronGlyph, { className: 'dc-mode-chevron' }))),
                h('div', { className: 'dc-bar-right' },
                  h('button', {
                    type: 'button', className: 'dc-model',
                    title: describeModel(t, catalog, props.bot.model),
                    onClick: () => setView('detail'),
                  }, h('span', { className: 'dc-model-name' }, `${modelName} ${effortName}`), h(ChevronGlyph, { className: 'dc-mode-chevron' })),
                  h('button', { type: 'button', className: 'dc-icon-btn', title: t('chat.voice'), onClick: () => {} }, h(MicGlyph)),
                  snapshot.running
                    ? h('button', { type: 'button', className: 'dc-send', title: t('chat.stop'), onClick: stop }, h(StopGlyph))
                    : h('button', {
                      type: 'submit', className: 'dc-send', title: t('chat.send'),
                      disabled: busy || (text.trim() === '' && images.length === 0),
                    }, h(SendGlyph))))),
            h(FlowStats, { stats: flow.stats }))
          if (view === 'trajectory') {
            return h('div', { className: 'dc-chat' },
              head,
              h('div', { className: 'dc-scroll' },
                h('div', { className: 'dc-column dc-traj-column' }, h(FlowTrajectory, { flow }))))
          }
          return h('div', { className: 'dc-chat' },
            head,
            h('div', {
              className: 'dc-scroll', ref: logRef,
              onScroll: (event) => {
                const node = event.currentTarget
                stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
              },
            },
              h('div', { className: 'dc-column' },
                flow.items.length === 0 && !snapshot.running
                  ? h('div', { className: 'dc-hero' },
                    h('div', { className: 'dc-hero-title' }, t('chat.emptyTitle')),
                    h('div', { className: 'dc-hero-sub' }, t('chat.empty', { name: props.bot.name })))
                  : null,
                snapshot.hasMore
                  ? h('button', {
                    className: 'dc-older', type: 'button',
                    onClick: () => { if (session) void session.loadOlder() },
                  }, t('chat.older'))
                  : null,
                flow.items.map(item => item.kind === 'user'
                  ? h(FlowUser, { key: item.key, text: item.text, context: item.context, time: item.time, bot: props.bot })
                  : h(FlowTurn, { key: item.key, turn: item, calls: flow.calls })),
                snapshot.running
                  ? h(FlowRunning, { startTime: flow.runningStart, now })
                  : null)),
            error ? h('div', { className: 'bm-error dc-chat-error' }, error) : null,
            composer)
        }

        function GroupForm(props) {
          const t = useT()
          const [name, setName] = useState(props.group ? props.group.name : '')
          const [members, setMembers] = useState(props.group ? [...props.group.members] : [])
          const [mode, setMode] = useState(props.group && props.group.mode ? props.group.mode : 'auto')
          const [leadBotId, setLeadBotId] = useState(props.group && props.group.leadBotId ? props.group.leadBotId : '')
          const [error, setError] = useState('')
          const toggle = (id) => setMembers(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))
          const submit = (event) => {
            event.preventDefault()
            const value = name.trim()
            if (value === '') { setError(t('group.needName')); return }
            if (members.length < 2) { setError(t('group.needMembers')); return }
            props.onSave({
              name: value,
              members,
              mode,
              leadBotId: members.includes(leadBotId) ? leadBotId : '',
            })
          }
          return h('form', { className: 'bm-form', onSubmit: submit },
            h('h2', null, t(props.group ? 'group.editTitle' : 'group.createTitle')),
            h('p', { className: 'bm-form-hint' }, t('group.hint')),
            h('label', { className: 'bm-label' }, t('group.name'),
              h('input', {
                className: 'bm-input', value: name, autoFocus: true, placeholder: t('group.namePlaceholder'),
                onChange: event => setName(event.target.value),
              })),
            h('div', { className: 'bm-row' },
              h('label', { className: 'bm-label' }, t('group.mode'),
                h('select', {
                  className: 'bm-input', value: mode,
                  onChange: event => setMode(event.target.value),
                },
                  h('option', { value: 'auto' }, t('group.modeAuto')),
                  h('option', { value: 'everyone' }, t('group.modeEveryone')))),
              h('label', { className: 'bm-label' }, t('group.lead'),
                h('select', {
                  className: 'bm-input', value: leadBotId,
                  onChange: event => setLeadBotId(event.target.value),
                },
                  h('option', { value: '' }, t('group.leadAuto')),
                  props.bots.filter(bot => members.includes(bot.id)).map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))))),
            h('div', { className: 'bm-label' }, t('group.members'),
              h('div', { className: 'bm-picks' }, props.bots.map(bot => h('label', {
                key: bot.id, className: 'bm-pick', 'data-on': members.includes(bot.id),
              },
                h('input', { type: 'checkbox', checked: members.includes(bot.id), onChange: () => toggle(bot.id) }),
                bot.name)))),
            error ? h('div', { className: 'bm-error' }, error) : null,
            h('div', { className: 'bm-form-actions' },
              props.group ? h('button', { type: 'button', className: 'bm-btn danger', onClick: props.onDelete }, t('group.delete')) : null,
              h('button', { type: 'button', className: 'bm-btn', onClick: props.onCancel }, t('form.cancel')),
              h('button', { type: 'submit', className: 'bm-btn primary', disabled: members.length < 2 || name.trim() === '' },
                t(props.group ? 'form.save' : 'group.create'))))
        }

        function GroupChat(props) {
          const t = useT()
          const [text, setText] = useState('')
          const [busy, setBusy] = useState(false)
          const [error, setError] = useState('')
          const logRef = useRef(null)
          const group = props.group
          const members = props.bots.filter(bot => (group.members || []).includes(bot.id))
          const messages = group.messages || []
          const paused = group.status === 'paused' || group.needsYou === true
          useEffect(() => {
            const node = logRef.current
            if (node) node.scrollTop = node.scrollHeight
          }, [messages.length, group.status])
          const send = async (event) => {
            event.preventDefault()
            const value = text.trim()
            if (value === '' || busy) return
            if (members.length < 2) { setError(t('group.noMembers')); return }
            setBusy(true)
            setError('')
            try {
              await hostCommand('room.send', { roomId: group.id, text: value })
              setText('')
            } catch (failure) {
              setError(failure && failure.message ? failure.message : String(failure))
            } finally {
              setBusy(false)
            }
          }
          const control = async (action) => {
            setBusy(true)
            setError('')
            try { await hostCommand('room.control', { roomId: group.id, action }) } catch (failure) {
              setError(failure && failure.message ? failure.message : String(failure))
            } finally { setBusy(false) }
          }
          const running = group.status === 'running' || group.running === true
          const reason = group.pausedReason === 'budget'
            ? t('group.pausedBudget')
            : t('group.pausedMention')
          return h('div', { className: 'bm-chat' },
            h('header', { className: 'bm-chat-head' },
              h('span', { className: 'bm-avatar bm-avatar-sm', style: { background: group.color || COLORS[3] } }, initialOf(group.name)),
              h('div', { className: 'bm-chat-title' },
                h('span', { className: 'bm-name' }, group.name),
                h('span', { className: 'bm-role' }, t('group.membersCount', { n: members.length }))),
              running ? h('span', { className: 'bm-chat-status', 'data-running': true }, t('group.running')) : null,
              paused ? h('span', { className: 'bm-needs-you' }, t('group.needsYou')) : null,
              h('div', { className: 'bm-chat-tabs' },
                h('button', { type: 'button', 'data-active': true }, t('chat.tab')),
                h('button', { type: 'button', onClick: props.onEdit }, t('chat.detail')))),
            paused ? h('div', { className: 'bm-room-alert' },
              h('span', null, reason),
              h('button', { className: 'bm-btn small primary', disabled: busy, onClick: () => control('continue') }, t('group.continue')),
              h('button', { className: 'bm-btn small', disabled: busy, onClick: () => control('stop') }, t('group.stop'))) : null,
            h('div', { className: 'bm-log', ref: logRef },
              messages.length === 0 ? h('div', { className: 'bm-chat-empty' }, t('group.empty')) : null,
              messages.map(message => h('div', {
                key: message.id,
                className: `bm-msg ${message.from === 'user' ? 'bm-msg-user' : 'bm-msg-bot'}`,
              },
                message.from === 'user' ? null : h('div', { className: 'bm-msg-name' }, message.name),
                h('div', null, message.text)))),
            error ? h('div', { className: 'bm-error bm-chat-error' }, error) : null,
            h('form', { className: 'bm-compose', onSubmit: send },
              h('textarea', {
                value: text, rows: 1, placeholder: t('group.placeholder'),
                onChange: event => setText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event) }
                },
              }),
              h('button', { type: 'submit', className: 'bm-btn primary', disabled: text.trim() === '' || busy }, t('group.send'))))
        }

        function BotsPage() {
          const t = useT()
          const stored = useSyncExternalStore(roster.subscribe, roster.getSnapshot)
          const groups = useSyncExternalStore(groupStore.subscribe, groupStore.getSnapshot)
          const list = useSyncExternalStore(
            listener => sessions.list.subscribe(listener),
            rawSessionSnapshot,
          )
          const hostSnapshot = useSyncExternalStore(hostStore.subscribe, hostStore.getSnapshot)
          const models = useSyncExternalStore(modelStore.subscribe, modelStore.getSnapshot)
          useEffect(() => {
            if (modelStore.getSnapshot().status === 'idle') void loadModels()
          }, [])
          const sections = (hostSnapshot.state && hostSnapshot.state.sections) || []
          const routines = (hostSnapshot.state && hostSnapshot.state.routines) || []
          const approvals = (hostSnapshot.state && hostSnapshot.state.approvals) || []
          const bots = stored.filter(bot => bot.hidden !== true)
          const lang = useLang()
          const activeLang = (lang && lang.active) || 'en'
          const [form, setForm] = useState(null)
          const [selection, setSelection] = useState(null)
          const [query, setQuery] = useState('')

          const botActivity = () => () => {}
          const botSeen = () => () => {}

          const sessionRowsOf = (bot) => {
            const rows = list.ids
              .filter(id => id === bot.sessionId || (bot.dir && list.byId[id] && list.byId[id].cwd === bot.dir && list.byId[id].blank !== true))
              .map(id => ({
                id,
                title: list.byId[id] ? (list.byId[id].displayTitle || id) : id,
                summary: list.byId[id],
                primary: id === bot.sessionId,
              }))
            rows.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)
              || ((b.summary && b.summary.updatedAt) || 0) - ((a.summary && a.summary.updatedAt) || 0))
            return rows
          }

          const q = query.trim().toLowerCase()
          const visibleBots = bots.filter(bot => q === '' || `${bot.name} ${bot.role || ''}`.toLowerCase().includes(q))
          const visibleGroups = groups.filter(group => q === '' || `${group.name} ${(group.messages || []).slice(-1).map(m => m.text).join(' ')}`.toLowerCase().includes(q))

          const selectedBot = selection && selection.kind === 'bot'
            ? bots.find(bot => bot.id === selection.id)
            : undefined
          const activeBot = selectedBot || (selection && selection.kind === 'group' ? undefined : bots[0])
          const activeGroup = selection && selection.kind === 'group'
            ? groups.find(group => group.id === selection.id)
            : undefined
          const activeSessionId = activeBot ? activeBot.sessionId : null
          const activeRows = activeBot ? sessionRowsOf(activeBot) : []

          const openBotEntry = (bot) => { setSelection({ kind: 'bot', id: bot.id }); setForm(null) }
          const openGroupEntry = (group) => { setSelection({ kind: 'group', id: group.id }); setForm(null) }
          const createGroup = async (draft) => {
            const room = await hostCommand('room.save', { draft: {
              name: draft.name,
              memberIds: draft.members,
              mode: draft.mode || 'auto',
              leadBotId: draft.leadBotId || '',
              color: COLORS[(groups.length + 2) % COLORS.length],
            } })
            setForm(null)
            setSelection({ kind: 'group', id: room.id })
          }
          const saveGroup = async (group, draft) => {
            await hostCommand('room.save', { roomId: group.id, draft: {
              name: draft.name,
              memberIds: draft.members,
              mode: draft.mode || group.mode || 'auto',
              leadBotId: draft.leadBotId || group.leadBotId || '',
            } })
            setForm(null)
          }
          const deleteGroup = async (group) => {
            await hostCommand('room.delete', { roomId: group.id })
            setForm(null)
            setSelection(null)
          }

          const sectionGroups = sections
            .map(section => ({ section, bots: visibleBots.filter(bot => bot.sectionId === section.id) }))
            .filter(group => group.bots.length > 0)
          const orphanBots = visibleBots.filter(bot => !sections.some(section => section.id === bot.sectionId))
          const botRow = (bot) => {
            const summary = sessionOf(list, bot)
            const active = activeBot && activeBot.id === bot.id
            const time = bot.lastTurnAt ? Date.parse(bot.lastTurnAt) : (summary && summary.updatedAt)
            const preview = bot.lastReply || bot.role || t('card.noPreview')
            return h('button', {
              key: bot.id, type: 'button', className: 'bm-frow', 'data-active': active,
              onClick: () => openBotEntry(bot),
            },
              h('span', { className: 'bm-avatar bm-avatar-sm', style: { background: bot.color || COLORS[0] } }, initialOf(bot.name)),
              h('span', { className: 'bm-frow-text' },
                h('span', { className: 'bm-frow-top' },
                  h('span', { className: 'bm-frow-name' }, bot.name),
                  time ? h('span', { className: 'bm-frow-time' }, new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null),
                h('span', { className: 'bm-frow-preview' }, preview)),
              bot.running ? h('span', { className: 'bm-srow-dot', 'data-running': true }) : null)
          }

          const groupRow = (group) => {
            const active = activeGroup && activeGroup.id === group.id
            const last = (group.messages || []).length > 0 ? group.messages[group.messages.length - 1] : undefined
            const preview = last ? `${last.name}: ${last.text}` : t('group.emptyPreview')
            return h('button', {
              key: group.id, type: 'button', className: 'bm-frow', 'data-active': active,
              onClick: () => openGroupEntry(group),
            },
              h('span', { className: 'bm-avatar bm-avatar-sm', style: { background: group.color || COLORS[3] } }, initialOf(group.name)),
              h('span', { className: 'bm-frow-text' },
                h('span', { className: 'bm-frow-top' },
                  h('span', { className: 'bm-frow-name' }, group.name),
                  last ? h('span', { className: 'bm-frow-time' }, new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null),
                h('span', { className: 'bm-frow-preview' }, preview)),
              group.needsYou ? h('span', { className: 'bm-unread' }) : null)
          }

          const hostNotice = hostSnapshot.status === 'ready'
            ? null
            : h('div', { className: 'bm-room-alert' },
              h('span', null, hostSnapshot.status === 'loading'
                ? t('host.loading')
                : `${t('host.error')}: ${hostSnapshot.error || ''}`),
              hostSnapshot.status === 'error'
                ? h('button', { className: 'bm-btn small', onClick: () => { void refreshHost() } }, t('host.retry'))
                : null)
          const approvalBanner = approvals.length === 0 ? null : h('div', { className: 'bm-approvals' },
            approvals.map(approval => h('div', { key: approval.id, className: 'bm-approval' },
              h('div', { className: 'bm-approval-text' },
                h('span', { className: 'bm-approval-name' }, approval.botName),
                h('span', { className: 'bm-approval-tool' }, approval.toolName),
                approval.reason ? h('span', { className: 'bm-approval-reason' }, approval.reason) : null),
              h('div', { className: 'bm-approval-actions' },
                h('button', { className: 'bm-btn small primary', onClick: () => hostCommand('approval.decide', { approvalId: approval.id, decision: 'once' }).catch(() => {}) }, t('approval.once')),
                h('button', { className: 'bm-btn small', onClick: () => hostCommand('approval.decide', { approvalId: approval.id, decision: 'session' }).catch(() => {}) }, t('approval.session')),
                h('button', { className: 'bm-btn small', onClick: () => hostCommand('approval.decide', { approvalId: approval.id, decision: 'always' }).catch(() => {}) }, t('approval.always')),
                h('button', { className: 'bm-btn small danger', onClick: () => hostCommand('approval.decide', { approvalId: approval.id, decision: 'deny' }).catch(() => {}) }, t('approval.deny'))))))
          const pane = h('aside', { className: 'bm-pane' },
            h('div', { className: 'bm-pane-head' },
              h('span', { className: 'bm-pane-title' }, t('pane.title')),
              h('button', { className: 'bm-btn small primary', onClick: () => setForm({ mode: 'create' }) }, t('page.new'))),
            h('input', {
              className: 'bm-search', value: query, placeholder: t('pane.search'),
              onChange: event => setQuery(event.target.value),
            }),
            h('div', { className: 'bm-groups' },
              h('div', { className: 'bm-section' },
                h('span', null, t('pane.bots')),
                h('button', {
                  className: 'bm-section-add',
                  onClick: async () => {
                    const name = window.prompt(t('section.namePrompt'))
                    if (name && name.trim() !== '') await hostCommand('section.save', { name: name.trim() }).catch(() => {})
                  },
                }, t('section.new'))),
              visibleBots.length === 0
                ? h('p', { className: 'bm-muted bm-pane-empty' }, t('pane.empty'))
                : sectionGroups.map(group => h('div', { key: group.section.id, className: 'bm-bot-group' },
                  h('div', { className: 'bm-group-title' }, group.section.nameZh || group.section.name),
                  group.bots.map(botRow))),
              orphanBots.length > 0 ? h('div', { className: 'bm-bot-group' }, orphanBots.map(botRow)) : null,
              h('div', { className: 'bm-section' },
                h('span', null, t('pane.groups')),
                h('button', { className: 'bm-section-add', onClick: () => setForm({ mode: 'group' }) }, t('pane.newGroup'))),
              visibleGroups.length === 0
                ? h('p', { className: 'bm-muted bm-pane-empty' }, t('group.none'))
                : visibleGroups.map(groupRow)),
            h('div', { className: 'bm-pane-foot' },
              h('button', { className: 'bm-btn small', onClick: toHarness }, t('foot.back'))))

          const detailBody = activeBot
            ? h(BotDetail, {
              bot: activeBot,
              summary: sessionOf(list, activeBot),
              sessions: activeRows,
              models,
              routines: routines.filter(routine => routine.botId === activeBot.id),
              onCommand: hostCommand,
              brief: bots.length >= 2 ? h(BriefBox, { bots, onCommand: hostCommand }) : null,
              onOpen: openBot,
              onOpenSession: (id) => setSelection({ kind: 'bot', id: activeBot.id }),
              onEdit: (bot) => setForm({ mode: 'edit', bot }),
              onDelete: deleteBot,
              onMigrate: (bot) => migrateBot(bot),
            })
            : null
          const detail = form
            ? form.mode === 'group'
              ? h(GroupForm, {
                key: 'group-create',
                bots,
                onCancel: () => setForm(null),
                onSave: createGroup,
              })
              : form.mode === 'groupEdit'
                ? h(GroupForm, {
                  key: `group-${form.group.id}`,
                  bots,
                  group: form.group,
                  onCancel: () => setForm(null),
                  onSave: (draft) => saveGroup(form.group, draft),
                  onDelete: () => deleteGroup(form.group),
                })
                : h(BotForm, {
                  key: form.mode === 'edit' ? `bot-${form.bot.id}` : 'bot-create',
                  mode: form.mode,
                  bot: form.bot,
                  lang: activeLang,
                  sections,
                  models,
                  onReloadModels: (force) => { void loadModels(force) },
                  initial: form.mode === 'create'
                    ? {
                      name: '', role: '', instructions: '',
                      color: COLORS[(bots.length + 1) % COLORS.length],
                      sectionId: sections[0] ? sections[0].id : 'general',
                      model: { provider: '', model: '', reasoningEffort: '' },
                      tools: { allow: [], deny: [] },
                      approvalPolicy: 'ask',
                    }
                    : {
                      name: form.bot.name,
                      role: form.bot.role || '',
                      instructions: form.bot.instructions || '',
                      color: form.bot.color || COLORS[0],
                      sectionId: form.bot.sectionId || 'general',
                      model: form.bot.model || { provider: '', model: '', reasoningEffort: '' },
                      tools: form.bot.tools || { allow: [], deny: [] },
                      approvalPolicy: form.bot.approvalPolicy || 'ask',
                    },
                  onCancel: () => setForm(null),
                  onDone: () => setForm(null),
                })
            : activeGroup
              ? h(GroupChat, {
                key: activeGroup.id,
                group: activeGroup,
                bots,
                onEdit: () => setForm({ mode: 'groupEdit', group: activeGroup }),
              })
              : activeBot && activeSessionId
                ? h(ChatPane, {
                  key: activeSessionId,
                  sessionId: activeSessionId,
                  bot: activeBot,
                  models,
                  detail: detailBody,
                  onActivity: botActivity(activeBot),
                  onSeen: botSeen(activeBot),
                })
                : activeBot
                  ? h('section', { className: 'bm-detail-col' }, detailBody)
                  : h('section', { className: 'bm-empty bm-detail-empty' },
                  h('h2', null, t('page.empty.title')),
                  h('p', null, t('page.empty.body')),
                  h('button', { className: 'bm-btn primary', onClick: () => setForm({ mode: 'create' }) }, t('page.empty.cta')))

          const chatMode = !form && !activeGroup && Boolean(activeBot && activeSessionId)
          return h('div', { className: 'bm-page bm-page-split' },
            h('style', null, CSS),
            pane,
            h('section', { className: chatMode ? 'bm-detail-col bm-chat-col' : 'bm-detail-col' },
              hostNotice, approvalBanner, detail))
        }

        function PanelIcon(props) {
          const size = props.size || 16
          return h('svg', {
            width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
          },
            h('rect', { x: 3, y: 6, width: 18, height: 13, rx: 4, stroke: 'currentColor', strokeWidth: 1.6 }),
            h('circle', { cx: 9, cy: 12.5, r: 1.6, fill: 'currentColor' }),
            h('circle', { cx: 15, cy: 12.5, r: 1.6, fill: 'currentColor' }),
            h('path', { d: 'M12 3v3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
        }

        function ModeSwitch(props) {
          const t = useT()
          const panel = useMainPanel()
          const mode = panel && panel.activePanelId === PANEL_ID ? 'bots' : 'harness'
          const choose = (next) => {
            if (next === mode) return
            if (next === 'bots') toBots()
            else toHarness()
          }
          const control = props.wide
            ? h('div', { className: 'bm-switch', role: 'group', 'aria-label': t('mode.label') },
              h('button', {
                type: 'button', 'data-active': mode === 'harness', 'aria-pressed': mode === 'harness',
                title: t(mode === 'harness' ? 'mode.currentHarness' : 'mode.toHarness'),
                onClick: () => choose('harness'),
              }, t('mode.harness')),
              h('button', {
                type: 'button', 'data-active': mode === 'bots', 'aria-pressed': mode === 'bots',
                title: t(mode === 'bots' ? 'mode.currentBots' : 'mode.toBots'),
                onClick: () => choose('bots'),
              }, t('mode.bot')))
            : h('button', {
              type: 'button', className: 'bm-rail', title: t(mode === 'bots' ? 'mode.toHarness' : 'mode.toBots'),
              'aria-label': t(mode === 'bots' ? 'mode.toHarness' : 'mode.toBots'),
              onClick: () => choose(mode === 'bots' ? 'harness' : 'bots'),
            }, h(PanelIcon, { size: 18 }))
          return h('div', { style: { display: 'contents' } }, h('style', null, CSS), props.children, control)
        }

        function FooterToggle(props) {
          const t = useT()
          const panel = useMainPanel()
          const active = Boolean(panel && panel.activePanelId === PANEL_ID)
          return h('button', {
            type: 'button',
            className: 'bm-foot-toggle',
            'data-active': active,
            'data-wide': props.wide !== false,
            title: t(active ? 'mode.toHarness' : 'mode.toBots'),
            onClick: () => { if (active) toHarness(); else toBots() },
          },
            h(PanelIcon, { size: 15 }),
            props.wide === false ? null : h('span', null, t(active ? 'foot.back' : 'mode.bot')))
        }

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'botmode.mode-switch',
          order: 10,
          label: () => (typeof locale.getLocale === 'function'
            ? (String((locale.getLocale() || {}).active || '').startsWith('zh') ? 'Bot 模式' : 'Bot mode')
            : 'Bot mode'),
          locale: NS,
        }, FooterToggle))

        const panelLabel = () => {
          const active = String((locale.getLocale() && locale.getLocale().active) || '').toLowerCase()
          return active.startsWith('zh') ? 'Bot 团队' : 'Bots'
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: panelLabel,
          locale: NS,
        }, PanelIcon))

        class PageBoundary extends React.Component {
          constructor(props) {
            super(props)
            this.state = { error: null }
          }
          static getDerivedStateFromError(error) {
            return { error }
          }
          render() {
            if (this.state.error) {
              return h('div', { className: 'bm-page', style: { padding: '32px', overflow: 'auto' } },
                h('h2', null, 'Bot 模式渲染失败 / Bot mode failed to render'),
                h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '12px', opacity: 0.8 } },
                  String((this.state.error && this.state.error.stack) || this.state.error)))
            }
            return this.props.children
          }
        }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, () => h(PageBoundary, null, h(BotsPage))))
      },
    }
  },
})