window.__ModuleLoader__.load({
  id: 'dsh-quay-bot',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useState, useMemo, useEffect, useRef, useCallback, useSyncExternalStore } = React

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
        'pane.general': 'General',
        'pane.bots': 'Bots',
        'pane.groups': 'Groups',
        'pane.newGroup': 'New',
        'card.noPreview': 'No messages yet',
        'group.createTitle': 'New group chat',
        'group.editTitle': 'Group settings',
        'group.hint': 'Every member answers in the group; each reply is posted in the shared transcript.',
        'group.name': 'Name',
        'group.namePlaceholder': 'e.g. Research desk',
        'group.mode': 'Routing',
        'group.modeAuto': 'Smart multi-round (auto)',
        'group.modeEveryone': 'Everyone round-robin',
        'group.modeLead': 'Lead first, then @mentions',
        'group.lead': 'Lead Bot',
        'group.leadAuto': 'First member',
        'group.purpose': 'Room purpose',
        'group.purposePlaceholder': 'Optional shared goal for this room (injected into room turns only)',
        'group.notes': 'Shared notes',
        'group.notesPlaceholder': 'Optional standing facts or constraints shared by all members',
        'group.maxRounds': 'Max rounds',
        'group.maxMessages': 'Max messages',
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
        'chat.detail': 'Details',
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
        'chat.attachOpen': 'Open preview',
        'chat.attachClear': 'Clear all',
        'chat.attachDrop': 'Drop images to attach',
        'chat.bindMissing': 'Chat history is not bound to this session right now; messages still reach the Host and the Bot still runs.',
        'chat.bindRetry': 'Retry binding',
        'chat.historyRefresh': 'Refresh history',
        'chat.imageCount': '{count} image(s)',
        'chat.hostReply': 'Latest reply from Host',
        'chat.imageOnly': 'Image only',
        'detail.model': 'Model',
        'model.default': 'DSH default',
        'model.custom': 'Pinned',
        'model.unknown': 'not in the current catalog',
        'pane.title': 'Bots',
        'pane.search': 'Search Bots',
        'pane.empty': 'No matching Bot',
        'pane.collapse': 'Collapse bot list',
        'pane.expand': 'Expand bot list',
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
        'form.avatar': 'Bot Avatar (optional)',
        'avatar.modeRandom': 'Random (default)',
        'avatar.modeCustom': 'Customize',
        'avatar.randomHint': 'A unique avatar & clay colour palette will be randomly assigned on creation. You can customize it anytime later.',
        'avatar.loading': 'Loading avatar engine…',
        'avatar.poke': 'Poke',
        'avatar.randomize': 'Randomize',
        'avatar.resetView': 'Reset view',
        'avatar.dragHint': 'Drag to rotate 3D · Click to poke',
        'avatar.gallery': 'Built-in avatars (19)',
        'avatar.bodyColor': 'Body colour',
        'avatar.eyeColor': 'Eye colour',
        'avatar.material': 'Material',
        'avatar.materialFlat': 'Flat',
        'avatar.materialFluffy': 'Fluffy',
        'avatar.clay': 'Clay shading',
        'avatar.depth': 'Depth',
        'avatar.follow': 'Follow pointer',
        'avatar.orbit': 'Orbit particles',
        'avatar.badge': 'Notification badge',
        'avatar.customJsonToggle': 'Import custom JSON (version: 1)',
        'avatar.customJsonHint': 'Paste an Image-bot / Avatar Forge version:1 JSON definition (body.path + eyes).',
        'avatar.customJsonApply': 'Apply JSON',
        'avatar.customJsonClear': 'Clear custom JSON',
        'avatar.customJsonApplied': 'Using custom JSON definition',
        'avatar.customJsonInvalid': 'Invalid avatar JSON: {msg}',
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
        'group.speaking': '{name} speaking…',
        'group.speakingMulti': '{n} Bots working in parallel…',
        'group.completed': 'Completed',
        'group.settled': 'Settled',
        'group.stalled': 'Soft-paused',
        'group.waitingUser': 'Waiting on you',
        'group.capped': 'Capped',
        'group.needsYou': 'needs you',
        'group.budget': '{r}/{mr} rounds · {m}/{mm} msgs',
        'group.metricsUnlimited': 'Epoch {e} · {m} msgs · {tk}k tok',
        'group.continue': 'Continue',
        'group.stop': 'Stop',
        'group.workDir': 'Shared project directory (optional)',
        'group.workDirPlaceholder': 'e.g. /path/to/repo (empty uses each Bot\'s isolated folder)',
        'group.tokenLimit': 'Soft token checkpoint (0 = off)',
        'group.idleRoundLimit': 'Idle spin limit (pure-text rounds)',
        'group.maxRoundsHint': 'Max rounds (0 = until finished)',
        'group.maxMessagesHint': 'Max messages (0 = until finished)',
        'group.interjectPlaceholder': 'Soft steer: idle Bots respond immediately, busy Bots pick this up right after their current step (/stop to abort)…',
        'group.pausedBudget': 'The optional round/message cap was reached. Continue with a fresh window, or stop.',
        'group.pausedTokenBudget': 'Soft token budget checkpoint reached (all sessions & watermarks preserved). Click Continue to extend budget.',
        'group.pausedIdleSpin': 'Detected consecutive pure-text rounds with zero tool calls, file edits, or task claims (idle spin). Continue or stop?',
        'group.pausedBotError': 'One or more Bots paused locally after repeated identical errors. Review the log or click Continue to retry.',
        'group.pausedTurnError': 'Bots failed to execute this round due to a model/provider error. Check model settings or click Continue to retry.',
        'group.pausedApproval': 'A Bot is waiting on tool approval above; other parallel Bots remain unblocked.',
        'group.pausedQuestion': 'A Bot asked an interactive question above; answer it to resume that branch.',
        'group.pausedMention': 'A Bot asked for a human decision (@user). Reply below or click Continue.',
        'group.liveZone': 'Live parallel tracks ({n})',
        'group.actorRunning': 'Working',
        'group.actorApproval': 'Waiting approval',
        'group.actorQuestion': 'Waiting answer',
        'group.actorPausedError': 'Fault paused',
        'group.resumeBot': 'Resume Bot',
        'group.taskBoard': 'Shared task board & file soft-locks',
        'group.completedBanner': 'Task completed by @{name}',
        'group.deliverables': 'Deliverables',
        'group.actPassed': '{name} passed (silent)',
        'group.actCompleted': '{name} finished the task',
        'group.actSettled': 'Discussion settled naturally ({reason})',
        'group.actStalled': 'Soft-paused by probe ({reason})',
        'group.actCapped': 'Reached cap ({reason})',
        'group.actCancelled': 'Stopped ({reason})',
        'group.actSoftSteer': 'Soft-steered into new epoch',
        'group.actContinued': 'Resumed by user',
        'group.actEscalation': '{name} asked for human input',
        'group.actBotError': '{name} paused after 3 identical errors',
        'group.actSubtaskClaim': '{name} claimed {taskId}',
        'group.actSubtaskDone': '{name} completed {taskId}',
        'group.mentionAll': 'Everyone',
        'group.mentionAllSub': 'Notify all Bots in this room',
        'group.mentionPickTitle': 'Mention a Bot',
        'group.mentionBtnTitle': 'Insert @ mention',
        'group.mentionHint': '↑↓ select · Enter insert · Esc close',
        'question.customPlaceholder': 'Optional custom note or write-in answer…',
        'question.submit': 'Submit answer',
        'question.dismiss': 'Dismiss',
        'pane.memory': 'Memory Hub',
        'pane.settings': 'Settings',
        'settings.title': 'Bot Settings',
        'settings.back': 'Overview',
        'settings.groupWork': 'Work',
        'settings.groupAgent': 'Agent',
        'settings.groupAdvanced': 'Advanced',
        'settings.model': 'Model',
        'settings.skills': 'Skills',
        'settings.tools': 'Toolset',
        'settings.workspace': 'Workspace',
        'settings.routines': 'Routines',
        'settings.artifacts': 'Artifacts',
        'settings.rooms': 'Group Chat',
        'settings.soul': 'Soul',
        'settings.memory': 'Memory',
        'settings.format': 'Response Format',
        'settings.usage': 'Usage',
        'settings.approval': 'Approval & Governance',
        'settings.mcp': 'MCP Servers',
        'settings.channels': 'Webhooks & Alerts',
        'settings.integrations': 'Plugins & Tools',
        'settings.logs': 'Logs',
        'settings.mcpDesc': 'Shared with normal mode with reversed precedence: Bot Mode uses Bot MCP > Normal MCP; Normal Mode uses Normal MCP > Bot MCP.',
        'settings.mcpAdd': 'Add / Edit Bot MCP Server',
        'settings.mcpTest': 'Test',
        'settings.mcpOverride': 'Overrides normal MCP in Bot Mode',
        'settings.skillsAdd': 'New / Edit Custom Skill',
        'settings.skillsScopeShared': 'Bot Shared Library (all Bots)',
        'settings.skillsScopeBot': 'This Bot Only (.dsh/skills)',
        'settings.channelsDesc': 'Receive external Webhook events to wake Bots/Rooms 24×7, and push approvals, takeovers, completions or budget alerts to IM & desktop.',
        'settings.notifyTitle': 'Outbound Alerts & Desktop Notifications',
        'settings.notifyTest': 'Send Test Alert',
        'settings.webhookTitle': 'Inbound Webhook Triggers',
        'settings.webhookAdd': 'Create Inbound Webhook',
        'settings.webhookTest': 'Trigger Test',
        'settings.govTitle': 'Global Security & Governance',
        'settings.govBotCrud': 'Require human approval for worker Bots calling bot_manage(create/delete) or room_manage(delete)',
        'settings.govExtWrite': 'Block non-admin Bots from writing files outside their own workspace directory',
        'settings.govDefaultBudget': 'Default daily Token limit per Bot (0 = unlimited)',
        'settings.botRole': 'Permission Role',
        'settings.botRoleWorker': 'Worker (standard; governed by approvals & workspace rules)',
        'settings.botRoleAdmin': 'Admin (orchestrator; bypasses Bot CRUD approval gate)',
        'settings.botDailyLimit': 'Daily Token Budget for this Bot (0 = inherit global)',
        'settings.save': 'Save changes',
        'settings.saved': 'Saved.',
        'settings.noBot': 'Create a Bot first to edit Bot-level settings.',
        'settings.allTools': 'All tools',
        'settings.formatDesc': 'Modularly control the modern rich-media output protocol injected into Bots and rendered in chat.',
        'settings.fmtEnable': 'Inject Response Format Protocol into Bot prompts',
        'settings.fmtExtMd': 'Extended Markdown (GFM tables, Callouts, Diff, collapsible <details>)',
        'settings.fmtDiagrams': 'Diagrams & Math (Mermaid visual flowcards & LaTeX math)',
        'settings.fmtArtifacts': 'Structured Artifacts (<artifact> preview & HTML sandbox cards)',
        'settings.fmtCards': 'Structured UI Cards (```metrics, ```card, ```file JSON blocks)',
        'settings.fmtMultimodal': 'Multimodal Outputs (inline images, audio & file attachment cards)',
        'settings.fmtPreview': 'Live format preview',
        'settings.gcTokenLimit': 'Default soft Token checkpoint (0 = off)',
        'settings.gcIdleLimit': 'Default idle spin limit (pure-text rounds)',
        'settings.gcSoftLock': 'Enable silent file-write soft-lock guard in Group Rooms',
        'settings.gcErrorProbe': 'Enable per-Bot repeated error pause probe (3x identical error)',
        'settings.gcAutoReview': 'Auto progress review & completion skill (Lead checks progress and calls room_finish_task)',
        'settings.gcActivityStrip': 'Show compact activity chips below Group Chat',
        'settings.soulHint': 'Edit this Bot\'s identity, standing instructions and SOUL.md file directly.',
        'settings.memoryMdTitle': 'Long-term notes (MEMORY.md)',
        'settings.artifactsEmpty': 'No deliverables or <artifact> outputs recorded yet.',
        'settings.logsEmpty': 'No activity logs yet.',
        'settings.logsRefresh': 'Refresh logs',
        'rich.preview': 'Preview',
        'rich.source': 'Source',
        'rich.download': 'Download',
        'rich.diagram': 'Diagram',
        'rich.copyPath': 'Copy path',
        'memory.title': 'Team Memory Hub',
        'memory.subtitle': 'One pluggable memory provider shared across all Bots, isolated per Bot by agent_id. Switch built-in providers or download new ones.',
        'memory.test': 'Test health',
        'memory.testing': 'Testing…',
        'memory.modeGateway': 'Gateway online',
        'memory.modeFallback': 'Local SQLite fallback',
        'memory.modeLocal': 'Local SQLite',
        'memory.modeBuiltin': 'MEMORY.md only',
        'memory.modeOffline': 'Offline',
        'memory.globalSettings': 'Shared memory settings',
        'memory.teamId': 'Team ID',
        'memory.userId': 'User ID',
        'memory.prefetch': 'Auto prefetch before turns',
        'memory.sync': 'Auto sync completed turns',
        'memory.syncRooms': 'Sync Group Room replies',
        'memory.saveSettings': 'Save settings',
        'memory.saved': 'Saved.',
        'memory.providers': 'Installed memory providers',
        'memory.use': 'Activate',
        'memory.inUse': 'Active',
        'memory.bundled': 'Built-in',
        'memory.downloaded': 'Downloaded',
        'memory.uninstall': 'Uninstall',
        'memory.config': 'Configure',
        'memory.hideConfig': 'Close config',
        'memory.saveConfig': 'Save & reload',
        'memory.installTitle': 'Download / install another memory provider',
        'memory.installHint': 'Install from curated templates, npm package (npm:<pkg>), Git repo URL, .tgz archive URL, or a local plugin folder containing plugin.json.',
        'memory.installPlaceholder': 'e.g. npm:@scope/dsh-memory-xxx, https://github.com/..., or /path/to/plugin',
        'memory.installBtn': 'Download & activate',
        'memory.catalogTitle': 'Available catalog providers',
        'memory.catalogInstall': 'Install & activate',
        'memory.installed': 'Installed',
        'memory.searchTitle': 'Test per-Bot memory recall',
        'memory.searchPlaceholder': 'Query memories for the selected Bot…',
        'memory.searchBtn': 'Search',
        'memory.searchEmpty': 'No matching memories.',
        'screen.title': 'Screen',
        'screen.stopped': 'Off · RAM/CPU released',
        'screen.stoppedSaved': 'Off · Desktop saved',
        'screen.offline': 'Gateway offline (click Take over to auto-launch)',
        'screen.starting': 'Starting screen gateway…',
        'screen.hostOutdated': 'Restart dsh web to load updated Host plugin',
        'screen.refreshHost': 'Re-check',
        'screen.active': 'Running',
        'screen.frozen': 'Off · RAM/CPU released',
        'screen.needHuman': 'Needs human help',
        'screen.takeoverState': 'Human in control',
        'screen.start': 'Start',
        'screen.stop': 'Shut down',
        'screen.thaw': 'Wake →',
        'screen.freeze': 'Freeze',
        'screen.takeover': 'Take over',
        'screen.shrinkRelease': 'Shrink & hand back',
        'screen.release': 'Hand back',
        'screen.brake': 'Brake',
        'screen.browser': 'Browser',
        'screen.terminal': 'Terminal',
        'screen.filesApp': 'Files',
        'screen.files': 'Screen files',
        'screen.filesEmpty': 'No files in screen downloads.',
        'settings.system': 'System & Gateway',
        'system.title': 'Host System Info & Gateway Interface',
        'system.hint': 'Collects host disk, memory, CPU usage and uptime, transmitted via the BotScreen gateway.',
        'system.refresh': 'Refresh',
        'system.liveOn': 'Live stream: ON',
        'system.liveOff': 'Live stream: OFF',
        'system.cpu': 'CPU Usage',
        'system.memory': 'Memory Usage',
        'system.disk': 'Disk Usage',
        'system.uptime': 'System Uptime',
        'system.cores': 'Cores',
        'system.load': 'Load Avg',
        'system.bootTime': 'Boot Time',
        'system.available': 'Available',
        'system.free': 'Free',
        'system.gatewayStatus': 'Gateway',
        'system.online': 'Connected',
        'system.offline': 'Disconnected',
        'system.configTitle': 'Gateway & Interface Configuration',
        'system.gatewayUrl': 'Gateway URL',
        'system.gatewayUrlPlaceholder': 'Default: http://127.0.0.1:6200',
        'system.adminToken': 'Gateway Admin Token',
        'system.adminTokenPlaceholder': 'Optional (leave empty to use BOTSCREEN_ADMIN_TOKEN)',
        'system.diskPaths': 'Disk Mount Paths',
        'system.diskPathsPlaceholder': 'Comma-separated, e.g. /, /data',
        'system.refreshInterval': 'Refresh Interval (sec)',
        'system.frameRate': 'Virtual Screen FPS',
        'system.frameRateHint': '30 / 15 / 10 fps. Default 15. Applies live to the enlarged screen.',
        'system.pushUrl': 'Outbound Push URL (optional)',
        'system.pushUrlPlaceholder': 'e.g. http://127.0.0.1:9000/metrics',
        'system.pushInterval': 'Auto Push Interval (sec, 0=off)',
        'system.pushToken': 'Push Auth Token (optional)',
        'system.saveConfig': 'Save & Sync Gateway',
        'system.testPush': 'Push Now',
        'system.pushOk': 'Pushed via gateway',
        'system.endpointsTitle': 'Configured API Endpoints',
        'system.mountsTitle': 'Disk Mounts',
        'system.hostPanelTitle': 'Host & Performance',
        'system.hostname': 'Host',
        'system.cgroupOff': 'Host metrics (no cgroup)',
        'system.fallbackMode': 'Host fallback',
        'system.openDetails': 'Details',
        'system.waitingGateway': 'Pending',
        'screen.upload': 'Upload',
        'screen.panelToggle': 'Screen & Routines',
        'screen.helpTitle': 'Human takeover needed',
        'screen.helpOpen': 'Take over screen',
        'screen.helpRelease': 'Shrink & hand back',
        'screen.helpCancel': 'Cancel',
        'screen.helpNotePlaceholder': 'Optional note for the Bot (e.g. Logged in, continue)…',
        'screen.modalHint': 'Expanded takeover mode: click, drag, scroll, or type directly. Shrinking immediately hands control back to the Bot.',
        'screen.hudFps': 'FPS',
        'screen.hudLatency': 'Latency',
        'screen.hudTarget': 'to gateway',
        'screen.typePlaceholder': 'Type text / password to send to screen…',
        'screen.typeSend': 'Send',
        'screen.openVnc': 'Open VNC window',
        'screen.routinesEmptyTitle': 'No scheduled tasks',
        'screen.routinesEmptyDesc': 'Schedule a prompt by cron expression. This Bot will run it in its workspace & screen and report here.',
        'screen.routinesNew': 'New scheduled task',
        'remote.button': 'Remote',
        'remote.title': 'Remote access',
        'remote.subtitle': 'Publish this DSH gateway through a Cloudflare tunnel with end-to-end encryption.',
        'remote.appSubtitle': 'Publish this DSH gateway through a Cloudflare tunnel; scan the QR below with public-bot to connect.',
        'remote.starting': 'Starting the gateway…',
        'remote.rotating': 'Rotating the access key…',
        'remote.running': 'Online',
        'remote.stopped': 'Offline',
        'remote.healthy': 'Healthy',
        'remote.unhealthy': 'Unhealthy',
        'remote.tab.qr': 'QR code',
        'remote.tab.input': 'Enter link',
        'remote.tab.app': 'Android app',
        'remote.appLabel': 'Plain-token link for the Android app',
        'remote.appHint': 'Scan in public-bot › Add host › QR link. This channel is not end-to-end encrypted: Cloudflare can see the token, so rotate it if it leaks.',
        'remote.appDisabled': 'The app channel is off. Set proxy.appBridge=true in dsh-remote config, then reopen this dialog.',
        'remote.copyApp': 'Copy app link',
        'remote.rotateApp': 'Rotate app token',
        'remote.rotatedApp': 'App token rotated; devices must rescan',
        'remote.linkLabel': 'Full access link (contains the key)',
        'remote.inputPlaceholder': 'Paste a full access link, e.g. https://xxx.trycloudflare.com/#k=…',
        'remote.inputHint': 'Scan the QR with the phone app, or paste the whole link here to validate and open it.',
        'remote.qrHint': 'Scan with public-bot, or copy the link. The key lives in the URL fragment and never reaches Cloudflare.',
        'remote.check': 'Validate',
        'remote.copied': 'Copied',
        'remote.copyFailed': 'Copy failed',
        'remote.copy': 'Copy link',
        'remote.open': 'Open in browser',
        'remote.refresh': 'Refresh',
        'remote.rotate': 'Rotate key',
        'remote.rotated': 'Key rotated, old link expires after the grace window',
        'remote.stop': 'Stop mapping',
        'remote.close': 'Close',
        'remote.notRunning': 'The gateway is not running yet.',
        'remote.failed': 'Gateway command failed',
        'remote.valid': 'Link looks valid',
        'remote.invalid': 'Not a recognised gateway or SSH link',
        'remote.token': 'Key',
        'remote.tunnel': 'Tunnel',
        'remote.psk': 'Key id',
        'remote.pid': 'PID',
        'remote.copyLegacy': 'This link uses the legacy plaintext token channel.',
        'remote.emptyState': 'Start the gateway to get a QR code and a full access link.',
        'remote.stoppedToast': 'Gateway stopped',
        'remote.needBin': 'dsh-remote CLI not found. Set DSH_REMOTE_BIN to bin/dsh-remote.mjs.',
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
        'pane.general': '常规',
        'pane.bots': 'Bot',
        'pane.groups': '群组',
        'pane.newGroup': '新建',
        'card.noPreview': '还没有消息',
        'group.createTitle': '新建群聊',
        'group.editTitle': '群聊设置',
        'group.hint': '每位成员都会在群里回复，所有消息落在同一个群记录里。',
        'group.name': '群名称',
        'group.namePlaceholder': '例如：调研小组',
        'group.mode': '路由方式',
        'group.modeAuto': '智能多轮（全员 / @ 接力）',
        'group.modeEveryone': '全员顺位轮转',
        'group.modeLead': 'Lead 统筹，再按 @ 接力',
        'group.lead': 'Lead Bot',
        'group.leadAuto': '默认第一个成员',
        'group.purpose': '群聊目标',
        'group.purposePlaceholder': '可选：本群共同目标（仅随群消息注入，不污染 Bot 人格）',
        'group.notes': '共享笔记',
        'group.notesPlaceholder': '可选：全体成员共享的事实、约定或约束',
        'group.maxRounds': '轮次上限',
        'group.maxMessages': '消息上限',
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
        'chat.detail': '详情',
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
        'chat.attachOpen': '查看大图',
        'chat.attachClear': '全部清除',
        'chat.attachDrop': '松开即可添加图片',
        'chat.bindMissing': '当前会话历史没绑定上；消息仍会送到 Host，Bot 也会照常运行。',
        'chat.bindRetry': '重试绑定',
        'chat.historyRefresh': '刷新历史',
        'chat.imageCount': '{count} 张图片',
        'chat.hostReply': 'Host 最新回复',
        'chat.imageOnly': '仅图片',
        'detail.model': '模型',
        'model.default': 'DSH 默认',
        'model.custom': '单独指定',
        'model.unknown': '不在当前模型目录里',
        'pane.title': 'Bot 会话',
        'pane.search': '搜索 Bot',
        'pane.empty': '没有匹配的 Bot',
        'pane.collapse': '收起机器人侧栏',
        'pane.expand': '展开机器人侧栏',
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
        'form.avatar': 'Bot 形象（可选）',
        'avatar.modeRandom': '随机生成（默认）',
        'avatar.modeCustom': '自定义形象',
        'avatar.randomHint': '未自定义形象时，创建后将自动随机分配一套形象与黏土配色；随时可在编辑或设置中调整。',
        'avatar.loading': '正在加载形象引擎…',
        'avatar.poke': '逗一下',
        'avatar.randomize': '随机一套',
        'avatar.resetView': '重置视角',
        'avatar.dragHint': '拖动可 3D 旋转 · 轻点逗一下',
        'avatar.gallery': '内置形象库（19 款）',
        'avatar.bodyColor': '主体配色',
        'avatar.eyeColor': '眼睛配色',
        'avatar.material': '材质',
        'avatar.materialFlat': '平面',
        'avatar.materialFluffy': '毛绒',
        'avatar.clay': '橡皮泥质感',
        'avatar.depth': '体积深度',
        'avatar.follow': '跟随视线',
        'avatar.orbit': '轨道粒子',
        'avatar.badge': '通知角标',
        'avatar.customJsonToggle': '导入自定义形象 JSON（version: 1）',
        'avatar.customJsonHint': '粘贴 Image-bot / Avatar Forge 的 version:1 定义（含 body.path 与 eyes），应用后优先生效。',
        'avatar.customJsonApply': '应用 JSON',
        'avatar.customJsonClear': '取消自定义 JSON',
        'avatar.customJsonApplied': '当前使用自定义 JSON 形象',
        'avatar.customJsonInvalid': '形象 JSON 校验失败：{msg}',
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
        'group.running': '并行调度中…',
        'group.speaking': '{name} 执行中…',
        'group.speakingMulti': '{n} 个 Bot 并行协作中…',
        'group.completed': '任务已完成',
        'group.settled': '已静默收敛',
        'group.stalled': '异常软暂停',
        'group.waitingUser': '等待你确认',
        'group.capped': '已达上限',
        'group.needsYou': '需要你',
        'group.budget': '{r}/{mr} 轮 · {m}/{mm} 条',
        'group.metricsUnlimited': '纪元 {e} · {m} 条发言 · {tk}k Token',
        'group.continue': '继续执行',
        'group.stop': '停止',
        'group.workDir': '共享工程目录（可选，用于多 Bot 协同改代码）',
        'group.workDirPlaceholder': '例如：/home/ubuntu/project（留空则使用各 Bot 独立目录）',
        'group.tokenLimit': '软 Token 安全阀检查点（0 为关闭）',
        'group.idleRoundLimit': '连续纯文本空转阈值（轮）',
        'group.maxRoundsHint': '轮次上限（0 = 直到任务完成）',
        'group.maxMessagesHint': '消息上限（0 = 直到任务完成）',
        'group.interjectPlaceholder': '软插话补充要求：空闲 Bot 立即并行响应，忙碌 Bot 跑完当前工具步后自动吸纳（发 /stop 全局强杀）…',
        'group.pausedBudget': '已达到可选轮次/消息上限（capped）。点击「继续执行」追加窗口，或停止。',
        'group.pausedTokenBudget': '已触发软预算检查点（全部会话与水位线完好保留）。点击「继续执行」自动追加预算无损续跑。',
        'group.pausedIdleSpin': '连续空转探针触发：连续多轮全员仅纯文本回复，零工具调用、零文件变更、零任务认领。是否继续？',
        'group.pausedBotError': '重复报错探针触发：有成员连续 3 次返回相同错误已局部暂停。请查看排障提示或点击「继续执行」恢复。',
        'group.pausedTurnError': '本轮模型/提供方调用全部出错，未产生有效回复（不会伪装为已收敛）。请检查模型配置或点击「继续执行」重试。',
        'group.pausedApproval': '有成员正在等待上方工具审批（局部挂起，不阻塞其他并行成员）。',
        'group.pausedQuestion': '有成员正在等待你回答上方的提问（ask_user_question）。',
        'group.pausedMention': '有 Bot 显式 @user 请求人类决策，请直接回复或点击「继续执行」。',
        'group.liveZone': '正在并行执行 / 输入区（{n} 轨）',
        'group.actorRunning': '执行中',
        'group.actorApproval': '等待审批',
        'group.actorQuestion': '等待回答',
        'group.actorPausedError': '重复报错已暂停',
        'group.resumeBot': '恢复该成员',
        'group.taskBoard': '共享任务板与文件写入租约',
        'group.completedBanner': '任务已由 @{name} 验收完成',
        'group.deliverables': '交付物',
        'group.actPassed': '{name} 已确认无补充 (pass)',
        'group.actCompleted': '{name} 已调用 room_finish_task 完成任务',
        'group.actSettled': '全员静默自然收敛（{reason}）',
        'group.actStalled': '异常探针软暂停（{reason}）',
        'group.actCapped': '达到可选上限（{reason}）',
        'group.actCancelled': '已停止（{reason}）',
        'group.actSoftSteer': '人类软插话开启新纪元',
        'group.actContinued': '用户已恢复继续运行',
        'group.actEscalation': '{name} @user 请求人类决策',
        'group.actBotError': '{name} 连续 3 次相同报错已局部暂停',
        'group.actSubtaskClaim': '{name} 认领了子任务 {taskId}',
        'group.actSubtaskDone': '{name} 完成了子任务 {taskId}',
        'group.mentionAll': '所有人',
        'group.mentionAllSub': '通知群内全部 Bot 协作响应',
        'group.mentionPickTitle': '选择要 @ 的 Bot',
        'group.mentionBtnTitle': '选择并 @ 成员',
        'group.mentionHint': '↑↓ 切换 · Enter 填充 · Esc 关闭',
        'question.customPlaceholder': '补充说明或自定义回答（可选）…',
        'question.submit': '提交回答',
        'question.dismiss': '取消提问',
        'pane.memory': '记忆库',
        'pane.settings': '设置',
        'settings.title': 'Bot 设置',
        'settings.back': '返回概览',
        'settings.groupWork': '工作',
        'settings.groupAgent': '智能体',
        'settings.groupAdvanced': '高级',
        'settings.model': '模型',
        'settings.skills': '技能',
        'settings.tools': '工具集',
        'settings.workspace': '项目与工作区',
        'settings.routines': '例程',
        'settings.artifacts': '产物',
        'settings.rooms': '群聊策略',
        'settings.soul': 'Soul',
        'settings.memory': '记忆',
        'settings.format': '回复格式',
        'settings.usage': '用量',
        'settings.approval': '审批与治理',
        'settings.mcp': 'MCP 服务',
        'settings.channels': 'Webhook 与通知',
        'settings.integrations': '插件与集成',
        'settings.logs': '日志',
        'settings.mcpDesc': '与普通模式互通但优先级相反：Bot 模式下 Bot MCP 优先于普通 MCP（同名自动独立覆写）；普通模式下普通 MCP 优先。',
        'settings.mcpAdd': '新增 / 编辑 Bot MCP 服务',
        'settings.mcpTest': '测试连接',
        'settings.mcpOverride': 'Bot 模式下优先覆写同名普通 MCP',
        'settings.skillsAdd': '新建 / 编辑自定义技能',
        'settings.skillsScopeShared': 'Bot 公共技能库（全部 Bot 可见）',
        'settings.skillsScopeBot': '仅当前 Bot 目录（.dsh/skills）',
        'settings.channelsDesc': '通过 Inbound Webhook 接收外部事件 7×24 唤醒 Bot/群聊，并将审批、屏幕接管、任务完成和预算告警主动推送到飞书/企微/钉钉/Slack 或桌面。',
        'settings.notifyTitle': '主动消息推送与桌面提醒',
        'settings.notifyTest': '发送测试通知',
        'settings.webhookTitle': '外部事件触发器（Inbound Webhook）',
        'settings.webhookAdd': '新建 Webhook 触发器',
        'settings.webhookTest': '触发测试',
        'settings.govTitle': '全局安全治理与预算护栏',
        'settings.govBotCrud': '普通成员 Bot 调用 bot_manage(增删) 或 room_manage(删群) 时强制人工审批',
        'settings.govExtWrite': '禁止非管理员 Bot 在单聊中向自身工作目录外写入文件',
        'settings.govDefaultBudget': '全局默认单 Bot 每日 Token 熔断上限（0 为不限）',
        'settings.botRole': '权限角色',
        'settings.botRoleWorker': '普通成员（worker · 受审批与目录写保护约束）',
        'settings.botRoleAdmin': '管理员（admin · 可直接编排增删 Bot/群聊）',
        'settings.botDailyLimit': '当前 Bot 每日 Token 熔断上限（0 = 继承全局）',
        'settings.save': '保存配置',
        'settings.saved': '已保存。',
        'settings.noBot': '请先新建至少一个 Bot，即可编辑 Bot 级配置。',
        'settings.allTools': '全部工具',
        'settings.formatDesc': '按模块配置注入到 Bot 的现代富媒体回复格式协议与前端渲染能力。',
        'settings.fmtEnable': '向 Bot 系统提示词注入回复格式规范',
        'settings.fmtExtMd': '基础扩展 Markdown（GFM 表格、Callouts 提示框、Diff 对比、可折叠 <details>）',
        'settings.fmtDiagrams': '图表与公式（Mermaid 流程图卡片与数学公式排版）',
        'settings.fmtArtifacts': '结构化语义标签（<artifact> 独立预览卡与 HTML 沙盒预览）',
        'settings.fmtCards': '结构化 UI 卡片（```metrics 指标卡、```card 信息卡、```file 产物卡）',
        'settings.fmtMultimodal': '多模态原生输出（内联图片、音频播放器与文件下载卡）',
        'settings.fmtPreview': '富媒体渲染效果预览',
        'settings.gcTokenLimit': '新群默认软 Token 安全阀（0 为不限）',
        'settings.gcIdleLimit': '新群默认连续纯文本空转阈值（轮）',
        'settings.gcSoftLock': '启用群聊底层文件写入路径软锁（静默防撞车）',
        'settings.gcErrorProbe': '启用单 Bot 连续 3 次重复报错局部暂停探针',
        'settings.gcAutoReview': '启用全自动进度复核与收口 Skill（协作收尾时自动检查进度并调用 room_finish_task 结束）',
        'settings.gcActivityStrip': '在群聊底部显示状态活动标签条',
        'settings.soulHint': '直接配置该 Bot 的基础身份、常驻指令及磁盘 SOUL.md 人格档案。',
        'settings.memoryMdTitle': '长期记忆笔记（MEMORY.md）',
        'settings.artifactsEmpty': '还没有记录到群聊交付物或 <artifact> 产物。',
        'settings.logsEmpty': '暂无运行日志。',
        'settings.logsRefresh': '刷新日志',
        'rich.preview': '预览',
        'rich.source': '源码',
        'rich.download': '下载',
        'rich.diagram': '图表',
        'rich.copyPath': '复制路径',
        'memory.title': '团队记忆库（Memory Hub）',
        'memory.subtitle': '所有 Bot 共用一套可插拔记忆库插件，按 agent_id 为每个 Bot 隔离记忆。默认内置 Memory_tencentdb，支持下载与随时切换其他记忆库。',
        'memory.test': '检测连接',
        'memory.testing': '检测中…',
        'memory.modeGateway': 'Gateway 在线',
        'memory.modeFallback': '本地 SQLite 兜底中',
        'memory.modeLocal': '本地 SQLite',
        'memory.modeBuiltin': '仅 MEMORY.md',
        'memory.modeOffline': '离线',
        'memory.globalSettings': '全局记忆策略',
        'memory.teamId': '团队 ID (team_id)',
        'memory.userId': '用户 ID (user_id)',
        'memory.prefetch': '发言前自动召回记忆 (prefetch)',
        'memory.sync': '回合结束后自动写入记忆 (syncTurn)',
        'memory.syncRooms': '同步群聊有效发言到记忆库',
        'memory.saveSettings': '保存策略',
        'memory.saved': '已保存。',
        'memory.providers': '已安装的记忆库插件',
        'memory.use': '切换启用',
        'memory.inUse': '当前使用',
        'memory.bundled': '内置',
        'memory.downloaded': '已下载',
        'memory.uninstall': '卸载',
        'memory.config': '配置',
        'memory.hideConfig': '收起配置',
        'memory.saveConfig': '保存并重载',
        'memory.installTitle': '下载 / 安装其他记忆库插件',
        'memory.installHint': '支持一键安装目录模板，或填写 npm 包（npm:<包名>）、Git 仓库地址、.tgz 链接或包含 plugin.json 的本地目录路径。',
        'memory.installPlaceholder': '例如：npm:@scope/dsh-memory-xxx、https://github.com/... 或 /path/to/plugin',
        'memory.installBtn': '下载并启用',
        'memory.catalogTitle': '可一键安装的记忆库目录',
        'memory.catalogInstall': '安装并启用',
        'memory.installed': '已安装',
        'memory.searchTitle': '按 Bot 测试记忆召回',
        'memory.searchPlaceholder': '输入关键词，测试该 Bot 独立空间的记忆检索…',
        'memory.searchBtn': '检索',
        'memory.searchEmpty': '未检索到匹配记忆。',
        'screen.title': '屏幕',
        'screen.stopped': '已关闭 · 释放内存与 CPU',
        'screen.stoppedSaved': '已关闭 · 桌面状态已保存',
        'screen.offline': '虚拟屏服务未启动（点接管将自动拉起）',
        'screen.starting': '正在启动虚拟屏服务…',
        'screen.hostOutdated': 'Host 插件未重载（请重启当前 dsh web）',
        'screen.refreshHost': '刷新检测',
        'screen.active': '运行中',
        'screen.frozen': '已关闭 · 释放内存与 CPU',
        'screen.needHuman': '等待人工接管',
        'screen.takeoverState': '人工接管中',
        'screen.start': '启动',
        'screen.stop': '关闭释放',
        'screen.thaw': '唤醒 →',
        'screen.freeze': '冻结',
        'screen.takeover': '接管',
        'screen.shrinkRelease': '缩小归还',
        'screen.release': '交还',
        'screen.brake': '制动',
        'screen.browser': '浏览器',
        'screen.terminal': '终端',
        'screen.filesApp': '文件',
        'screen.files': '屏内文件中转',
        'screen.filesEmpty': '虚拟屏 downloads 目录暂无文件。',
        'settings.system': '系统监控与网关',
        'system.title': '宿主机系统信息与网关传输配置',
        'system.hint': '实时采集磁盘占用、内存占用、CPU 占用与开机时长，通过 BotScreen 网关传输并支持配置接口与主动上报。',
        'system.refresh': '立即刷新',
        'system.liveOn': '实时流：已开启',
        'system.liveOff': '实时流：已关闭',
        'system.cpu': 'CPU 占用',
        'system.memory': '内存占用',
        'system.disk': '磁盘占用',
        'system.uptime': '开机时长',
        'system.cores': '核心数',
        'system.load': '平均负载',
        'system.bootTime': '开机时间',
        'system.available': '可用',
        'system.free': '剩余',
        'system.gatewayStatus': '网关状态',
        'system.online': '已连接',
        'system.offline': '未连接',
        'system.configTitle': '网关与采集接口配置',
        'system.gatewayUrl': '网关地址 (Gateway URL)',
        'system.gatewayUrlPlaceholder': '留空默认 http://127.0.0.1:6200',
        'system.adminToken': '网关管理 Token',
        'system.adminTokenPlaceholder': '可选（留空沿用环境变量 BOTSCREEN_ADMIN_TOKEN）',
        'system.diskPaths': '磁盘挂载点路径',
        'system.diskPathsPlaceholder': '逗号分隔，如 /, /data',
        'system.refreshInterval': '刷新间隔（秒）',
        'system.frameRate': '虚拟屏帧率',
        'system.frameRateHint': '30 / 15 / 10 帧，默认 15 帧。修改后放大屏幕实时生效。',
        'system.pushUrl': '网关主动上报目标接口（可选）',
        'system.pushUrlPlaceholder': '例如 http://127.0.0.1:9000/metrics',
        'system.pushInterval': '定时上报周期（秒，0 表示关闭）',
        'system.pushToken': '上报鉴权 Token（可选）',
        'system.saveConfig': '保存并同步到网关',
        'system.testPush': '立即推送一次',
        'system.pushOk': '已通过网关成功推送',
        'system.endpointsTitle': '已配置的接口地址',
        'system.mountsTitle': '磁盘挂载点明细',
        'system.hostPanelTitle': '性能用量 · 主机信息',
        'system.hostname': '主机',
        'system.cgroupOff': '整机指标（无 cgroup）',
        'system.fallbackMode': '本机降级采集',
        'system.openDetails': '详情',
        'system.waitingGateway': '待连接',
        'screen.upload': '上传文件',
        'screen.panelToggle': '屏幕与任务栏',
        'screen.helpTitle': '遇到阻塞，请求人工接管',
        'screen.helpOpen': '接管屏幕处理',
        'screen.helpRelease': '缩小归还 Bot',
        'screen.helpCancel': '取消',
        'screen.helpNotePlaceholder': '可选备注（如：已完成验证码/登录，请继续）…',
        'screen.modalHint': '已放大进入人工接管：可直接点击、拖拽、滚轮或输入；点击「缩小归还」或收起窗口即刻归还给 Bot。',
        'screen.hudFps': '帧率',
        'screen.hudLatency': '延迟',
        'screen.hudTarget': '到网关',
        'screen.typePlaceholder': '输入要发送到屏幕的文本或密码…',
        'screen.typeSend': '发送',
        'screen.openVnc': '新窗口 VNC',
        'screen.routinesEmptyTitle': '暂无排程任务',
        'screen.routinesEmptyDesc': '按 cron 表达式排程一个提示词。Bot 会自动在工作区与虚拟屏中运行并汇报结果。',
        'screen.routinesNew': '新建定时任务',
        'remote.button': '远程',
        'remote.title': '公网访问',
        'remote.subtitle': '把本机 DSH 网关通过 Cloudflare 隧道发布出去，链路端到端加密。',
        'remote.appSubtitle': '把本机 DSH 网关通过 Cloudflare 隧道发布出去；用 public-bot 扫下方二维码即可连接。',
        'remote.starting': '正在启动网关…',
        'remote.rotating': '正在轮换访问密钥…',
        'remote.running': '在线',
        'remote.stopped': '未启动',
        'remote.healthy': '健康',
        'remote.unhealthy': '异常',
        'remote.tab.qr': '二维码',
        'remote.tab.input': '输入链接',
        'remote.tab.app': '安卓 App',
        'remote.appLabel': 'Android App 用的明文 token 链接',
        'remote.appHint': '在 public-bot › 添加主机 › 扫码链接 里扫描。此通道不是端到端加密：Cloudflare 能看到 token，泄漏时请点「轮换 App 令牌」。',
        'remote.appDisabled': 'App 直连通道未启用：在 dsh-remote 配置里打开 proxy.appBridge=true 后重开本弹窗。',
        'remote.copyApp': '复制 App 链接',
        'remote.rotateApp': '轮换 App 令牌',
        'remote.rotatedApp': 'App 令牌已轮换，旧链接失效，需要重新扫码',
        'remote.linkLabel': '完整访问链接（含访问密钥）',
        'remote.inputPlaceholder': '粘贴完整访问链接，例如 https://xxx.trycloudflare.com/#k=…',
        'remote.inputHint': '用手机 App 扫左侧二维码，或在这里粘贴整条链接校验后直接打开。',
        'remote.qrHint': '用 public-bot 扫码，或复制链接。密钥在 URL 的 # 片段里，不会经过 Cloudflare。',
        'remote.check': '校验',
        'remote.copied': '已复制',
        'remote.copyFailed': '复制失败',
        'remote.copy': '复制链接',
        'remote.open': '在浏览器打开',
        'remote.refresh': '刷新',
        'remote.rotate': '轮换密钥',
        'remote.rotated': '密钥已轮换，旧链接在宽限期后失效',
        'remote.stop': '停止映射',
        'remote.close': '关闭',
        'remote.notRunning': '网关尚未启动。',
        'remote.failed': '网关命令失败',
        'remote.valid': '链接有效',
        'remote.invalid': '无法识别的网关链接或 SSH 串',
        'remote.token': '密钥',
        'remote.tunnel': '隧道',
        'remote.psk': '密钥 ID',
        'remote.pid': '进程',
        'remote.copyLegacy': '该链接走的是旧版明文 token 通道。',
        'remote.emptyState': '启动网关后这里会显示二维码与完整访问链接。',
        'remote.stoppedToast': '网关已停止',
        'remote.needBin': '找不到 dsh-remote CLI，请用 DSH_REMOTE_BIN 指向 bin/dsh-remote.mjs。',
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

    const REMOTE_CSS = `
.bm-remote-backdrop { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center;
  justify-content: center; padding: 16px; background: rgba(6, 10, 16, 0.78); backdrop-filter: blur(5px); }
.bm-remote-dialog { width: min(620px, 94vw); max-height: 90vh; display: flex; flex-direction: column;
  background: var(--dsw-alias-card-fill, #17171c); border: 0.5px solid var(--dsw-alias-border-l2, #2a2a31); border-radius: 14px;
  overflow: hidden; box-shadow: 0 24px 64px rgba(0,0,0,0.5); }
.bm-remote-head { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px 10px; }
.bm-remote-title { font-size: 15px; font-weight: 650; color: var(--dsw-alias-label-primary, #e8e8ec); }
.bm-remote-sub { margin-top: 3px; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary, #9b9ba4); }
.bm-remote-x { margin-left: auto; appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #9b9ba4);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 8px; }
.bm-remote-x:hover { background: var(--dsw-alias-interactive-bg-hover, #26262f); color: var(--dsw-alias-label-primary, #e8e8ec); }
.bm-remote-body { padding: 0 16px 10px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.bm-remote-meta { display: flex; flex-wrap: wrap; gap: 6px; }
.bm-remote-chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2, #2a2a31);
  color: var(--dsw-alias-label-secondary, #9b9ba4); background: var(--dsw-alias-bg-layer-1, #1d1d24); }
.bm-remote-chip[data-ok='true'] { color: #16a34a; border-color: color-mix(in srgb, #16a34a 40%, transparent); }
.bm-remote-chip[data-ok='false'] { color: #d97706; }
.bm-remote-tabs { display: inline-flex; gap: 3px; padding: 3px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #1d1d24);
  border: 0.5px solid var(--dsw-alias-border-l2, #2a2a31); align-self: flex-start; }
.bm-remote-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #9b9ba4);
  font-size: 12.5px; padding: 5px 12px; border-radius: 8px; cursor: pointer; }
.bm-remote-tab[data-active='true'] { background: var(--dsw-alias-interactive-bg-hover, #26262f); color: var(--dsw-alias-label-primary, #e8e8ec); font-weight: 600; }
.bm-remote-pane { display: flex; flex-direction: column; gap: 10px; }
.bm-remote-qr-wrap { align-self: center; padding: 8px; border-radius: 14px; background: #fff; border: 0.5px solid var(--dsw-alias-border-l2, #2a2a31); }
.bm-remote-qr { width: 168px; height: 168px; display: block; image-rendering: pixelated; }
.bm-remote-link { font-size: 11.5px; line-height: 16px; word-break: break-all; padding: 8px 10px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #1d1d24); border: 0.5px solid var(--dsw-alias-border-l2, #2a2a31);
  color: var(--dsw-alias-label-primary, #e8e8ec); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.bm-remote-hint { font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-secondary, #9b9ba4); }
.bm-remote-input { width: 100%; min-height: 74px; resize: vertical; box-sizing: border-box; font: inherit; font-size: 12.5px;
  padding: 9px 10px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2, #2a2a31);
  background: var(--dsw-alias-bg-layer-1, #1d1d24); color: var(--dsw-alias-label-primary, #e8e8ec); }
.bm-remote-result { font-size: 12px; color: var(--dsw-alias-label-secondary, #9b9ba4); }
.bm-remote-error { font-size: 12px; color: #dc2626; line-height: 17px; white-space: pre-wrap; }
.bm-remote-busy { font-size: 12px; color: var(--dsw-alias-brand-primary, #4d6bfe); }
.bm-remote-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 16px 14px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, #2a2a31); background: var(--dsw-alias-bg-layer-1, #1d1d24); }
.bm-remote-btn { appearance: none; border: 0.5px solid var(--dsw-alias-border-l2, #2a2a31); background: var(--dsw-alias-card-fill, #17171c);
  color: var(--dsw-alias-label-primary, #e8e8ec); font-size: 12.5px; padding: 6px 12px; border-radius: 9px; cursor: pointer; }
.bm-remote-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #26262f); }
.bm-remote-btn[data-primary='true'] { background: #4d6bfe; border-color: transparent; color: #fff; font-weight: 600; }
.bm-remote-btn[data-danger='true'] { color: #dc2626; }
.bm-remote-btn:disabled { opacity: 0.5; cursor: default; }
.bm-remote-toast { font-size: 11.5px; color: #16a34a; margin-left: auto; }
.bm-remote-empty { padding: 24px 8px; text-align: center; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #9b9ba4); }
    `

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
      .bm-btn.primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted); border-color: transparent; }
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
      .bm-page-split { display: flex; height: 100%; padding: 0; overflow: hidden;
        /* Standalone page has no shell sidebar: still clear the window strip (macOS). */
        padding-top: var(--dsh-frame-top-clearance, 0px); }
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
      /* Bot sidebar collapse: a 56px rail keeps every Bot one click away. */
      .bm-pane { transition: width 180ms var(--ds-ease-in-out, ease), padding 180ms var(--ds-ease-in-out, ease); }
      .bm-pane[data-collapsed='true'] { width: 56px; padding: 10px 6px; gap: 8px; align-items: center; }
      .bm-pane[data-collapsed='true'] .bm-pane-head { justify-content: center; width: 100%; padding: 2px 0; }
      .bm-pane-actions { display: flex; align-items: center; gap: 4px; flex: none; }
      .bm-pane-collapse { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary);
        width: 24px; height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center;
        border-radius: var(--dsw-radius-sm, 6px); cursor: pointer; flex: none; }
      .bm-pane-collapse:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .bm-pane-rail { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; align-items: center;
        gap: 4px; overflow-y: auto; overflow-x: hidden; padding: 2px 0; scrollbar-width: none; }
      .bm-pane-rail::-webkit-scrollbar { width: 0; }
      .bm-pane-rail-btn { appearance: none; border: 0; background: transparent; padding: 3px; width: 38px; height: 38px;
        display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; cursor: pointer;
        color: var(--dsw-alias-label-secondary); position: relative; flex: none; }
      .bm-pane-rail-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .bm-pane-rail-btn[data-active='true'] { background: var(--dsw-alias-button-ghost-active-fill); }
      .bm-pane-rail-btn[data-active='true']::after { content: ''; position: absolute; left: -3px; top: 10px; bottom: 10px;
        width: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
      .bm-pane-rail-dot { position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px; border-radius: 50%;
        background: var(--dsw-alias-brand-primary); border: 1.5px solid var(--dsw-alias-bg-base); }
      .bm-pane-rail-sep { width: 24px; height: 1px; background: var(--dsw-alias-border-l2); margin: 2px 0; flex: none; }
      .bm-pane-rail-foot { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 2px;
        border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 6px; flex: none; }
      .bm-pane-rail-empty { font-size: 11px; color: var(--dsw-alias-label-tertiary); padding: 4px 0; }
      /* Standalone page: no shell chrome. The narrow-screen drawer keeps its own
         overlay so it can never strand an inert page behind a hidden column. */
      html[data-bm-page='standalone'] [data-shell-leading] { display: none !important; }
      html[data-bm-page='standalone'] [data-slot='root'] > div:not([data-sidebar-drawer]) > [class*='sidebarCol'],
      html[data-bm-page='standalone'] [data-slot='root'] > div:not([data-sidebar-drawer]) > [class*='handle'][data-side='sidebar'] { display: none !important; }
      html[data-bm-page='standalone'] [data-slot='root'] > div:not([data-sidebar-drawer]):has(> [class*='sidebarCol']) {
        grid-template-columns: 0 minmax(0px, 1fr) minmax(0px, 0px) !important; }
      /* The drawer band exists only for the opener this page hides. */
      html[data-bm-page='standalone'] [data-slot='root'] > div[data-sidebar-drawer] [data-global-panel] { padding-top: 0 !important; }
      .bm-detail-col { flex: 1; min-width: 0; overflow: auto; padding: 28px 32px 48px; }
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
      .bm-attach-list { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .bm-attach-item { display: flex; align-items: center; gap: 7px; max-width: 240px; padding: 4px 6px 4px 4px;
        border-radius: 9px; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-attach-thumb { appearance: none; border: 0; padding: 0; width: 34px; height: 34px; flex: none;
        border-radius: 6px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); cursor: zoom-in; }
      .bm-attach-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .bm-attach-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .bm-attach-name { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 132px; }
      .bm-attach-size { font-size: 10px; line-height: 13px; color: var(--dsw-alias-label-tertiary);
        font-variant-numeric: tabular-nums; }
      .bm-attach-remove { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary);
        font: inherit; font-size: 14px; line-height: 16px; cursor: pointer; padding: 0 2px; flex: none; }
      .bm-attach-remove:hover { color: var(--dsw-alias-label-error); }
      .bm-attach-tools { display: inline-flex; align-items: center; gap: 8px; }
      .bm-attach-count { font-size: 10.5px; line-height: 14px; color: var(--dsw-alias-label-tertiary);
        font-variant-numeric: tabular-nums; }
      .bm-compose[data-drag='true'] { outline: 1px dashed var(--dsw-alias-border-selected); outline-offset: 3px;
        border-radius: var(--dsw-radius-lg); }
      .bm-drop-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        font-size: 12px; color: var(--dsw-alias-brand-primary); pointer-events: none;
        background: color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent); border-radius: inherit; }
      .bm-compose { position: relative; }
      .bm-bind-note { display: flex; align-items: center; gap: 8px; margin: 0 16px 8px; padding: 6px 10px;
        font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary);
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-1); }
      .bm-bind-note span { flex: 1; min-width: 0; }
      /* a Host-folded transcript: same rhythm as a live one, no streaming affordances */
      .bm-history { display: flex; flex-direction: column; gap: 10px; }
      .bm-history-note { display: flex; align-items: center; gap: 8px; font-size: 11px;
        color: var(--dsw-alias-label-tertiary); }
      .bm-history-note[data-error='true'] { color: var(--dsw-alias-label-danger, #c0392b); }
      .bm-tool-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
      .bm-tool-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px;
        font-size: 10.5px; line-height: 16px; color: var(--dsw-alias-label-secondary);
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px;
        background: var(--dsw-alias-bg-layer-1); }
      .bm-msg-badge { margin-left: 6px; font-size: 10.5px; opacity: 0.7; }
      .bm-host-reply { align-self: stretch; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-1); padding: 6px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .bm-host-reply summary { cursor: pointer; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }
      .bm-host-reply-body { margin-top: 8px; max-height: 220px; overflow: auto; color: var(--dsw-alias-label-primary); }
      .bm-host-reply-body .bm-md { font-size: 12.5px; line-height: 19px; }
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
      .bm-status-pill { font-size: 10.5px; line-height: 16px; padding: 1px 8px; border-radius: 999px;
        border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .bm-status-pill[data-kind='completed'] { color: #16a34a; border-color: color-mix(in srgb, #16a34a 50%, transparent); background: color-mix(in srgb, #16a34a 10%, transparent); font-weight: 600; }
      .bm-status-pill[data-kind='settled'] { color: #2f9e6e; border-color: color-mix(in srgb, #2f9e6e 45%, transparent); }
      .bm-status-pill[data-kind='stalled'], .bm-status-pill[data-kind='capped'] { color: #d97706; border-color: color-mix(in srgb, #d97706 45%, transparent); }
      .bm-status-pill[data-kind='waiting_user'] { color: #ea580c; border-color: color-mix(in srgb, #ea580c 45%, transparent); }
      .bm-status-pill[data-kind='running'] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-border-selected); }
      .bm-taskboard { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 16px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
      .bm-taskboard-title { font-size: 10.5px; line-height: 14px; font-weight: 600; color: var(--dsw-alias-label-tertiary);
        letter-spacing: 0.03em; text-transform: uppercase; }
      .bm-taskboard-list { display: flex; flex-wrap: wrap; gap: 6px; }
      .bm-task-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; line-height: 16px;
        padding: 2px 8px; border-radius: 6px; border: 0.5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-card-fill); }
      .bm-task-chip[data-status='in_progress'] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); }
      .bm-task-chip[data-status='completed'] { opacity: 0.72; border-color: color-mix(in srgb, #2f9e6e 40%, transparent); }
      .bm-task-paths { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 10px; color: var(--dsw-alias-label-tertiary); }
      .bm-msg-completion { align-self: stretch; max-width: 880px; border-radius: 10px; padding: 12px 14px;
        border: 1px solid color-mix(in srgb, #16a34a 45%, transparent);
        background: color-mix(in srgb, #16a34a 8%, var(--dsw-alias-card-fill)); display: flex; flex-direction: column; gap: 6px; }
      .bm-msg-completion-head { font-size: 12px; font-weight: 600; color: #16a34a; display: flex; align-items: center; gap: 6px; }
      .bm-msg-deliverables { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
      .bm-msg-system { align-self: stretch; max-width: 880px; border-radius: 8px; padding: 8px 12px; font-size: 12px; line-height: 18px;
        border: 0.5px solid color-mix(in srgb, #d97706 45%, transparent);
        background: color-mix(in srgb, #d97706 8%, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-secondary); }
      .bm-ephemeral-zone { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 16px;
        border-top: 0.5px solid var(--dsw-alias-border-l2); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%, transparent);
        max-height: 260px; overflow: auto; }
      .bm-ephemeral-title { font-size: 10.5px; line-height: 14px; font-weight: 600; letter-spacing: 0.03em;
        text-transform: uppercase; color: var(--dsw-alias-label-tertiary); display: flex; align-items: center; gap: 6px; }
      .bm-ephemeral-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 8px; }
      .bm-ephemeral-card { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 9px; padding: 9px 11px;
        background: var(--dsw-alias-card-fill); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .bm-ephemeral-card[data-state='waiting_approval'], .bm-ephemeral-card[data-state='waiting_question'] {
        border-color: color-mix(in srgb, #d97706 55%, transparent); }
      .bm-ephemeral-card[data-state='paused_error'] { border-color: color-mix(in srgb, var(--dsw-alias-label-error) 55%, transparent); }
      .bm-ephemeral-head { display: flex; align-items: center; gap: 7px; font-size: 12px; }
      .bm-ephemeral-badge { margin-left: auto; font-size: 10px; line-height: 15px; padding: 1px 6px; border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .bm-qcard { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--dsw-radius-md);
        border: 0.5px solid var(--dsw-alias-border-selected); background: var(--dsw-alias-bg-layer-1); }
      .bm-qitem { display: flex; flex-direction: column; gap: 5px; }
      .bm-qtitle { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      /* Rich Media Output Styles (Tables, Callouts, Details, Diff, Mermaid, Math, Artifacts, Cards) */
      .bm-table-wrap { overflow-x: auto; margin: 8px 0; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-table { width: 100%; border-collapse: collapse; font-size: 12.5px; line-height: 18px; }
      .bm-table th, .bm-table td { padding: 7px 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); text-align: left; }
      .bm-table th { background: var(--dsw-alias-bg-layer-1); font-weight: 600; color: var(--dsw-alias-label-primary); }
      .bm-table tr:last-child td { border-bottom: 0; }
      .bm-table tr:hover td { background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover) 55%, transparent); }
      .bm-callout { margin: 8px 0; padding: 9px 12px; border-radius: 8px; border-left: 3px solid var(--dsw-alias-brand-primary);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-layer-1)); display: flex; flex-direction: column; gap: 4px; }
      .bm-callout[data-tone='tip'] { border-left-color: #16a34a; background: color-mix(in srgb, #16a34a 8%, var(--dsw-alias-bg-layer-1)); }
      .bm-callout[data-tone='important'] { border-left-color: #7c3aed; background: color-mix(in srgb, #7c3aed 8%, var(--dsw-alias-bg-layer-1)); }
      .bm-callout[data-tone='warning'] { border-left-color: #d97706; background: color-mix(in srgb, #d97706 9%, var(--dsw-alias-bg-layer-1)); }
      .bm-callout[data-tone='caution'] { border-left-color: #dc2626; background: color-mix(in srgb, #dc2626 9%, var(--dsw-alias-bg-layer-1)); }
      .bm-callout-head { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-primary); }
      .bm-details { margin: 8px 0; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
      .bm-details > summary { padding: 7px 11px; cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-secondary); user-select: none; }
      .bm-details > summary:hover { color: var(--dsw-alias-label-primary); }
      .bm-details-body { padding: 8px 12px 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-diff-line { display: block; padding: 0 6px; margin: 0 -6px; }
      .bm-diff-line[data-diff='add'] { background: color-mix(in srgb, #16a34a 18%, transparent); color: #15803d; }
      .bm-diff-line[data-diff='del'] { background: color-mix(in srgb, #dc2626 18%, transparent); color: #b91c1c; }
      .bm-diff-line[data-diff='hunk'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-brand-primary); }
      .bm-math-block { margin: 8px 0; padding: 10px 14px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l2); font-family: Georgia, Cambria, 'Times New Roman', serif;
        font-size: 14px; text-align: center; overflow-x: auto; color: var(--dsw-alias-label-primary); }
      .bm-math-inline { font-family: Georgia, Cambria, 'Times New Roman', serif; font-style: italic;
        padding: 0 4px; border-radius: 4px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 80%, transparent); }
      .bm-artifact { margin: 10px 0; border: 0.5px solid var(--dsw-alias-border-selected); border-radius: 10px;
        overflow: hidden; background: var(--dsw-alias-card-fill); }
      .bm-artifact-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
        background: var(--dsw-alias-bg-layer-1); border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-artifact-type { font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 1px 6px; border-radius: 5px;
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color: var(--dsw-alias-brand-primary); }
      .bm-artifact-title { font-size: 12.5px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-artifact-body { padding: 10px 12px; max-height: 420px; overflow: auto; }
      .bm-artifact-iframe { width: 100%; height: 280px; border: 0; border-radius: 6px; background: #fff; }
      .bm-mermaid-viz { padding: 12px; overflow-x: auto; display: flex; flex-direction: column; gap: 8px; }
      .bm-mermaid-edge { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
      .bm-mermaid-node { padding: 4px 10px; border-radius: 7px; border: 0.5px solid var(--dsw-alias-border-selected);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-card-fill)); font-weight: 500; }
      .bm-mermaid-arrow { font-size: 11px; color: var(--dsw-alias-label-tertiary); display: inline-flex; align-items: center; gap: 4px; }
      .bm-metrics-card, .bm-struct-card, .bm-file-card { margin: 8px 0; padding: 11px 13px; border-radius: 10px;
        border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 8px; }
      .bm-metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
      .bm-metric-tile { padding: 8px 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-card-fill); }
      .bm-metric-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .bm-metric-val { font-size: 18px; font-weight: 700; line-height: 24px; color: var(--dsw-alias-label-primary); margin-top: 2px; }
      .bm-metric-delta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .bm-metric-tile[data-tone='ok'] .bm-metric-delta { color: #16a34a; }
      .bm-metric-tile[data-tone='warn'] .bm-metric-delta { color: #d97706; }
      .bm-metric-tile[data-tone='err'] .bm-metric-delta { color: var(--dsw-alias-label-error); }
      .bm-file-row { display: flex; align-items: center; gap: 10px; }
      .bm-file-icon { width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center;
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); color: var(--dsw-alias-brand-primary); font-weight: 700; font-size: 11px; flex: none; }
      .bm-inline-img { max-width: 100%; max-height: 320px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); margin: 4px 0; display: block; }
      .bm-msg-streaming { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l2)); }
      /* Colored @mention pill cards & upward @ Bot picker */
      .bm-mention-pill { --bm-mc: var(--dsw-alias-brand-primary); display: inline-flex; align-items: center; gap: 4px;
        padding: 0 7px; margin: 0 2px; border-radius: 6px; font-size: 0.92em; line-height: 1.55; font-weight: 600;
        vertical-align: baseline; white-space: nowrap;
        color: var(--bm-mc);
        border: 1px solid color-mix(in srgb, var(--bm-mc) 48%, transparent);
        background: color-mix(in srgb, var(--bm-mc) 13%, var(--dsw-alias-card-fill));
        box-shadow: 0 1px 2px color-mix(in srgb, var(--bm-mc) 12%, transparent); }
      .bm-mention-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--bm-mc); flex: none; }
      .bm-mention-rm { appearance: none; border: 0; background: transparent; color: inherit; opacity: 0.7;
        font: inherit; font-size: 13px; line-height: 1; padding: 0 0 0 2px; cursor: pointer; }
      .bm-mention-rm:hover { opacity: 1; }
      .bm-compose-wrap { position: relative; flex: none; border-top: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-compose-wrap .bm-compose { border-top: 0; }
      .bm-compose-mentions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 12px 0; }
      .bm-mention-btn { flex: none; height: 34px; min-width: 34px; padding: 0 8px; font-weight: 700; font-size: 14px; }
      .bm-mention-pop { position: absolute; bottom: calc(100% + 6px); left: 12px; width: min(340px, calc(100% - 24px));
        max-height: 260px; overflow: auto; z-index: 45; border-radius: 11px; padding: 5px;
        border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-card-fill);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22); display: flex; flex-direction: column; gap: 2px; }
      .bm-mention-pop-head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 4px 8px 5px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
        border-bottom: 0.5px solid var(--dsw-alias-border-l2); margin-bottom: 2px; }
      .bm-mention-opt { appearance: none; border: 0; background: transparent; font: inherit; width: 100%;
        display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 8px; cursor: pointer;
        text-align: left; color: var(--dsw-alias-label-primary); }
      .bm-mention-opt:hover, .bm-mention-opt[data-active='true'] { background: var(--dsw-alias-button-ghost-active-fill); }
      .bm-mention-opt-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .bm-mention-opt-name { font-size: 12.5px; font-weight: 600; line-height: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-mention-opt-role { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-mention-opt-tag { font-size: 10px; line-height: 14px; padding: 1px 6px; border-radius: 5px; flex: none; font-weight: 600;
        color: var(--bm-mc, var(--dsw-alias-brand-primary));
        border: 1px solid color-mix(in srgb, var(--bm-mc, var(--dsw-alias-brand-primary)) 40%, transparent);
        background: color-mix(in srgb, var(--bm-mc, var(--dsw-alias-brand-primary)) 11%, transparent); }
      /* Modular Settings Center (inspired by grouped mobile/desktop card navigation) */
      .bm-settings { display: flex; height: 100%; min-height: 0; overflow: hidden; }
      .bm-set-nav { width: 310px; flex: none; overflow: auto; padding: 18px 16px 32px;
        border-right: 0.5px solid var(--dsw-alias-border-l2); display: flex; flex-direction: column; gap: 14px; }
      .bm-set-hero { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px 4px 4px; }
      .bm-set-hero-top { display: flex; align-items: center; justify-content: space-between; width: 100%; }
      .bm-set-botpills { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
      .bm-set-group-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary);
        padding: 4px 6px 0; letter-spacing: 0.03em; }
      .bm-set-card { border-radius: 14px; border: 0.5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-card-fill); overflow: hidden; display: flex; flex-direction: column; }
      .bm-set-row { appearance: none; border: 0; background: transparent; font: inherit; width: 100%; box-sizing: border-box;
        display: flex; align-items: center; gap: 11px; padding: 11px 14px; color: var(--dsw-alias-label-primary);
        cursor: pointer; text-align: left; border-bottom: 0.5px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l2)); }
      .bm-set-row:last-child { border-bottom: 0; }
      .bm-set-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-set-row[data-active='true'] { background: var(--dsw-alias-button-ghost-active-fill); }
      .bm-set-icon { width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center;
        color: var(--dsw-alias-label-secondary); flex: none; }
      .bm-set-row-label { font-size: 13px; font-weight: 500; flex: 1; min-width: 0; }
      .bm-set-row-val { font-size: 12px; color: var(--dsw-alias-label-tertiary); max-width: 130px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-set-chev { font-size: 14px; color: var(--dsw-alias-label-tertiary); opacity: 0.7; }
      .bm-set-body { flex: 1; min-width: 0; overflow: auto; padding: 24px 28px 48px; }
      .bm-set-panel { max-width: 780px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
      .bm-sys-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
      .bm-sys-card { border-radius: 12px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
        padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
      .bm-sys-card-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: 0.02em; }
      .bm-sys-card-val { font-size: 20px; font-weight: 650; color: var(--dsw-alias-label-primary); line-height: 1.2; }
      .bm-sys-card-sub { font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.35; }
      .bm-sys-bar { height: 6px; border-radius: 99px; background: var(--dsw-alias-border-l2); overflow: hidden; margin-top: 2px; }
      .bm-sys-bar-fill { height: 100%; border-radius: 99px; background: #4d6bfe; transition: width 0.25s ease; }
      .bm-sys-bar-fill[data-warn='true'] { background: #f59e0b; }
      .bm-sys-bar-fill[data-crit='true'] { background: #ef4444; }
      .bm-host-mini { margin-top: 8px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2); padding: 9px 10px; display: flex; flex-direction: column; gap: 7px; }
      .bm-host-mini-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
      .bm-host-mini-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bm-host-mini-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
      .bm-host-mini-rows { display: flex; flex-direction: column; gap: 5px; }
      .bm-host-mini-row { display: flex; flex-direction: column; gap: 2px; }
      .bm-host-mini-row-top { display: flex; align-items: center; justify-content: space-between; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
      .bm-host-mini-row-top strong { font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
      .bm-host-mini .bm-sys-bar { height: 4px; margin-top: 0; }
      .bm-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px;
        border-radius: 9px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); cursor: pointer; }
      .bm-toggle-row span { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-primary); }
      .bm-pane-foot { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 8px; display: flex; gap: 6px; align-items: center; }
      .bm-room-activity { flex: none; display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 16px;
        border-top: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
      .bm-act-chip { font-size: 11px; line-height: 16px; padding: 1px 8px; border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); }
      .bm-mem-panel { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
      .bm-mem-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .bm-mem-grid { display: flex; flex-direction: column; gap: 10px; }
      .bm-mem-card { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-card-fill); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
      .bm-mem-card[data-active='true'] { border-color: var(--dsw-alias-border-selected); }
      .bm-mem-card-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .bm-mem-badge { font-size: 10.5px; line-height: 16px; padding: 1px 7px; border-radius: 999px;
        border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); }
      .bm-mem-badge[data-state='ok'] { color: #2f9e6e; border-color: color-mix(in srgb, #2f9e6e 45%, transparent); }
      .bm-mem-badge[data-state='warn'] { color: #d97706; border-color: color-mix(in srgb, #d97706 45%, transparent); }
      .bm-mem-badge[data-state='err'] { color: var(--dsw-alias-label-error); }
      .bm-mem-checks { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .bm-mem-checks label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
      .bm-mem-cfg { display: flex; flex-direction: column; gap: 10px; padding-top: 10px;
        border-top: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-mem-results { display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 18px;
        padding: 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l2); white-space: pre-wrap; }
      .bm-foot-toggle:not([data-wide='true']) span { display: none; }
      .bm-foot-toggle { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12px; line-height: 16px; display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 8px; border-radius: var(--dsw-radius-md); cursor: pointer; width: 100%; text-align: left; }
      .bm-foot-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .bm-foot-toggle[data-active='true'] { color: var(--dsw-alias-brand-primary); }

      /* ---- 3-column workspace + Right Rail (Screen Card + Scheduled Tasks) ---- */
      .bm-workspace { flex: 1; min-height: 0; display: flex; overflow: hidden; }
      .bm-right-rail { width: 296px; flex: none; border-left: 0.5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-0, var(--dsw-alias-card-fill)); display: flex; flex-direction: column; overflow-y: auto; }
      @media (max-width: 1020px) { .bm-right-rail { width: 256px; } }
      @media (max-width: 820px) { .bm-right-rail { display: none; } }
      .bm-rail-tabs { display: flex; align-items: center; gap: 14px; padding: 0 14px; height: 40px; flex: none;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-rail-tab { appearance: none; border: 0; background: transparent; font: inherit; font-size: 12.5px; font-weight: 500;
        color: var(--dsw-alias-label-tertiary); padding: 10px 2px; cursor: pointer; position: relative; }
      .bm-rail-tab[data-active='true'] { color: var(--dsw-alias-label-primary); font-weight: 600; }
      .bm-rail-tab[data-active='true']::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
        border-radius: 2px; background: var(--dsw-alias-brand-primary, #1677ff); }
      .bm-rail-body { padding: 12px; display: flex; flex-direction: column; gap: 14px; flex: 1; min-height: 0; }
      .bm-screen-card { position: relative; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden;
        background: #07090c; border: 1px solid var(--dsw-alias-border-l2); display: flex; align-items: center; justify-content: center; }
      .bm-screen-card[data-state='AGENT_ACTIVE'] { border-color: color-mix(in srgb, #2f9e6e 48%, transparent); }
      .bm-screen-card[data-state='FROZEN'] { border-color: color-mix(in srgb, #3b82f6 42%, transparent); }
      .bm-screen-card[data-state='NEED_HUMAN'], .bm-screen-card[data-state='HUMAN_TAKEOVER'] {
        border-color: #f59e0b; box-shadow: 0 0 0 2px color-mix(in srgb, #f59e0b 24%, transparent); }
      .bm-screen-img { width: 100%; height: 100%; object-fit: cover; display: block; cursor: default; }
      .bm-screen-img[data-frozen='true'], .bm-screen-img[data-stopped='true'] { opacity: 0.42; filter: grayscale(35%); }
      .bm-screen-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center;
        color: rgba(255,255,255,0.32); padding-bottom: 24px; }
      .bm-screen-overlay-badge { position: absolute; top: 8px; right: 8px; font-size: 10px; line-height: 14px;
        padding: 2px 7px; border-radius: 999px; background: rgba(15, 23, 42, 0.78); color: #e2e8f0;
        border: 0.5px solid rgba(255,255,255,0.16); backdrop-filter: blur(4px); }
      .bm-screen-footer { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 8px;
        padding: 20px 10px 9px; background: linear-gradient(transparent, rgba(0, 0, 0, 0.86) 45%); color: #f8fafc; }
      .bm-screen-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: #64748b; }
      .bm-screen-dot[data-state='AGENT_ACTIVE'] { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
      .bm-screen-dot[data-state='FROZEN'] { background: #60a5fa; }
      .bm-screen-dot[data-state='NEED_HUMAN'], .bm-screen-dot[data-state='HUMAN_TAKEOVER'] {
        background: #f59e0b; box-shadow: 0 0 6px #f59e0b; animation: bm-pulse 1.2s ease-in-out infinite; }
      .bm-screen-ftext { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .bm-screen-ftitle { font-size: 12px; line-height: 15px; font-weight: 600; color: #f8fafc; }
      .bm-screen-fsub { font-size: 10.5px; line-height: 14px; color: rgba(226, 232, 240, 0.72);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-screen-cta { appearance: none; border: 0.5px solid rgba(255,255,255,0.22); background: rgba(255,255,255,0.12);
        color: #fff; font: inherit; font-size: 11px; font-weight: 500; padding: 4px 10px; border-radius: 6px;
        cursor: pointer; white-space: nowrap; backdrop-filter: blur(4px); }
      .bm-screen-cta:hover:not(:disabled) { background: rgba(255,255,255,0.22); }
      .bm-screen-cta:disabled { opacity: 0.45; cursor: not-allowed; }
      .bm-screen-cta[data-tone='warn'] { background: #d97706; border-color: #f59e0b; }
      .bm-screen-toolbar { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-top: 7px; }
      .bm-screen-toolbar .bm-btn.xs { font-size: 10.5px; padding: 2px 7px; line-height: 16px; }
      .bm-screen-meta { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); margin-left: auto;
        font-family: var(--dsw-font-mono, monospace); }

      .bm-rail-bothead { display: flex; align-items: center; gap: 8px; padding: 8px 0;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-rail-botmeta { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .bm-rail-botname { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary);
        display: flex; align-items: center; gap: 5px; }
      .bm-rail-botrole { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-weight: 400;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-rail-sub { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
      .bm-rail-plus { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
        font-size: 18px; line-height: 20px; width: 26px; height: 26px; border-radius: 6px; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; }
      .bm-rail-plus:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .bm-rail-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
        text-align: center; padding: 24px 12px; gap: 8px; }
      .bm-rail-empty-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); margin-top: 4px; }
      .bm-rail-empty-desc { font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-tertiary); max-width: 220px; }

      /* ---- Human Takeover Card & Modal ---- */
      .bm-help-card { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; border-radius: 10px;
        border: 1px solid color-mix(in srgb, #f59e0b 65%, transparent);
        background: color-mix(in srgb, #f59e0b 8%, var(--dsw-alias-card-fill)); }
      .bm-help-thumb { width: 124px; aspect-ratio: 16 / 9; border-radius: 6px; object-fit: cover; flex: none;
        background: #090c10; border: 0.5px solid var(--dsw-alias-border-l2); cursor: pointer; }
      .bm-help-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
      .bm-help-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12px; }
      .bm-help-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px;
        background: color-mix(in srgb, #f59e0b 20%, transparent); color: #b45309; text-transform: uppercase; }
      .bm-help-reason { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-primary); }
      .bm-help-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .bm-help-note { flex: 1; min-width: 180px; font: inherit; font-size: 11.5px; padding: 4px 8px; border-radius: 6px;
        border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }

      .bm-modal-backdrop { position: fixed; inset: 0; z-index: 9999; background: rgba(6, 10, 16, 0.78);
        display: flex; align-items: center; justify-content: center; padding: 16px; backdrop-filter: blur(5px); }
      .bm-modal { width: min(1240px, 95vw); max-height: 94vh; background: var(--dsw-alias-card-fill);
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 12px; overflow: hidden;
        display: flex; flex-direction: column; box-shadow: 0 24px 64px rgba(0,0,0,0.52); }
      .bm-modal-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
      .bm-modal-stage { position: relative; background: #05070a; display: flex; align-items: center; justify-content: center;
        overflow: hidden; max-height: 74vh; }
      .bm-modal-canvas { width: auto; height: auto; max-width: 100%; max-height: 74vh; display: block;
        cursor: default; touch-action: none; user-select: none; outline: none; }
      .bm-screen-hud { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px;
        pointer-events: none; z-index: 2; }
      .bm-screen-hud-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px;
        border-radius: 6px; background: rgba(2, 6, 23, 0.72); color: #e2e8f0;
        font-size: 11px; font-variant-numeric: tabular-nums; line-height: 1.4;
        border: 0.5px solid rgba(148, 163, 184, 0.28); backdrop-filter: blur(4px); }
      .bm-screen-hud-chip strong { color: #38bdf8; font-weight: 600; }
      .bm-screen-hud-chip[data-warn='1'] strong { color: #f59e0b; }
      .bm-modal-bar { display: flex; align-items: center; gap: 6px; padding: 8px 14px; flex-wrap: wrap;
        border-top: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
      .bm-modal-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; flex-wrap: wrap;
        border-top: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-bot-screen-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; margin-left: 2px; }
      .bm-bot-screen-dot[data-state='AGENT_ACTIVE'] { background: #22c55e; }
      .bm-bot-screen-dot[data-state='FROZEN'] { background: #60a5fa; }
      .bm-bot-screen-dot[data-state='NEED_HUMAN'], .bm-bot-screen-dot[data-state='HUMAN_TAKEOVER'] {
        background: #f59e0b; animation: bm-pulse 1.1s ease-in-out infinite; }
      .bm-avatar-rendered { background: transparent !important; overflow: visible; padding: 0; }
      .bm-avatar-rendered svg { width: 100%; height: 100%; display: block; overflow: visible; }
      .bm-avatar-live { display: inline-flex; align-items: center; justify-content: center; flex: none;
        overflow: visible; cursor: pointer; }
      .bm-avatar-box { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; padding: 12px;
        background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 10px; }
      .bm-avatar-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .bm-avatar-stage-wrap { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
      .bm-avatar-stage { width: 132px; height: 132px; border-radius: 14px; flex: none;
        border: 0.5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-base);
        display: flex; align-items: center; justify-content: center; cursor: grab; user-select: none; position: relative; }
      .bm-avatar-stage:active { cursor: grabbing; }
      .bm-avatar-stage-side { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 180px; }
      .bm-avatar-stage-btns { display: flex; gap: 6px; flex-wrap: wrap; }
      .bm-avatar-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(58px, 1fr)); gap: 6px;
        max-height: 196px; overflow-y: auto; padding: 2px; }
      .bm-avatar-item { appearance: none; border: 1px solid var(--dsw-alias-border-l3); border-radius: 10px;
        background: var(--dsw-alias-bg-base); padding: 4px 2px; display: flex; flex-direction: column;
        align-items: center; gap: 2px; cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 10px; }
      .bm-avatar-item:hover { border-color: var(--dsw-alias-border-selected); }
      .bm-avatar-item[data-active='true'] { border-color: var(--dsw-alias-border-selected);
        background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 600; }
      .bm-avatar-item-thumb { width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; }
      .bm-avatar-item-thumb svg { width: 38px; height: 38px; display: block; }
      .bm-avatar-item-name { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
      .bm-avatar-color-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .bm-avatar-color-picker { width: 26px; height: 26px; padding: 0; border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 50%; background: transparent; cursor: pointer; overflow: hidden; }
      .bm-avatar-toggles { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
      .bm-avatar-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
        color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }
      .bm-avatar-depth { display: inline-flex; align-items: center; gap: 8px; font-size: 12px;
        color: var(--dsw-alias-label-secondary); }
      .bm-avatar-depth input[type='range'] { width: 110px; }
      .bm-avatar-json-box { border-top: 0.5px solid var(--dsw-alias-border-l3); padding-top: 8px;
        display: flex; flex-direction: column; gap: 6px; }
      ${REMOTE_CSS}
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
        const avatarEngineStore = createStore({
          status: window.__DSH_AVATAR_ENGINE__ ? 'ready' : 'idle',
          engine: window.__DSH_AVATAR_ENGINE__ || null,
        })
        let avatarEnginePromise = null
        const ensureAvatarEngine = () => {
          if (window.__DSH_AVATAR_ENGINE__) {
            if (avatarEngineStore.getSnapshot().status !== 'ready') {
              avatarEngineStore.set({ status: 'ready', engine: window.__DSH_AVATAR_ENGINE__ })
            }
            return Promise.resolve(window.__DSH_AVATAR_ENGINE__)
          }
          if (avatarEnginePromise) return avatarEnginePromise
          avatarEngineStore.set({ status: 'loading', engine: null })
          avatarEnginePromise = new Promise((resolve) => {
            const script = document.createElement('script')
            script.src = '/botmode/api/avatar/bundle.js'
            script.async = true
            script.onload = () => {
              const eng = window.__DSH_AVATAR_ENGINE__ || null
              avatarEngineStore.set({ status: eng ? 'ready' : 'error', engine: eng })
              resolve(eng)
            }
            script.onerror = () => {
              avatarEnginePromise = null
              avatarEngineStore.set({ status: 'error', engine: null })
              resolve(null)
            }
            document.head.appendChild(script)
          })
          return avatarEnginePromise
        }
        const avatarSvgCache = new Map()
        const renderAvatarSvgCached = (engine, avatar, px) => {
          if (!engine || !avatar) return ''
          const key = JSON.stringify([
            avatar.avatarId || 'mochi',
            avatar.customJson || '',
            avatar.color || '#ff8a1f',
            avatar.eyeColor || '',
            avatar.clay !== false,
            Number(avatar.depth ?? 6),
            Number(avatar.yaw ?? 0),
            Number(avatar.pitch ?? 0),
            Boolean(avatar.orbit),
            Boolean(avatar.badge),
            px,
          ])
          if (avatarSvgCache.has(key)) return avatarSvgCache.get(key)
          try {
            const svg = engine.renderAvatarSvg(avatar, { size: px, reducedMotion: true })
            if (avatarSvgCache.size >= 256) {
              const firstKey = avatarSvgCache.keys().next().value
              if (firstKey !== undefined) avatarSvgCache.delete(firstKey)
            }
            avatarSvgCache.set(key, svg)
            return svg
          } catch (_err) {
            return ''
          }
        }
        const useAvatarEngine = () => {
          const snap = useSyncExternalStore(
            listener => avatarEngineStore.subscribe(listener),
            () => avatarEngineStore.getSnapshot(),
          )
          useEffect(() => {
            if (snap.status === 'idle') void ensureAvatarEngine()
          }, [snap.status])
          return snap
        }
        const AVATAR_EYE_SWATCHES = ['#151515', '#1b1b1b', '#ffffff', '#0a7cff', '#e11d48']
        const defaultClientAvatar = (fallbackColor) => ({
          avatarId: 'mochi',
          customJson: '',
          color: fallbackColor || '#ff8a1f',
          eyeColor: '#1b1b1b',
          material: 'flat',
          clay: true,
          yaw: 0,
          pitch: 0,
          orbit: false,
          badge: false,
          depth: 6,
          followPointer: true,
        })
        const pickRandomClientAvatar = (engine, prevId) => {
          const items = (engine && engine.ALL_AVATARS) || []
          const pals = ((engine && engine.PALETTES) || []).filter(p => p && p.id !== 'obsidian' && p.id !== 'pearl')
          const pool = items.length > 1 ? items.filter(it => it.id !== prevId) : items
          const item = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : { id: 'mochi' }
          const pal = pals.length > 0 ? pals[Math.floor(Math.random() * pals.length)] : { base: '#ff6a1a', eye: '#151515' }
          return {
            avatarId: item.id,
            customJson: '',
            color: pal.base,
            eyeColor: pal.eye || '#151515',
            material: 'flat',
            clay: true,
            yaw: 0,
            pitch: 0,
            orbit: false,
            badge: false,
            depth: 6,
            followPointer: true,
          }
        }
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
        const sendScreenInput = async (botId, input) => {
          const response = await fetch('/botmode/api/screen/input', {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ botId, input }),
          })
          if (response.status === 404) {
            return hostCommand('screen.human_input', { botId, input })
          }
          let payload
          try { payload = await response.json() } catch (_failure) { payload = null }
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error((payload && payload.error) || `Bot mode API answered ${response.status}`)
          }
          return payload.result
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
          const onBotPage = () => document.documentElement.getAttribute('data-bm-page') === 'standalone'
          const timer = window.setInterval(() => {
            if (document.visibilityState === 'hidden') return
            const panel = ctx.layout.panelInfo.getSnapshot()
            if ((panel && panel.activeId === PANEL_ID) || onBotPage()) void refreshHost()
          }, 3000)
          const unsubPanel = ctx.layout.panelInfo.subscribe(() => {
            const panel = ctx.layout.panelInfo.getSnapshot()
            if (panel && panel.activeId === PANEL_ID) void refreshHost()
          })
          return () => {
            window.clearInterval(timer)
            unsubPanel?.()
          }
        }, 'botmode: host state polling')
        // Strict sidebar isolation: Bot sessions (1:1 primary chats, hidden Group Room
        // sessions, and any legacy Bot directories) NEVER appear in the normal DSH
        // sidebar or normal workspace lists — regardless of which panel is active.
        const workspaceSvc = ctx.get('workspaces')
        const rawSessionSnapshot = sessions.list.getSnapshot.bind(sessions.list)
        const rawWorkspaceSnapshot = workspaceSvc.list.getSnapshot.bind(workspaceSvc.list)
        const normalizePath = (value) => (typeof value === 'string' ? value.trim().replaceAll('\\', '/').replace(/\/+$/, '') : '')
        const sameOrUnder = (parent, target) => {
          const p = normalizePath(parent)
          const t = normalizePath(target)
          if (!p || !t) return false
          return t === p || t.startsWith(`${p}/`)
        }
        const botDirs = () => {
          const dirs = roster.getSnapshot().map(bot => bot.dir).filter(dir => typeof dir === 'string' && dir !== '')
          const rt = hostStore.getSnapshot().state && hostStore.getSnapshot().state.runtime
          if (rt && typeof rt.root === 'string' && rt.root !== '') dirs.push(rt.root)
          if (rt && typeof rt.botsRoot === 'string' && rt.botsRoot !== '') dirs.push(rt.botsRoot)
          return dirs
        }
        const botSessionIds = () => {
          const ids = new Set(roster.getSnapshot().map(bot => bot.sessionId).filter(Boolean))
          for (const group of groupStore.getSnapshot()) {
            const memberSessions = group && group.memberSessions
            if (memberSessions && typeof memberSessions === 'object') {
              for (const sid of Object.values(memberSessions)) {
                if (typeof sid === 'string' && sid !== '') ids.add(sid)
              }
            }
          }
          return ids
        }
        const hiddenRoomSessionIds = () => {
          const ids = new Set()
          for (const group of groupStore.getSnapshot()) {
            const memberSessions = group && group.memberSessions
            if (memberSessions && typeof memberSessions === 'object') {
              for (const sid of Object.values(memberSessions)) {
                if (typeof sid === 'string' && sid !== '') ids.add(sid)
              }
            }
          }
          return ids
        }
        const underBotDir = (path) => {
          const norm = normalizePath(path)
          if (norm === '') return false
          if (/\/\.dsh\/botmode(\/|$)/.test(norm) || /\/\.dsh\/bot\/DSH-Bots(\/|$)/.test(norm)) return true
          return botDirs().some(dir => sameOrUnder(dir, norm))
        }
        const isBotEntry = (id, cwd, botIds) => {
          if (id && botIds.has(id)) return true
          if (cwd && underBotDir(cwd)) return true
          return false
        }
        let filterVersion = 0
        let sessionCache = { source: null, version: -1, value: null }
        let workspaceCache = { source: null, version: -1, value: null }
        const filteredSessionSnapshot = () => {
          const state = rawSessionSnapshot()
          if (sessionCache.source === state && sessionCache.version === filterVersion) return sessionCache.value
          const botIds = botSessionIds()
          const ids = (state.ids || []).filter(id => !isBotEntry(id, state.byId && state.byId[id] && state.byId[id].cwd, botIds))
          let value = state
          if (ids.length !== (state.ids || []).length) {
            const byId = {}
            for (const id of ids) byId[id] = state.byId[id]
            value = { ...state, ids, byId }
          }
          sessionCache = { source: state, version: filterVersion, value }
          return value
        }
        const filteredWorkspaceSnapshot = () => {
          const state = rawWorkspaceSnapshot()
          if (workspaceCache.source === state && workspaceCache.version === filterVersion) return workspaceCache.value
          const botIds = botSessionIds()
          let changed = false
          const items = []
          for (const row of (state.items || [])) {
            if (underBotDir(row && row.path)) {
              changed = true
              continue
            }
            if (Array.isArray(row && row.sessionIds) && row.sessionIds.some(sid => botIds.has(sid))) {
              changed = true
              items.push({ ...row, sessionIds: row.sessionIds.filter(sid => !botIds.has(sid)) })
            } else {
              items.push(row)
            }
          }
          let archivedSessionIds = state.archivedSessionIds
          if (Array.isArray(archivedSessionIds) && archivedSessionIds.some(sid => botIds.has(sid))) {
            changed = true
            archivedSessionIds = archivedSessionIds.filter(sid => !botIds.has(sid))
          }
          let pinnedSessionIds = state.pinnedSessionIds
          if (Array.isArray(pinnedSessionIds) && pinnedSessionIds.some(sid => botIds.has(sid))) {
            changed = true
            pinnedSessionIds = pinnedSessionIds.filter(sid => !botIds.has(sid))
          }
          const value = changed ? { ...state, items, archivedSessionIds, pinnedSessionIds } : state
          workspaceCache = { source: state, version: filterVersion, value }
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
        const invalidateAndRefresh = () => {
          filterVersion += 1
          sessionCache = { source: null, version: -1, value: null }
          workspaceCache = { source: null, version: -1, value: null }
          for (const listener of [...sessionListeners]) {
            try { listener() } catch (_error) { /* one consumer's failure must not stop the rest */ }
          }
          for (const listener of [...workspaceListeners]) {
            try { listener() } catch (_error) { /* as above */ }
          }
        }
        ctx.effect(() => {
          invalidateAndRefresh()
          const offRoster = roster.subscribe(invalidateAndRefresh)
          const offGroups = groupStore.subscribe(invalidateAndRefresh)
          const offHost = hostStore.subscribe(invalidateAndRefresh)
          return () => {
            offRoster?.()
            offGroups?.()
            offHost?.()
          }
        }, 'botmode: sidebar isolation filter')
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

        // Narrow frames open the shell sidebar as a drawer; selecting the Bot
        // page leaves the centre inert until that drawer closes, so close it here.
        const closeSidebarDrawer = () => {
          if (typeof document === 'undefined') return
          const frame = document.querySelector('[data-slot="root"] > div')
          if (!frame || !frame.hasAttribute('data-sidebar-drawer')) return
          if (!frame.querySelector('[class*="centerCol"][inert]')) return
          ctx.layout.toggleSidebar()
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

        const AVATAR_SIZE_PX = { xs: 18, sm: 22, md: 36, lg: 44, xl: 64 }
        const AVATAR_SIZE_CLS = { xs: 'bm-avatar bm-avatar-xs', sm: 'bm-avatar bm-avatar-sm', md: 'bm-avatar', lg: 'bm-avatar bm-avatar-lg' }

        function BotAvatarBadge(props) {
          const { engine } = useAvatarEngine()
          const bot = props.bot || null
          const avatar = props.avatar || (bot && bot.avatar) || null
          const sizeKey = props.size || 'md'
          const px = typeof props.px === 'number' ? props.px : (AVATAR_SIZE_PX[sizeKey] || 36)
          const baseCls = AVATAR_SIZE_CLS[sizeKey] || 'bm-avatar'
          const color = (avatar && avatar.color) || (bot && bot.color) || props.color || COLORS[0]
          const label = (bot && bot.name) || props.name || ''
          const animated = props.animated === true && px >= 32
          const runtimeState = props.state || (bot && bot.running ? 'working' : 'idle')
          const mountRef = useRef(null)
          const instanceRef = useRef(null)

          useEffect(() => {
            if (!animated || !engine || !avatar || !mountRef.current) return undefined
            const el = mountRef.current
            el.replaceChildren()
            let inst = null
            try {
              inst = engine.mountBotAvatar(el, avatar, {
                size: px,
                state: runtimeState,
                mood: 'auto',
                interactive: true,
                sleepWhenIdle: true,
              })
              instanceRef.current = inst
            } catch (_err) {
              instanceRef.current = null
            }
            return () => {
              if (inst) inst.destroy()
              instanceRef.current = null
              el.replaceChildren()
            }
          }, [
            animated,
            engine,
            px,
            avatar && avatar.avatarId,
            avatar && avatar.customJson,
            avatar && avatar.color,
            avatar && avatar.eyeColor,
            avatar && avatar.clay,
            avatar && avatar.depth,
            avatar && avatar.yaw,
            avatar && avatar.pitch,
            avatar && avatar.orbit,
            avatar && avatar.badge,
            avatar && avatar.followPointer,
          ])

          useEffect(() => {
            if (instanceRef.current && runtimeState) {
              try { instanceRef.current.setState(runtimeState) } catch (_err) { /* ignore */ }
            }
          }, [runtimeState])

          if (animated && engine && avatar) {
            return h('span', {
              ref: mountRef,
              className: `bm-avatar-live ${props.className || ''}`.trim(),
              style: { width: `${px}px`, height: `${px}px` },
              title: label,
            })
          }

          const svg = engine && avatar ? renderAvatarSvgCached(engine, avatar, px) : ''
          if (svg) {
            return h('span', {
              className: `${baseCls} bm-avatar-rendered ${props.className || ''}`.trim(),
              style: { width: `${px}px`, height: `${px}px` },
              title: label,
              dangerouslySetInnerHTML: { __html: svg },
            })
          }

          return h('span', {
            className: `${baseCls} ${props.className || ''}`.trim(),
            style: { background: color },
            title: label,
          }, initialOf(label))
        }

        function BotAvatarEditor(props) {
          const t = useT()
          const { status, engine } = useAvatarEngine()
          const isCreate = props.mode === 'create'
          const useCustom = isCreate ? Boolean(props.useCustom) : true
          const value = props.value || defaultClientAvatar(props.fallbackColor)
          const stageRef = useRef(null)
          const botRef = useRef(null)
          const dragRef = useRef(null)
          const [jsonOpen, setJsonOpen] = useState(Boolean(value.customJson))
          const [jsonText, setJsonText] = useState(value.customJson || '')
          const [jsonErr, setJsonErr] = useState('')

          useEffect(() => {
            setJsonText(value.customJson || '')
          }, [value.customJson])

          const patch = (partial) => {
            if (typeof props.onChange === 'function') {
              props.onChange({ ...value, ...partial })
            }
          }

          useEffect(() => {
            if (!useCustom || !engine || !stageRef.current) return undefined
            const hostEl = stageRef.current
            hostEl.replaceChildren()
            let inst = null
            try {
              inst = engine.mountBotAvatar(hostEl, value, {
                size: 118,
                state: 'idle',
                mood: 'auto',
                interactive: false,
                sleepWhenIdle: false,
              })
              botRef.current = inst
            } catch (_err) {
              botRef.current = null
            }
            return () => {
              if (inst) inst.destroy()
              botRef.current = null
              hostEl.replaceChildren()
            }
          }, [useCustom, engine])

          useEffect(() => {
            const inst = botRef.current
            if (!inst || !engine) return
            try {
              inst.setShape(engine.resolveDefinition(value))
              inst.setPalette(value.color || '#ff8a1f')
              inst.setEyeColor(value.eyeColor || undefined)
              inst.setDepth(Number(value.depth ?? 6))
              inst.setClay(value.clay !== false)
              inst.setOrbit(Boolean(value.orbit))
              inst.setBadge(engine.normalizeBadge(value.badge))
              inst.setFollowPointer(value.followPointer !== false)
              inst.setView(Number(value.yaw ?? 0), Number(value.pitch ?? 0), true)
            } catch (_err) { /* ignore transient invalid value */ }
          }, [
            engine,
            value.avatarId,
            value.customJson,
            value.color,
            value.eyeColor,
            value.depth,
            value.clay,
            value.orbit,
            value.badge,
            value.followPointer,
            value.yaw,
            value.pitch,
          ])

          const onStagePointerDown = (e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId)
            dragRef.current = {
              x: e.clientX,
              y: e.clientY,
              yaw: Number(value.yaw ?? 0),
              pitch: Number(value.pitch ?? 0),
              moved: false,
            }
          }
          const onStagePointerMove = (e) => {
            const d = dragRef.current
            if (!d) return
            const dx = e.clientX - d.x
            const dy = e.clientY - d.y
            if (Math.hypot(dx, dy) > 4) d.moved = true
            if (!d.moved) return
            const nextYaw = Math.max(-0.9, Math.min(0.9, Number((d.yaw + dx / 180).toFixed(3))))
            const nextPitch = Math.max(-0.6, Math.min(0.6, Number((d.pitch - dy / 220).toFixed(3))))
            patch({ yaw: nextYaw, pitch: nextPitch })
          }
          const onStagePointerUp = (e) => {
            const d = dragRef.current
            dragRef.current = null
            e.currentTarget.releasePointerCapture?.(e.pointerId)
            if (d && !d.moved && botRef.current) {
              try { botRef.current.poke() } catch (_err) { /* ignore */ }
            }
          }

          const applyCustomJson = () => {
            const raw = String(jsonText || '').trim()
            if (raw === '') {
              setJsonErr('')
              patch({ customJson: '' })
              return
            }
            try {
              const parsed = JSON.parse(raw)
              if (engine && typeof engine.validateAvatar === 'function') {
                const res = engine.validateAvatar(parsed)
                if (!res.ok) {
                  setJsonErr(interpolate(t('avatar.customJsonInvalid'), { msg: (res.errors || []).join('; ') }))
                  return
                }
                setJsonErr('')
                patch({ customJson: JSON.stringify(res.value) })
                return
              }
              if (parsed.version !== 1 || !parsed.body || !parsed.body.path || !parsed.eyes) {
                setJsonErr(interpolate(t('avatar.customJsonInvalid'), { msg: 'version:1 + body.path + eyes required' }))
                return
              }
              setJsonErr('')
              patch({ customJson: JSON.stringify(parsed) })
            } catch (err) {
              setJsonErr(interpolate(t('avatar.customJsonInvalid'), { msg: err && err.message ? err.message : String(err) }))
            }
          }

          const allAvatars = (engine && engine.ALL_AVATARS) || []
          const palettes = (engine && engine.PALETTES) || COLORS.map(c => ({ id: c, name: c, base: c, eye: '#151515' }))

          return h('div', { className: 'bm-avatar-box' },
            h('div', { className: 'bm-avatar-head' },
              h('span', { className: 'bm-model-title' }, t('form.avatar')),
              isCreate
                ? h('div', { className: 'bm-seg' },
                  h('button', {
                    type: 'button', 'data-active': !useCustom,
                    onClick: () => props.onModeChange && props.onModeChange(false),
                  }, t('avatar.modeRandom')),
                  h('button', {
                    type: 'button', 'data-active': useCustom,
                    onClick: () => props.onModeChange && props.onModeChange(true),
                  }, t('avatar.modeCustom')))
                : null),
            !useCustom
              ? h('div', { className: 'bm-model-hint' }, t('avatar.randomHint'))
              : !engine
                ? h('div', { className: 'bm-model-hint' }, status === 'error' ? 'Avatar engine unavailable' : t('avatar.loading'))
                : h(React.Fragment, null,
                  h('div', { className: 'bm-avatar-stage-wrap' },
                    h('div', {
                      ref: stageRef,
                      className: 'bm-avatar-stage',
                      onPointerDown: onStagePointerDown,
                      onPointerMove: onStagePointerMove,
                      onPointerUp: onStagePointerUp,
                      onPointerCancel: onStagePointerUp,
                    }),
                    h('div', { className: 'bm-avatar-stage-side' },
                      h('div', { className: 'bm-model-hint' }, t('avatar.dragHint')),
                      value.customJson
                        ? h('div', { className: 'bm-model-now' }, t('avatar.customJsonApplied'))
                        : null,
                      h('div', { className: 'bm-avatar-stage-btns' },
                        h('button', {
                          type: 'button', className: 'bm-btn small',
                          onClick: () => { if (botRef.current) botRef.current.poke() },
                        }, t('avatar.poke')),
                        h('button', {
                          type: 'button', className: 'bm-btn small',
                          onClick: () => {
                            const next = pickRandomClientAvatar(engine, value.avatarId)
                            props.onChange && props.onChange(next)
                          },
                        }, t('avatar.randomize')),
                        (Number(value.yaw || 0) !== 0 || Number(value.pitch || 0) !== 0)
                          ? h('button', {
                            type: 'button', className: 'bm-btn small',
                            onClick: () => patch({ yaw: 0, pitch: 0 }),
                          }, t('avatar.resetView'))
                          : null),
                      h('div', { className: 'bm-avatar-toggles' },
                        h('div', { className: 'bm-seg' },
                          h('button', {
                            type: 'button', 'data-active': (value.material || 'flat') === 'flat',
                            onClick: () => patch({ material: 'flat' }),
                          }, t('avatar.materialFlat')),
                          h('button', {
                            type: 'button', 'data-active': value.material === 'fluffy',
                            onClick: () => patch({ material: 'fluffy' }),
                          }, t('avatar.materialFluffy'))),
                        h('label', { className: 'bm-avatar-depth' },
                          h('span', null, `${t('avatar.depth')} ${Math.round(Number(value.depth ?? 6))}`),
                          h('input', {
                            type: 'range', min: 0, max: 14, step: 1,
                            value: Number(value.depth ?? 6),
                            onChange: (e) => patch({ depth: Number(e.target.value) }),
                          }))))),
                  h('div', { className: 'bm-label' }, t('avatar.gallery'),
                    h('div', { className: 'bm-avatar-grid' }, allAvatars.map(item => {
                      const thumbSvg = renderAvatarSvgCached(engine, {
                        ...value,
                        avatarId: item.id,
                        customJson: '',
                        yaw: 0,
                        pitch: 0,
                        orbit: false,
                        badge: false,
                      }, 38)
                      const active = !value.customJson && value.avatarId === item.id
                      return h('button', {
                        key: item.id,
                        type: 'button',
                        className: 'bm-avatar-item',
                        'data-active': active,
                        title: item.name,
                        onClick: () => patch({ avatarId: item.id, customJson: '' }),
                      },
                        h('span', { className: 'bm-avatar-item-thumb', dangerouslySetInnerHTML: { __html: thumbSvg } }),
                        h('span', { className: 'bm-avatar-item-name' }, item.name))
                    }))),
                  h('div', { className: 'bm-label' }, t('avatar.bodyColor'),
                    h('div', { className: 'bm-avatar-color-row' },
                      palettes.map(pal => h('button', {
                        key: pal.id,
                        type: 'button',
                        className: 'bm-swatch',
                        title: `${pal.name} (${pal.base})`,
                        style: { background: pal.base },
                        'data-active': String(value.color || '').toLowerCase() === String(pal.base).toLowerCase(),
                        onClick: () => patch({ color: pal.base, eyeColor: pal.eye || value.eyeColor }),
                      })),
                      h('input', {
                        type: 'color',
                        className: 'bm-avatar-color-picker',
                        value: /^#[0-9a-f]{6}$/i.test(value.color || '') ? value.color : '#ff8a1f',
                        title: t('avatar.bodyColor'),
                        onChange: (e) => patch({ color: e.target.value }),
                      }))),
                  h('div', { className: 'bm-label' }, t('avatar.eyeColor'),
                    h('div', { className: 'bm-avatar-color-row' },
                      AVATAR_EYE_SWATCHES.map(hex => h('button', {
                        key: hex,
                        type: 'button',
                        className: 'bm-swatch',
                        title: hex,
                        style: { background: hex },
                        'data-active': String(value.eyeColor || '').toLowerCase() === hex,
                        onClick: () => patch({ eyeColor: hex }),
                      })),
                      h('input', {
                        type: 'color',
                        className: 'bm-avatar-color-picker',
                        value: /^#[0-9a-f]{6}$/i.test(value.eyeColor || '') ? value.eyeColor : '#1b1b1b',
                        title: t('avatar.eyeColor'),
                        onChange: (e) => patch({ eyeColor: e.target.value }),
                      }))),
                  h('div', { className: 'bm-avatar-toggles' },
                    h('label', { className: 'bm-avatar-toggle' },
                      h('input', {
                        type: 'checkbox', checked: value.clay !== false,
                        onChange: (e) => patch({ clay: e.target.checked }),
                      }), t('avatar.clay')),
                    h('label', { className: 'bm-avatar-toggle' },
                      h('input', {
                        type: 'checkbox', checked: value.followPointer !== false,
                        onChange: (e) => patch({ followPointer: e.target.checked }),
                      }), t('avatar.follow')),
                    h('label', { className: 'bm-avatar-toggle' },
                      h('input', {
                        type: 'checkbox', checked: Boolean(value.orbit),
                        onChange: (e) => patch({ orbit: e.target.checked }),
                      }), t('avatar.orbit')),
                    h('label', { className: 'bm-avatar-toggle' },
                      h('input', {
                        type: 'checkbox', checked: Boolean(value.badge),
                        onChange: (e) => patch({ badge: e.target.checked }),
                      }), t('avatar.badge'))),
                  h('div', { className: 'bm-avatar-json-box' },
                    h('div', { className: 'bm-avatar-stage-btns' },
                      h('button', {
                        type: 'button', className: 'bm-btn small',
                        onClick: () => setJsonOpen(v => !v),
                      }, t('avatar.customJsonToggle')),
                      value.customJson
                        ? h('button', {
                          type: 'button', className: 'bm-btn small',
                          onClick: () => { setJsonText(''); setJsonErr(''); patch({ customJson: '' }) },
                        }, t('avatar.customJsonClear'))
                        : null),
                    jsonOpen
                      ? h(React.Fragment, null,
                        h('div', { className: 'bm-model-hint' }, t('avatar.customJsonHint')),
                        h('textarea', {
                          className: 'bm-area',
                          rows: 4,
                          value: jsonText,
                          placeholder: '{"version":1,"id":"custom","name":"Custom","body":{"path":"M...Z"},"eyes":{"x":50,"y":48,"spacing":18,"scale":1.1}}',
                          onChange: (e) => { setJsonText(e.target.value); setJsonErr('') },
                        }),
                        jsonErr ? h('div', { className: 'bm-error' }, jsonErr) : null,
                        h('div', { className: 'bm-avatar-stage-btns' },
                          h('button', { type: 'button', className: 'bm-btn small primary', onClick: applyCustomJson }, t('avatar.customJsonApply'))))
                      : null)))
        }

        function BotForm(props) {
          const t = useT()
          const [draft, setDraft] = useState(props.initial)
          const [avatarCustom, setAvatarCustom] = useState(props.mode !== 'create')
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
              const useCustomAvatar = props.mode !== 'create' || avatarCustom
              const value = {
                ...draft,
                name,
                ...(useCustomAvatar
                  ? {
                    color: (draft.avatar && draft.avatar.color) || draft.color,
                    avatar: draft.avatar || defaultClientAvatar(draft.color),
                    avatarRandom: false,
                  }
                  : {
                    color: '',
                    avatar: undefined,
                    avatarRandom: true,
                  }),
              }
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
            h(BotAvatarEditor, {
              mode: props.mode,
              useCustom: avatarCustom,
              onModeChange: (next) => {
                setAvatarCustom(next)
                if (next && !draft.avatar) {
                  const initialAv = pickRandomClientAvatar(avatarEngineStore.getSnapshot().engine)
                  setDraft({ ...draft, avatar: initialAv, color: initialAv.color })
                }
              },
              value: draft.avatar || defaultClientAvatar(draft.color),
              fallbackColor: draft.color,
              onChange: (nextAvatar) => setDraft({
                ...draft,
                avatar: nextAvatar,
                color: nextAvatar.color || draft.color,
              }),
            }),
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
              h(BotAvatarBadge, { bot, size: 'md' }),
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
                schedule: cron.trim(),
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
              h('div', { className: 'bm-routine-name' },
                `${routine.origin?.kind === 'bot' ? '🤖 ' : ''}${routine.name}`),
              h('div', { className: 'bm-routine-meta' },
                `${routine.cron}${routine.lastStatus ? ` · ${routine.lastStatus}` : ''}${routine.nextAt ? ` · ${t('routine.next')} ${new Date(routine.nextAt).toLocaleString()}` : ''}${routine.pausedReason ? ` · ${routine.pausedReason}` : ''}`),
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
              h(BotAvatarBadge, { bot, size: 'lg', animated: true }),
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

        function safeLinkHref(value) {
          const trimmed = String(value || '').trim()
          return /^(https?:\/\/|\/(?!\/))/i.test(trimmed) ? trimmed : undefined
        }

        function safeImageSrc(value) {
          const trimmed = String(value || '').trim()
          return /^(https?:\/\/|\/(?!\/)|data:image\/(png|jpeg|webp|gif);base64,)/i.test(trimmed) ? trimmed : undefined
        }

        const HTML_ARTIFACT_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:;">'
        function wrapHtmlArtifactCsp(html) {
          const raw = String(html || '')
          if (/<head[\s>]/i.test(raw)) return raw.replace(/<head([\s>])/i, `<head$1${HTML_ARTIFACT_CSP}`)
          return `<!doctype html><html><head>${HTML_ARTIFACT_CSP}</head><body>${raw}</body></html>`
        }

        function currentFormatSettings() {
          const st = hostStore.getSnapshot().state
          const rf = st && st.settings && st.settings.responseFormat
          return {
            enabled: !rf || rf.enabled !== false,
            extendedMarkdown: !rf || rf.extendedMarkdown !== false,
            diagramsAndMath: !rf || rf.diagramsAndMath !== false,
            artifacts: !rf || rf.artifacts !== false,
            structuredCards: !rf || rf.structuredCards !== false,
            multimodal: !rf || rf.multimodal !== false,
          }
        }

        const MENTION_BEFORE_DISALLOW_RE = /[A-Za-z0-9._+-]/
        const MENTION_IDENT_RE = /[\p{L}\p{N}_]/u
        const MENTION_ASCII_IDENT_RE = /[A-Za-z0-9_]/
        const MENTION_ENDS_CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u

        function escapeRegExp(value) {
          return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        }

        function buildMentionTokens(mentionMembers) {
          const tokens = []
          const list = Array.isArray(mentionMembers) ? mentionMembers : []
          for (const bot of list) {
            if (!bot || typeof bot.id !== 'string') continue
            const color = bot.color || COLORS[0]
            const name = typeof bot.name === 'string' ? bot.name.trim() : ''
            if (name !== '') {
              tokens.push({ id: bot.id, token: name, label: name, color, kind: 'bot' })
            }
            if (bot.id && bot.id !== name) {
              tokens.push({ id: bot.id, token: bot.id, label: name || bot.id, color, kind: 'bot' })
            }
          }
          for (const word of ['所有人', '全员', 'everyone', 'all']) {
            tokens.push({ id: '__all__', token: word, label: word, color: '#4d6bfe', kind: 'all' })
          }
          for (const word of ['user', 'human', '你']) {
            tokens.push({ id: '__user__', token: word, label: word, color: '#ea580c', kind: 'user' })
          }
          tokens.sort((a, b) => b.token.length - a.token.length)
          return tokens
        }

        function findMentionSpans(rawText, mentionMembers) {
          const text = String(rawText || '')
          if (!text || (!text.includes('@') && !text.includes('＠'))) return []
          if (!Array.isArray(mentionMembers) || mentionMembers.length === 0) return []
          const tokens = buildMentionTokens(mentionMembers)
          const consumed = new Uint8Array(text.length)
          const spans = []
          for (const entry of tokens) {
            const regex = new RegExp(`[@＠][ \\t]?${escapeRegExp(entry.token)}`, 'giu')
            for (const match of text.matchAll(regex)) {
              const start = match.index ?? 0
              const end = start + match[0].length
              let overlap = false
              for (let i = start; i < end; i += 1) {
                if (consumed[i] === 1) { overlap = true; break }
              }
              if (overlap) continue
              const prev = start > 0 ? text[start - 1] : ''
              const next = end < text.length ? text[end] : ''
              if (prev !== '' && MENTION_BEFORE_DISALLOW_RE.test(prev)) continue
              const allowCjkAfter = entry.kind !== 'user' && MENTION_ENDS_CJK_RE.test(entry.token)
              if (next !== '' && (allowCjkAfter ? MENTION_ASCII_IDENT_RE.test(next) : MENTION_IDENT_RE.test(next))) continue
              for (let i = start; i < end; i += 1) consumed[i] = 1
              spans.push({
                start,
                end,
                raw: match[0],
                id: entry.id,
                label: entry.label,
                color: entry.color,
                kind: entry.kind,
              })
            }
          }
          spans.sort((a, b) => a.start - b.start)
          return spans
        }

        function renderTextWithMentions(rawText, keyPrefix, mentionMembers) {
          const text = String(rawText || '')
          const spans = findMentionSpans(text, mentionMembers)
          if (spans.length === 0) return [text]
          const out = []
          let cursor = 0
          spans.forEach((span, idx) => {
            if (span.start > cursor) out.push(text.slice(cursor, span.start))
            out.push(h('span', {
              key: `${keyPrefix}-m${idx}`,
              className: 'bm-mention-pill',
              style: { '--bm-mc': span.color },
            },
            h('span', { className: 'bm-mention-dot', 'aria-hidden': 'true' }),
            `@${span.label}`))
            cursor = span.end
          })
          if (cursor < text.length) out.push(text.slice(cursor))
          return out
        }

        function inlineMarkdown(text, keyPrefix, fmt = currentFormatSettings(), mentionMembers = null) {
          const nodes = []
          const pattern = /(!\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\$[^$\n]+\$|\[[^\]]+\]\([^)]+\))/g
          let cursor = 0
          let index = 0
          const pushPlain = (slice, subKey) => {
            if (!slice) return
            if (mentionMembers && mentionMembers.length > 0) {
              nodes.push(...renderTextWithMentions(slice, subKey, mentionMembers))
            } else {
              nodes.push(slice)
            }
          }
          for (const match of String(text || '').matchAll(pattern)) {
            if (match.index > cursor) pushPlain(text.slice(cursor, match.index), `${keyPrefix}-p${index}`)
            const token = match[0]
            const key = `${keyPrefix}-i${index++}`
            if (token.startsWith('![')) {
              const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token)
              const src = img ? safeImageSrc(img[2]) : undefined
              if (src && fmt.multimodal) {
                nodes.push(h('img', { key, src, alt: img[1] || 'image', className: 'bm-inline-img', loading: 'lazy' }))
              } else {
                nodes.push(token)
              }
            } else if (token.startsWith('**')) {
              const inner = token.slice(2, -2)
              nodes.push(h('strong', { key },
                mentionMembers && mentionMembers.length > 0
                  ? renderTextWithMentions(inner, `${key}-b`, mentionMembers)
                  : inner))
            } else if (token.startsWith('`')) {
              nodes.push(h('code', { key, className: 'bm-inline-code' }, token.slice(1, -1)))
            } else if (token.startsWith('$') && token.endsWith('$') && fmt.diagramsAndMath) {
              nodes.push(h('span', { key, className: 'bm-math-inline' }, token.slice(1, -1)))
            } else {
              const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
              const href = link === null ? undefined : safeLinkHref(link[2])
              if (href && fmt.multimodal && /\.(mp3|wav|ogg|m4a)(\?.*)?$/i.test(href)) {
                nodes.push(h('audio', { key, controls: true, src: href, style: { display: 'block', margin: '4px 0', maxWidth: '100%' } }))
              } else {
                nodes.push(href
                  ? h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, link[1])
                  : token)
              }
            }
            cursor = match.index + token.length
          }
          if (cursor < text.length) pushPlain(text.slice(cursor), `${keyPrefix}-tail`)
          return nodes
        }

        function ArtifactCard(props) {
          const t = useT()
          // Never auto-execute untrusted HTML scripts on render; require explicit Preview click + strict no-network CSP.
          const [mode, setMode] = useState(props.type === 'markdown' ? 'preview' : 'source')
          const [copied, setCopied] = useState(false)
          const copy = async () => {
            try {
              await navigator.clipboard.writeText(props.content)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            } catch (_error) { /* clipboard unavailable */ }
          }
          const download = () => {
            try {
              const ext = props.type === 'html' ? 'html' : props.type === 'json' ? 'json' : props.type === 'markdown' ? 'md' : 'txt'
              const blob = new Blob([props.content], { type: 'text/plain;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `${String(props.title || 'artifact').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')}.${ext}`
              a.click()
              window.setTimeout(() => URL.revokeObjectURL(url), 1000)
            } catch (_error) { /* download unavailable */ }
          }
          return h('div', { className: 'bm-artifact' },
            h('div', { className: 'bm-artifact-head' },
              h('span', { className: 'bm-artifact-type' }, props.type || 'artifact'),
              h('span', { className: 'bm-artifact-title' }, props.title || 'Artifact'),
              (props.type === 'html' || props.type === 'markdown')
                ? h('button', {
                  type: 'button', className: 'bm-code-copy',
                  onClick: () => setMode(m => (m === 'preview' ? 'source' : 'preview')),
                }, t(mode === 'preview' ? 'rich.source' : 'rich.preview'))
                : null,
              h('button', { type: 'button', className: 'bm-code-copy', onClick: copy }, t(copied ? 'chat.copied' : 'chat.copy')),
              h('button', { type: 'button', className: 'bm-code-copy', onClick: download }, t('rich.download'))),
            h('div', { className: 'bm-artifact-body' },
              mode === 'preview' && props.type === 'html'
                ? h('iframe', { className: 'bm-artifact-iframe', sandbox: 'allow-scripts', srcDoc: wrapHtmlArtifactCsp(props.content), title: props.title })
                : mode === 'preview' && props.type === 'markdown'
                  ? h(MarkdownText, { text: props.content })
                  : h('pre', { style: { margin: 0, overflow: 'auto' } }, h('code', null, props.content))))
        }

        function DiffBlock(props) {
          const [copied, setCopied] = useState(false)
          const copy = async () => {
            try {
              await navigator.clipboard.writeText(props.code)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            } catch (_error) { /* clipboard unavailable */ }
          }
          const lines = String(props.code || '').split('\n')
          return h('div', { className: 'bm-code' },
            h('div', { className: 'bm-code-head' },
              h('span', { className: 'bm-code-lang' }, 'diff'),
              h('button', { type: 'button', className: 'bm-code-copy', onClick: copy }, props.t(copied ? 'chat.copied' : 'chat.copy'))),
            h('pre', null, h('code', null, lines.map((line, i) => {
              const kind = line.startsWith('+') && !line.startsWith('+++')
                ? 'add'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'del'
                  : line.startsWith('@@')
                    ? 'hunk'
                    : 'ctx'
              return h('span', { key: `d${i}`, className: 'bm-diff-line', 'data-diff': kind }, line || ' ')
            }))))
        }

        function parseMermaidEdges(code) {
          const edges = []
          for (const rawLine of String(code || '').split('\n')) {
            const line = rawLine.trim()
            if (!line || /^(graph|flowchart|sequenceDiagram|stateDiagram|classDiagram|erDiagram|subgraph|end|%%)/i.test(line)) continue
            const seq = /^([^\s:>-]+)\s*(--?>>?|->>|-->>)\s*([^\s:]+)\s*:\s*(.+)$/.exec(line)
            if (seq) {
              edges.push({ from: seq[1], to: seq[3], label: seq[4].trim() })
              continue
            }
            const flow = /^([A-Za-z0-9_]+)(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})?\s*(?:--?>|==>|-\.->)(?:\|([^|]+)\|)?\s*([A-Za-z0-9_]+)(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})?/.exec(line)
            if (flow) {
              edges.push({
                from: (flow[2] || flow[3] || flow[4] || flow[1]).replace(/^["']|["']$/g, ''),
                label: (flow[5] || '').trim(),
                to: (flow[7] || flow[8] || flow[9] || flow[6]).replace(/^["']|["']$/g, ''),
              })
            }
          }
          return edges
        }

        function MermaidCard(props) {
          const [view, setView] = useState('diagram')
          const [copied, setCopied] = useState(false)
          const edges = useMemo(() => parseMermaidEdges(props.code), [props.code])
          const copy = async () => {
            try {
              await navigator.clipboard.writeText(props.code)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            } catch (_error) { /* clipboard unavailable */ }
          }
          return h('div', { className: 'bm-code' },
            h('div', { className: 'bm-code-head' },
              h('span', { className: 'bm-code-lang' }, 'mermaid'),
              h('div', { style: { display: 'flex', gap: '8px' } },
                edges.length > 0
                  ? h('button', {
                    type: 'button', className: 'bm-code-copy',
                    onClick: () => setView(v => (v === 'diagram' ? 'source' : 'diagram')),
                  }, props.t(view === 'diagram' ? 'rich.source' : 'rich.diagram'))
                  : null,
                h('button', { type: 'button', className: 'bm-code-copy', onClick: copy }, props.t(copied ? 'chat.copied' : 'chat.copy')))),
            view === 'diagram' && edges.length > 0
              ? h('div', { className: 'bm-mermaid-viz' }, edges.map((edge, i) => h('div', { key: `me${i}`, className: 'bm-mermaid-edge' },
                h('span', { className: 'bm-mermaid-node' }, edge.from),
                h('span', { className: 'bm-mermaid-arrow' }, edge.label ? `── ${edge.label} →` : '──→'),
                h('span', { className: 'bm-mermaid-node' }, edge.to))))
              : h('pre', null, h('code', null, props.code)))
        }

        function MetricsCard(props) {
          const data = props.data || {}
          const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : [])
          return h('div', { className: 'bm-metrics-card' },
            data.title ? h('strong', { style: { fontSize: '12.5px' } }, String(data.title)) : null,
            h('div', { className: 'bm-metrics-grid' }, items.map((item, idx) => h('div', {
              key: `mt${idx}`,
              className: 'bm-metric-tile',
              'data-tone': item.tone || 'neutral',
            },
              h('div', { className: 'bm-metric-label' }, String(item.label || '')),
              h('div', { className: 'bm-metric-val' }, String(item.value ?? '')),
              item.delta ? h('div', { className: 'bm-metric-delta' }, String(item.delta)) : null))))
        }

        function FileCard(props) {
          const t = useT()
          const data = props.data || {}
          const [copied, setCopied] = useState(false)
          const name = String(data.name || data.path || 'file')
          const ext = (name.includes('.') ? name.split('.').pop() : 'FILE').slice(0, 4).toUpperCase()
          const copyPath = async () => {
            try {
              await navigator.clipboard.writeText(String(data.path || data.url || name))
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            } catch (_error) { /* clipboard unavailable */ }
          }
          return h('div', { className: 'bm-file-card' },
            h('div', { className: 'bm-file-row' },
              h('span', { className: 'bm-file-icon' }, ext),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontWeight: 600, fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
                h('div', { className: 'bm-muted' }, [data.size, data.mime, data.path].filter(Boolean).join(' · '))),
              h('button', { type: 'button', className: 'bm-btn small', onClick: copyPath }, t(copied ? 'chat.copied' : 'rich.copyPath'))),
            data.description ? h('div', { className: 'bm-muted' }, String(data.description)) : null)
        }

        function StructCard(props) {
          const data = props.data || {}
          const fields = Array.isArray(data.fields) ? data.fields : []
          return h('div', { className: 'bm-struct-card' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('strong', { style: { fontSize: '13px', flex: 1 } }, String(data.title || 'Card')),
              data.badge ? h('span', { className: 'bm-status-pill' }, String(data.badge)) : null),
            data.subtitle ? h('div', { className: 'bm-muted' }, String(data.subtitle)) : null,
            fields.length > 0
              ? h('div', { className: 'bm-table-wrap', style: { margin: 0 } },
                h('table', { className: 'bm-table' },
                  h('tbody', null, fields.map((f, idx) => h('tr', { key: `sf${idx}` },
                    h('th', { style: { width: '34%' } }, String(f.label || '')),
                    h('td', null, String(f.value ?? '')))))))
              : null,
            data.note ? h('div', { className: 'bm-muted' }, String(data.note)) : null)
        }

        function parseMarkdownTable(lines) {
          if (lines.length < 2) return null
          const rowRe = /^\s*\|(.+)\|\s*$/
          const sepRe = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/
          if (!rowRe.test(lines[0]) || !sepRe.test(lines[1])) return null
          const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
          const headers = splitRow(lines[0])
          const rows = lines.slice(2).filter(l => l.trim().includes('|')).map(splitRow)
          return { headers, rows }
        }

        function MarkdownText(props) {
          const t = useT()
          const fmt = props.formatOptions || currentFormatSettings()
          const mentionMembers = props.mentionMembers || null
          const nodes = []
          const source = String(props.text || '')
          let index = 0

          const renderFencedOrPlain = (segment) => {
            const fence = /```([^\n`]*)\n([\s\S]*?)```|\$\$([\s\S]+?)\$\$/g
            let cursor = 0
            const pushProse = (prose) => {
              const paragraphs = prose.split(/\n{2,}/)
              for (const paragraph of paragraphs) {
                if (paragraph.trim() === '') continue
                const lines = paragraph.split('\n')
                if (fmt.extendedMarkdown) {
                  const tbl = parseMarkdownTable(lines)
                  if (tbl) {
                    nodes.push(h('div', { key: `md-tbl${index++}`, className: 'bm-table-wrap' },
                      h('table', { className: 'bm-table' },
                        h('thead', null, h('tr', null, tbl.headers.map((col, ci) => h('th', { key: `th${ci}` }, inlineMarkdown(col, `th${index}-${ci}`, fmt, mentionMembers))))),
                        h('tbody', null, tbl.rows.map((row, ri) => h('tr', { key: `tr${ri}` },
                          tbl.headers.map((_, ci) => h('td', { key: `td${ci}` }, inlineMarkdown(row[ci] || '', `td${index}-${ri}-${ci}`, fmt, mentionMembers)))))))))
                    continue
                  }
                }
                if (/^#{1,4}\s/.test(lines[0])) {
                  const level = Math.min(4, (lines[0].match(/^#+/) || ['#'])[0].length)
                  nodes.push(h(`h${level + 2}`, { key: `md-h${index++}`, className: 'bm-md-heading' },
                    inlineMarkdown(lines[0].replace(/^#{1,4}\s/, ''), `h${index}`, fmt, mentionMembers)))
                  if (lines.length > 1) pushProse(lines.slice(1).join('\n'))
                  continue
                }
                if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
                  nodes.push(h('ul', { key: `md-ul${index++}`, className: 'bm-md-list' },
                    lines.map((line, lineIndex) => h('li', { key: `li${lineIndex}` },
                      inlineMarkdown(line.replace(/^\s*[-*]\s+/, ''), `li${index}-${lineIndex}`, fmt, mentionMembers)))))
                  continue
                }
                if (lines.every(line => /^\s*\d+[.)]\s+/.test(line))) {
                  nodes.push(h('ol', { key: `md-ol${index++}`, className: 'bm-md-list' },
                    lines.map((line, lineIndex) => h('li', { key: `li${lineIndex}` },
                      inlineMarkdown(line.replace(/^\s*\d+[.)]\s+/, ''), `li${index}-${lineIndex}`, fmt, mentionMembers)))))
                  continue
                }
                if (lines.every(line => /^>\s?/.test(line))) {
                  const stripped = lines.map(line => line.replace(/^>\s?/, ''))
                  const calloutMatch = fmt.extendedMarkdown ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(stripped[0] || '') : null
                  if (calloutMatch) {
                    const tone = calloutMatch[1].toLowerCase()
                    const rest = [calloutMatch[2], ...stripped.slice(1)].filter(Boolean).join('\n')
                    nodes.push(h('div', { key: `md-co${index++}`, className: 'bm-callout', 'data-tone': tone },
                      h('div', { className: 'bm-callout-head' }, calloutMatch[1].toUpperCase()),
                      rest ? h('div', null, inlineMarkdown(rest, `co${index}`, fmt, mentionMembers)) : null))
                    continue
                  }
                  nodes.push(h('blockquote', { key: `md-bq${index++}`, className: 'bm-md-quote' },
                    inlineMarkdown(stripped.join('\n'), `bq${index}`, fmt, mentionMembers)))
                  continue
                }
                const children = []
                lines.forEach((line, lineIndex) => {
                  if (lineIndex > 0) children.push(h('br', { key: `br${lineIndex}` }))
                  children.push(...inlineMarkdown(line, `p${index}-${lineIndex}`, fmt, mentionMembers))
                })
                nodes.push(h('p', { key: `md-p${index++}`, className: 'bm-md-p' }, children))
              }
            }
            for (const match of segment.matchAll(fence)) {
              if (match.index > cursor) pushProse(segment.slice(cursor, match.index))
              if (match[3] !== undefined) {
                if (fmt.diagramsAndMath) {
                  nodes.push(h('div', { key: `md-math${index++}`, className: 'bm-math-block' }, match[3].trim()))
                } else {
                  pushProse(match[0])
                }
              } else {
                const language = (match[1] || '').trim().toLowerCase()
                const code = match[2] || ''
                if (language === 'diff' && fmt.extendedMarkdown) {
                  nodes.push(h(DiffBlock, { key: `md-diff${index++}`, code, t }))
                } else if (language === 'mermaid' && fmt.diagramsAndMath) {
                  nodes.push(h(MermaidCard, { key: `md-merm${index++}`, code, t }))
                } else if ((language === 'metrics' || language === 'card' || language === 'file') && fmt.structuredCards) {
                  let parsed = null
                  try { parsed = JSON.parse(code) } catch (_err) { parsed = null }
                  if (parsed && typeof parsed === 'object') {
                    if (language === 'metrics') nodes.push(h(MetricsCard, { key: `md-met${index++}`, data: parsed }))
                    else if (language === 'file') nodes.push(h(FileCard, { key: `md-file${index++}`, data: parsed }))
                    else nodes.push(h(StructCard, { key: `md-card${index++}`, data: parsed }))
                  } else {
                    nodes.push(h(CodeBlock, { key: `md-code${index++}`, language, code, t }))
                  }
                } else {
                  nodes.push(h(CodeBlock, { key: `md-code${index++}`, language, code, t }))
                }
              }
              cursor = match.index + match[0].length
            }
            if (cursor < segment.length) pushProse(segment.slice(cursor))
          }

          // Top-level structured XML tags: <artifact ...>...</artifact> & <details><summary>...</summary>...</details>
          const xmlPattern = /<artifact\b([^>]*)>([\s\S]*?)<\/artifact>|<details\b[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi
          let topCursor = 0
          for (const match of source.matchAll(xmlPattern)) {
            if (match.index > topCursor) renderFencedOrPlain(source.slice(topCursor, match.index))
            if (match[1] !== undefined && match[2] !== undefined && fmt.artifacts) {
              const attrs = match[1] || ''
              const title = (/title="([^"]+)"/i.exec(attrs)?.[1] ?? /title='([^']+)'/i.exec(attrs)?.[1] ?? 'Artifact').trim()
              const type = (/type="([^"]+)"/i.exec(attrs)?.[1] ?? /type='([^']+)'/i.exec(attrs)?.[1] ?? 'code').trim().toLowerCase()
              nodes.push(h(ArtifactCard, { key: `md-art${index++}`, type, title, content: match[2].trim() }))
            } else if (match[3] !== undefined && match[4] !== undefined && fmt.extendedMarkdown) {
              nodes.push(h('details', { key: `md-det${index++}`, className: 'bm-details' },
                h('summary', null, match[3].trim()),
                h('div', { className: 'bm-details-body' }, h(MarkdownText, { text: match[4].trim(), formatOptions: fmt, mentionMembers }))))
            } else {
              renderFencedOrPlain(match[0])
            }
            topCursor = match.index + match[0].length
          }
          if (topCursor < source.length) renderFencedOrPlain(source.slice(topCursor))

          return h('div', { className: 'bm-md' }, nodes)
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
              h(BotAvatarBadge, { bot: props.bot, size: 'xs' }),
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
        function ChatPane(props) {
          const t = useT()
          const [tab, setTab] = useState('chat')
          const [text, setText] = useState('')
          const [error, setError] = useState('')
          const [busy, setBusy] = useState(false)
          const [images, setImages] = useState([])
          const [dragOver, setDragOver] = useState(false)
          const [retainKey, setRetainKey] = useState(0)
          const [echoed, setEchoed] = useState([])
          const imagesRef = useRef([])
          imagesRef.current = images
          const attachRef = useRef(null)
          const inputRef = useRef(null)
          const composingRef = useRef(false)
          const composingDoneAt = useRef(0)
          const catalog = props.models && props.models.catalog
          const vision = modelVisionOf(catalog, effectiveModelOf(catalog, props.bot.model))
          const ATTACH_LIMIT = 6
          const ATTACH_MAX_BYTES = 12 * 1024 * 1024
          const formatBytes = (bytes) => (bytes >= 1024 * 1024
            ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
            : `${Math.max(1, Math.round(bytes / 1024))} KB`)
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
            node.style.height = `${Math.min(160, node.scrollHeight)}px`
          }, [text])
          const dragCarriesFiles = (transfer) => {
            if (!transfer) return false
            const types = Array.from(transfer.types || [])
            if (types.includes('Files')) return true
            return Array.from(transfer.items || []).some(item => item.kind === 'file')
          }
          // One entry point for picker, drop and paste: every rejection is reported,
          // accepted files respect the per-message limit, and the model's vision
          // capability gates the whole path.
          const addFiles = (fileList) => {
            const incoming = Array.from(fileList || [])
            if (incoming.length === 0) return
            if (vision === false) { setError(t('chat.attachVisionOnly')); return }
            const notes = []
            const accepted = []
            for (const file of incoming) {
              if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { notes.push(t('chat.attachType')); continue }
              if (file.size > ATTACH_MAX_BYTES) { notes.push(t('chat.attachSize')); continue }
              accepted.push({ id: newId(), file, url: URL.createObjectURL(file), name: file.name || 'image' })
            }
            const room = Math.max(0, ATTACH_LIMIT - imagesRef.current.length)
            if (accepted.length > room) notes.push(t('chat.attachLimit'))
            if (accepted.length > 0) setImages(current => [...current, ...accepted.slice(0, room)])
            setError(Array.from(new Set(notes)).join(' '))
          }
          const removeImage = (id) => {
            setImages((current) => {
              const item = current.find(image => image.id === id)
              if (item) releaseImages([item])
              return current.filter(image => image.id !== id)
            })
          }
          const clearImages = () => {
            setImages((current) => {
              releaseImages(current)
              return []
            })
            setError('')
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
          // Sending never depends on this binding: the Host owns the turn FIFO.
          // A failed binding only hides the local transcript, so keep the reason
          // around and offer one explicit re-attempt.
          const retained = useMemo(() => {
            try {
              return { reference: sessions.retain(props.sessionId, { source: 'botmode.chat' }), error: '' }
            } catch (failure) {
              return { reference: null, error: (failure && failure.message) || String(failure) }
            }
          }, [props.sessionId, retainKey])
          const reference = retained.reference
          const retainError = retained.error
          useEffect(() => () => { if (reference) reference.release() }, [reference])
          const binding = reference ? reference.binding : null
          const session = binding ? binding.session : null
          const snapshot = useSyncExternalStore(
            listener => (session ? session.subscribe(listener) : () => {}),
            () => (session ? session.getSnapshot() : ERROR_SESSION_SNAP),
          )
          const events = useSyncExternalStore(
            listener => (binding ? binding.eventSource.subscribe(listener) : () => {}),
            () => (binding ? binding.eventSource.getSnapshot() : EMPTY_EVENT_SNAP),
          )
          const turns = useMemo(() => buildTranscript(events.entries), [events])
          const stickRef = useRef(true)
          useEffect(() => {
            const node = logRef.current
            if (node && stickRef.current) node.scrollTop = node.scrollHeight
          }, [events.revision, snapshot.running])
          useEffect(() => {
            if (props.onSeen) props.onSeen()
          }, [props.sessionId])
          useEffect(() => {
            if (!props.onActivity) return
            const last = [...turns].reverse().find(turn => turn.kind === 'assistant')
            if (!last) return
            const text = last.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n')
            if (text !== '') props.onActivity(text)
          }, [events.revision])
          // Without a bound transcript the Host stays the only live source: mirror
          // its running flag and echo this turn's text so the turn is still visible.
          const running = session ? Boolean(snapshot.running) : Boolean(props.bot.running)
          useEffect(() => { if (session) setEchoed([]) }, [session])
          // A Bot Session lives under the Bot's own directory, so the Client's
          // Session list never carries it and `sessions.retain()` refuses it.
          // The Host owns the events, so it folds that log for this pane instead.
          const [history, setHistory] = useState([])
          const [historyLoaded, setHistoryLoaded] = useState(false)
          const [historyError, setHistoryError] = useState('')
          const historySeq = useRef(0)
          // The Host hands back the newest event seq, so a poll asks only for what
          // landed after it instead of re-reading the whole log.
          const cursorRef = useRef(-1)
          const loadHistory = useCallback(async (options = {}) => {
            const append = options.append === true
            const seq = historySeq.current + 1
            historySeq.current = seq
            // Overlap the cursor so a turn whose tool result landed in the next
            // batch is rebuilt with its output instead of staying stale.
            const after = append && cursorRef.current >= 0 ? Math.max(-1, cursorRef.current - 50) : -1
            try {
              const suffix = after >= 0 ? `&after=${after}` : ''
              const response = await fetch(`/botmode/api/transcript?botId=${encodeURIComponent(props.bot.id)}&limit=160${suffix}`, { credentials: 'include' })
              const payload = await response.json().catch(() => null)
              if (historySeq.current !== seq) return null
              if (!payload || payload.ok !== true) {
                setHistoryError((payload && payload.error) || `transcript ${response.status}`)
                return null
              }
              setHistoryError('')
              setHistoryLoaded(true)
              if (Number.isInteger(payload.cursor)) cursorRef.current = payload.cursor
              const turns = Array.isArray(payload.turns) ? payload.turns : []
              if (append) {
                if (turns.length > 0) {
                  // Same key means the same turn: the newer fold wins, so a late
                  // tool result replaces the row it belongs to.
                  setHistory((current) => {
                    const merged = current.slice()
                    const index = new Map(merged.map((turn, position) => [turn.key, position]))
                    for (const turn of turns) {
                      const position = index.get(turn.key)
                      if (position === undefined) {
                        index.set(turn.key, merged.length)
                        merged.push(turn)
                      } else {
                        merged[position] = turn
                      }
                    }
                    return merged
                  })
                }
              } else {
                setHistory(turns)
              }
              return turns
            } catch (failure) {
              if (historySeq.current === seq) setHistoryError(failure && failure.message ? failure.message : String(failure))
              return null
            }
          }, [props.bot.id])
          // A different Bot is a different conversation: never show the old rows
          // while the new log is on its way.
          useEffect(() => {
            cursorRef.current = -1
            setHistory([])
            setHistoryLoaded(false)
            setHistoryError('')
          }, [props.bot.id])
          useEffect(() => { void loadHistory() }, [loadHistory])
          // A running turn is chased; an idle pane still ticks slowly so a turn
          // started elsewhere (another tab, a teammate, a Routine) lands by itself.
          useEffect(() => {
            const timer = window.setInterval(() => {
              if (document.visibilityState === 'hidden') return
              void loadHistory({ append: true })
            }, props.bot.running === true ? 3000 : 12000)
            return () => window.clearInterval(timer)
          }, [props.bot.running, loadHistory])
          // A reloaded log already holds what was just echoed; drop those repeats.
          useEffect(() => {
            if (history.length === 0) return
            const recent = new Set(history.filter(turn => turn.kind === 'user').slice(-16).map(turn => turn.text))
            setEchoed(current => (current.length === 0 ? current : current.filter(item => !recent.has(item.text))))
          }, [history])
          const send = async (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            const value = text.trim()
            if (busy) return
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
              if (session === null && value !== '') setEchoed(current => [...current, { id: newId(), text: value, at: Date.now() }])
              if (inputRef.current) inputRef.current.focus()
              void loadHistory({ append: true })
            } catch (failure) {
              setError(failure && failure.message ? failure.message : String(failure))
            } finally {
              setBusy(false)
            }
          }
          const rotateApp = async () => {
            setError('')
            setBusy(t('remote.rotating'))
            try {
              const next = await hostCommand('remote.rotateApp')
              setData(next)
              if (next && next.rotated) flash(t('remote.rotatedApp'))
              else if (next && next.error === 'app-bridge-disabled') setError(t('remote.appDisabled'))
            } catch (failure) {
              setError(String(failure && failure.message ? failure.message : failure))
            } finally {
              setBusy('')
            }
          }

          const stop = async () => {
            try { await hostCommand('bot.stop', { botId: props.bot.id }) } catch (_failure) { /* the turn may already be settling */ }
          }
          const head = h('header', { className: 'bm-chat-head' },
            h(BotAvatarBadge, { bot: props.bot, size: 'sm' }),
            h('div', { className: 'bm-chat-title' },
              h('span', { className: 'bm-name' }, props.bot.name),
              h('span', { className: 'bm-role' }, props.bot.role || '—')),
            h('span', { className: 'bm-chat-status', 'data-running': running },
              running ? t('chat.working') : t('chat.idle')),
            h('span', {
              className: 'bm-model-pill',
              title: describeModel(t, catalog, props.bot.model, { optional: true }),
            }, modelLabelOf(catalog, effectiveModelOf(catalog, props.bot.model))
              || (props.bot.model && props.bot.model.provider && props.bot.model.model
                ? `${props.bot.model.provider}/${props.bot.model.model}`
                : t('model.default'))),
            h('div', { className: 'bm-chat-tabs' },
              h('button', { type: 'button', 'data-active': tab === 'chat', onClick: () => setTab('chat') }, t('chat.tab')),
              h('button', { type: 'button', 'data-active': tab === 'detail', onClick: () => setTab('detail') }, t('chat.detail'))),
            props.onToggleRail
              ? h('button', {
                type: 'button',
                className: 'bm-btn small',
                title: t('screen.panelToggle'),
                onClick: props.onToggleRail,
              }, props.railOpen ? '◫' : '◨')
              : null)
          if (tab === 'detail') {
            return h('div', { className: 'bm-chat' }, head, h('div', { className: 'bm-detail-col' }, props.detail))
          }
          return h('div', { className: 'bm-chat' },
            head,
            h('div', {
              className: 'bm-log', ref: logRef,
              onScroll: (event) => {
                const node = event.currentTarget
                stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
              },
            },
              turns.length === 0 && echoed.length === 0 && history.length === 0 && !running && (session !== null || historyLoaded)
                ? h('div', { className: 'bm-chat-empty' }, t('chat.empty', { name: props.bot.name }))
                : null,
              session && snapshot.hasMore
                ? h('button', { className: 'bm-btn small', style: { alignSelf: 'center' }, onClick: () => { if (session) void session.loadOlder() } }, t('chat.older'))
                : null,
              turns.map(turn => turn.kind === 'user'
                ? h('div', { key: turn.key, className: 'bm-msg bm-msg-user' }, turn.text)
                : turn.kind === 'error'
                  ? h('div', { key: turn.key, className: 'bm-turn-error' }, turn.text)
                  : turn.kind === 'notice'
                    ? h('div', { key: turn.key, className: 'bm-turn-notice' }, t('chat.stopped'))
                    : h(AssistantTurn, { key: turn.key, turn, bot: props.bot })),
              session === null && history.length > 0
                ? h('div', { className: 'bm-history' },
                  history.map(turn => turn.kind === 'user'
                    ? h('div', { key: turn.key, className: 'bm-msg bm-msg-user' },
                      turn.text,
                      turn.images > 0
                        ? h('span', { className: 'bm-msg-badge' }, t('chat.imageCount', { count: turn.images }))
                        : null)
                    : turn.kind === 'error'
                      ? h('div', { key: turn.key, className: 'bm-turn-error' }, turn.text)
                      : turn.kind === 'notice'
                        ? h('div', { key: turn.key, className: 'bm-turn-notice' }, t('chat.stopped'))
                        : h(AssistantTurn, { key: turn.key, turn, bot: props.bot })))
                : null,
              session === null
                ? echoed.filter(item => !history.some(turn => turn.kind === 'user' && turn.text === item.text))
                  .map(item => h('div', { key: item.id, className: 'bm-msg bm-msg-user' }, item.text))
                : null,
              session === null && props.bot.lastReply && history.length === 0
                ? h('details', { className: 'bm-host-reply' },
                  h('summary', null, t('chat.hostReply')),
                  h('div', { className: 'bm-host-reply-body' }, h(MarkdownText, { text: props.bot.lastReply })))
                : null,
              session === null && history.length > 0
                ? h('div', { className: 'bm-history-note', 'data-error': historyError !== '' ? 'true' : undefined },
                  h('button', { type: 'button', className: 'bm-btn small', onClick: () => { void loadHistory() } }, t('chat.historyRefresh')),
                  historyError !== ''
                    ? h('span', null, historyError)
                    : null)
                : null,
              running && turns.every(turn => turn.kind !== 'assistant' || turn.streaming !== true)
                ? h('div', { className: 'bm-tail' }, h('span', { className: 'bm-spin' }), h('span', { className: 'bm-tail-text' }, t('chat.tail')))
                : null),
            error ? h('div', { className: 'bm-error bm-chat-error' }, error) : null,
            retainError && session === null && history.length === 0 && !historyLoaded
              ? h('div', { className: 'bm-bind-note' },
                h('span', null, t('chat.bindMissing')),
                h('button', { type: 'button', className: 'bm-btn small', onClick: () => setRetainKey(value => value + 1) }, t('chat.bindRetry')))
              : null,
            h('form', {
              className: 'bm-compose bm-compose-col',
              onSubmit: send,
              'data-drag': dragOver ? 'true' : undefined,
              onDragOver: (event) => {
                if (!dragCarriesFiles(event.dataTransfer)) return
                event.preventDefault()
                if (!dragOver) setDragOver(true)
              },
              onDragLeave: (event) => {
                if (event.currentTarget.contains(event.relatedTarget)) return
                setDragOver(false)
              },
              onDrop: (event) => {
                if (!dragCarriesFiles(event.dataTransfer)) return
                event.preventDefault()
                setDragOver(false)
                addFiles(event.dataTransfer && event.dataTransfer.files)
              },
            },
              dragOver ? h('div', { className: 'bm-drop-hint' }, t('chat.attachDrop')) : null,
              images.length > 0
                ? h('div', { className: 'bm-attach-list' },
                  images.map(image => h('div', { key: image.id, className: 'bm-attach-item' },
                    h('button', {
                      type: 'button',
                      className: 'bm-attach-thumb',
                      title: t('chat.attachOpen'),
                      onClick: () => { try { window.open(image.url, '_blank', 'noopener') } catch (_error) { /* popup blocked */ } },
                    }, h('img', { src: image.url, alt: image.name })),
                    h('span', { className: 'bm-attach-meta' },
                      h('span', { className: 'bm-attach-name', title: image.name }, image.name),
                      h('span', { className: 'bm-attach-size' }, formatBytes(image.file.size))),
                    h('button', {
                      type: 'button', className: 'bm-attach-remove', title: t('chat.attachRemove'),
                      'aria-label': `${t('chat.attachRemove')}: ${image.name}`,
                      onClick: () => removeImage(image.id),
                    }, '×'))),
                  h('div', { className: 'bm-attach-tools' },
                    h('span', { className: 'bm-attach-count' }, `${images.length}/${ATTACH_LIMIT}`),
                    images.length > 1
                      ? h('button', { type: 'button', className: 'bm-btn small', onClick: clearImages }, t('chat.attachClear'))
                      : null))
                : null,
              h('div', { className: 'bm-compose-row' },
                h('button', {
                  type: 'button',
                  className: 'bm-btn small bm-attach-btn',
                  disabled: vision === false || busy || images.length >= ATTACH_LIMIT,
                  title: vision === false
                    ? t('chat.attachVisionOnly')
                    : images.length >= ATTACH_LIMIT ? t('chat.attachLimit') : t('chat.attachAdd'),
                  onClick: () => { if (attachRef.current) attachRef.current.click() },
                }, t('chat.attach')),
                h('input', {
                  ref: attachRef, type: 'file', hidden: true, multiple: true,
                  accept: 'image/png,image/jpeg,image/webp,image/gif',
                  onChange: (event) => { addFiles(event.target.files); event.target.value = '' },
                }),
                h('textarea', {
                  ref: inputRef,
                  value: text, rows: 1, placeholder: t('chat.placeholder', { name: props.bot.name }),
                  onChange: event => setText(event.target.value),
                  onPaste: (event) => {
                    const files = []
                    const items = event.clipboardData && event.clipboardData.items
                    if (items) {
                      for (const item of items) {
                        if (item.kind !== 'file') continue
                        const file = item.getAsFile()
                        if (file) files.push(file)
                      }
                    }
                    if (files.length === 0) return
                    event.preventDefault()
                    addFiles(files)
                  },
                  onCompositionStart: () => { composingRef.current = true },
                  onCompositionEnd: () => {
                    composingRef.current = false
                    composingDoneAt.current = Date.now()
                  },
                  onKeyDown: (event) => {
                    const native = event.nativeEvent || event
                    // IME: an Enter that commits a candidate must never send.
                    if (native.isComposing || composingRef.current || event.keyCode === 229) return
                    if (Date.now() - composingDoneAt.current < 60) return
                    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event) }
                  },
                }),
                running
                  ? h('button', { type: 'button', className: 'bm-btn', onClick: stop }, t('chat.stop'))
                  : h('button', { type: 'submit', className: 'bm-btn primary', disabled: busy || (text.trim() === '' && images.length === 0) }, busy ? t('form.busy') : t('chat.send')))))
        }

        const IDLE_SESSION_SNAP = Object.freeze({ running: false, openState: 'idle', hasMore: false })
        const ERROR_SESSION_SNAP = Object.freeze({ running: false, openState: 'error', hasMore: false })
        const EMPTY_EVENT_SNAP = Object.freeze({ entries: Object.freeze([]), hasMore: false, revision: 0 })

        function isClientPassToken(raw) {
          let v = String(raw || '').trim()
          if (v === '') return true
          v = v.replace(/^[`*_~\s]+|[`*_~\s]+$/g, '').replace(/[.。!！?？;；,，\s]+$/g, '').trim()
          const wrapped = /^(\(|（|\[|【|<)(.*)(\)|）|\]|】|>)$/.exec(v)
          if (wrapped) v = wrapped[2].trim()
          const token = v.replace(/[\s_-]+/g, '').toLowerCase()
          return token === '' || token === 'pass' || token === 'noreply' || token === 'silent' || token === 'skip'
        }

        function GroupForm(props) {
          const t = useT()
          const g = props.group
          const b = (g && g.budget) || {}
          const [name, setName] = useState(g ? g.name : '')
          const [members, setMembers] = useState(g ? [...g.members] : [])
          const [mode, setMode] = useState(g && g.mode ? g.mode : 'auto')
          const [leadBotId, setLeadBotId] = useState(g && g.leadBotId ? g.leadBotId : '')
          const [workDir, setWorkDir] = useState(g && g.workDir ? g.workDir : '')
          const [purpose, setPurpose] = useState(g && g.purpose ? g.purpose : '')
          const [notes, setNotes] = useState(g && g.notes ? g.notes : '')
          const [tokenLimit, setTokenLimit] = useState(b.tokenLimit !== undefined ? b.tokenLimit : 0)
          const [idleRoundLimit, setIdleRoundLimit] = useState(b.idleRoundLimit || 5)
          const [maxRounds, setMaxRounds] = useState(b.maxRounds !== undefined ? b.maxRounds : 0)
          const [maxMessages, setMaxMessages] = useState(b.maxMessages !== undefined ? b.maxMessages : 0)
          const [error, setError] = useState('')
          const toggle = (id) => setMembers(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))
          const submit = (event) => {
            event.preventDefault()
            const value = name.trim()
            if (value === '') { setError(t('group.needName')); return }
            if (members.length < 2) { setError(t('group.needMembers')); return }
            const parsedMaxRounds = Math.max(0, Math.min(10000, Math.trunc(Number(maxRounds) || 0)))
            const parsedMaxMessages = Math.max(0, Math.min(100000, Math.trunc(Number(maxMessages) || 0)))
            const parsedTokenLimit = Math.max(0, Math.min(1000000000, Math.trunc(Number(tokenLimit) || 0)))
            const parsedIdleLimit = Math.max(1, Math.min(100, Math.trunc(Number(idleRoundLimit) || 5)))
            props.onSave({
              name: value,
              members,
              mode,
              leadBotId: members.includes(leadBotId) ? leadBotId : '',
              workDir: workDir.trim(),
              purpose: purpose.trim(),
              notes: notes.trim(),
              tokenLimit: parsedTokenLimit,
              idleRoundLimit: parsedIdleLimit,
              maxRounds: parsedMaxRounds,
              maxMessages: parsedMaxMessages,
            })
          }
          return h('form', { className: 'bm-form', onSubmit: submit },
            h('h2', null, t(g ? 'group.editTitle' : 'group.createTitle')),
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
                  h('option', { value: 'everyone' }, t('group.modeEveryone')),
                  h('option', { value: 'lead' }, t('group.modeLead')))),
              h('label', { className: 'bm-label' }, t('group.lead'),
                h('select', {
                  className: 'bm-input', value: leadBotId,
                  onChange: event => setLeadBotId(event.target.value),
                },
                  h('option', { value: '' }, t('group.leadAuto')),
                  props.bots.filter(bot => members.includes(bot.id)).map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))))),
            h('label', { className: 'bm-label' }, t('group.workDir'),
              h('input', {
                className: 'bm-input', value: workDir, placeholder: t('group.workDirPlaceholder'),
                onChange: event => setWorkDir(event.target.value),
              })),
            h('div', { className: 'bm-row' },
              h('label', { className: 'bm-label' }, t('group.tokenLimit'),
                h('input', {
                  type: 'number', min: 0, step: 50000, className: 'bm-input', value: tokenLimit,
                  onChange: event => setTokenLimit(event.target.value),
                })),
              h('label', { className: 'bm-label' }, t('group.idleRoundLimit'),
                h('input', {
                  type: 'number', min: 1, max: 100, className: 'bm-input', value: idleRoundLimit,
                  onChange: event => setIdleRoundLimit(event.target.value),
                }))),
            h('div', { className: 'bm-row' },
              h('label', { className: 'bm-label' }, t('group.maxRoundsHint'),
                h('input', {
                  type: 'number', min: 0, max: 10000, className: 'bm-input', value: maxRounds,
                  onChange: event => setMaxRounds(event.target.value),
                })),
              h('label', { className: 'bm-label' }, t('group.maxMessagesHint'),
                h('input', {
                  type: 'number', min: 0, max: 100000, className: 'bm-input', value: maxMessages,
                  onChange: event => setMaxMessages(event.target.value),
                }))),
            h('label', { className: 'bm-label' }, t('group.purpose'),
              h('input', {
                className: 'bm-input', value: purpose, placeholder: t('group.purposePlaceholder'),
                onChange: event => setPurpose(event.target.value),
              })),
            h('label', { className: 'bm-label' }, t('group.notes'),
              h('textarea', {
                className: 'bm-area', rows: 2, value: notes, placeholder: t('group.notesPlaceholder'),
                onChange: event => setNotes(event.target.value),
              })),
            h('div', { className: 'bm-label' }, t('group.members'),
              h('div', { className: 'bm-picks' }, props.bots.map(bot => h('label', {
                key: bot.id, className: 'bm-pick', 'data-on': members.includes(bot.id),
              },
                h('input', { type: 'checkbox', checked: members.includes(bot.id), onChange: () => toggle(bot.id) }),
                bot.name)))),
            error ? h('div', { className: 'bm-error' }, error) : null,
            h('div', { className: 'bm-form-actions' },
              g ? h('button', { type: 'button', className: 'bm-btn danger', onClick: props.onDelete }, t('group.delete')) : null,
              h('button', { type: 'button', className: 'bm-btn', onClick: props.onCancel }, t('form.cancel')),
              h('button', { type: 'submit', className: 'bm-btn primary', disabled: members.length < 2 || name.trim() === '' },
                t(g ? 'form.save' : 'group.create'))))
        }

        function formatActivityLabel(t, item) {
          if (!item || !item.kind) return ''
          if (item.kind === 'passed') return t('group.actPassed', { name: item.botName || 'Bot' })
          if (item.kind === 'completed') return t('group.actCompleted', { name: item.botName || 'Bot' })
          if (item.kind === 'settled') return t('group.actSettled', { reason: item.reason || 'done' })
          if (item.kind === 'stalled') return t('group.actStalled', { reason: item.reason || 'probe' })
          if (item.kind === 'capped') return t('group.actCapped', { reason: item.reason || 'budget' })
          if (item.kind === 'cancelled') return t('group.actCancelled', { reason: item.reason || 'stop' })
          if (item.kind === 'soft_steer') return t('group.actSoftSteer')
          if (item.kind === 'continued') return t('group.actContinued')
          if (item.kind === 'escalation') return t('group.actEscalation', { name: item.botName || 'Bot' })
          if (item.kind === 'bot_paused_error') return t('group.actBotError', { name: item.botName || 'Bot' })
          if (item.kind === 'subtask_claimed') return t('group.actSubtaskClaim', { name: item.botName || 'Bot', taskId: item.taskId || '' })
          if (item.kind === 'subtask_completed') return t('group.actSubtaskDone', { name: item.botName || 'Bot', taskId: item.taskId || '' })
          return ''
        }

        function QuestionCard(props) {
          const t = useT()
          const entry = props.entry
          const [draft, setDraft] = useState({})
          const [busy, setBusy] = useState(false)
          const toggleOption = (q, label) => {
            setDraft((prev) => {
              const cur = prev[q.id] || { selected: [], custom: '' }
              const nextSelected = q.multiSelect
                ? (cur.selected.includes(label) ? cur.selected.filter(item => item !== label) : [...cur.selected, label])
                : [label]
              return { ...prev, [q.id]: { ...cur, selected: nextSelected } }
            })
          }
          const setCustom = (qid, value) => {
            setDraft((prev) => {
              const cur = prev[qid] || { selected: [], custom: '' }
              return { ...prev, [qid]: { ...cur, custom: value } }
            })
          }
          const submit = async () => {
            setBusy(true)
            try {
              const answers = (entry.questions || []).map((q) => {
                const cur = draft[q.id] || { selected: [], custom: '' }
                return {
                  id: q.id,
                  selected: cur.selected,
                  ...(cur.custom.trim() !== '' ? { custom: cur.custom.trim() } : {}),
                }
              })
              await hostCommand('question.decide', { questionId: entry.id, answers })
            } catch (_error) { /* settled */ } finally {
              setBusy(false)
            }
          }
          const dismiss = async () => {
            setBusy(true)
            try {
              await hostCommand('question.decide', { questionId: entry.id, answers: 'cancel' })
            } catch (_error) { /* settled */ } finally {
              setBusy(false)
            }
          }
          return h('div', { className: 'bm-qcard' },
            h('div', { className: 'bm-approval-text' },
              h('span', { className: 'bm-approval-name' }, `@${entry.botName}`),
              h('span', { className: 'bm-approval-tool' }, 'ask_user_question')),
            (entry.questions || []).map(q => h('div', { key: q.id, className: 'bm-qitem' },
              h('div', { className: 'bm-qtitle' }, q.question),
              q.detail ? h('div', { className: 'bm-muted' }, q.detail) : null,
              (q.options || []).length > 0
                ? h('div', { className: 'bm-picks' }, q.options.map(opt => h('button', {
                  key: opt.label,
                  type: 'button',
                  className: 'bm-pick',
                  'data-on': Boolean(draft[q.id] && draft[q.id].selected.includes(opt.label)),
                  title: opt.description || opt.label,
                  onClick: () => toggleOption(q, opt.label),
                }, opt.label)))
                : null,
              h('input', {
                className: 'bm-input',
                placeholder: t('question.customPlaceholder'),
                value: (draft[q.id] && draft[q.id].custom) || '',
                onChange: e => setCustom(q.id, e.target.value),
              }))),
            h('div', { className: 'bm-approval-actions' },
              h('button', { type: 'button', className: 'bm-btn small primary', disabled: busy, onClick: submit }, t('question.submit')),
              h('button', { type: 'button', className: 'bm-btn small danger', disabled: busy, onClick: dismiss }, t('question.dismiss'))))
        }

        /**
         * Inline real-time main reply bubble rendered directly inside GroupChat's `.bm-log`.
         *
         * Subscribes to `room.memberSessions[botId]` and renders ONLY the Bot's main reply text
         * stream (never showing tool calls, reasoning blocks, or `(pass)` silence tokens), so
         * multiple Bots stream cleanly inline inside the group conversation without a separate
         * bottom panel.
         */
        function RoomInlineStreamMessage(props) {
          const bot = props.bot
          const actor = props.actor
          const sessionId = props.sessionId || (actor && actor.sessionId) || ''
          const reference = useMemo(() => {
            if (!sessionId) return null
            try {
              return sessions.retain(sessionId, { source: 'botmode.room.stream' })
            } catch (_failure) {
              return null
            }
          }, [sessionId])
          useEffect(() => () => { if (reference) reference.release() }, [reference])
          const binding = reference ? reference.binding : null
          const session = binding ? binding.session : null
          const snapshot = useSyncExternalStore(
            listener => (session ? session.subscribe(listener) : () => {}),
            () => (session ? session.getSnapshot() : IDLE_SESSION_SNAP),
          )
          const events = useSyncExternalStore(
            listener => (binding ? binding.eventSource.subscribe(listener) : () => {}),
            () => (binding ? binding.eventSource.getSnapshot() : EMPTY_EVENT_SNAP),
          )

          const wasRunningRef = useRef(false)
          useEffect(() => {
            const isNowRunning = Boolean(snapshot.running)
            if (wasRunningRef.current && !isNowRunning) {
              void refreshHost()
            }
            wasRunningRef.current = isNowRunning
          }, [snapshot.running])

          const actorState = (actor && actor.state) || (snapshot.running ? 'running' : 'idle')
          const isStreamingNow = Boolean(snapshot.running) || actorState === 'running'

          const liveText = useMemo(() => {
            if (!isStreamingNow) return ''
            const turns = buildTranscript(events.entries || [])
            let lastUserIdx = -1
            for (let i = turns.length - 1; i >= 0; i -= 1) {
              if (turns[i].kind === 'user') { lastUserIdx = i; break }
            }
            const activeSlice = lastUserIdx >= 0 ? turns.slice(lastUserIdx + 1) : turns.slice(-2)
            const parts = []
            for (const item of activeSlice) {
              if (item.kind !== 'assistant') continue
              for (const block of item.blocks || []) {
                if (block.kind !== 'text') continue
                const val = String(block.text || '').trim()
                if (val === '' || isClientPassToken(val)) continue
                parts.push(val)
              }
            }
            return parts.length > 0 ? parts[parts.length - 1] : ''
          }, [isStreamingNow, events])

          useEffect(() => {
            if (liveText && props.onStreamTick) props.onStreamTick()
          }, [liveText])

          if (!isStreamingNow || liveText === '') return null
          if (props.lastCommittedText && liveText === props.lastCommittedText.trim()) return null

          return h('div', { className: 'bm-msg bm-msg-bot bm-msg-streaming' },
            h('div', { className: 'bm-msg-name', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h(BotAvatarBadge, { bot, size: 'xs' }),
              h('span', null, bot.name),
              h('span', { className: 'bm-spin', style: { marginLeft: 'auto' } })),
            h('div', { className: 'bm-assistant-text' },
              h(MarkdownText, { text: liveText, mentionMembers: props.mentionMembers }),
              h('span', { className: 'bm-cursor' })))
        }

        function detectMentionTrigger(value, cursorPos) {
          const text = String(value || '')
          const pos = typeof cursorPos === 'number' && cursorPos >= 0 ? cursorPos : text.length
          const before = text.slice(0, pos)
          const match = /(?:^|[\s，。！？、,;；:：(\[（【])([@＠]([^\s@＠]*))$/.exec(before)
          if (!match) return null
          const fullToken = match[1] // `@...`
          const query = match[2] || ''
          const start = pos - fullToken.length
          return { start, end: pos, query }
        }

        function GroupChat(props) {
          const t = useT()
          const [text, setText] = useState('')
          const [busy, setBusy] = useState(false)
          const [error, setError] = useState('')
          const [mentionQuery, setMentionQuery] = useState(null)
          const [mentionIdx, setMentionIdx] = useState(0)
          const composingRef = useRef(false)
          const composingDoneAt = useRef(0)
          const logRef = useRef(null)
          const inputRef = useRef(null)
          const stickRef = useRef(true)
          const group = props.group
          const settings = props.settings || {}
          const showActivityStrip = Boolean(settings.groupChat && settings.groupChat.showActivityStrip)
          const members = props.bots.filter(bot => (group.members || []).includes(bot.id))
          const memberMap = useMemo(() => new Map(props.bots.map(b => [b.id, b])), [props.bots])
          const messages = group.messages || []
          const actors = group.actors || []
          const actorByBotId = useMemo(() => new Map(actors.map(a => [a.botId, a])), [actors])
          const speakingIds = group.speakingBotIds || []
          const running = group.status === 'running' || group.running === true
          const completed = group.status === 'completed'
          const settled = group.status === 'settled'
          const stalled = group.status === 'stalled'
          const capped = group.status === 'capped'
          const waitingUser = group.status === 'waiting_user' || group.status === 'paused'
          const paused = waitingUser || stalled || capped || group.needsYou === true
          const budget = group.budget || { rounds: 0, messages: 0, maxRounds: 0, maxMessages: 0, tokensUsed: 0 }
          const currentSpeaker = group.currentSpeakerId
            ? members.find(bot => bot.id === group.currentSpeakerId)
            : undefined
          const recentActivity = (group.activity || []).slice(-6).map(item => ({
            id: item.id || `${item.kind}-${item.at}`,
            label: formatActivityLabel(t, item),
          })).filter(item => item.label !== '')

          const mentionCandidates = useMemo(() => {
            if (!mentionQuery) return []
            const q = mentionQuery.query.trim().toLowerCase()
            const allOption = {
              id: '__all__',
              name: t('group.mentionAll'),
              role: t('group.mentionAllSub'),
              color: '#4d6bfe',
              isAll: true,
              searchKey: 'all everyone 所有人 全员',
            }
            const botOptions = members.map(bot => ({
              id: bot.id,
              name: bot.name,
              role: bot.role || '',
              color: bot.color || COLORS[0],
              avatar: bot.avatar || null,
              isAll: false,
              searchKey: `${bot.name} ${bot.role || ''} ${bot.id}`.toLowerCase(),
            }))
            const pool = [...botOptions, allOption]
            if (!q) return pool
            return pool.filter(opt => opt.searchKey.includes(q))
          }, [mentionQuery, members, t])

          useEffect(() => {
            setMentionQuery(null)
            setMentionIdx(0)
          }, [group.id])

          useEffect(() => {
            setMentionIdx(prev => (mentionCandidates.length === 0 ? 0 : Math.min(prev, mentionCandidates.length - 1)))
          }, [mentionCandidates.length])

          // Live colored mention cards extracted from the composer draft
          const draftMentions = useMemo(() => {
            const spans = findMentionSpans(text, members)
            const seen = new Set()
            const chips = []
            for (const span of spans) {
              const key = `${span.kind}:${span.id}`
              if (seen.has(key)) continue
              seen.add(key)
              chips.push(span)
            }
            return chips
          }, [text, members])

          const syncMentionFromTarget = (el, nextVal) => {
            const val = typeof nextVal === 'string' ? nextVal : (el ? el.value : text)
            const pos = el && typeof el.selectionStart === 'number' ? el.selectionStart : val.length
            const detected = detectMentionTrigger(val, pos)
            setMentionQuery(detected)
            if (detected) setMentionIdx(0)
          }

          const insertMention = (candidate) => {
            if (!candidate) return
            const el = inputRef.current
            const insertion = `@${candidate.name} `
            let nextText = text
            let nextCursor = text.length
            if (mentionQuery) {
              nextText = `${text.slice(0, mentionQuery.start)}${insertion}${text.slice(mentionQuery.end)}`
              nextCursor = mentionQuery.start + insertion.length
            } else {
              const pos = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length
              const before = text.slice(0, pos)
              const needSpace = before.length > 0 && !/[\s(（【]$/.test(before)
              const prefix = needSpace ? ' ' : ''
              nextText = `${before}${prefix}${insertion}${text.slice(pos)}`
              nextCursor = pos + prefix.length + insertion.length
            }
            setText(nextText)
            setMentionQuery(null)
            setMentionIdx(0)
            window.requestAnimationFrame(() => {
              const node = inputRef.current
              if (!node) return
              node.focus()
              try { node.setSelectionRange(nextCursor, nextCursor) } catch (_err) { /* ignore */ }
            })
          }

          const removeDraftMention = (span) => {
            const spans = findMentionSpans(text, members).filter(s => s.kind === span.kind && s.id === span.id)
            if (spans.length === 0) return
            // Remove all occurrences of that mention cleanly from right to left
            let next = text
            for (let i = spans.length - 1; i >= 0; i -= 1) {
              const s = spans[i]
              const afterChar = next[s.end] === ' ' ? 1 : 0
              next = next.slice(0, s.start) + next.slice(s.end + afterChar)
            }
            setText(next)
            setMentionQuery(null)
            window.requestAnimationFrame(() => { if (inputRef.current) inputRef.current.focus() })
          }

          const toggleMentionButton = () => {
            if (mentionQuery) {
              setMentionQuery(null)
              return
            }
            const el = inputRef.current
            const pos = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length
            const existing = detectMentionTrigger(text, pos)
            if (existing) {
              setMentionQuery(existing)
              setMentionIdx(0)
              if (el) el.focus()
              return
            }
            const before = text.slice(0, pos)
            const needSpace = before.length > 0 && !/[\s，。！？、,;；:：(\[（【]$/.test(before)
            const prefix = needSpace ? ' @' : '@'
            const nextText = `${before}${prefix}${text.slice(pos)}`
            const nextPos = pos + prefix.length
            setText(nextText)
            setMentionQuery({ start: nextPos - 1, end: nextPos, query: '' })
            setMentionIdx(0)
            window.requestAnimationFrame(() => {
              const node = inputRef.current
              if (!node) return
              node.focus()
              try { node.setSelectionRange(nextPos, nextPos) } catch (_err) { /* ignore */ }
            })
          }

          const lastCommittedByBot = useMemo(() => {
            const map = new Map()
            const currentEpoch = group.epoch || 0
            for (const msg of messages) {
              if (msg.from && msg.from !== 'user' && (msg.epoch || 0) === currentEpoch && typeof msg.text === 'string') {
                map.set(msg.from, msg.text)
              }
            }
            return map
          }, [messages, group.epoch])

          const scrollToBottomIfStuck = () => {
            const node = logRef.current
            if (node && stickRef.current) node.scrollTop = node.scrollHeight
          }

          // Fast polling while group actors are actively executing in parallel
          useEffect(() => {
            if (!running && speakingIds.length === 0) return undefined
            const fast = window.setInterval(() => {
              if (document.visibilityState !== 'hidden') void refreshHost()
            }, 1000)
            return () => window.clearInterval(fast)
          }, [running, speakingIds.length])

          useEffect(() => {
            scrollToBottomIfStuck()
          }, [messages.length, group.status, speakingIds.length])

          const send = async (event) => {
            event.preventDefault()
            const value = text.trim()
            if (value === '' || busy) return
            if (members.length < 2) { setError(t('group.noMembers')); return }
            setMentionQuery(null)
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
          const control = async (action, extra = {}) => {
            setBusy(true)
            setError('')
            try { await hostCommand('room.control', { roomId: group.id, action, ...extra }) } catch (failure) {
              setError(failure && failure.message ? failure.message : String(failure))
            } finally { setBusy(false) }
          }

          let pauseMessage = t('group.pausedMention')
          if (group.pausedReason === 'token_budget') pauseMessage = t('group.pausedTokenBudget')
          else if (group.pausedReason === 'idle_spin') pauseMessage = t('group.pausedIdleSpin')
          else if (group.pausedReason === 'bot_error') pauseMessage = t('group.pausedBotError')
          else if (group.pausedReason === 'turn_error') pauseMessage = t('group.pausedTurnError')
          else if (group.pausedReason === 'approval') pauseMessage = t('group.pausedApproval')
          else if (group.pausedReason === 'question') pauseMessage = t('group.pausedQuestion')
          else if (capped || group.pausedReason === 'budget') pauseMessage = t('group.pausedBudget')

          const hasHardBudget = (budget.maxRounds || 0) > 0 || (budget.maxMessages || 0) > 0
          const metricsSubtitle = hasHardBudget
            ? `${t('group.membersCount', { n: members.length })} · ${t('group.budget', {
              r: budget.rounds || 0,
              mr: budget.maxRounds || '∞',
              m: budget.messages || 0,
              mm: budget.maxMessages || '∞',
            })}`
            : `${t('group.membersCount', { n: members.length })} · ${t('group.metricsUnlimited', {
              e: group.epoch || 0,
              m: budget.messages || 0,
              tk: Math.round((budget.tokensUsed || 0) / 100) / 10,
            })}`

          return h('div', { className: 'bm-chat' },
            h('header', { className: 'bm-chat-head' },
              h('span', { className: 'bm-avatar bm-avatar-sm', style: { background: group.color || COLORS[3] } }, initialOf(group.name)),
              h('div', { className: 'bm-chat-title' },
                h('span', { className: 'bm-name' }, group.name),
                h('span', { className: 'bm-role' },
                  group.workDir ? `${metricsSubtitle} · ${group.workDir}` : metricsSubtitle)),
              running
                ? h('span', { className: 'bm-status-pill', 'data-kind': 'running' },
                  speakingIds.length > 1
                    ? t('group.speakingMulti', { n: speakingIds.length })
                    : currentSpeaker
                      ? t('group.speaking', { name: currentSpeaker.name })
                      : t('group.running'))
                : completed
                  ? h('span', { className: 'bm-status-pill', 'data-kind': 'completed' }, t('group.completed'))
                  : settled
                    ? h('span', { className: 'bm-status-pill', 'data-kind': 'settled' }, t('group.settled'))
                    : stalled
                      ? h('span', { className: 'bm-status-pill', 'data-kind': 'stalled' }, t('group.stalled'))
                      : waitingUser
                        ? h('span', { className: 'bm-status-pill', 'data-kind': 'waiting_user' }, t('group.waitingUser'))
                        : capped
                          ? h('span', { className: 'bm-status-pill', 'data-kind': 'capped' }, t('group.capped'))
                          : null,
              running
                ? h('button', { type: 'button', className: 'bm-btn small', disabled: busy, onClick: () => control('stop') }, t('group.stop'))
                : null,
              paused && !capped && !running ? h('span', { className: 'bm-needs-you' }, t('group.needsYou')) : null,
              h('div', { className: 'bm-chat-tabs' },
                h('button', { type: 'button', 'data-active': true }, t('chat.tab')),
                h('button', { type: 'button', onClick: props.onEdit }, t('chat.detail')))),
            paused && !running ? h('div', { className: 'bm-room-alert' },
              h('span', null, pauseMessage),
              group.pausedReason === 'approval' || group.pausedReason === 'question'
                ? null
                : h('button', { type: 'button', className: 'bm-btn small primary', disabled: busy, onClick: () => control('continue') }, t('group.continue')),
              h('button', { type: 'button', className: 'bm-btn small', disabled: busy, onClick: () => control('stop') }, t('group.stop'))) : null,
            (() => {
              const pausedActors = (group.actors || []).filter(a => a && a.state === 'paused_error')
              if (pausedActors.length === 0) return null
              return h('div', { className: 'bm-room-alert' },
                pausedActors.map(actor => h('div', { key: `pe-${actor.botId}`, style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', width: '100%' } },
                  h('span', null, `${actor.botName || actor.botId}: ${actor.pausedError || t('group.actorPausedError')}`),
                  h('button', {
                    type: 'button',
                    className: 'bm-btn small primary',
                    disabled: busy,
                    onClick: () => control('resume_bot', { botId: actor.botId }),
                  }, t('group.resumeBot')))))
            })(),
            (() => {
              const subtasks = Array.isArray(group.subtasks) ? group.subtasks.filter(s => s.status === 'in_progress' || s.status === 'completed') : []
              const progressItems = Array.isArray(group.progress && group.progress.items) ? group.progress.items : []
              if (subtasks.length === 0 && progressItems.length === 0) return null
              const doneCount = progressItems.filter(i => i.done).length
              return h('div', { className: 'bm-taskboard' },
                h('div', { className: 'bm-taskboard-title' },
                  h('span', null, t('group.taskBoard')),
                  progressItems.length > 0
                    ? h('span', { className: 'bm-muted', style: { marginLeft: 'auto' } }, `${doneCount}/${progressItems.length}`)
                    : null),
                h('div', { className: 'bm-taskboard-list' },
                  subtasks.map(task => h('span', { key: `st-${task.taskId}`, className: 'bm-task-chip', 'data-status': task.status },
                    h('strong', null, task.status === 'completed' ? '✓ ' : '🔒 '),
                    h('span', null, task.title || task.taskId),
                    task.ownerName ? h('span', { className: 'bm-muted' }, ` @${task.ownerName}`) : null,
                    Array.isArray(task.paths) && task.paths.length > 0
                      ? h('span', { className: 'bm-task-paths' }, ` (${task.paths.length})`)
                      : null)),
                  progressItems.map(item => h('span', { key: `pg-${item.id}`, className: 'bm-task-chip', 'data-status': item.done ? 'completed' : 'in_progress' },
                    h('strong', null, item.done ? '☑ ' : '☐ '),
                    h('span', null, item.title),
                    item.owner ? h('span', { className: 'bm-muted' }, ` @${item.owner}`) : null))))
            })(),
            h('div', {
              className: 'bm-log',
              ref: logRef,
              onScroll: (event) => {
                const node = event.currentTarget
                stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 56
              },
            },
              messages.length === 0 && !running ? h('div', { className: 'bm-chat-empty' }, t('group.empty')) : null,
              messages.map((message) => {
                if (message.kind === 'completion') {
                  return h('div', { key: message.id, className: 'bm-msg-completion' },
                    h('div', { className: 'bm-msg-completion-head' },
                      '✓ ',
                      t('group.completedBanner', { name: message.name || 'Bot' }),
                      message.seq ? h('span', { className: 'bm-muted', style: { marginLeft: 'auto' } }, `#${message.seq}`) : null),
                    h(MarkdownText, { text: message.text, mentionMembers: members }),
                    Array.isArray(message.deliverables) && message.deliverables.length > 0
                      ? h('div', { className: 'bm-msg-deliverables' },
                        message.deliverables.map((d, idx) => h('code', { key: `deliv-${idx}`, className: 'bm-inline-code' }, d)))
                      : null)
                }
                if (message.kind === 'system') {
                  return h('div', { key: message.id, className: 'bm-msg-system' }, renderTextWithMentions(message.text, message.id, members))
                }
                if (message.kind === 'error') {
                  return h('div', { key: message.id, className: 'bm-turn-error' }, `${message.name}: ${message.text}`)
                }
                if (message.from === 'user') {
                  return h('div', { key: message.id, className: 'bm-msg bm-msg-user' }, renderTextWithMentions(message.text, message.id, members))
                }
                const authorBot = memberMap.get(message.from)
                return h('div', { key: message.id, className: 'bm-msg bm-msg-bot' },
                  h('div', { className: 'bm-msg-name', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                    authorBot
                      ? h(BotAvatarBadge, { bot: authorBot, size: 'xs' })
                      : null,
                    h('span', null, message.name),
                    message.seq ? h('span', { className: 'bm-muted', style: { marginLeft: 'auto', fontWeight: 400 } }, `#${message.seq}`) : null),
                  h(MarkdownText, { text: message.text, mentionMembers: members }))
              }),
              // Real-time main reply streams rendered directly inline in `.bm-log` (zero tool calls, zero separate bottom cards)
              members.map(bot => h(RoomInlineStreamMessage, {
                key: `live-${bot.id}`,
                bot,
                actor: actorByBotId.get(bot.id),
                sessionId: group.memberSessions && group.memberSessions[bot.id],
                lastCommittedText: lastCommittedByBot.get(bot.id) || '',
                mentionMembers: members,
                onStreamTick: scrollToBottomIfStuck,
              }))),
            showActivityStrip && recentActivity.length > 0
              ? h('div', { className: 'bm-room-activity' },
                recentActivity.map(item => h('span', { key: item.id, className: 'bm-act-chip' }, item.label)))
              : null,
            error ? h('div', { className: 'bm-error bm-chat-error' }, error) : null,
            h('div', { className: 'bm-compose-wrap' },
              mentionQuery && mentionCandidates.length > 0
                ? h('div', { className: 'bm-mention-pop', role: 'listbox', 'aria-label': t('group.mentionPickTitle') },
                  h('div', { className: 'bm-mention-pop-head' },
                    h('span', null, t('group.mentionPickTitle')),
                    h('span', null, t('group.mentionHint'))),
                  mentionCandidates.map((cand, idx) => h('button', {
                    key: `mo-${cand.id}`,
                    type: 'button',
                    role: 'option',
                    'aria-selected': idx === mentionIdx,
                    className: 'bm-mention-opt',
                    'data-active': idx === mentionIdx,
                    onMouseEnter: () => setMentionIdx(idx),
                    onMouseDown: (e) => { e.preventDefault(); insertMention(cand) },
                  },
                  cand.isAll
                    ? h('span', { className: 'bm-avatar bm-avatar-xs', style: { background: cand.color } }, '@')
                    : h(BotAvatarBadge, { bot: cand, size: 'xs' }),
                  h('span', { className: 'bm-mention-opt-body' },
                    h('span', { className: 'bm-mention-opt-name' }, cand.name),
                    cand.role ? h('span', { className: 'bm-mention-opt-role' }, cand.role) : null),
                  h('span', { className: 'bm-mention-opt-tag', style: { '--bm-mc': cand.color } }, `@${cand.name}`))))
                : null,
              draftMentions.length > 0
                ? h('div', { className: 'bm-compose-mentions' },
                  draftMentions.map((span, idx) => h('span', {
                    key: `dm-${span.kind}-${span.id}-${idx}`,
                    className: 'bm-mention-pill',
                    style: { '--bm-mc': span.color },
                  },
                  h('span', { className: 'bm-mention-dot', 'aria-hidden': 'true' }),
                  `@${span.label}`,
                  h('button', {
                    type: 'button',
                    className: 'bm-mention-rm',
                    'aria-label': `remove @${span.label}`,
                    onMouseDown: (e) => { e.preventDefault(); removeDraftMention(span) },
                  }, '×'))))
                : null,
              h('form', { className: 'bm-compose', onSubmit: send },
                h('button', {
                  type: 'button',
                  className: 'bm-btn bm-mention-btn',
                  title: t('group.mentionBtnTitle'),
                  onMouseDown: (e) => { e.preventDefault(); toggleMentionButton() },
                }, '@'),
                h('textarea', {
                  ref: inputRef,
                  value: text, rows: 1,
                  placeholder: running ? t('group.interjectPlaceholder') : t('group.placeholder'),
                  onChange: (event) => {
                    const nextVal = event.target.value
                    setText(nextVal)
                    syncMentionFromTarget(event.target, nextVal)
                  },
                  onClick: (event) => syncMentionFromTarget(event.target),
                  onKeyUp: (event) => {
                    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape') return
                    syncMentionFromTarget(event.target)
                  },
                  onBlur: () => { setMentionQuery(null) },
                  onCompositionStart: () => { composingRef.current = true },
                  onCompositionEnd: () => {
                    composingRef.current = false
                    composingDoneAt.current = Date.now()
                  },
                  onKeyDown: (event) => {
                    const native = event.nativeEvent || event
                    if (native.isComposing || composingRef.current || event.keyCode === 229) return
                    if (Date.now() - composingDoneAt.current < 60) return
                    if (mentionQuery && mentionCandidates.length > 0) {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        setMentionIdx(i => (i + 1) % mentionCandidates.length)
                        return
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        setMentionIdx(i => (i - 1 + mentionCandidates.length) % mentionCandidates.length)
                        return
                      }
                      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                        event.preventDefault()
                        insertMention(mentionCandidates[mentionIdx] || mentionCandidates[0])
                        return
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setMentionQuery(null)
                        return
                      }
                    }
                    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event) }
                  },
                }),
                h('button', { type: 'submit', className: 'bm-btn primary', disabled: text.trim() === '' || busy }, t('group.send')))))
        }

        function MemoryHubPanel(props) {
          const t = useT()
          const memory = props.memory || {
            provider: 'memory_tencentdb',
            teamId: 'dsh-botmode',
            userId: 'default',
            prefetchEnabled: true,
            syncEnabled: true,
            syncGroupRooms: true,
            health: null,
            providers: [],
            catalog: [],
          }
          const [teamId, setTeamId] = useState(memory.teamId || 'dsh-botmode')
          const [userId, setUserId] = useState(memory.userId || 'default')
          const [prefetchEnabled, setPrefetchEnabled] = useState(memory.prefetchEnabled !== false)
          const [syncEnabled, setSyncEnabled] = useState(memory.syncEnabled !== false)
          const [syncGroupRooms, setSyncGroupRooms] = useState(memory.syncGroupRooms !== false)
          const [expandedId, setExpandedId] = useState('')
          const [cfgDrafts, setCfgDrafts] = useState({})
          const [installSource, setInstallSource] = useState('')
          const [searchBotId, setSearchBotId] = useState((props.bots[0] && props.bots[0].id) || '')
          const [searchQuery, setSearchQuery] = useState('')
          const [searchOut, setSearchOut] = useState('')
          const [busy, setBusy] = useState(false)
          const [notice, setNotice] = useState('')
          const [error, setError] = useState('')

          useEffect(() => {
            setTeamId(memory.teamId || 'dsh-botmode')
            setUserId(memory.userId || 'default')
            setPrefetchEnabled(memory.prefetchEnabled !== false)
            setSyncEnabled(memory.syncEnabled !== false)
            setSyncGroupRooms(memory.syncGroupRooms !== false)
          }, [memory.teamId, memory.userId, memory.prefetchEnabled, memory.syncEnabled, memory.syncGroupRooms])

          const runAction = async (fn, successMsg = '') => {
            setBusy(true)
            setError('')
            setNotice('')
            try {
              const out = await fn()
              if (successMsg) setNotice(successMsg)
              return out
            } catch (failure) {
              setError(failure && failure.message ? failure.message : String(failure))
              return undefined
            } finally {
              setBusy(false)
            }
          }

          const health = memory.health
          const healthState = !health ? 'warn'
            : health.ok && health.mode === 'fallback-local' ? 'warn'
              : health.ok ? 'ok' : 'err'
          const modeLabel = !health ? t('memory.modeOffline')
            : health.mode === 'gateway' ? t('memory.modeGateway')
              : health.mode === 'fallback-local' ? t('memory.modeFallback')
                : health.mode === 'local-sqlite' ? t('memory.modeLocal')
                  : health.mode === 'builtin' ? t('memory.modeBuiltin')
                    : (health.ok ? health.mode : t('memory.modeOffline'))

          const openConfig = (provider) => {
            if (expandedId === provider.id) { setExpandedId(''); return }
            setCfgDrafts(prev => ({ ...prev, [provider.id]: { ...(provider.config || {}) } }))
            setExpandedId(provider.id)
          }

          const updateDraftField = (providerId, key, value) => {
            setCfgDrafts(prev => ({
              ...prev,
              [providerId]: { ...(prev[providerId] || {}), [key]: value },
            }))
          }

          const saveProviderConfig = async (provider) => {
            const draft = cfgDrafts[provider.id] || {}
            const coerced = {}
            for (const field of provider.configSchema || []) {
              const val = draft[field.key]
              if (field.type === 'integer' || field.type === 'number') coerced[field.key] = Number(val)
              else if (field.type === 'boolean') coerced[field.key] = Boolean(val)
              else coerced[field.key] = String(val ?? '')
            }
            await runAction(() => props.onCommand('memory.configure', {
              providerId: provider.id,
              config: coerced,
            }), t('memory.saved'))
          }

          const doSearch = async (event) => {
            event.preventDefault()
            if (!searchQuery.trim()) return
            const botId = searchBotId || (props.bots[0] && props.bots[0].id) || ''
            const res = await runAction(() => props.onCommand('memory.search', {
              botId,
              query: searchQuery.trim(),
            }))
            if (res) setSearchOut(res.text || t('memory.searchEmpty'))
          }

          return h('div', { className: 'bm-mem-panel' },
            h('header', { className: 'bm-mem-head' },
              h('div', null,
                h('div', { className: 'bm-eyebrow' }, t('pane.memory')),
                h('h2', { className: 'bm-title' }, t('memory.title')),
                h('p', { className: 'bm-sub' }, t('memory.subtitle'))),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                h('span', { className: 'bm-mem-badge', 'data-state': healthState }, modeLabel),
                h('button', {
                  type: 'button', className: 'bm-btn small', disabled: busy,
                  onClick: () => runAction(() => props.onCommand('memory.test', { providerId: memory.provider }), ''),
                }, busy ? t('memory.testing') : t('memory.test')))),
            health && health.detail ? h('div', { className: 'bm-muted' }, health.detail) : null,
            error ? h('div', { className: 'bm-error' }, error) : null,
            notice ? h('div', { className: 'bm-ok' }, notice) : null,

            h('section', { className: 'bm-form' },
              h('h2', null, t('memory.globalSettings')),
              h('div', { className: 'bm-row' },
                h('label', { className: 'bm-label' }, t('memory.teamId'),
                  h('input', { className: 'bm-input', value: teamId, onChange: e => setTeamId(e.target.value) })),
                h('label', { className: 'bm-label' }, t('memory.userId'),
                  h('input', { className: 'bm-input', value: userId, onChange: e => setUserId(e.target.value) }))),
              h('div', { className: 'bm-mem-checks' },
                h('label', null,
                  h('input', { type: 'checkbox', checked: prefetchEnabled, onChange: e => setPrefetchEnabled(e.target.checked) }),
                  t('memory.prefetch')),
                h('label', null,
                  h('input', { type: 'checkbox', checked: syncEnabled, onChange: e => setSyncEnabled(e.target.checked) }),
                  t('memory.sync')),
                h('label', null,
                  h('input', { type: 'checkbox', checked: syncGroupRooms, onChange: e => setSyncGroupRooms(e.target.checked) }),
                  t('memory.syncRooms'))),
              h('div', { className: 'bm-form-actions' },
                h('button', {
                  type: 'button', className: 'bm-btn primary small', disabled: busy,
                  onClick: () => runAction(() => props.onCommand('memory.configure', {
                    teamId: teamId.trim(),
                    userId: userId.trim(),
                    prefetchEnabled,
                    syncEnabled,
                    syncGroupRooms,
                  }), t('memory.saved')),
                }, t('memory.saveSettings')))),

            h('section', { className: 'bm-block' },
              h('h3', null, t('memory.providers')),
              h('div', { className: 'bm-mem-grid' }, (memory.providers || []).map(provider => {
                const isExpanded = expandedId === provider.id
                const draft = cfgDrafts[provider.id] || provider.config || {}
                return h('div', { key: provider.id, className: 'bm-mem-card', 'data-active': provider.active === true },
                  h('div', { className: 'bm-mem-card-top' },
                    h('strong', { className: 'bm-name' }, provider.displayName),
                    h('span', { className: 'bm-mem-badge' }, provider.bundled ? t('memory.bundled') : t('memory.downloaded')),
                    h('span', { className: 'bm-mem-badge' }, `v${provider.version}`),
                    provider.active
                      ? h('span', { className: 'bm-mem-badge', 'data-state': 'ok' }, t('memory.inUse'))
                      : null,
                    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
                      (provider.configSchema || []).length > 0
                        ? h('button', { type: 'button', className: 'bm-btn small', onClick: () => openConfig(provider) },
                          isExpanded ? t('memory.hideConfig') : t('memory.config'))
                        : null,
                      !provider.active
                        ? h('button', {
                          type: 'button', className: 'bm-btn small primary', disabled: busy,
                          onClick: () => runAction(() => props.onCommand('memory.select', { providerId: provider.id }), ''),
                        }, t('memory.use'))
                        : null,
                      !provider.bundled
                        ? h('button', {
                          type: 'button', className: 'bm-btn small danger', disabled: busy,
                          onClick: () => runAction(() => props.onCommand('memory.uninstall', { providerId: provider.id }), ''),
                        }, t('memory.uninstall'))
                        : null)),
                  provider.description ? h('p', { className: 'bm-muted', style: { margin: 0 } }, provider.description) : null,
                  isExpanded
                    ? h('div', { className: 'bm-mem-cfg' },
                      (provider.configSchema || []).map(field => {
                        const val = draft[field.key] ?? field.default ?? ''
                        if (field.type === 'boolean') {
                          return h('label', { key: field.key, style: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px' } },
                            h('input', {
                              type: 'checkbox', checked: Boolean(val),
                              onChange: e => updateDraftField(provider.id, field.key, e.target.checked),
                            }),
                            field.label || field.key)
                        }
                        return h('label', { key: field.key, className: 'bm-label' },
                          field.label || field.key,
                          h('input', {
                            className: 'bm-input',
                            type: field.secret ? 'password' : (field.type === 'integer' || field.type === 'number' ? 'number' : 'text'),
                            value: String(val),
                            placeholder: field.description || '',
                            onChange: e => updateDraftField(provider.id, field.key, e.target.value),
                          }))
                      }),
                      h('div', { className: 'bm-form-actions' },
                        h('button', {
                          type: 'button', className: 'bm-btn small primary', disabled: busy,
                          onClick: () => saveProviderConfig(provider),
                        }, t('memory.saveConfig'))))
                    : null)
              }))),

            h('section', { className: 'bm-form' },
              h('h2', null, t('memory.installTitle')),
              h('p', { className: 'bm-form-hint' }, t('memory.installHint')),
              h('div', { className: 'bm-compose-row' },
                h('input', {
                  className: 'bm-input', value: installSource, placeholder: t('memory.installPlaceholder'),
                  onChange: e => setInstallSource(e.target.value),
                }),
                h('button', {
                  type: 'button', className: 'bm-btn primary', disabled: busy || installSource.trim() === '',
                  onClick: async () => {
                    const ok = await runAction(() => props.onCommand('memory.install', {
                      source: installSource.trim(),
                      activate: true,
                      overwrite: true,
                    }), t('memory.saved'))
                    if (ok) setInstallSource('')
                  },
                }, t('memory.installBtn'))),
              (memory.catalog || []).length > 0
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' } },
                  h('div', { className: 'bm-muted' }, t('memory.catalogTitle')),
                  (memory.catalog || []).map(item => h('div', { key: item.id, className: 'bm-mem-card' },
                    h('div', { className: 'bm-mem-card-top' },
                      h('strong', { className: 'bm-name' }, item.displayName),
                      h('span', { className: 'bm-mem-badge' }, `v${item.version}`),
                      h('button', {
                        type: 'button', className: 'bm-btn small', style: { marginLeft: 'auto' },
                        disabled: busy || item.installed,
                        onClick: () => runAction(() => props.onCommand('memory.install', {
                          source: item.installSource,
                          activate: true,
                          overwrite: true,
                        }), t('memory.saved')),
                      }, item.installed ? t('memory.installed') : t('memory.catalogInstall'))),
                    h('p', { className: 'bm-muted', style: { margin: 0 } }, item.description))))
                : null),

            props.bots.length > 0
              ? h('form', { className: 'bm-form', onSubmit: doSearch },
                h('h2', null, t('memory.searchTitle')),
                h('div', { className: 'bm-row' },
                  h('select', {
                    className: 'bm-input', value: searchBotId || props.bots[0].id,
                    onChange: e => setSearchBotId(e.target.value),
                  }, props.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
                  h('div', { className: 'bm-compose-row' },
                    h('input', {
                      className: 'bm-input', value: searchQuery, placeholder: t('memory.searchPlaceholder'),
                      onChange: e => setSearchQuery(e.target.value),
                    }),
                    h('button', { type: 'submit', className: 'bm-btn primary', disabled: busy || searchQuery.trim() === '' }, t('memory.searchBtn')))),
                searchOut !== '' ? h('div', { className: 'bm-mem-results' }, searchOut) : null)
              : null)
        }

        function SettingsIcon(props) {
          const kind = props.kind || 'gear'
          const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
          if (kind === 'model') {
            return h('svg', common, h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }), h('path', { d: 'M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4' }))
          }
          if (kind === 'skills') {
            return h('svg', common, h('path', { d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z' }), h('path', { d: 'M12 12l8-4.5M12 12v9M12 12L4 7.5' }))
          }
          if (kind === 'tools') {
            return h('svg', common, h('path', { d: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.2 2.2-2.2-2.2 1.4-3z' }))
          }
          if (kind === 'workspace') {
            return h('svg', common, h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z' }))
          }
          if (kind === 'routines') {
            return h('svg', common, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 7v5l3 2' }))
          }
          if (kind === 'artifacts') {
            return h('svg', common, h('rect', { x: 3, y: 4, width: 18, height: 4, rx: 1 }), h('path', { d: 'M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4' }))
          }
          if (kind === 'rooms') {
            return h('svg', common, h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }), h('path', { d: 'M9 4v16M15 4v16' }))
          }
          if (kind === 'soul') {
            return h('svg', common, h('path', { d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z' }))
          }
          if (kind === 'memory') {
            return h('svg', common, h('path', { d: 'M9 4a5 5 0 0 0-4 8 4 4 0 0 0 2 7h3V4H9zM15 4a5 5 0 0 1 4 8 4 4 0 0 1-2 7h-3V4h1z' }))
          }
          if (kind === 'format') {
            return h('svg', common, h('path', { d: 'M4 6h16M4 12h10M4 18h14' }))
          }
          if (kind === 'usage') {
            return h('svg', common, h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }), h('path', { d: 'M8 16v-5M12 16V8M16 16v-3' }))
          }
          if (kind === 'approval') {
            return h('svg', common, h('path', { d: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z' }), h('path', { d: 'M9.5 12l2 2 3.5-4' }))
          }
          if (kind === 'integrations') {
            return h('svg', common, h('path', { d: 'M12 2v5M7 7h10v4a5 5 0 0 1-10 0V7zM12 16v6' }))
          }
          if (kind === 'logs') {
            return h('svg', common, h('path', { d: 'M6 3h9l4 4v14H6z' }), h('path', { d: 'M9 11h6M9 15h6' }))
          }
          if (kind === 'system') {
            return h('svg', common,
              h('rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }),
              h('path', { d: 'M7 20h10M12 16v4M7 10h2l1.5-3 2.5 6 1.5-3H17' }))
          }
          return h('svg', common,
            h('circle', { cx: 12, cy: 12, r: 3 }),
            h('path', { d: 'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 .9-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5.9H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z' }))
        }

        const FORMAT_PREVIEW_SAMPLE = [
          '> [!TIP] 现代 Agent 富媒体回复规范已生效，支持表格、提示框、Diff、折叠面板、图表与结构化卡片。',
          '',
          '| 模块 | 状态 | 说明 |',
          '| --- | --- | --- |',
          '| 扩展 Markdown | 已启用 | 表格 / Callouts / Diff / 折叠面板 |',
          '| 结构化卡片 | 已启用 | Metrics / Card / File / Artifact |',
          '',
          '```metrics',
          '{"title":"实时指标示例","items":[{"label":"吞吐","value":"128 req/s","delta":"+12%","tone":"ok"},{"label":"P95 延迟","value":"42ms","delta":"-8ms","tone":"ok"},{"label":"错误率","value":"0.02%","delta":"稳定","tone":"neutral"}]}',
          '```',
          '',
          '```diff',
          '- maxRounds = 16',
          '+ terminalState = "room_finish_task"',
          '```',
          '',
          '```mermaid',
          'flowchart LR',
          '  A[用户指令] --> B[多 Bot 并行处理]',
          '  B --> C[room_finish_task 验收完成]',
          '```',
          '',
          '<details><summary>展开查看折叠详情</summary>冗长的诊断日志或背景信息可收纳在折叠面板里，不干扰主回复阅读。</details>',
          '',
          '<artifact type="html" title="独立 HTML 预览卡"><div style="font-family:sans-serif;padding:12px;color:#0f172a"><strong>Artifact 预览</strong><p style="margin:4px 0 0;color:#475569">复杂代码、报告或 HTML 片段自动分流到独立卡片中。</p></div></artifact>',
        ].join('\n')

        function SystemMonitorPanel(props) {
          const t = useT()
          const initialCfg = (props.settings && props.settings.system) || {}
          const initialInfo = props.initialSystem || (props.screenGateway && props.screenGateway.host) || null
          const [info, setInfo] = useState(initialInfo)
          const [endpoints, setEndpoints] = useState(null)
          const [live, setLive] = useState(true)
          const [busy, setBusy] = useState(false)
          const [notice, setNotice] = useState('')
          const [error, setError] = useState('')

          const [gatewayUrl, setGatewayUrl] = useState(initialCfg.gatewayUrl || '')
          const [adminToken, setAdminToken] = useState(initialCfg.adminToken || '')
          const [diskPaths, setDiskPaths] = useState(Array.isArray(initialCfg.diskPaths) ? initialCfg.diskPaths.join(', ') : '/')
          const [refreshIntervalSec, setRefreshIntervalSec] = useState(String(initialCfg.refreshIntervalSec ?? 5))
          const [frameRate, setFrameRate] = useState(String([30, 15, 10].includes(Number(initialCfg.frameRate)) ? Number(initialCfg.frameRate) : 15))
          const [pushUrl, setPushUrl] = useState(initialCfg.pushUrl || '')
          const [pushIntervalSec, setPushIntervalSec] = useState(String(initialCfg.pushIntervalSec ?? 0))
          const [pushToken, setPushToken] = useState(initialCfg.pushToken || '')

          const fetchNow = async () => {
            setError('')
            try {
              const res = await props.onCommand('system.info', {})
              if (res && res.system) setInfo(res.system)
              if (res && res.config && res.config.endpoints) setEndpoints(res.config.endpoints)
            } catch (err) {
              setError(err && err.message ? err.message : String(err))
            }
          }

          useEffect(() => {
            void fetchNow()
            void props.onCommand('system.config.get', {})
              .then((res) => {
                const cfg = res && res.config
                if (cfg) {
                  setGatewayUrl(cfg.gatewayUrl || '')
                  setAdminToken(cfg.adminToken || '')
                  setDiskPaths(Array.isArray(cfg.diskPaths) ? cfg.diskPaths.join(', ') : '/')
                  setRefreshIntervalSec(String(cfg.refreshIntervalSec ?? 5))
                  setFrameRate(String([30, 15, 10].includes(Number(cfg.frameRate)) ? Number(cfg.frameRate) : 15))
                  setPushUrl(cfg.pushUrl || '')
                  setPushIntervalSec(String(cfg.pushIntervalSec ?? 0))
                  setPushToken(cfg.pushToken || '')
                  if (cfg.endpoints) setEndpoints(cfg.endpoints)
                }
              })
              .catch(() => {})
          }, [])

          useEffect(() => {
            if (!live) return undefined
            const sec = Math.max(1, Math.min(60, Number(refreshIntervalSec) || 5))
            let cancelled = false
            let es = null
            let pollTimer = null
            let watchdog = null
            let receivedAny = false

            const startPolling = () => {
              if (cancelled || pollTimer) return
              if (es) {
                try { es.close() } catch (_e) { /* ignore */ }
                es = null
              }
              if (watchdog) {
                window.clearTimeout(watchdog)
                watchdog = null
              }
              void fetchNow()
              pollTimer = window.setInterval(() => { void fetchNow() }, sec * 1000)
            }

            if (typeof window.EventSource === 'function') {
              es = new window.EventSource(`/botmode/api/system/stream?interval=${encodeURIComponent(String(sec))}`, { withCredentials: true })
              watchdog = window.setTimeout(() => {
                if (!cancelled && !receivedAny) startPolling()
              }, Math.max(4000, sec * 1000 + 2500))
              es.onmessage = (ev) => {
                if (cancelled || !ev.data) return
                try {
                  const pkt = JSON.parse(ev.data)
                  if (pkt && (pkt.cpu || pkt.memory || pkt.disk || pkt.uptime)) {
                    receivedAny = true
                    if (watchdog) {
                      window.clearTimeout(watchdog)
                      watchdog = null
                    }
                    setInfo(prev => ({ ...(prev || {}), ...pkt, available: true }))
                  }
                } catch (_e) { /* ignore */ }
              }
              es.onerror = () => {
                if (!cancelled) startPolling()
              }
            } else {
              startPolling()
            }

            return () => {
              cancelled = true
              if (es) {
                try { es.close() } catch (_e) { /* ignore */ }
                es = null
              }
              if (watchdog) {
                window.clearTimeout(watchdog)
                watchdog = null
              }
              if (pollTimer) {
                window.clearInterval(pollTimer)
                pollTimer = null
              }
            }
          }, [live, refreshIntervalSec])

          const saveConfig = async () => {
            setBusy(true)
            setError('')
            setNotice('')
            try {
              const res = await props.onCommand('system.config.save', {
                config: {
                  gatewayUrl: gatewayUrl.trim(),
                  adminToken: adminToken.trim(),
                  diskPaths: diskPaths.split(/[,\n]/).map(s => s.trim()).filter(Boolean),
                  refreshIntervalSec: Number(refreshIntervalSec) || 5,
                  frameRate: Number(frameRate) || 15,
                  pushUrl: pushUrl.trim(),
                  pushIntervalSec: Number(pushIntervalSec) || 0,
                  pushToken: pushToken.trim(),
                },
              })
              if (res && res.config && res.config.endpoints) setEndpoints(res.config.endpoints)
              setNotice(res && res.gatewaySynced
                ? t('settings.saved')
                : `${t('settings.saved')}${res && res.gatewayError ? ` (${res.gatewayError})` : ''}`)
              await fetchNow()
            } catch (err) {
              setError(err && err.message ? err.message : String(err))
            } finally {
              setBusy(false)
            }
          }

          const triggerPush = async () => {
            setBusy(true)
            setError('')
            setNotice('')
            try {
              const res = await props.onCommand('system.push', {
                url: pushUrl.trim() || undefined,
                token: pushToken.trim() || undefined,
              })
              if (res && res.ok) {
                setNotice(`${t('system.pushOk')} (HTTP ${res.status_code}, ${res.latency_ms}ms)`)
              } else {
                setError((res && res.error) || 'Push failed')
              }
            } catch (err) {
              setError(err && err.message ? err.message : String(err))
            } finally {
              setBusy(false)
            }
          }

          const cpu = info && info.cpu
          const mem = info && info.memory
          const disk = info && info.disk
          const up = info && info.uptime
          const fallbackMemTotal = mem && mem.total_mb != null ? mem.total_mb : (info && info.limit_mb != null ? info.limit_mb : null)
          const fallbackMemAvail = mem && mem.available_mb != null ? mem.available_mb : (info && info.available_mb != null ? info.available_mb : null)
          const fallbackMemUsed = mem && mem.used_mb != null
            ? mem.used_mb
            : (fallbackMemTotal != null && fallbackMemAvail != null ? Math.max(0, fallbackMemTotal - fallbackMemAvail) : null)
          const memPct = mem && mem.usage_percent != null
            ? mem.usage_percent
            : (fallbackMemTotal != null && fallbackMemTotal > 0 && fallbackMemUsed != null
              ? Math.round((fallbackMemUsed / fallbackMemTotal) * 1000) / 10
              : null)
          const gwOnline = Boolean(info && info.available !== false && info.gatewayAvailable !== false && (cpu || mem || disk || up || fallbackMemAvail != null))
          const isFallback = Boolean(info && (info.degraded || info.source === 'host-fallback'))
          const cgroupDisabled = info && info.cgroup === false

          const metricBar = (pct) => {
            const num = Number(pct)
            if (!Number.isFinite(num)) return null
            const clamped = Math.max(0, Math.min(100, num))
            return h('div', { className: 'bm-sys-bar' },
              h('div', {
                className: 'bm-sys-bar-fill',
                'data-warn': clamped >= 75 && clamped < 90,
                'data-crit': clamped >= 90,
                style: { width: `${clamped}%` },
              }))
          }

          return h('div', { className: 'bm-set-panel' },
            error ? h('div', { className: 'bm-error' }, error) : null,
            notice ? h('div', { className: 'bm-ok' }, notice) : null,
            h('section', { className: 'bm-form' },
              h('div', { className: 'bm-block-head' },
                h('h2', null, t('system.title')),
                h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { className: 'bm-act-chip' }, `${t('system.gatewayStatus')}: ${gwOnline ? t('system.online') : (isFallback ? t('system.fallbackMode') : t('system.offline'))}`),
                  cgroupDisabled ? h('span', { className: 'bm-act-chip' }, t('system.cgroupOff')) : null,
                  h('button', {
                    type: 'button', className: 'bm-btn small',
                    onClick: () => setLive(v => !v),
                  }, live ? t('system.liveOn') : t('system.liveOff')),
                  h('button', {
                    type: 'button', className: 'bm-btn small',
                    onClick: () => { void fetchNow() },
                  }, t('system.refresh')))),
              h('p', { className: 'bm-form-hint' }, t('system.hint')),
              info && (info.hostname || info.platform || info.gatewayError)
                ? h('div', { className: 'bm-host-mini-meta', style: { marginBottom: '2px' } },
                  info.hostname ? h('span', { className: 'bm-act-chip' }, `${t('system.hostname')}: ${info.hostname}`) : null,
                  info.os && info.arch ? h('span', { className: 'bm-act-chip' }, `${info.os} ${info.arch}${info.kernel ? ` (${info.kernel})` : ''}`) : (info.platform ? h('span', { className: 'bm-act-chip' }, info.platform) : null),
                  info.gatewayError ? h('span', { className: 'bm-act-chip', style: { color: '#f59e0b' } }, info.gatewayError) : null)
                : null,
              h('div', { className: 'bm-sys-grid' },
                h('div', { className: 'bm-sys-card' },
                  h('span', { className: 'bm-sys-card-label' }, t('system.cpu')),
                  h('strong', { className: 'bm-sys-card-val' }, cpu && cpu.usage_percent != null ? `${cpu.usage_percent}%` : '—'),
                  metricBar(cpu && cpu.usage_percent),
                  h('span', { className: 'bm-sys-card-sub' }, cpu
                    ? `${t('system.cores')}: ${cpu.cores}${cpu.load_avg ? ` · ${t('system.load')}: ${cpu.load_avg['1m']} / ${cpu.load_avg['5m']} / ${cpu.load_avg['15m']}` : ''}`
                    : '—')),
                h('div', { className: 'bm-sys-card' },
                  h('span', { className: 'bm-sys-card-label' }, t('system.memory')),
                  h('strong', { className: 'bm-sys-card-val' }, memPct != null ? `${memPct}%` : '—'),
                  metricBar(memPct),
                  h('span', { className: 'bm-sys-card-sub' }, fallbackMemTotal != null
                    ? `${fallbackMemUsed ?? '—'} / ${fallbackMemTotal} MB (${t('system.available')} ${fallbackMemAvail ?? '—'} MB)`
                    : (fallbackMemAvail != null ? `${t('system.available')} ${fallbackMemAvail} MB` : '—'))),
                h('div', { className: 'bm-sys-card' },
                  h('span', { className: 'bm-sys-card-label' }, `${t('system.disk')}${disk && disk.path ? ` (${disk.path})` : ''}`),
                  h('strong', { className: 'bm-sys-card-val' }, disk && disk.usage_percent != null ? `${disk.usage_percent}%` : '—'),
                  metricBar(disk && disk.usage_percent),
                  h('span', { className: 'bm-sys-card-sub' }, disk && disk.total_gb != null
                    ? `${disk.used_gb} / ${disk.total_gb} GB (${t('system.free')} ${disk.free_gb} GB)`
                    : '—')),
                h('div', { className: 'bm-sys-card' },
                  h('span', { className: 'bm-sys-card-label' }, t('system.uptime')),
                  h('strong', { className: 'bm-sys-card-val', style: { fontSize: '16px' } }, up && up.formatted ? up.formatted : '—'),
                  h('span', { className: 'bm-sys-card-sub' }, up && up.boot_time
                    ? `${t('system.bootTime')}: ${up.boot_time.replace('T', ' ').slice(0, 19)} UTC`
                    : (info && info.hostname ? info.hostname : '—')))),
              disk && Array.isArray(disk.mounts) && disk.mounts.length > 1
                ? h('div', { className: 'bm-table-wrap', style: { margin: '8px 0 0' } },
                  h('table', { className: 'bm-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, t('system.mountsTitle')),
                      h('th', null, 'Used / Total'),
                      h('th', null, 'Free'),
                      h('th', null, '%'))),
                    h('tbody', null, disk.mounts.map(m => h('tr', { key: m.path },
                      h('td', null, m.path),
                      h('td', null, m.ok ? `${m.used_gb} / ${m.total_gb} GB` : (m.error || 'N/A')),
                      h('td', null, m.ok ? `${m.free_gb} GB` : '—'),
                      h('td', null, m.ok ? `${m.usage_percent}%` : '—'))))))
                : null),
            h('section', { className: 'bm-form' },
              h('h2', null, t('system.configTitle')),
              h('div', { className: 'bm-row' },
                h('label', { className: 'bm-label' }, t('system.gatewayUrl'),
                  h('input', {
                    className: 'bm-input', value: gatewayUrl,
                    placeholder: t('system.gatewayUrlPlaceholder'),
                    onChange: e => setGatewayUrl(e.target.value),
                  })),
                h('label', { className: 'bm-label' }, t('system.adminToken'),
                  h('input', {
                    className: 'bm-input', type: 'password', value: adminToken,
                    placeholder: t('system.adminTokenPlaceholder'),
                    onChange: e => setAdminToken(e.target.value),
                  }))),
              h('div', { className: 'bm-row' },
                h('label', { className: 'bm-label' }, t('system.diskPaths'),
                  h('input', {
                    className: 'bm-input', value: diskPaths,
                    placeholder: t('system.diskPathsPlaceholder'),
                    onChange: e => setDiskPaths(e.target.value),
                  })),
                h('label', { className: 'bm-label' }, t('system.refreshInterval'),
                  h('input', {
                    className: 'bm-input', type: 'number', min: 1, max: 60, value: refreshIntervalSec,
                    onChange: e => setRefreshIntervalSec(e.target.value),
                  })),
                h('label', { className: 'bm-label' }, t('system.frameRate'),
                  h('select', {
                    className: 'bm-input', value: frameRate,
                    onChange: e => setFrameRate(e.target.value),
                  }, [30, 15, 10].map(fps => h('option', { key: fps, value: String(fps) }, `${fps} fps`))),
                  h('span', { className: 'bm-form-hint', style: { display: 'block', marginTop: '2px' } }, t('system.frameRateHint')))),
              h('div', { className: 'bm-row' },
                h('label', { className: 'bm-label' }, t('system.pushUrl'),
                  h('input', {
                    className: 'bm-input', value: pushUrl,
                    placeholder: t('system.pushUrlPlaceholder'),
                    onChange: e => setPushUrl(e.target.value),
                  })),
                h('label', { className: 'bm-label' }, t('system.pushInterval'),
                  h('input', {
                    className: 'bm-input', type: 'number', min: 0, max: 86400, value: pushIntervalSec,
                    onChange: e => setPushIntervalSec(e.target.value),
                  }))),
              h('label', { className: 'bm-label' }, t('system.pushToken'),
                h('input', {
                  className: 'bm-input', type: 'password', value: pushToken,
                  onChange: e => setPushToken(e.target.value),
                })),
              h('div', { className: 'bm-form-actions' },
                h('button', {
                  type: 'button', className: 'bm-btn primary', disabled: busy,
                  onClick: () => { void saveConfig() },
                }, t('system.saveConfig')),
                h('button', {
                  type: 'button', className: 'bm-btn', disabled: busy || !pushUrl.trim(),
                  onClick: () => { void triggerPush() },
                }, t('system.testPush')))),
            endpoints
              ? h('section', { className: 'bm-form' },
                h('h2', null, t('system.endpointsTitle')),
                h('div', { className: 'bm-table-wrap', style: { margin: 0 } },
                  h('table', { className: 'bm-table' },
                    h('tbody', null,
                      h('tr', null, h('th', null, 'Plugin Info (GET)'), h('td', null, h('code', null, endpoints.hostInfo))),
                      endpoints.hostAlias ? h('tr', null, h('th', null, 'Plugin Host Alias (GET)'), h('td', null, h('code', null, endpoints.hostAlias))) : null,
                      h('tr', null, h('th', null, 'Plugin Config (GET/PUT)'), h('td', null, h('code', null, endpoints.hostConfig))),
                      h('tr', null, h('th', null, 'Plugin SSE Stream (GET)'), h('td', null, h('code', null, endpoints.hostStream))),
                      h('tr', null, h('th', null, 'Plugin Push (POST)'), h('td', null, h('code', null, endpoints.hostPush))),
                      h('tr', null, h('th', null, 'Gateway Info (GET)'), h('td', null, h('code', null, endpoints.gatewayInfo))),
                      endpoints.gatewayAlias ? h('tr', null, h('th', null, 'Gateway Host Alias (GET)'), h('td', null, h('code', null, endpoints.gatewayAlias))) : null,
                      h('tr', null, h('th', null, 'Gateway Config (GET/PUT)'), h('td', null, h('code', null, endpoints.gatewayConfig))),
                      h('tr', null, h('th', null, 'Gateway Stream (GET)'), h('td', null, h('code', null, endpoints.gatewayStream)))))))
              : null)
        }

        function SettingsView(props) {
          const t = useT()
          const bots = props.bots || []
          const rooms = props.rooms || []
          const routines = props.routines || []
          const sections = props.sections || []
          const allTools = props.tools || []
          const artifacts = props.artifacts || []
          const mcpInfo = props.mcp || { configPath: '', servers: [], botServers: [], normalServers: [] }
          const webhooksList = props.webhooks || []
          const notificationLogs = props.notificationLogs || []
          const usage = props.usage || { totalTokens: 0, totalRoomMessages: 0, byRoom: [] }
          const runtimeInfo = props.runtime || {}
          const appSettings = props.settings || {
            responseFormat: { enabled: true, extendedMarkdown: true, diagramsAndMath: true, artifacts: true, structuredCards: true, multimodal: true },
            groupChat: { defaultTokenLimit: 0, defaultIdleRoundLimit: 5, enableSoftLock: true, enableErrorProbe: true, autoProgressReview: true, showActivityStrip: false },
            governance: { requireApprovalForBotCrud: true, defaultDailyTokenLimit: 0, protectExternalWrites: false },
            notifications: { enabled: false, desktopNotifications: true, webhookUrl: '', format: 'generic', secret: '', onApproval: true, onScreenHelp: true, onRoomComplete: true, onBudgetExceeded: true, onRoutineError: true },
          }

          const [botId, setBotId] = useState(props.initialBotId || (bots[0] && bots[0].id) || '')
          const [moduleKey, setModuleKey] = useState(props.initialModule || 'soul')
          const [advOpen, setAdvOpen] = useState(true)
          const [busy, setBusy] = useState(false)
          const [notice, setNotice] = useState('')
          const [error, setError] = useState('')

          const bot = bots.find(item => item.id === botId) || bots[0] || null

          // Bot-level editable state
          const [botName, setBotName] = useState(bot ? bot.name : '')
          const [botRole, setBotRole] = useState(bot ? (bot.role || '') : '')
          const [botInstructions, setBotInstructions] = useState(bot ? (bot.instructions || '') : '')
          const [botColor, setBotColor] = useState(bot ? (bot.color || COLORS[0]) : COLORS[0])
          const [botAvatar, setBotAvatar] = useState(bot && bot.avatar ? { ...bot.avatar } : defaultClientAvatar(bot ? bot.color : COLORS[0]))
          const [botSectionId, setBotSectionId] = useState(bot ? (bot.sectionId || 'general') : 'general')
          const [botApproval, setBotApproval] = useState(bot ? (bot.approvalPolicy || 'ask') : 'ask')
          const [botPermRole, setBotPermRole] = useState(bot ? (bot.permissionRole || 'worker') : 'worker')
          const [botDailyLimit, setBotDailyLimit] = useState(bot ? (Number(bot.dailyTokenLimit) || 0) : 0)
          const [botToolsAllow, setBotToolsAllow] = useState(bot && bot.tools ? (bot.tools.allow || []).join(', ') : '')
          const [botToolsDeny, setBotToolsDeny] = useState(bot && bot.tools ? (bot.tools.deny || []).join(', ') : '')
          const [botModel, setBotModel] = useState(bot && bot.model ? { ...bot.model } : { ...EMPTY_MODEL })
          const [soulMd, setSoulMd] = useState('')
          const [memoryMd, setMemoryMd] = useState('')
          const [logs, setLogs] = useState([])

          // Modular Global Settings state
          const [rf, setRf] = useState(appSettings.responseFormat)
          const [gc, setGc] = useState(appSettings.groupChat)
          const [gov, setGov] = useState(appSettings.governance || { requireApprovalForBotCrud: true, defaultDailyTokenLimit: 0, protectExternalWrites: false })
          const [notif, setNotif] = useState(appSettings.notifications || { enabled: false, desktopNotifications: true, webhookUrl: '', format: 'generic', secret: '', onApproval: true, onScreenHelp: true, onRoomComplete: true, onBudgetExceeded: true, onRoutineError: true })

          // MCP form state
          const [mcpForm, setMcpForm] = useState({ name: '', transport: 'stdio', command: '', argsText: '', url: '', envText: '', disabled: false })
          const [mcpProbe, setMcpProbe] = useState('')

          // Custom Skill editor state
          const [skillForm, setSkillForm] = useState({
            name: '',
            scope: 'shared',
            content: '---\nname: my-custom-skill\ndescription: Concise summary of when and how to use this skill.\n---\n\n# My Custom Skill\n\n1. Step one...\n',
          })

          // Inbound Webhook form state
          const [hookForm, setHookForm] = useState({
            name: '',
            targetKind: 'bot',
            targetId: (bots[0] && bots[0].id) || '',
            promptTemplate: '[Webhook {{name}} · {{event}}]\n{{payload}}',
          })

          useEffect(() => {
            if (!bot) return
            setBotName(bot.name || '')
            setBotRole(bot.role || '')
            setBotInstructions(bot.instructions || '')
            setBotColor(bot.color || COLORS[0])
            setBotAvatar(bot.avatar ? { ...bot.avatar } : defaultClientAvatar(bot.color || COLORS[0]))
            setBotSectionId(bot.sectionId || 'general')
            setBotApproval(bot.approvalPolicy || 'ask')
            setBotPermRole(bot.permissionRole || 'worker')
            setBotDailyLimit(Number(bot.dailyTokenLimit) || 0)
            setBotToolsAllow((bot.tools && bot.tools.allow ? bot.tools.allow : []).join(', '))
            setBotToolsDeny((bot.tools && bot.tools.deny ? bot.tools.deny : []).join(', '))
            setBotModel(bot.model ? { ...bot.model } : { ...EMPTY_MODEL })
            void props.onCommand('bot.files.read', { botId: bot.id })
              .then((res) => {
                if (res) {
                  setSoulMd(res.soul || '')
                  setMemoryMd(res.memoryMd || '')
                }
              })
              .catch(() => {})
          }, [bot && bot.id])

          useEffect(() => {
            setRf(appSettings.responseFormat)
            setGc(appSettings.groupChat)
            if (appSettings.governance) setGov(appSettings.governance)
            if (appSettings.notifications) setNotif(appSettings.notifications)
          }, [appSettings])

          const loadLogs = async () => {
            try {
              const res = await props.onCommand('logs.read', { limit: 80 })
              setLogs((res && res.entries) || [])
            } catch (_err) { /* ignore */ }
          }

          useEffect(() => {
            if (moduleKey === 'logs') void loadLogs()
          }, [moduleKey])

          const runSave = async (fn) => {
            setBusy(true)
            setError('')
            setNotice('')
            try {
              await fn()
              setNotice(t('settings.saved'))
              window.setTimeout(() => setNotice(''), 2000)
            } catch (failure) {
              setError(failure && failure.message ? failure.message : String(failure))
            } finally {
              setBusy(false)
            }
          }

          const saveBotPatch = async (extraDraft = {}, filesPatch = null) => {
            if (!bot) return
            const splitList = (raw) => String(raw || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean)
            await props.onCommand('bot.save', {
              botId: bot.id,
              draft: {
                name: botName.trim() || bot.name,
                role: botRole.trim(),
                instructions: botInstructions,
                color: (botAvatar && botAvatar.color) || botColor,
                avatar: botAvatar,
                sectionId: botSectionId,
                approvalPolicy: botApproval,
                permissionRole: botPermRole,
                dailyTokenLimit: Number(botDailyLimit) || 0,
                model: botModel,
                tools: { allow: splitList(botToolsAllow), deny: splitList(botToolsDeny) },
                ...extraDraft,
              },
            })
            if (filesPatch) {
              await props.onCommand('bot.files.save', { botId: bot.id, ...filesPatch })
            }
          }

          const catalog = props.models && props.models.catalog
          const activeModelLabel = bot
            ? (modelLabelOf(catalog, effectiveModelOf(catalog, bot.model))
              || (bot.model && bot.model.model)
              || t('model.default'))
            : '—'
          const botRoutines = bot ? routines.filter(r => r.botId === bot.id) : []
          const toolCountLabel = bot && bot.tools && bot.tools.allow && bot.tools.allow.length > 0
            ? String(bot.tools.allow.length)
            : (allTools.length > 0 ? String(allTools.length) : t('settings.allTools'))
          const memLabel = props.memory ? props.memory.provider : 'memory_tencentdb'

          const navRow = (key, icon, label, valueText) => h('button', {
            key,
            type: 'button',
            className: 'bm-set-row',
            'data-active': moduleKey === key,
            onClick: () => { setModuleKey(key); setError(''); setNotice('') },
          },
            h('span', { className: 'bm-set-icon' }, h(SettingsIcon, { kind: icon })),
            h('span', { className: 'bm-set-row-label' }, label),
            valueText !== undefined && valueText !== '' ? h('span', { className: 'bm-set-row-val' }, valueText) : null,
            h('span', { className: 'bm-set-chev' }, '›'))

          const providers = (catalog && catalog.groups) || []
          const selectedProvider = providers.find(g => g.id === botModel.provider)
          const selectedModelEntry = modelEntryOf(catalog, botModel)

          const renderModuleBody = () => {
            if (moduleKey === 'memory') {
              return h('div', { className: 'bm-set-panel' },
                h(MemoryHubPanel, { memory: props.memory, bots, onCommand: props.onCommand }),
                bot
                  ? h('section', { className: 'bm-form' },
                    h('h2', null, `${bot.name} · ${t('settings.memoryMdTitle')}`),
                    h('textarea', {
                      className: 'bm-area', rows: 8, value: memoryMd,
                      onChange: e => setMemoryMd(e.target.value),
                    }),
                    h('div', { className: 'bm-form-actions' },
                      h('button', {
                        type: 'button', className: 'bm-btn primary', disabled: busy,
                        onClick: () => runSave(() => props.onCommand('bot.files.save', { botId: bot.id, memoryMd })),
                      }, t('settings.save'))))
                  : null)
            }

            if (moduleKey === 'format') {
              const toggleRf = (key) => {
                const next = { ...rf, [key]: !rf[key] }
                setRf(next)
                void runSave(() => props.onCommand('settings.save', { responseFormat: next }))
              }
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, t('settings.format')),
                  h('p', { className: 'bm-form-hint' }, t('settings.formatDesc')),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.fmtEnable')),
                    h('input', { type: 'checkbox', checked: rf.enabled !== false, onChange: () => toggleRf('enabled') })),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.fmtExtMd')),
                    h('input', { type: 'checkbox', checked: rf.extendedMarkdown !== false, onChange: () => toggleRf('extendedMarkdown') })),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.fmtDiagrams')),
                    h('input', { type: 'checkbox', checked: rf.diagramsAndMath !== false, onChange: () => toggleRf('diagramsAndMath') })),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.fmtArtifacts')),
                    h('input', { type: 'checkbox', checked: rf.artifacts !== false, onChange: () => toggleRf('artifacts') })),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.fmtCards')),
                    h('input', { type: 'checkbox', checked: rf.structuredCards !== false, onChange: () => toggleRf('structuredCards') })),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.fmtMultimodal')),
                    h('input', { type: 'checkbox', checked: rf.multimodal !== false, onChange: () => toggleRf('multimodal') }))),
                h('section', { className: 'bm-form' },
                  h('h2', null, t('settings.fmtPreview')),
                  h(MarkdownText, { text: FORMAT_PREVIEW_SAMPLE, formatOptions: rf })))
            }

            if (moduleKey === 'rooms') {
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, t('settings.rooms')),
                  h('div', { className: 'bm-row' },
                    h('label', { className: 'bm-label' }, t('settings.gcTokenLimit'),
                      h('input', {
                        type: 'number', min: 0, step: 50000, className: 'bm-input',
                        value: gc.defaultTokenLimit ?? 0,
                        onChange: e => setGc({ ...gc, defaultTokenLimit: Number(e.target.value) || 0 }),
                      })),
                    h('label', { className: 'bm-label' }, t('settings.gcIdleLimit'),
                      h('input', {
                        type: 'number', min: 1, max: 100, className: 'bm-input',
                        value: gc.defaultIdleRoundLimit ?? 5,
                        onChange: e => setGc({ ...gc, defaultIdleRoundLimit: Number(e.target.value) || 5 }),
                      }))),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.gcSoftLock')),
                    h('input', { type: 'checkbox', checked: gc.enableSoftLock !== false, onChange: e => setGc({ ...gc, enableSoftLock: e.target.checked }) })),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.gcErrorProbe')),
                    h('input', { type: 'checkbox', checked: gc.enableErrorProbe !== false, onChange: e => setGc({ ...gc, enableErrorProbe: e.target.checked }) })),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.gcAutoReview')),
                    h('input', { type: 'checkbox', checked: gc.autoProgressReview !== false, onChange: e => setGc({ ...gc, autoProgressReview: e.target.checked }) })),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.gcActivityStrip')),
                    h('input', { type: 'checkbox', checked: gc.showActivityStrip === true, onChange: e => setGc({ ...gc, showActivityStrip: e.target.checked }) })),
                  h('div', { className: 'bm-form-actions' },
                    h('button', {
                      type: 'button', className: 'bm-btn primary', disabled: busy,
                      onClick: () => runSave(() => props.onCommand('settings.save', { groupChat: gc })),
                    }, t('settings.save')))),
                rooms.length > 0
                  ? h('section', { className: 'bm-form' },
                    h('h2', null, `${t('pane.groups')} (${rooms.length})`),
                    rooms.map(r => h('div', { key: r.id, className: 'bm-routine' },
                      h('div', { className: 'bm-routine-text' },
                        h('span', { className: 'bm-routine-name' }, r.name),
                        h('span', { className: 'bm-routine-meta' }, `${r.mode} · ${r.status}${r.workDir ? ` · ${r.workDir}` : ''}`)),
                      h('button', { type: 'button', className: 'bm-btn small', onClick: () => props.onEditGroup(r) }, t('card.edit')))))
                  : null)
            }

            if (moduleKey === 'artifacts') {
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, `${t('settings.artifacts')} (${artifacts.length})`),
                  artifacts.length === 0
                    ? h('p', { className: 'bm-muted' }, t('settings.artifactsEmpty'))
                    : artifacts.map(item => {
                      const dlUrl = item.downloadUrl
                        || `/botmode/api/artifacts/download?id=${encodeURIComponent(item.artifactId || item.id)}${item.botId ? `&botId=${encodeURIComponent(item.botId)}` : ''}`
                      return h('div', { key: item.id, className: 'bm-routine' },
                        h('div', { className: 'bm-routine-text' },
                          h('span', { className: 'bm-routine-name' }, `${item.title} [${item.type}]`),
                          h('span', { className: 'bm-routine-meta' }, `${item.roomName || ''}${item.botName ? ` · @${item.botName}` : ''}${item.filename ? ` · ${item.filename}` : ''}`),
                          item.preview ? h('span', { className: 'bm-routine-prompt' }, item.preview) : null),
                        h('a', {
                          className: 'bm-btn small',
                          href: dlUrl,
                          download: item.filename || '',
                          style: { textDecoration: 'none', flex: 'none' },
                        }, t('rich.download')))
                    })))
            }

            if (moduleKey === 'usage') {
              return h('div', { className: 'bm-set-panel' },
                h(MetricsCard, {
                  data: {
                    title: t('settings.usage'),
                    items: [
                      { label: 'Total Tokens', value: `${Math.round((usage.totalTokens || 0) / 100) / 10}k`, tone: 'ok' },
                      { label: t('pane.bots'), value: String(usage.botCount ?? bots.length) },
                      { label: t('pane.groups'), value: String(usage.roomCount ?? rooms.length) },
                      { label: t('settings.routines'), value: String(usage.routineCount ?? routines.length) },
                    ],
                  },
                }),
                (usage.byRoom || []).length > 0
                  ? h('section', { className: 'bm-form' },
                    h('h2', null, t('pane.groups')),
                    h('div', { className: 'bm-table-wrap', style: { margin: 0 } },
                      h('table', { className: 'bm-table' },
                        h('thead', null, h('tr', null,
                          h('th', null, t('group.name')),
                          h('th', null, 'Status'),
                          h('th', null, 'Msgs'),
                          h('th', null, 'Tokens'))),
                        h('tbody', null, usage.byRoom.map(r => h('tr', { key: r.roomId },
                          h('td', null, r.name),
                          h('td', null, r.status),
                          h('td', null, String(r.messages)),
                          h('td', null, `${Math.round((r.tokensUsed || 0) / 100) / 10}k${r.tokenLimit > 0 ? ` / ${Math.round(r.tokenLimit / 1000)}k` : ''}`)))))))
                  : null)
            }

            if (moduleKey === 'system') {
              return h(SystemMonitorPanel, {
                settings: appSettings,
                screenGateway: props.screenGateway,
                initialSystem: props.systemInfo,
                onCommand: props.onCommand,
              })
            }

            if (moduleKey === 'mcp') {
              const botServers = Array.isArray(mcpInfo.botServers) ? mcpInfo.botServers : []
              const normalServers = Array.isArray(mcpInfo.normalServers) ? mcpInfo.normalServers : []
              const saveMcp = () => runSave(async () => {
                const name = String(mcpForm.name || '').trim()
                if (!name) throw new Error('MCP server name is required.')
                const cfg = { disabled: mcpForm.disabled === true }
                if (mcpForm.transport === 'streamable-http') {
                  cfg.type = 'streamable-http'
                  cfg.url = String(mcpForm.url || '').trim()
                } else {
                  cfg.command = String(mcpForm.command || '').trim()
                  cfg.args = String(mcpForm.argsText || '').trim()
                    ? String(mcpForm.argsText).trim().split(/\s+/)
                    : []
                  const envObj = {}
                  for (const line of String(mcpForm.envText || '').split('\n')) {
                    const idx = line.indexOf('=')
                    if (idx > 0) envObj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
                  }
                  if (Object.keys(envObj).length > 0) cfg.env = envObj
                }
                await props.onCommand('mcp.save', { name, config: cfg })
                setMcpForm({ name: '', transport: 'stdio', command: '', argsText: '', url: '', envText: '', disabled: false })
              })
              const testMcp = async (srvName) => {
                setMcpProbe('')
                try {
                  const res = await props.onCommand('mcp.test', { name: srvName })
                  setMcpProbe(res && res.ok ? `✓ ${srvName}: ${res.detail || 'OK'}` : `✗ ${srvName}: ${(res && res.detail) || 'Failed'}`)
                } catch (err) {
                  setMcpProbe(`✗ ${srvName}: ${err && err.message ? err.message : String(err)}`)
                }
              }
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, `${t('settings.mcp')} (${botServers.length} Bot / ${normalServers.length} Shared)`),
                  h('p', { className: 'bm-form-hint' }, `${t('settings.mcpDesc')}${mcpInfo.configPath ? ` · ${mcpInfo.configPath}` : ''}`),
                  mcpProbe ? h('div', { className: mcpProbe.startsWith('✓') ? 'bm-ok' : 'bm-error' }, mcpProbe) : null,
                  botServers.length === 0
                    ? h('p', { className: 'bm-muted' }, 'No Bot-priority MCP servers configured yet.')
                    : botServers.map(srv => h('div', { key: srv.name, className: 'bm-routine' },
                      h('div', { className: 'bm-routine-text' },
                        h('span', { className: 'bm-routine-name' },
                          `${srv.name} [${srv.transport}]${srv.disabled ? ' (disabled)' : ''}${srv.overridesNormal ? ` · ★ ${t('settings.mcpOverride')}` : ''}`),
                        h('span', { className: 'bm-routine-meta' },
                          srv.url ? srv.url : `${srv.command} ${(srv.args || []).join(' ')}`)),
                      h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                        h('button', { type: 'button', className: 'bm-btn small', disabled: busy, onClick: () => { void testMcp(srv.name) } }, t('settings.mcpTest')),
                        h('button', {
                          type: 'button', className: 'bm-btn small', disabled: busy,
                          onClick: () => runSave(() => props.onCommand('mcp.toggle', { name: srv.name, disabled: !srv.disabled })),
                        }, srv.disabled ? 'Enable' : 'Disable'),
                        h('button', {
                          type: 'button', className: 'bm-btn small',
                          onClick: () => setMcpForm({
                            name: srv.name,
                            transport: srv.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
                            command: srv.command || '',
                            argsText: Array.isArray(srv.args) ? srv.args.join(' ') : '',
                            url: srv.url || '',
                            envText: '',
                            disabled: srv.disabled === true,
                          }),
                        }, t('card.edit')),
                        h('button', {
                          type: 'button', className: 'bm-btn small danger', disabled: busy,
                          onClick: () => runSave(() => props.onCommand('mcp.delete', { name: srv.name })),
                        }, '×')))),
                  normalServers.length > 0
                    ? h('div', { style: { marginTop: '10px' } },
                      h('p', { className: 'bm-form-hint' }, `Shared Normal-Mode MCP (${normalServers.length}):`),
                      h('div', { className: 'bm-picks' }, normalServers.map(s => h('span', { key: s.name, className: 'bm-act-chip' }, `${s.name} [shared · ${s.transport}]`))))
                    : null),
                h('section', { className: 'bm-form' },
                  h('h2', null, t('settings.mcpAdd')),
                  h('div', { className: 'bm-row' },
                    h('label', { className: 'bm-label' }, 'Name',
                      h('input', {
                        className: 'bm-input', placeholder: 'github / postgres / playwright',
                        value: mcpForm.name, onChange: e => setMcpForm({ ...mcpForm, name: e.target.value }),
                      })),
                    h('label', { className: 'bm-label' }, 'Transport',
                      h('select', {
                        className: 'bm-input', value: mcpForm.transport,
                        onChange: e => setMcpForm({ ...mcpForm, transport: e.target.value }),
                      },
                        h('option', { value: 'stdio' }, 'stdio (local command)'),
                        h('option', { value: 'streamable-http' }, 'streamable-http (remote URL)')))),
                  mcpForm.transport === 'streamable-http'
                    ? h('label', { className: 'bm-label' }, 'Endpoint URL',
                      h('input', {
                        className: 'bm-input', placeholder: 'https://mcp.example.com/sse',
                        value: mcpForm.url, onChange: e => setMcpForm({ ...mcpForm, url: e.target.value }),
                      }))
                    : h('div', null,
                      h('div', { className: 'bm-row' },
                        h('label', { className: 'bm-label' }, 'Command',
                          h('input', {
                            className: 'bm-input', placeholder: 'npx / uvx / node',
                            value: mcpForm.command, onChange: e => setMcpForm({ ...mcpForm, command: e.target.value }),
                          })),
                        h('label', { className: 'bm-label' }, 'Args (space separated)',
                          h('input', {
                            className: 'bm-input', placeholder: '-y @modelcontextprotocol/server-filesystem /path',
                            value: mcpForm.argsText, onChange: e => setMcpForm({ ...mcpForm, argsText: e.target.value }),
                          }))),
                      h('label', { className: 'bm-label' }, 'Env (KEY=VALUE per line, optional)',
                        h('textarea', {
                          className: 'bm-area', rows: 2, placeholder: 'GITHUB_TOKEN=ghp_xxx',
                          value: mcpForm.envText, onChange: e => setMcpForm({ ...mcpForm, envText: e.target.value }),
                        }))),
                  h('div', { className: 'bm-form-actions' },
                    h('button', { type: 'button', className: 'bm-btn primary', disabled: busy, onClick: saveMcp }, t('settings.save')))))
            }

            if (moduleKey === 'channels') {
              const origin = typeof window !== 'undefined' && window.location ? window.location.origin : ''
              const reqDesktopPerm = () => {
                if (typeof window !== 'undefined' && 'Notification' in window && window.Notification.requestPermission) {
                  void window.Notification.requestPermission()
                }
              }
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, t('settings.notifyTitle')),
                  h('p', { className: 'bm-form-hint' }, t('settings.channelsDesc')),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, 'Browser Desktop Notifications (approvals & screen takeover)'),
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                      h('button', { type: 'button', className: 'bm-btn small', onClick: reqDesktopPerm }, 'Allow'),
                      h('input', { type: 'checkbox', checked: notif.desktopNotifications !== false, onChange: e => setNotif({ ...notif, desktopNotifications: e.target.checked }) }))),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, 'Enable Outbound IM / Webhook Push'),
                    h('input', { type: 'checkbox', checked: notif.enabled === true, onChange: e => setNotif({ ...notif, enabled: e.target.checked }) })),
                  h('div', { className: 'bm-row' },
                    h('label', { className: 'bm-label' }, 'Format',
                      h('select', {
                        className: 'bm-input', value: notif.webhookFormat || notif.format || 'generic',
                        onChange: e => setNotif({ ...notif, webhookFormat: e.target.value }),
                      },
                        h('option', { value: 'generic' }, 'Generic JSON'),
                        h('option', { value: 'feishu' }, 'Feishu / Lark (飞书)'),
                        h('option', { value: 'wecom' }, 'WeCom (企业微信)'),
                        h('option', { value: 'dingtalk' }, 'DingTalk (钉钉)'),
                        h('option', { value: 'slack' }, 'Slack'))),
                    h('label', { className: 'bm-label' }, 'Secret (optional HMAC/token)',
                      h('input', {
                        className: 'bm-input', type: 'password', value: notif.webhookSecret || notif.secret || '',
                        onChange: e => setNotif({ ...notif, webhookSecret: e.target.value }),
                      }))),
                  h('label', { className: 'bm-label' }, 'Outbound Webhook URL',
                    h('input', {
                      className: 'bm-input', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
                      value: notif.webhookUrl || '', onChange: e => setNotif({ ...notif, webhookUrl: e.target.value }),
                    })),
                  h('div', { className: 'bm-picks', style: { marginTop: '6px' } },
                    [
                      ['onApproval', 'Approvals'],
                      ['onScreenHelp', 'Screen Takeover'],
                      ['onRoomComplete', 'Room Complete'],
                      ['onBudgetExceeded', 'Budget Exceeded'],
                      ['onRoutineError', 'Routine Error'],
                    ].map(([k, lbl]) => h('button', {
                      key: k, type: 'button', className: 'bm-pick', 'data-on': notif[k] !== false,
                      onClick: () => setNotif({ ...notif, [k]: notif[k] === false }),
                    }, lbl))),
                  h('div', { className: 'bm-form-actions' },
                    h('button', {
                      type: 'button', className: 'bm-btn', disabled: busy,
                      onClick: () => runSave(async () => {
                        const res = await props.onCommand('notifications.test', { override: notif })
                        if (res && res.ok === false) throw new Error(res.error || 'Test failed')
                      }),
                    }, t('settings.notifyTest')),
                    h('button', {
                      type: 'button', className: 'bm-btn primary', disabled: busy,
                      onClick: () => runSave(() => props.onCommand('settings.save', { notifications: notif })),
                    }, t('settings.save'))),
                  notificationLogs.length > 0
                    ? h('div', { style: { marginTop: '10px' } },
                      notificationLogs.slice(0, 6).map((lg, i) => h('div', { key: `${lg.at}-${i}`, className: 'bm-routine' },
                        h('div', { className: 'bm-routine-text' },
                          h('span', { className: 'bm-routine-name' }, `${lg.ok ? '✓' : '✗'} [${lg.kind}] ${lg.title}`),
                          h('span', { className: 'bm-routine-meta' }, `${lg.at || ''}${lg.error ? ` · ${lg.error}` : ''}`)))))
                    : null),
                h('section', { className: 'bm-form' },
                  h('h2', null, `${t('settings.webhookTitle')} (${webhooksList.length})`),
                  webhooksList.length === 0
                    ? h('p', { className: 'bm-muted' }, 'No Inbound Webhooks yet.')
                    : webhooksList.map(wh => h('div', { key: wh.id, className: 'bm-routine' },
                      h('div', { className: 'bm-routine-text' },
                        h('span', { className: 'bm-routine-name' }, `${wh.name} → ${wh.targetKind}:${wh.targetId} (${wh.triggerCount || 0}×)`),
                        h('span', { className: 'bm-routine-meta' }, `POST ${origin}/botmode/api/webhook/${wh.id}`),
                        h('span', { className: 'bm-routine-prompt' }, `Secret: ${wh.secret}`)),
                      h('div', { style: { display: 'flex', gap: '6px' } },
                        h('button', {
                          type: 'button', className: 'bm-btn small', disabled: busy,
                          onClick: () => runSave(() => props.onCommand('webhook.test', { webhookId: wh.id })),
                        }, t('settings.webhookTest')),
                        h('button', {
                          type: 'button', className: 'bm-btn small danger', disabled: busy,
                          onClick: () => runSave(() => props.onCommand('webhook.delete', { webhookId: wh.id })),
                        }, '×')))),
                  h('h2', { style: { marginTop: '12px' } }, t('settings.webhookAdd')),
                  h('div', { className: 'bm-row' },
                    h('label', { className: 'bm-label' }, 'Name',
                      h('input', {
                        className: 'bm-input', placeholder: 'GitHub PR Alert / Sentry Hook',
                        value: hookForm.name, onChange: e => setHookForm({ ...hookForm, name: e.target.value }),
                      })),
                    h('label', { className: 'bm-label' }, 'Target Type',
                      h('select', {
                        className: 'bm-input', value: hookForm.targetKind,
                        onChange: e => {
                          const k = e.target.value
                          const firstId = k === 'room' ? ((rooms[0] && rooms[0].id) || '') : ((bots[0] && bots[0].id) || '')
                          setHookForm({ ...hookForm, targetKind: k, targetId: firstId })
                        },
                      },
                        h('option', { value: 'bot' }, 'Bot (1:1)'),
                        h('option', { value: 'room' }, 'Group Room')))),
                  h('label', { className: 'bm-label' }, 'Target',
                    h('select', {
                      className: 'bm-input', value: hookForm.targetId,
                      onChange: e => setHookForm({ ...hookForm, targetId: e.target.value }),
                    },
                      (hookForm.targetKind === 'room' ? rooms : bots).map(item => h('option', { key: item.id, value: item.id }, item.name)))),
                  h('label', { className: 'bm-label' }, 'Prompt Template ({{name}}, {{event}}, {{payload}})',
                    h('textarea', {
                      className: 'bm-area', rows: 2, value: hookForm.promptTemplate,
                      onChange: e => setHookForm({ ...hookForm, promptTemplate: e.target.value }),
                    })),
                  h('div', { className: 'bm-form-actions' },
                    h('button', {
                      type: 'button', className: 'bm-btn primary', disabled: busy,
                      onClick: () => runSave(async () => {
                        await props.onCommand('webhook.save', { draft: hookForm })
                        setHookForm({ ...hookForm, name: '' })
                      }),
                    }, t('settings.webhookAdd')))))
            }

            if (moduleKey === 'integrations') {
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, t('settings.integrations')),
                  h('div', { className: 'bm-table-wrap', style: { margin: 0 } },
                    h('table', { className: 'bm-table' },
                      h('tbody', null,
                        h('tr', null, h('th', null, 'State Root'), h('td', null, runtimeInfo.root || '—')),
                        h('tr', null, h('th', null, 'Host PID'), h('td', null, String(runtimeInfo.pid || '—'))),
                        h('tr', null, h('th', null, 'Memory Provider'), h('td', null, memLabel)),
                        h('tr', null, h('th', null, 'Registered Tools'), h('td', null, String(allTools.length)))))),
                  allTools.length > 0
                    ? h('div', { className: 'bm-picks' }, allTools.map(tn => h('span', { key: tn, className: 'bm-act-chip' }, tn)))
                    : null))
            }

            if (moduleKey === 'logs') {
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('div', { className: 'bm-block-head' },
                    h('h2', null, t('settings.logs')),
                    h('button', { type: 'button', className: 'bm-btn small', onClick: () => { void loadLogs() } }, t('settings.logsRefresh'))),
                  logs.length === 0
                    ? h('p', { className: 'bm-muted' }, t('settings.logsEmpty'))
                    : logs.map((entry, idx) => h('div', { key: entry.id || `lg${idx}`, className: 'bm-routine' },
                      h('div', { className: 'bm-routine-text' },
                        h('span', { className: 'bm-routine-name' }, `[${entry.roomName || entry.roomId}] ${entry.kind}${entry.botName ? ` · ${entry.botName}` : ''}`),
                        h('span', { className: 'bm-routine-meta' }, `${entry.at || ''}${entry.reason ? ` · ${entry.reason}` : ''}`))))))
            }

            // Bot-scoped settings modules
            if (!bot) {
              return h('div', { className: 'bm-set-panel' },
                h('div', { className: 'bm-empty' },
                  h('p', null, t('settings.noBot')),
                  h('button', { type: 'button', className: 'bm-btn primary', onClick: props.onNewBot }, t('page.new'))))
            }

            if (moduleKey === 'model') {
              const useCustom = Boolean(botModel.provider && botModel.model)
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, `${bot.name} · ${t('settings.model')}`),
                  h('div', { className: 'bm-seg' },
                    h('button', {
                      type: 'button', 'data-active': !useCustom,
                      onClick: () => setBotModel({ ...EMPTY_MODEL }),
                    }, t('form.modelDefault')),
                    h('button', {
                      type: 'button', 'data-active': useCustom,
                      onClick: () => {
                        const firstG = providers[0]
                        const firstM = firstG && firstG.models && firstG.models[0]
                        setBotModel({
                          provider: (firstG && firstG.id) || (catalog && catalog.default && catalog.default.provider) || '',
                          model: (firstM && firstM.id) || (catalog && catalog.default && catalog.default.model) || '',
                          reasoningEffort: '',
                        })
                      },
                    }, t('form.modelCustom'))),
                  useCustom
                    ? h('div', { className: 'bm-row' },
                      h('label', { className: 'bm-label' }, t('form.modelProvider'),
                        providers.length > 0
                          ? h('select', {
                            className: 'bm-input', value: botModel.provider,
                            onChange: (e) => {
                              const g = providers.find(item => item.id === e.target.value)
                              const m = g && g.models && g.models[0]
                              setBotModel({ provider: e.target.value, model: (m && m.id) || '', reasoningEffort: '' })
                            },
                          }, providers.map(g => h('option', { key: g.id, value: g.id }, g.name || g.id)))
                          : h('input', {
                            className: 'bm-input', value: botModel.provider,
                            onChange: e => setBotModel({ ...botModel, provider: e.target.value }),
                          })),
                      h('label', { className: 'bm-label' }, t('form.modelPick'),
                        selectedProvider && selectedProvider.models && selectedProvider.models.length > 0
                          ? h('select', {
                            className: 'bm-input', value: botModel.model,
                            onChange: e => setBotModel({ ...botModel, model: e.target.value, reasoningEffort: '' }),
                          }, selectedProvider.models.map(m => h('option', { key: m.id, value: m.id }, m.name || m.id)))
                          : h('input', {
                            className: 'bm-input', value: botModel.model,
                            onChange: e => setBotModel({ ...botModel, model: e.target.value }),
                          })))
                    : h('p', { className: 'bm-form-hint' }, t('form.modelDefaultHint')),
                  useCustom && selectedModelEntry && selectedModelEntry.reasoning && selectedModelEntry.reasoning.efforts
                    ? h('label', { className: 'bm-label' }, t('form.reasoning'),
                      h('select', {
                        className: 'bm-input', value: botModel.reasoningEffort || '',
                        onChange: e => setBotModel({ ...botModel, reasoningEffort: e.target.value }),
                      },
                        h('option', { value: '' }, t('form.reasoningDefault')),
                        selectedModelEntry.reasoning.efforts.map(ef => h('option', { key: ef.id, value: ef.id }, ef.name || ef.id))))
                    : null,
                  h('div', { className: 'bm-form-actions' },
                    h('button', { type: 'button', className: 'bm-btn', onClick: () => props.onReloadModels(true) }, t('form.modelRefresh')),
                    h('button', {
                      type: 'button', className: 'bm-btn primary', disabled: busy,
                      onClick: () => runSave(() => saveBotPatch({ model: botModel })),
                    }, t('settings.save')))))
            }

            if (moduleKey === 'tools') {
              const allowSet = new Set(String(botToolsAllow || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean))
              const toggleTool = (name) => {
                const next = new Set(allowSet)
                if (next.has(name)) next.delete(name)
                else next.add(name)
                setBotToolsAllow([...next].join(', '))
              }
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, `${bot.name} · ${t('settings.tools')}`),
                  h('label', { className: 'bm-label' }, t('form.tools'),
                    h('input', {
                      className: 'bm-input', value: botToolsAllow, placeholder: t('form.toolsPlaceholder'),
                      onChange: e => setBotToolsAllow(e.target.value),
                    })),
                  allTools.length > 0
                    ? h('div', { className: 'bm-picks' }, allTools.map(tn => h('button', {
                      key: tn, type: 'button', className: 'bm-pick', 'data-on': allowSet.has(tn),
                      onClick: () => toggleTool(tn),
                    }, tn)))
                    : null,
                  h('div', { className: 'bm-form-actions' },
                    h('button', {
                      type: 'button', className: 'bm-btn primary', disabled: busy,
                      onClick: () => runSave(() => saveBotPatch()),
                    }, t('settings.save')))))
            }

            if (moduleKey === 'skills') {
              const discovered = Array.isArray(bot.discoveredSkills) ? bot.discoveredSkills : []
              const sharedDir = runtimeInfo && runtimeInfo.skillsRoot ? runtimeInfo.skillsRoot : ''
              const loadSkillForEdit = async (sk) => {
                try {
                  const res = await props.onCommand('skills.read', { botId: bot.id, name: sk.name })
                  if (res && res.skill) {
                    setSkillForm({
                      name: res.skill.name,
                      scope: res.skill.source === 'bot-local' ? 'bot' : 'shared',
                      content: res.skill.raw || '',
                    })
                  }
                } catch (err) {
                  setError(err && err.message ? err.message : String(err))
                }
              }
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, `${bot.name} · ${t('settings.skills')} (${discovered.filter(s => s.enabled !== false).length}/${discovered.length})`),
                  h('p', { className: 'bm-form-hint' }, [
                    'Priority: Bot local > Bot shared > Bot built-in > Shared normal skills',
                    bot.dir ? ` · ${bot.dir}/.dsh/skills/` : '',
                    sharedDir ? ` · ${sharedDir}` : '',
                  ].filter(Boolean).join('')),
                  discovered.length === 0
                    ? h('p', { className: 'bm-muted' }, 'No skills discovered yet.')
                    : discovered.map(sk => h('div', { key: sk.name, className: 'bm-routine' },
                      h('div', { className: 'bm-routine-text' },
                        h('span', { className: 'bm-routine-name' },
                          `${sk.name} [${sk.tier === 'bot' ? 'Bot 优先' : '共享'} · ${sk.source || 'bot'}]`),
                        h('span', { className: 'bm-routine-meta' }, sk.description || sk.path || '')),
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                        h('input', {
                          type: 'checkbox',
                          title: 'Enable/disable for this Bot',
                          checked: sk.enabled !== false,
                          onChange: e => runSave(() => props.onCommand('skills.toggle', { botId: bot.id, name: sk.name, enabled: e.target.checked })),
                        }),
                        h('button', { type: 'button', className: 'bm-btn small', onClick: () => { void loadSkillForEdit(sk) } }, t('card.edit')),
                        sk.editable === true
                          ? h('button', {
                            type: 'button', className: 'bm-btn small danger', disabled: busy,
                            onClick: () => runSave(() => props.onCommand('skills.delete', {
                              botId: bot.id,
                              scope: sk.source === 'bot-local' ? 'bot' : 'shared',
                              name: sk.name,
                            })),
                          }, '×')
                          : null)))),
                h('section', { className: 'bm-form' },
                  h('h2', null, t('settings.skillsAdd')),
                  h('div', { className: 'bm-row' },
                    h('label', { className: 'bm-label' }, 'Skill Name (kebab-case)',
                      h('input', {
                        className: 'bm-input', placeholder: 'my-custom-skill',
                        value: skillForm.name, onChange: e => setSkillForm({ ...skillForm, name: e.target.value }),
                      })),
                    h('label', { className: 'bm-label' }, 'Target Library',
                      h('select', {
                        className: 'bm-input', value: skillForm.scope,
                        onChange: e => setSkillForm({ ...skillForm, scope: e.target.value }),
                      },
                        h('option', { value: 'shared' }, t('settings.skillsScopeShared')),
                        h('option', { value: 'bot' }, t('settings.skillsScopeBot'))))),
                  h('label', { className: 'bm-label' }, 'SKILL.md',
                    h('textarea', {
                      className: 'bm-area', rows: 10, value: skillForm.content,
                      onChange: e => setSkillForm({ ...skillForm, content: e.target.value }),
                    })),
                  h('div', { className: 'bm-form-actions' },
                    h('button', {
                      type: 'button', className: 'bm-btn primary', disabled: busy,
                      onClick: () => runSave(() => props.onCommand('skills.save', {
                        botId: bot.id,
                        scope: skillForm.scope,
                        name: skillForm.name,
                        content: skillForm.content,
                      })),
                    }, t('settings.save')))))
            }

            if (moduleKey === 'workspace') {
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, `${bot.name} · ${t('settings.workspace')}`),
                  h('div', { className: 'bm-table-wrap', style: { margin: 0 } },
                    h('table', { className: 'bm-table' },
                      h('tbody', null,
                        h('tr', null, h('th', null, 'Bot Directory'), h('td', null, bot.dir || '—')),
                        h('tr', null, h('th', null, 'Primary Session'), h('td', null, bot.sessionId || '—')))))))
            }

            if (moduleKey === 'routines') {
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, `${bot.name} · ${t('settings.routines')}`),
                  h(RoutineSection, { bot, routines: botRoutines, onCommand: props.onCommand })))
            }

            if (moduleKey === 'approval') {
              const todayTokens = (bot.tokenUsage && bot.tokenUsage.tokens) ? bot.tokenUsage.tokens : 0
              const todayDay = (bot.tokenUsage && bot.tokenUsage.day) ? bot.tokenUsage.day : ''
              return h('div', { className: 'bm-set-panel' },
                h('section', { className: 'bm-form' },
                  h('h2', null, `${bot.name} · ${t('settings.approval')}`),
                  h('label', { className: 'bm-label' }, t('form.approval'),
                    h('select', {
                      className: 'bm-input', value: botApproval,
                      onChange: e => setBotApproval(e.target.value),
                    },
                      h('option', { value: 'ask' }, t('approval.ask')),
                      h('option', { value: 'always' }, t('approval.allowAlways')),
                      h('option', { value: 'never' }, t('approval.denyAlways')))),
                  h('div', { className: 'bm-row' },
                    h('label', { className: 'bm-label' }, t('settings.botRole'),
                      h('select', {
                        className: 'bm-input', value: botPermRole,
                        onChange: e => setBotPermRole(e.target.value),
                      },
                        h('option', { value: 'worker' }, t('settings.botRoleWorker')),
                        h('option', { value: 'admin' }, t('settings.botRoleAdmin')))),
                    h('label', { className: 'bm-label' }, t('settings.botDailyLimit'),
                      h('input', {
                        type: 'number', min: 0, step: 10000, className: 'bm-input',
                        value: botDailyLimit,
                        onChange: e => setBotDailyLimit(Number(e.target.value) || 0),
                      }))),
                  h('p', { className: 'bm-form-hint' }, `Today usage${todayDay ? ` (${todayDay})` : ''}: ${todayTokens.toLocaleString()} tokens`),
                  h('div', { className: 'bm-form-actions' },
                    h('button', {
                      type: 'button', className: 'bm-btn primary', disabled: busy,
                      onClick: () => runSave(() => saveBotPatch({
                        approvalPolicy: botApproval,
                        permissionRole: botPermRole,
                        dailyTokenLimit: Number(botDailyLimit) || 0,
                      })),
                    }, t('settings.save')))),
                h('section', { className: 'bm-form' },
                  h('h2', null, t('settings.govTitle')),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.govBotCrud')),
                    h('input', {
                      type: 'checkbox', checked: gov.requireApprovalForBotCrud !== false,
                      onChange: e => setGov({ ...gov, requireApprovalForBotCrud: e.target.checked }),
                    })),
                  h('label', { className: 'bm-toggle-row' },
                    h('span', null, t('settings.govExtWrite')),
                    h('input', {
                      type: 'checkbox', checked: gov.protectExternalWrites === true,
                      onChange: e => setGov({ ...gov, protectExternalWrites: e.target.checked }),
                    })),
                  h('label', { className: 'bm-label' }, t('settings.govDefaultBudget'),
                    h('input', {
                      type: 'number', min: 0, step: 50000, className: 'bm-input',
                      value: gov.defaultDailyTokenLimit ?? 0,
                      onChange: e => setGov({ ...gov, defaultDailyTokenLimit: Number(e.target.value) || 0 }),
                    })),
                  h('div', { className: 'bm-form-actions' },
                    h('button', {
                      type: 'button', className: 'bm-btn primary', disabled: busy,
                      onClick: () => runSave(() => props.onCommand('settings.save', { governance: gov })),
                    }, t('settings.save')))))
            }

            // Default: `soul`
            return h('div', { className: 'bm-set-panel' },
              h('section', { className: 'bm-form' },
                h('h2', null, `${bot.name} · ${t('settings.soul')}`),
                h('p', { className: 'bm-form-hint' }, t('settings.soulHint')),
                h('div', { className: 'bm-row' },
                  h('label', { className: 'bm-label' }, t('form.name'),
                    h('input', { className: 'bm-input', value: botName, onChange: e => setBotName(e.target.value) })),
                  h('label', { className: 'bm-label' }, t('form.role'),
                    h('input', { className: 'bm-input', value: botRole, onChange: e => setBotRole(e.target.value) }))),
                h(BotAvatarEditor, {
                  mode: 'edit',
                  useCustom: true,
                  value: botAvatar,
                  fallbackColor: botColor,
                  onChange: (nextAv) => {
                    setBotAvatar(nextAv)
                    if (nextAv && nextAv.color) setBotColor(nextAv.color)
                  },
                }),
                h('label', { className: 'bm-label' }, t('form.instructions'),
                  h('textarea', { className: 'bm-area', rows: 4, value: botInstructions, onChange: e => setBotInstructions(e.target.value) })),
                h('label', { className: 'bm-label' }, 'SOUL.md',
                  h('textarea', { className: 'bm-area', rows: 6, value: soulMd, onChange: e => setSoulMd(e.target.value) })),
                h('div', { className: 'bm-form-actions' },
                  h('button', {
                    type: 'button', className: 'bm-btn primary', disabled: busy,
                    onClick: () => runSave(() => saveBotPatch({}, { soul: soulMd })),
                  }, t('settings.save')))))
          }

          return h('div', { className: 'bm-settings' },
            h('nav', { className: 'bm-set-nav' },
              h('div', { className: 'bm-set-hero' },
                h('div', { className: 'bm-set-hero-top' },
                  h('strong', { style: { fontSize: '14px' } }, t('settings.title')),
                  h('button', { type: 'button', className: 'bm-btn small', onClick: props.onNewBot }, `+ ${t('page.new')}`)),
                bot
                  ? h(BotAvatarBadge, { bot, avatar: botAvatar, size: 'lg', animated: true })
                  : null,
                bot ? h('strong', { style: { fontSize: '15px' } }, bot.name) : null,
                bots.length > 1
                  ? h('div', { className: 'bm-set-botpills' }, bots.map(item => h('button', {
                    key: item.id, type: 'button', className: 'bm-pick', 'data-on': bot && bot.id === item.id,
                    onClick: () => setBotId(item.id),
                  }, item.name)))
                  : null),
              h('div', { className: 'bm-set-card' },
                navRow('model', 'model', t('settings.model'), activeModelLabel),
                navRow('skills', 'skills', t('settings.skills'), String(
                  bot && Array.isArray(bot.discoveredSkills) && bot.discoveredSkills.length > 0
                    ? bot.discoveredSkills.filter(s => s.enabled !== false).length
                    : ((bot && bot.skills ? bot.skills.length : 0) + 5),
                )),
                navRow('mcp', 'integrations', t('settings.mcp'), String((mcpInfo.botServers || []).length)),
                navRow('tools', 'tools', t('settings.tools'), toolCountLabel)),
              h('div', { className: 'bm-set-group-label' }, t('settings.groupWork')),
              h('div', { className: 'bm-set-card' },
                navRow('workspace', 'workspace', t('settings.workspace'), ''),
                navRow('routines', 'routines', t('settings.routines'), String(botRoutines.length)),
                navRow('artifacts', 'artifacts', t('settings.artifacts'), String(artifacts.length)),
                navRow('rooms', 'rooms', t('settings.rooms'), String(rooms.length))),
              h('div', { className: 'bm-set-group-label' }, t('settings.groupAgent')),
              h('div', { className: 'bm-set-card' },
                navRow('soul', 'soul', t('settings.soul'), ''),
                navRow('memory', 'memory', t('settings.memory'), memLabel),
                navRow('format', 'format', t('settings.format'), rf.enabled !== false ? 'ON' : 'OFF'),
                navRow('usage', 'usage', t('settings.usage'), `${Math.round((usage.totalTokens || 0) / 100) / 10}k`)),
              h('div', { className: 'bm-set-card' },
                h('button', {
                  type: 'button', className: 'bm-set-row',
                  onClick: () => setAdvOpen(v => !v),
                },
                  h('span', { className: 'bm-set-icon' }, h(SettingsIcon, { kind: 'gear' })),
                  h('span', { className: 'bm-set-row-label' }, t('settings.groupAdvanced')),
                  h('span', { className: 'bm-set-chev' }, advOpen ? '⌄' : '›')),
                advOpen ? navRow('approval', 'approval', t('settings.approval'), bot ? `${bot.permissionRole || 'worker'} · ${bot.approvalPolicy}` : '') : null,
                advOpen ? navRow('channels', 'routines', t('settings.channels'), String(webhooksList.length)) : null,
                advOpen ? navRow('system', 'system', t('settings.system'), props.screenGateway && props.screenGateway.available ? 'ON' : '') : null,
                advOpen ? navRow('integrations', 'integrations', t('settings.integrations'), String(allTools.length)) : null,
                advOpen ? navRow('logs', 'logs', t('settings.logs'), '') : null)),
            h('div', { className: 'bm-set-body' },
              error ? h('div', { className: 'bm-error', style: { maxWidth: '780px', margin: '0 auto 12px' } }, error) : null,
              notice ? h('div', { className: 'bm-ok', style: { maxWidth: '780px', margin: '0 auto 12px' } }, notice) : null,
              renderModuleBody()))
        }

        function MonitorGlyph(props) {
          const size = props.size || 24
          return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
            h('rect', { x: 2.5, y: 4, width: 19, height: 13, rx: 2.2 }),
            h('path', { d: 'M8.5 20h7M12 17v3', strokeLinecap: 'round' }))
        }

        function ClockGlyph(props) {
          const size = props.size || 26
          return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
            h('rect', { x: 7.5, y: 2.5, width: 9, height: 3, rx: 1 }),
            h('rect', { x: 7.5, y: 18.5, width: 9, height: 3, rx: 1 }),
            h('circle', { cx: 12, cy: 12, r: 6.2 }))
        }

        function fmtScreenBytes(bytes) {
          if (!bytes) return '0 MB'
          const mb = bytes / (1024 * 1024)
          return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
        }

        function ScreenHelpCard(props) {
          const t = useT()
          const item = props.entry
          const [note, setNote] = useState('')
          const [busy, setBusy] = useState(false)
          const previewUrl = item.previewDataUrl || `/botmode/api/screen/preview?botId=${encodeURIComponent(item.botId)}&cached=1`
          const decide = async (decision) => {
            setBusy(true)
            try {
              await props.onCommand('screen.help.decide', { helpId: item.id, decision, note })
            } catch (_e) { /* handled */ } finally {
              setBusy(false)
            }
          }
          return h('div', { className: 'bm-help-card' },
            h('img', {
              className: 'bm-help-thumb',
              src: previewUrl,
              alt: item.botName,
              onClick: () => props.onTakeover(item),
              onError: (e) => { e.currentTarget.style.display = 'none' },
            }),
            h('div', { className: 'bm-help-body' },
              h('div', { className: 'bm-help-head' },
                h('span', { className: 'bm-approval-name' }, item.botName || item.botId),
                h('span', { className: 'bm-help-badge' }, item.category || 'manual'),
                h('span', { className: 'bm-muted' }, t('screen.helpTitle'))),
              h('div', { className: 'bm-help-reason' }, item.reason),
              h('div', { className: 'bm-help-controls' },
                h('button', {
                  type: 'button', className: 'bm-btn small primary', disabled: busy,
                  onClick: () => props.onTakeover(item),
                }, t('screen.helpOpen')),
                h('input', {
                  className: 'bm-help-note',
                  value: note,
                  placeholder: t('screen.helpNotePlaceholder'),
                  onChange: e => setNote(e.target.value),
                }),
                h('button', {
                  type: 'button', className: 'bm-btn small', disabled: busy,
                  onClick: () => decide('release'),
                }, t('screen.helpRelease')),
                h('button', {
                  type: 'button', className: 'bm-btn small danger', disabled: busy,
                  onClick: () => decide('cancel'),
                }, t('screen.helpCancel')))))
        }

        function ScreenTakeoverModal(props) {
          const t = useT()
          const { modal, screen, onCommand, onScreenInput, onClose } = props
          const [textInput, setTextInput] = useState('')
          const [note, setNote] = useState('')
          const [busy, setBusy] = useState(false)
          const [err, setErr] = useState('')
          const [hud, setHud] = useState({ fps: 0, latency: 0 })
          const canvasRef = useRef(null)
          const screenSizeRef = useRef({ w: 1280, h: 720 })
          const dragRef = useRef({ active: false, pointerId: null, button: 1, lastRatio: null, pendingMoves: [] })
          const inputQueueRef = useRef(Promise.resolve())
          const paintQueueRef = useRef(Promise.resolve())
          const moveFlushTimerRef = useRef(null)
          const hudRef = useRef({ frames: 0, lastAt: 0, lastPublish: 0, latencySum: 0, latencyCount: 0 })
          const fallbackPollRef = useRef(null)
          const nudgePollRef = useRef(null)
          const legacyModeRef = useRef(false)

          useEffect(() => {
            if (!modal) return undefined
            let cancelled = false
            legacyModeRef.current = false
            hudRef.current = { frames: 0, lastAt: 0, lastPublish: 0, latencySum: 0, latencyCount: 0 }
            setHud({ fps: 0, latency: 0 })
            let es = null
            let sseFrameSeen = false
            let fallbackActive = false
            let pullInFlight = false
            let pendingNudge = false
            let lastPreviewEtag = ''
            let failStreak = 0
            let earlyPreviewTimer = null
            let streamWatchdogTimer = null
            let errorFallbackTimer = null
            let followUpPollTimer = null
            let pollAbort = null

            const canvas = canvasRef.current
            if (canvas) {
              const ctx = canvas.getContext('2d')
              if (ctx) {
                ctx.fillStyle = '#05070a'
                ctx.fillRect(0, 0, canvas.width, canvas.height)
                ctx.fillStyle = 'rgba(226, 232, 240, 0.55)'
                ctx.font = '14px sans-serif'
                ctx.textAlign = 'center'
                ctx.fillText('Connecting stream…', canvas.width / 2, canvas.height / 2)
              }
            }

            const closeEventSource = () => {
              if (es) {
                try { es.close() } catch (_e) { /* ignore */ }
                es = null
              }
            }

            const clearTimer = (id) => {
              if (id) window.clearTimeout(id)
              return null
            }

            const decodeBase64Tile = async (b64, mime) => {
              if (typeof window.createImageBitmap === 'function') {
                const bin = window.atob(b64)
                const bytes = new Uint8Array(bin.length)
                for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
                const blob = new Blob([bytes], { type: mime || 'image/jpeg' })
                return window.createImageBitmap(blob)
              }
              return new Promise((resolve, reject) => {
                const img = new Image()
                img.onload = () => resolve(img)
                img.onerror = reject
                img.src = `data:${mime || 'image/jpeg'};base64,${b64}`
              })
            }

            const decodeImageBlob = async (blob) => {
              if (typeof window.createImageBitmap === 'function') {
                try {
                  return await window.createImageBitmap(blob)
                } catch (_e) { /* fallback to Image */ }
              }
              return new Promise((resolve, reject) => {
                const objUrl = URL.createObjectURL(blob)
                const img = new Image()
                img.onload = () => {
                  URL.revokeObjectURL(objUrl)
                  resolve(img)
                }
                img.onerror = (ev) => {
                  URL.revokeObjectURL(objUrl)
                  reject(ev)
                }
                img.src = objUrl
              })
            }

            // 统计实际帧率与到网关单程延迟：帧携带网关 ts，客户端用收到时刻 - ts 估算
            const noteFrame = (pkt) => {
              if (cancelled) return
              const now = Date.now()
              const stat = hudRef.current
              stat.frames += 1
              if (pkt && typeof pkt.ts === 'number' && pkt.ts > 0) {
                const lat = now - pkt.ts
                if (lat >= 0 && lat < 60000) {
                  stat.latencySum += lat
                  stat.latencyCount += 1
                }
              }
              if (!stat.lastAt) stat.lastAt = now
              if (now - stat.lastPublish >= 500) {
                const secs = (now - stat.lastAt) / 1000
                const fps = secs > 0 ? Math.round(stat.frames / secs) : 0
                const latency = stat.latencyCount > 0 ? Math.round(stat.latencySum / stat.latencyCount) : 0
                setHud({ fps, latency })
                stat.frames = 0
                stat.latencySum = 0
                stat.latencyCount = 0
                stat.lastAt = now
                stat.lastPublish = now
              }
            }

            const paintFullImage = (img) => {
              const task = async () => {
                if (cancelled) {
                  if (img && typeof img.close === 'function') img.close()
                  return
                }
                noteFrame(null)
                const node = canvasRef.current
                if (!node) {
                  if (img && typeof img.close === 'function') img.close()
                  return
                }
                const w = img.naturalWidth || img.width || 0
                const h = img.naturalHeight || img.height || 0
                if (w > 0 && h > 0 && (node.width !== w || node.height !== h)) {
                  screenSizeRef.current = { w, h }
                  node.width = w
                  node.height = h
                }
                const ctx = node.getContext('2d')
                if (ctx) ctx.drawImage(img, 0, 0, node.width, node.height)
                if (img && typeof img.close === 'function') img.close()
              }
              paintQueueRef.current = paintQueueRef.current.then(task, () => undefined)
            }

            const applyFramePacket = (pkt) => {
              const task = async () => {
                if (cancelled) return
                noteFrame(pkt)
                const node = canvasRef.current
                if (!node) return
                if (pkt.w > 0 && pkt.h > 0 && (node.width !== pkt.w || node.height !== pkt.h)) {
                  screenSizeRef.current = { w: pkt.w, h: pkt.h }
                  node.width = pkt.w
                  node.height = pkt.h
                }
                const tiles = Array.isArray(pkt.tiles) ? pkt.tiles : []
                if (tiles.length === 0) return
                const decoded = await Promise.all(
                  tiles.map(tile => decodeBase64Tile(tile.d, pkt.mime).then(bmp => ({ tile, bmp }))),
                )
                if (cancelled) {
                  for (const item of decoded) {
                    if (item.bmp && typeof item.bmp.close === 'function') item.bmp.close()
                  }
                  return
                }
                const ctx = node.getContext('2d')
                if (ctx) {
                  for (const { tile, bmp } of decoded) {
                    ctx.drawImage(bmp, tile.x, tile.y, tile.w, tile.h)
                    if (bmp && typeof bmp.close === 'function') bmp.close()
                  }
                }
              }
              paintQueueRef.current = paintQueueRef.current.then(task, () => undefined)
            }

            const pullPreviewOnce = async ({ ignoreEtag = false } = {}) => {
              if (cancelled || pullInFlight) return false
              pullInFlight = true
              const ac = typeof window.AbortController === 'function' ? new window.AbortController() : null
              pollAbort = ac
              try {
                const headers = (!ignoreEtag && lastPreviewEtag) ? { 'If-None-Match': lastPreviewEtag } : undefined
                const res = await fetch(
                  `/botmode/api/screen/preview?botId=${encodeURIComponent(modal.botId)}&cached=1&t=${Date.now()}`,
                  { credentials: 'include', cache: 'no-store', headers, signal: ac ? ac.signal : undefined },
                )
                if (cancelled) return false
                if (res.status === 304) {
                  failStreak = 0
                  return true
                }
                if (res.ok) {
                  const etag = res.headers.get('etag') || ''
                  if (etag) lastPreviewEtag = etag
                  const blob = await res.blob()
                  if (cancelled) return false
                  const img = await decodeImageBlob(blob)
                  if (cancelled) {
                    if (img && typeof img.close === 'function') img.close()
                    return false
                  }
                  paintFullImage(img)
                  failStreak = 0
                  setErr('')
                  return true
                }
                failStreak += 1
                if (failStreak >= 3) {
                  setErr(`画面刷新失败 (HTTP ${res.status})`)
                }
                return false
              } catch (e) {
                if (!cancelled && (!e || e.name !== 'AbortError')) {
                  failStreak += 1
                  if (failStreak >= 3) {
                    setErr(e && e.message ? e.message : '画面拉取失败，正在重试…')
                  }
                }
                return false
              } finally {
                if (pollAbort === ac) pollAbort = null
                pullInFlight = false
              }
            }

            const scheduleNextPoll = (delayMs) => {
              if (cancelled || !fallbackActive) return
              fallbackPollRef.current = clearTimer(fallbackPollRef.current)
              fallbackPollRef.current = window.setTimeout(() => {
                fallbackPollRef.current = null
                void pollLoop()
              }, delayMs)
            }

            const pollLoop = async () => {
              if (cancelled || !fallbackActive) return
              const ok = await pullPreviewOnce({ ignoreEtag: false })
              if (cancelled || !fallbackActive) return
              if (pendingNudge) {
                pendingNudge = false
                scheduleNextPoll(60)
                return
              }
              const nextDelay = ok ? 280 : Math.min(1500, 350 * Math.max(1, failStreak))
              scheduleNextPoll(nextDelay)
            }

            const startFallbackPolling = () => {
              if (cancelled || fallbackActive) return
              fallbackActive = true
              // 主动关闭被代理缓冲/假活的 SSE 连接，防止服务端持续抓屏与连接泄漏
              closeEventSource()
              earlyPreviewTimer = clearTimer(earlyPreviewTimer)
              streamWatchdogTimer = clearTimer(streamWatchdogTimer)
              errorFallbackTimer = clearTimer(errorFallbackTimer)
              nudgePollRef.current = () => {
                if (cancelled || !fallbackActive) return
                followUpPollTimer = clearTimer(followUpPollTimer)
                if (pullInFlight) {
                  pendingNudge = true
                } else {
                  scheduleNextPoll(60)
                }
                followUpPollTimer = window.setTimeout(() => {
                  followUpPollTimer = null
                  if (cancelled || !fallbackActive) return
                  if (pullInFlight) pendingNudge = true
                  else scheduleNextPoll(0)
                }, 220)
              }
              scheduleNextPoll(20)
            }

            // 按需接入 64×64 脏矩形增量帧 SSE 流；若经 Cloudflare/反代缓冲导致 SSE 假活无首帧，自动无感降级为 HTTP 条件轮询
            const streamUrl = `/botmode/api/screen/stream?botId=${encodeURIComponent(modal.botId)}&fmt=jpeg`
            if (typeof window.EventSource === 'function') {
              es = new window.EventSource(streamUrl, { withCredentials: true })
              // 400ms 未见 SSE 首帧时先拉一帧快照消除黑屏等待；不立即关 SSE，若 SSE 随后通畅自动接管
              earlyPreviewTimer = window.setTimeout(() => {
                earlyPreviewTimer = null
                if (!cancelled && !sseFrameSeen && !fallbackActive) {
                  void pullPreviewOnce({ ignoreEtag: true })
                }
              }, 400)
              // 1800ms 仍未收到任何 SSE frame（如代理/隧道缓冲 text/event-stream），直接关闭假活 SSE 并切轮询
              streamWatchdogTimer = window.setTimeout(() => {
                streamWatchdogTimer = null
                if (!cancelled && !sseFrameSeen && !fallbackActive) {
                  startFallbackPolling()
                }
              }, 1800)

              es.onmessage = (ev) => {
                if (cancelled || !ev.data || fallbackActive) return
                try {
                  const pkt = JSON.parse(ev.data)
                  if (pkt.type === 'meta' && pkt.w > 0 && pkt.h > 0) {
                    screenSizeRef.current = { w: pkt.w, h: pkt.h }
                    const node = canvasRef.current
                    if (node && (node.width !== pkt.w || node.height !== pkt.h)) {
                      node.width = pkt.w
                      node.height = pkt.h
                    }
                  } else if (pkt.type === 'frame') {
                    sseFrameSeen = true
                    earlyPreviewTimer = clearTimer(earlyPreviewTimer)
                    streamWatchdogTimer = clearTimer(streamWatchdogTimer)
                    errorFallbackTimer = clearTimer(errorFallbackTimer)
                    applyFramePacket(pkt)
                  }
                } catch (_e) { /* ignore malformed frame */ }
              }
              es.onerror = () => {
                if (cancelled || fallbackActive) return
                if (!sseFrameSeen || (es && es.readyState === window.EventSource.CLOSED)) {
                  startFallbackPolling()
                  return
                }
                if (!errorFallbackTimer) {
                  errorFallbackTimer = window.setTimeout(() => {
                    errorFallbackTimer = null
                    if (!cancelled && !fallbackActive) startFallbackPolling()
                  }, 2500)
                }
              }
            } else {
              startFallbackPolling()
            }

            return () => {
              cancelled = true
              nudgePollRef.current = null
              closeEventSource()
              if (pollAbort) {
                try { pollAbort.abort() } catch (_e) { /* ignore */ }
                pollAbort = null
              }
              earlyPreviewTimer = clearTimer(earlyPreviewTimer)
              streamWatchdogTimer = clearTimer(streamWatchdogTimer)
              errorFallbackTimer = clearTimer(errorFallbackTimer)
              followUpPollTimer = clearTimer(followUpPollTimer)
              fallbackPollRef.current = clearTimer(fallbackPollRef.current)
              moveFlushTimerRef.current = clearTimer(moveFlushTimerRef.current)
            }
          }, [modal && modal.botId])

          if (!modal) return null

          const dispatchInput = async (input) => {
            if (onScreenInput) return onScreenInput(modal.botId, input)
            return onCommand('screen.human_input', { botId: modal.botId, input })
          }

          const sendInput = (input) => {
            const task = async () => {
              setErr('')
              try {
                if (legacyModeRef.current && (input.kind === 'mousedown' || input.kind === 'move' || input.kind === 'move_batch')) {
                  return
                }
                if (legacyModeRef.current && input.kind === 'mouseup') {
                  await dispatchInput({ kind: 'click', x: input.x, y: input.y, rx: input.rx, ry: input.ry, button: input.button || 1 })
                } else {
                  await dispatchInput(input)
                }
              } catch (e) {
                const msg = e && e.message ? e.message : String(e)
                if (msg.includes('unknown human_input kind') && (input.kind === 'mousedown' || input.kind === 'mouseup' || input.kind === 'move' || input.kind === 'move_batch')) {
                  legacyModeRef.current = true
                  if (input.kind === 'mouseup') {
                    await dispatchInput({ kind: 'click', x: input.x, y: input.y, button: input.button || 1 }).catch(() => undefined)
                  }
                  return
                }
                setErr(msg)
              } finally {
                if (nudgePollRef.current) nudgePollRef.current()
              }
            }
            inputQueueRef.current = inputQueueRef.current.then(task, task)
            return inputQueueRef.current
          }

          // 零开销系统光标 + 归一化比例坐标映射 (rx = x / canvasWidth, ry = y / canvasHeight)
          const mapRatio = (event) => {
            const node = canvasRef.current
            if (!node) return null
            const rect = node.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) return null
            const sw = screenSizeRef.current.w || 1280
            const sh = screenSizeRef.current.h || 720
            const scale = Math.min(rect.width / sw, rect.height / sh)
            const drawW = sw * scale
            const drawH = sh * scale
            const offX = rect.left + (rect.width - drawW) / 2
            const offY = rect.top + (rect.height - drawH) / 2
            const rx = Math.max(0, Math.min(1, Number(((event.clientX - offX) / drawW).toFixed(5))))
            const ry = Math.max(0, Math.min(1, Number(((event.clientY - offY) / drawH).toFixed(5))))
            const x = Math.round(rx * (sw - 1))
            const y = Math.round(ry * (sh - 1))
            return { rx, ry, x, y }
          }

          const flushPendingMoves = () => {
            if (moveFlushTimerRef.current) {
              window.clearTimeout(moveFlushTimerRef.current)
              moveFlushTimerRef.current = null
            }
            const pending = dragRef.current.pendingMoves
            if (!pending || pending.length === 0) return
            dragRef.current.pendingMoves = []
            void sendInput({ kind: 'move_batch', normalized: true, points: pending })
          }

          const handlePointerDown = (event) => {
            if (event.button > 2 && event.pointerType === 'mouse') return
            event.preventDefault()
            const node = canvasRef.current
            if (node) {
              try { node.focus({ preventScroll: true }) } catch (_e) { /* ignore */ }
              try { node.setPointerCapture(event.pointerId) } catch (_e) { /* ignore */ }
            }
            const pos = mapRatio(event)
            if (!pos) return
            const button = event.button === 2 ? 3 : event.button === 1 ? 2 : 1
            dragRef.current = {
              active: true,
              pointerId: event.pointerId,
              button,
              lastRatio: pos,
              pendingMoves: [],
            }
            void sendInput({ kind: 'mousedown', rx: pos.rx, ry: pos.ry, x: pos.x, y: pos.y, button })
          }

          const handlePointerMove = (event) => {
            // 仅在按下拖拽时发送增量轨迹；普通悬停直接使用浏览器原生光标（0ms 响应，零网络开销）
            if (!dragRef.current.active || dragRef.current.pointerId !== event.pointerId) return
            const pos = mapRatio(event)
            if (!pos) return
            const prev = dragRef.current.lastRatio
            if (!prev || prev.x !== pos.x || prev.y !== pos.y) {
              dragRef.current.lastRatio = pos
              dragRef.current.pendingMoves.push([pos.rx, pos.ry])
              if (!moveFlushTimerRef.current) {
                moveFlushTimerRef.current = window.setTimeout(flushPendingMoves, 35)
              }
            }
          }

          const finishPointer = (event) => {
            if (!dragRef.current.active || dragRef.current.pointerId !== event.pointerId) return
            const node = canvasRef.current
            if (node) {
              try {
                if (node.hasPointerCapture && node.hasPointerCapture(event.pointerId)) {
                  node.releasePointerCapture(event.pointerId)
                }
              } catch (_e) { /* ignore */ }
            }
            flushPendingMoves()
            const pos = mapRatio(event) || dragRef.current.lastRatio
            const button = dragRef.current.button
            dragRef.current = { active: false, pointerId: null, button: 1, lastRatio: null, pendingMoves: [] }
            if (pos) {
              void sendInput({ kind: 'mouseup', rx: pos.rx, ry: pos.ry, x: pos.x, y: pos.y, button })
            }
          }

          const handleKeyDown = (event) => {
            if (event.target !== canvasRef.current) return
            if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return
            const SPECIAL_KEYS = {
              Enter: 'Return',
              Backspace: 'BackSpace',
              Escape: 'Escape',
              Tab: 'Tab',
              Delete: 'Delete',
              ArrowUp: 'Up',
              ArrowDown: 'Down',
              ArrowLeft: 'Left',
              ArrowRight: 'Right',
              Home: 'Home',
              End: 'End',
              PageUp: 'Prior',
              PageDown: 'Next',
              ' ': 'space',
            }
            const mapped = SPECIAL_KEYS[event.key]
            if (event.ctrlKey || event.altKey) {
              const base = mapped || (event.key.length === 1 ? event.key.toLowerCase() : '')
              if (!base) return
              event.preventDefault()
              const combo = `${event.ctrlKey ? 'ctrl+' : ''}${event.altKey ? 'alt+' : ''}${base}`
              void sendInput({ kind: 'key', combo })
              return
            }
            if (mapped) {
              event.preventDefault()
              void sendInput({ kind: 'key', combo: mapped })
              return
            }
            if (event.key.length === 1 && !event.metaKey) {
              event.preventDefault()
              void sendInput({ kind: 'type', text: event.key, press_enter: false })
            }
          }

          // 缩小/收起虚拟屏即属于归还状态：立即释放控制权并交还给 Bot
          const shrinkAndRelease = async () => {
            if (busy) return
            setBusy(true)
            setErr('')
            try {
              if (modal.helpId) {
                await onCommand('screen.help.decide', { helpId: modal.helpId, decision: 'release', note })
              } else {
                await onCommand('screen.release', { botId: modal.botId })
              }
              onClose()
            } catch (e) {
              setErr(e && e.message ? e.message : String(e))
            } finally {
              setBusy(false)
            }
          }

          const sendText = async (event) => {
            event.preventDefault()
            if (!textInput) return
            const val = textInput
            setTextInput('')
            await sendInput({ kind: 'type', text: val, press_enter: true })
          }

          return h('div', { className: 'bm-modal-backdrop', onClick: (e) => { if (e.target === e.currentTarget) void shrinkAndRelease() } },
            h('div', { className: 'bm-modal' },
              h('div', { className: 'bm-modal-head' },
                h('span', { className: 'bm-screen-dot', 'data-state': (screen && screen.state) || 'HUMAN_TAKEOVER' }),
                h('strong', { style: { fontSize: '13px' } }, `${modal.botName || modal.botId} · ${t('screen.takeoverState')}`),
                modal.reason ? h('span', { className: 'bm-muted', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, modal.reason) : h('span', { style: { flex: 1 } }),
                (() => {
                  const raw = modal.gatewayStreamUrl
                  if (!raw) return null
                  try {
                    const u = new URL(raw, window.location.href)
                    const isLoopbackTarget = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
                    const isLoopbackPage = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname === '[::1]'
                    if (isLoopbackTarget && !isLoopbackPage) return null
                  } catch (_e) { /* keep */ }
                  return h('a', {
                    className: 'bm-btn small',
                    href: raw,
                    target: '_blank',
                    rel: 'noreferrer',
                    style: { textDecoration: 'none' },
                  }, t('screen.openVnc'))
                })(),
                h('button', { type: 'button', className: 'bm-btn small primary', disabled: busy, onClick: () => void shrinkAndRelease() }, `⤡ ${t('screen.shrinkRelease')}`)),
              h('div', { className: 'bm-modal-stage' },
                h('canvas', {
                  ref: canvasRef,
                  className: 'bm-modal-canvas',
                  width: screenSizeRef.current.w,
                  height: screenSizeRef.current.h,
                  tabIndex: 0,
                  'aria-label': modal.botId,
                  onPointerDown: handlePointerDown,
                  onPointerMove: handlePointerMove,
                  onPointerUp: finishPointer,
                  onPointerCancel: finishPointer,
                  onLostPointerCapture: finishPointer,
                  onContextMenu: (e) => { e.preventDefault() },
                  onWheel: (e) => {
                    e.preventDefault()
                    const pos = mapRatio(e)
                    if (!pos) return
                    const clicks = e.deltaY > 0 ? 3 : -3
                    void sendInput({ kind: 'scroll', rx: pos.rx, ry: pos.ry, x: pos.x, y: pos.y, clicks })
                  },
                  onKeyDown: handleKeyDown,
                }),
                h('div', { className: 'bm-screen-hud' },
                  h('span', { className: 'bm-screen-hud-chip', 'data-warn': hud.fps > 0 && hud.fps < 10 ? '1' : '0' },
                    `${t('screen.hudFps')} `, h('strong', null, String(hud.fps || '—'))),
                  h('span', { className: 'bm-screen-hud-chip' },
                    `${t('screen.hudLatency')} `, h('strong', null, hud.latency ? `${hud.latency}ms` : '—'), ` ${t('screen.hudTarget')}`))),
              h('form', { className: 'bm-modal-bar', onSubmit: sendText },
                h('input', {
                  className: 'bm-help-note',
                  value: textInput,
                  placeholder: t('screen.typePlaceholder'),
                  onChange: e => setTextInput(e.target.value),
                }),
                h('button', { type: 'submit', className: 'bm-btn small primary' }, t('screen.typeSend')),
                ['Return', 'Tab', 'Escape', 'BackSpace', 'ctrl+l', 'ctrl+r'].map(combo => h('button', {
                  key: combo,
                  type: 'button',
                  className: 'bm-btn small',
                  onClick: () => void sendInput({ kind: 'key', combo }),
                }, combo)),
                h('button', { type: 'button', className: 'bm-btn small', onClick: () => void sendInput({ kind: 'open_app', app: 'chrome' }) }, t('screen.browser')),
                h('button', { type: 'button', className: 'bm-btn small', onClick: () => void sendInput({ kind: 'open_app', app: 'terminal' }) }, t('screen.terminal')),
                h('button', { type: 'button', className: 'bm-btn small', onClick: () => void sendInput({ kind: 'open_app', app: 'files' }) }, t('screen.filesApp'))),
              err ? h('div', { className: 'bm-error', style: { margin: '0 14px 8px' } }, err) : null,
              h('div', { className: 'bm-modal-foot' },
                h('span', { className: 'bm-muted', style: { marginRight: 'auto' } }, t('screen.modalHint')),
                h('input', {
                  className: 'bm-help-note',
                  style: { maxWidth: '280px' },
                  value: note,
                  placeholder: t('screen.helpNotePlaceholder'),
                  onChange: e => setNote(e.target.value),
                }),
                h('button', { type: 'button', className: 'bm-btn primary', disabled: busy, onClick: () => void shrinkAndRelease() }, t('screen.helpRelease')))))
        }

        function RightScreenPanel(props) {
          const t = useT()
          const { bot, screen, screenGateway, systemInfo, gatewayAvailable, routines, onCommand, onOpenTakeover, onRefreshHost, onOpenSystemSettings } = props
          const [railTab, setRailTab] = useState('tasks')
          const [shotTick, setShotTick] = useState(0)
          const [busy, setBusy] = useState(false)
          const [err, setErr] = useState('')
          const [files, setFiles] = useState([])
          const [creatingRoutine, setCreatingRoutine] = useState(false)
          const [rName, setRName] = useState('')
          const [rCron, setRCron] = useState('*/30 * * * *')
          const [rPrompt, setRPrompt] = useState('')
          const fileInputRef = useRef(null)

          const screenState = (screen && screen.state) || 'STOPPED'
          const healthy = Boolean(screen && screen.healthy)
          const isRunning = healthy && screenState !== 'STOPPED'
          const gatewayStarting = Boolean(screenGateway && screenGateway.starting)
          const autoStartable = !screenGateway || screenGateway.autoStartable !== false
          const gatewayErr = (screenGateway && screenGateway.error) || ''

          useEffect(() => {
            if (!gatewayStarting || !onRefreshHost) return undefined
            const timer = window.setInterval(() => onRefreshHost(), 1500)
            return () => window.clearInterval(timer)
          }, [gatewayStarting])

          const screenRev = `${(screen && screen.epoch) || 0}_${Math.floor((screen && screen.last_agent_call) || 0)}_${shotTick}`

          const refreshFiles = async () => {
            if (!bot) return
            try {
              const res = await fetch(`/botmode/api/screen/files?botId=${encodeURIComponent(bot.id)}`, { credentials: 'include', cache: 'no-store' })
              const data = await res.json()
              if (data && data.ok) setFiles(data.files || [])
            } catch (_e) { /* ignore */ }
          }

          useEffect(() => {
            if (railTab === 'files') void refreshFiles()
          }, [railTab, bot && bot.id])

          const runScreenCmd = async (type, extra = {}) => {
            setBusy(true)
            setErr('')
            try {
              const res = await onCommand(type, { botId: bot.id, ...extra })
              setShotTick(v => v + 1)
              return res
            } catch (e) {
              setErr(e && e.message ? e.message : String(e))
              return null
            } finally {
              setBusy(false)
            }
          }

          const startOnly = async () => {
            await runScreenCmd('screen.start')
          }

          const triggerTakeover = async () => {
            if (busy) return
            setBusy(true)
            setErr('')
            try {
              await onOpenTakeover(bot)
              setShotTick(v => v + 1)
            } catch (e) {
              setErr(e && e.message ? e.message : String(e))
            } finally {
              setBusy(false)
            }
          }

          const hasSavedSession = Boolean(screen && screen.has_saved_session)
          const hasCachedPreview = Boolean(screen && screen.has_cached_preview)

          const stateLabel = !props.hostScreenSupported
            ? t('screen.hostOutdated')
            : gatewayStarting
              ? t('screen.starting')
              : !gatewayAvailable
                ? t('screen.offline')
                : !isRunning
                  ? (hasSavedSession ? t('screen.stoppedSaved') : t('screen.stopped'))
                  : screenState === 'FROZEN'
                    ? t('screen.stopped')
                    : screenState === 'NEED_HUMAN'
                      ? t('screen.needHuman')
                      : screenState === 'HUMAN_TAKEOVER'
                        ? t('screen.takeoverState')
                        : t('screen.active')

          const showPreviewImg = isRunning || (gatewayAvailable && hasCachedPreview)
          const previewUrl = showPreviewImg
            ? `/botmode/api/screen/preview?botId=${encodeURIComponent(bot.id)}&cached=1&onlyCached=1&t=${screenRev}`
            : ''

          const saveNewRoutine = async (event) => {
            event.preventDefault()
            if (!rName.trim() || !rPrompt.trim()) return
            setBusy(true)
            setErr('')
            try {
              await onCommand('routine.save', {
                botId: bot.id,
                name: rName.trim(),
                cron: rCron.trim() || '*/30 * * * *',
                schedule: rCron.trim() || '*/30 * * * *',
                prompt: rPrompt.trim(),
                enabled: true,
              })
              setCreatingRoutine(false)
              setRName('')
              setRPrompt('')
            } catch (e) {
              setErr(e && e.message ? e.message : String(e))
            } finally {
              setBusy(false)
            }
          }

          const uploadScreenFile = async (file) => {
            if (!file || !bot) return
            setBusy(true)
            try {
              const buf = await file.arrayBuffer()
              await fetch(`/botmode/api/screen/files?botId=${encodeURIComponent(bot.id)}&name=${encodeURIComponent(file.name)}`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
                body: buf,
              })
              await refreshFiles()
            } finally {
              setBusy(false)
            }
          }

          return h('aside', { className: 'bm-right-rail' },
            h('div', { className: 'bm-rail-tabs' },
              h('button', { type: 'button', className: 'bm-rail-tab', 'data-active': railTab === 'tasks', onClick: () => setRailTab('tasks') }, t('detail.routines')),
              h('button', { type: 'button', className: 'bm-rail-tab', 'data-active': railTab === 'files', onClick: () => setRailTab('files') }, t('screen.files'))),
            h('div', { className: 'bm-rail-body' },
              // Top Screen Card (matching screenshot)
              h('div', null,
                h('div', { className: 'bm-screen-card', 'data-state': isRunning ? screenState : 'STOPPED' },
                  showPreviewImg
                    ? h('img', {
                      className: 'bm-screen-img',
                      src: previewUrl,
                      alt: bot.name,
                      'data-frozen': screenState === 'FROZEN',
                      'data-stopped': !isRunning,
                      onLoad: (e) => { e.currentTarget.style.opacity = '' },
                      onError: (e) => { e.currentTarget.style.opacity = '0.15' },
                    })
                    : h('div', { className: 'bm-screen-placeholder' }, h(MonitorGlyph, { size: 28 })),
                  isRunning && screen && screen.display
                    ? h('span', { className: 'bm-screen-overlay-badge' }, `${screen.display} · ${fmtScreenBytes(screen.memory_bytes)}`)
                    : (!isRunning && hasSavedSession
                      ? h('span', { className: 'bm-screen-overlay-badge' }, '0 MB · 状态已保存')
                      : null),
                  h('div', { className: 'bm-screen-footer' },
                    h('span', { className: 'bm-screen-dot', 'data-state': isRunning ? screenState : 'STOPPED' }),
                    h('div', { className: 'bm-screen-ftext' },
                      h('span', { className: 'bm-screen-ftitle' }, t('screen.title')),
                      h('span', { className: 'bm-screen-fsub' }, stateLabel)),
                    h('button', {
                      type: 'button',
                      className: 'bm-screen-cta',
                      'data-tone': (screenState === 'NEED_HUMAN' || screenState === 'HUMAN_TAKEOVER') ? 'warn' : undefined,
                      disabled: busy || !props.hostScreenSupported || (!gatewayAvailable && !autoStartable),
                      onClick: () => void triggerTakeover(),
                    }, t('screen.takeover')))),
                props.hostScreenSupported && (gatewayAvailable || autoStartable)
                  ? h('div', { className: 'bm-screen-toolbar' },
                    !isRunning
                      ? h('button', {
                        type: 'button', className: 'bm-btn xs', disabled: busy,
                        onClick: () => void startOnly(),
                      }, t('screen.start'))
                      : h('button', {
                        type: 'button', className: 'bm-btn xs', disabled: busy,
                        onClick: () => void runScreenCmd('screen.stop'),
                      }, t('screen.stop')),
                    isRunning
                      ? h('button', {
                        type: 'button', className: 'bm-btn xs danger', disabled: busy,
                        onClick: () => void runScreenCmd('screen.brake'),
                      }, t('screen.brake'))
                      : null)
                  : null,
                err ? h('div', { className: 'bm-error', style: { marginTop: '6px' } }, err) : null,
                !err && !props.hostScreenSupported && onRefreshHost
                  ? h('div', { style: { marginTop: '6px', display: 'flex', justifyContent: 'flex-end' } },
                    h('button', { type: 'button', className: 'bm-btn xs', onClick: onRefreshHost }, t('screen.refreshHost')))
                  : null,
                !err && props.hostScreenSupported && !gatewayAvailable && gatewayErr && !gatewayStarting
                  ? h('div', { className: 'bm-muted', style: { marginTop: '6px', fontSize: '11px', lineHeight: '1.35', wordBreak: 'break-word' } }, gatewayErr)
                  : null,
                (() => {
                  const host = (screenGateway && screenGateway.host) || systemInfo || null
                  if (!props.hostScreenSupported) return null
                  const cpu = host && host.cpu
                  const mem = host && host.memory
                  const disk = host && host.disk
                  const up = host && host.uptime
                  const memTotal = mem && mem.total_mb != null ? mem.total_mb : (host && host.limit_mb != null ? host.limit_mb : null)
                  const memAvail = mem && mem.available_mb != null ? mem.available_mb : (host && host.available_mb != null ? host.available_mb : null)
                  const memUsed = mem && mem.used_mb != null
                    ? mem.used_mb
                    : (memTotal != null && memAvail != null ? Math.max(0, memTotal - memAvail) : null)
                  const memPct = mem && mem.usage_percent != null
                    ? mem.usage_percent
                    : (memTotal != null && memTotal > 0 && memUsed != null ? Math.round((memUsed / memTotal) * 1000) / 10 : null)
                  const cpuPct = cpu && cpu.usage_percent != null ? cpu.usage_percent : null
                  const diskPct = disk && disk.usage_percent != null ? disk.usage_percent : null
                  const hasMetrics = cpuPct != null || memPct != null || diskPct != null
                  const isFallback = Boolean(host && (host.degraded || host.source === 'host-fallback'))
                  const miniBar = (pct) => {
                    const num = Number(pct)
                    const clamped = Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : 0
                    return h('div', { className: 'bm-sys-bar' },
                      h('div', {
                        className: 'bm-sys-bar-fill',
                        'data-warn': clamped >= 75 && clamped < 90,
                        'data-crit': clamped >= 90,
                        style: { width: `${clamped}%` },
                      }))
                  }
                  const statusChip = gatewayAvailable
                    ? (host && host.cgroup === false ? t('system.cgroupOff') : t('system.online'))
                    : (isFallback ? t('system.fallbackMode') : t('system.waitingGateway'))
                  return h('div', { className: 'bm-host-mini' },
                    h('div', { className: 'bm-host-mini-head' },
                      h('span', { className: 'bm-host-mini-title', title: (host && host.hostname) || '' },
                        `${t('system.hostPanelTitle')}${host && host.hostname ? ` · ${host.hostname}` : ''}`),
                      onOpenSystemSettings
                        ? h('button', {
                          type: 'button',
                          className: 'bm-btn xs',
                          onClick: onOpenSystemSettings,
                        }, t('system.openDetails'))
                        : null),
                    h('div', { className: 'bm-host-mini-meta' },
                      h('span', { className: 'bm-act-chip' }, statusChip),
                      up && up.formatted ? h('span', null, `${t('system.uptime')} ${up.formatted}`) : null),
                    hasMetrics
                      ? h('div', { className: 'bm-host-mini-rows' },
                        h('div', { className: 'bm-host-mini-row' },
                          h('div', { className: 'bm-host-mini-row-top' },
                            h('span', null, `${t('system.cpu')}${cpu && cpu.cores ? ` (${cpu.cores}C)` : ''}`),
                            h('strong', null, cpuPct != null ? `${cpuPct}%` : '—')),
                          miniBar(cpuPct)),
                        h('div', { className: 'bm-host-mini-row' },
                          h('div', { className: 'bm-host-mini-row-top' },
                            h('span', null, t('system.memory')),
                            h('strong', null, memPct != null
                              ? `${memPct}%${memTotal != null ? ` · ${memUsed}/${memTotal}MB` : ''}`
                              : (memAvail != null ? `${t('system.available')} ${memAvail}MB` : '—'))),
                          miniBar(memPct)),
                        h('div', { className: 'bm-host-mini-row' },
                          h('div', { className: 'bm-host-mini-row-top' },
                            h('span', null, `${t('system.disk')}${disk && disk.path ? ` (${disk.path})` : ''}`),
                            h('strong', null, diskPct != null
                              ? `${diskPct}%${disk && disk.total_gb != null ? ` · ${disk.used_gb}/${disk.total_gb}G` : ''}`
                              : '—')),
                          miniBar(diskPct)))
                      : h('div', { className: 'bm-muted', style: { fontSize: '10.5px' } }, statusChip))
                })()),

              // Bottom section: Scheduled Tasks or Screen Files
              railTab === 'tasks'
                ? h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: '10px' } },
                  h('div', { className: 'bm-rail-bothead' },
                    h(BotAvatarBadge, { bot, size: 'sm' }),
                    h('div', { className: 'bm-rail-botmeta' },
                      h('div', { className: 'bm-rail-botname' },
                        h('span', null, bot.name),
                        bot.role ? h('span', { className: 'bm-rail-botrole' }, `@${bot.role}`) : null),
                      h('span', { className: 'bm-rail-sub' }, t('detail.routines'))),
                    h('button', {
                      type: 'button', className: 'bm-rail-plus', title: t('screen.routinesNew'),
                      onClick: () => setCreatingRoutine(v => !v),
                    }, creatingRoutine ? '×' : '+')),
                  creatingRoutine
                    ? h('form', { className: 'bm-routine-form', onSubmit: saveNewRoutine },
                      h('input', { className: 'bm-input', value: rName, placeholder: t('routine.name'), onChange: e => setRName(e.target.value), autoFocus: true }),
                      h('input', { className: 'bm-input', value: rCron, placeholder: '*/30 * * * *', onChange: e => setRCron(e.target.value) }),
                      h('textarea', { className: 'bm-input', rows: 3, value: rPrompt, placeholder: t('routine.prompt'), onChange: e => setRPrompt(e.target.value) }),
                      h('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
                        h('button', { type: 'button', className: 'bm-btn small', onClick: () => setCreatingRoutine(false) }, t('form.cancel')),
                        h('button', { type: 'submit', className: 'bm-btn small primary', disabled: busy }, t('form.save'))))
                    : null,
                  routines.length === 0 && !creatingRoutine
                    ? h('div', { className: 'bm-rail-empty' },
                      h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', opacity: 0.7 } }, h(ClockGlyph, { size: 28 })),
                      h('div', { className: 'bm-rail-empty-title' }, t('screen.routinesEmptyTitle')),
                      h('div', { className: 'bm-rail-empty-desc' }, t('screen.routinesEmptyDesc')),
                      h('button', {
                        type: 'button', className: 'bm-btn primary', style: { marginTop: '6px' },
                        onClick: () => setCreatingRoutine(true),
                      }, t('screen.routinesNew')))
                    : h('div', { className: 'bm-routine-list' },
                      routines.map(rt => h('div', { key: rt.id, className: 'bm-routine' },
                        h('div', { className: 'bm-routine-text' },
                          h('span', { className: 'bm-routine-name' }, `${rt.origin?.kind === 'bot' ? '🤖 ' : ''}${rt.name}`),
                          h('span', { className: 'bm-routine-meta' }, `${rt.cron}${rt.lastStatus ? ` · ${rt.lastStatus}` : ''}${rt.enabled ? '' : ` (${rt.pausedReason || 'paused'})`}`),
                          h('span', { className: 'bm-routine-prompt' }, rt.prompt)),
                        h('div', { className: 'bm-routine-actions' },
                          h('button', { type: 'button', className: 'bm-btn small', onClick: () => void onCommand('routine.run', { routineId: rt.id }) }, t('routine.run')),
                          h('button', { type: 'button', className: 'bm-btn small', onClick: () => void onCommand('routine.toggle', { routineId: rt.id, enabled: !rt.enabled }) }, rt.enabled ? t('routine.pause') : t('routine.resume')),
                          h('button', { type: 'button', className: 'bm-btn small danger', onClick: () => void onCommand('routine.delete', { routineId: rt.id }) }, t('routine.delete')))))))
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                  h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
                    h('span', { className: 'bm-muted' }, t('screen.files')),
                    h('div', { style: { display: 'flex', gap: '4px' } },
                      h('button', { type: 'button', className: 'bm-btn small', onClick: () => void refreshFiles() }, t('settings.logsRefresh')),
                      h('button', { type: 'button', className: 'bm-btn small primary', onClick: () => fileInputRef.current && fileInputRef.current.click() }, t('screen.upload')),
                      h('input', {
                        ref: fileInputRef, type: 'file', hidden: true,
                        onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f) void uploadScreenFile(f); e.target.value = '' },
                      }))),
                  files.length === 0
                    ? h('p', { className: 'bm-muted' }, t('screen.filesEmpty'))
                    : files.map(f => h('div', { key: f.name, className: 'bm-routine', style: { alignItems: 'center' } },
                      h('div', { className: 'bm-routine-text' },
                        h('span', { className: 'bm-routine-name' }, f.name),
                        h('span', { className: 'bm-routine-meta' }, `${Math.max(1, Math.round((f.size || 0) / 1024))} KB`)),
                      h('a', {
                        className: 'bm-btn small',
                        href: `/botmode/api/screen/file?botId=${encodeURIComponent(bot.id)}&name=${encodeURIComponent(f.name)}`,
                        download: f.name,
                        style: { textDecoration: 'none' },
                      }, t('rich.download')))))))
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
          const questions = (hostSnapshot.state && hostSnapshot.state.questions) || []
          const screenHelps = (hostSnapshot.state && hostSnapshot.state.screenHelps) || []
          const screensMap = (hostSnapshot.state && hostSnapshot.state.screens) || {}
          const screenGateway = (hostSnapshot.state && hostSnapshot.state.screenGateway) || { available: false }
          const memoryHub = (hostSnapshot.state && hostSnapshot.state.memory) || null
          const mcpInfo = (hostSnapshot.state && hostSnapshot.state.mcp) || null
          const webhooksList = (hostSnapshot.state && hostSnapshot.state.webhooks) || []
          const notificationLogs = (hostSnapshot.state && hostSnapshot.state.notificationLogs) || []
          const appSettings = (hostSnapshot.state && hostSnapshot.state.settings) || null
          const usageSummary = (hostSnapshot.state && hostSnapshot.state.usage) || null
          const artifactsList = (hostSnapshot.state && hostSnapshot.state.artifacts) || []
          const hostTools = (hostSnapshot.state && hostSnapshot.state.tools) || []
          const runtimeInfo = (hostSnapshot.state && hostSnapshot.state.runtime) || {}
          const bots = stored.filter(bot => bot.hidden !== true)
          const seenAlertIdsRef = useRef(null)
          useEffect(() => {
            const desktopOn = !appSettings || !appSettings.notifications || appSettings.notifications.desktopNotifications !== false
            const currentIds = new Set([
              ...approvals.map(a => `apr:${a.id}`),
              ...screenHelps.map(s => `scr:${s.id}`),
            ])
            if (seenAlertIdsRef.current === null) {
              seenAlertIdsRef.current = currentIds
              return
            }
            if (desktopOn && typeof window !== 'undefined' && 'Notification' in window && window.Notification.permission === 'granted') {
              for (const apr of approvals) {
                const key = `apr:${apr.id}`
                if (!seenAlertIdsRef.current.has(key)) {
                  try { new window.Notification(`Bot Approval: ${apr.botName || 'Bot'}`, { body: apr.reason || apr.toolName || 'Approval required' }) } catch (_e) {}
                }
              }
              for (const sh of screenHelps) {
                const key = `scr:${sh.id}`
                if (!seenAlertIdsRef.current.has(key)) {
                  try { new window.Notification(`Screen Takeover: ${sh.botName || 'Bot'}`, { body: sh.reason || 'Human screen intervention requested' }) } catch (_e) {}
                }
              }
            }
            seenAlertIdsRef.current = currentIds
          }, [approvals, screenHelps, appSettings])
          const lang = useLang()
          const activeLang = (lang && lang.active) || 'en'
          const [form, setForm] = useState(null)
          const [selection, setSelection] = useState(null)
          const [query, setQuery] = useState('')
          const [railOpen, setRailOpen] = useState(true)
          const [paneCollapsed, setPaneCollapsed] = useState(() => {
            try { return window.localStorage.getItem('botmode.paneCollapsed') === '1' } catch (_err) { return false }
          })
          const [takeoverModal, setTakeoverModal] = useState(null)

          useEffect(() => {
            try { window.localStorage.setItem('botmode.paneCollapsed', paneCollapsed ? '1' : '0') } catch (_err) { /* storage unavailable */ }
          }, [paneCollapsed])
          // Standalone page: while the Bot page is mounted the shell's workspace
          // sidebar is dropped, so the Bot list is the only navigation column.
          React.useLayoutEffect(() => {
            const root = document.documentElement
            const previous = root.getAttribute('data-bm-page')
            root.setAttribute('data-bm-page', 'standalone')
            closeSidebarDrawer()
            return () => {
              if (previous === null) root.removeAttribute('data-bm-page')
              else root.setAttribute('data-bm-page', previous)
            }
          }, [])

          const openScreenTakeover = async (targetBot, helpEntry = null) => {
            const botId = (targetBot && targetBot.id) || (helpEntry && helpEntry.botId)
            if (!botId) return
            const botObj = bots.find(b => b.id === botId) || targetBot
            const res = await hostCommand('screen.takeover', {
              botId,
              reason: (helpEntry && helpEntry.reason) || 'human',
            })
            setTakeoverModal({
              botId,
              botName: (botObj && botObj.name) || (helpEntry && helpEntry.botName) || botId,
              helpId: (helpEntry && helpEntry.id) || '',
              reason: (helpEntry && helpEntry.reason) || '',
              gatewayStreamUrl: (res && res.gateway_stream_url) || '',
            })
          }

          const botActivity = () => () => {}
          const botSeen = () => () => {}

          const sessionRowsOf = (bot) => {
            const roomSessions = hiddenRoomSessionIds()
            const rows = (list.ids || [])
              .filter(id => !roomSessions.has(id) && (id === bot.sessionId || (bot.dir && list.byId[id] && list.byId[id].cwd === bot.dir && list.byId[id].blank !== true)))
              .map(id => ({
                id,
                title: list.byId[id] ? (list.byId[id].displayTitle || id) : id,
                summary: list.byId[id],
                primary: id === bot.sessionId,
              }))
            if (bot.sessionId && !rows.some(row => row.id === bot.sessionId)) {
              rows.unshift({
                id: bot.sessionId,
                title: bot.name || bot.sessionId,
                summary: {
                  sessionId: bot.sessionId,
                  displayTitle: bot.name || bot.sessionId,
                  cwd: bot.dir || '',
                  updatedAt: bot.lastTurnAt ? Date.parse(bot.lastTurnAt) || 0 : 0,
                  running: bot.running === true,
                },
                primary: true,
              })
            }
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
          const isSettingsView = selection && (selection.kind === 'settings' || selection.kind === 'memory')
          const activeBot = selectedBot || (selection && (selection.kind === 'group' || selection.kind === 'settings' || selection.kind === 'memory') ? undefined : bots[0])
          const activeGroup = selection && selection.kind === 'group'
            ? groups.find(group => group.id === selection.id)
            : undefined
          const activeSessionId = activeBot ? activeBot.sessionId : null
          const activeRows = activeBot ? sessionRowsOf(activeBot) : []

          const openBotEntry = (bot) => { setSelection({ kind: 'bot', id: bot.id }); setForm(null) }
          const openGroupEntry = (group) => { setSelection({ kind: 'group', id: group.id }); setForm(null) }
          const openSettingsView = (moduleKey = 'soul', targetBotId = '') => {
            setSelection({ kind: 'settings', module: moduleKey, botId: targetBotId || (activeBot && activeBot.id) || '' })
            setForm(null)
          }
          const createGroup = async (draft) => {
            const room = await hostCommand('room.save', { draft: {
              name: draft.name,
              memberIds: draft.members,
              mode: draft.mode || 'auto',
              leadBotId: draft.leadBotId || '',
              workDir: draft.workDir || '',
              purpose: draft.purpose || '',
              notes: draft.notes || '',
              tokenLimit: draft.tokenLimit !== undefined ? draft.tokenLimit : 0,
              idleRoundLimit: draft.idleRoundLimit || 5,
              maxRounds: draft.maxRounds !== undefined ? draft.maxRounds : 0,
              maxMessages: draft.maxMessages !== undefined ? draft.maxMessages : 0,
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
              leadBotId: draft.leadBotId || '',
              workDir: draft.workDir ?? group.workDir ?? '',
              purpose: draft.purpose ?? group.purpose ?? '',
              notes: draft.notes ?? group.notes ?? '',
              tokenLimit: draft.tokenLimit !== undefined ? draft.tokenLimit : ((group.budget && group.budget.tokenLimit) ?? 0),
              idleRoundLimit: draft.idleRoundLimit ?? (group.budget && group.budget.idleRoundLimit) ?? 5,
              maxRounds: draft.maxRounds !== undefined ? draft.maxRounds : ((group.budget && group.budget.maxRounds) ?? 0),
              maxMessages: draft.maxMessages !== undefined ? draft.maxMessages : ((group.budget && group.budget.maxMessages) ?? 0),
            } })
            setForm(null)
          }
          const deleteGroup = async (group) => {
            await hostCommand('room.delete', { roomId: group.id })
            setForm(null)
            setSelection(null)
          }

          const botRow = (bot) => {
            const summary = sessionOf(list, bot)
            const active = activeBot && activeBot.id === bot.id
            const time = bot.lastTurnAt ? Date.parse(bot.lastTurnAt) : (summary && summary.updatedAt)
            const preview = bot.lastReply || bot.role || t('card.noPreview')
            const scr = screensMap[bot.id]
            const scrState = scr && scr.healthy && scr.state !== 'STOPPED' ? scr.state : ''
            return h('button', {
              key: bot.id, type: 'button', className: 'bm-frow', 'data-active': active,
              onClick: () => openBotEntry(bot),
            },
              h(BotAvatarBadge, { bot, size: 'sm' }),
              h('span', { className: 'bm-frow-text' },
                h('span', { className: 'bm-frow-top' },
                  h('span', { className: 'bm-frow-name' }, bot.name),
                  time ? h('span', { className: 'bm-frow-time' }, new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null),
                h('span', { className: 'bm-frow-preview' }, preview)),
              scrState ? h('span', { className: 'bm-bot-screen-dot', 'data-state': scrState, title: scrState }) : null,
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
          const approvalBanner = (approvals.length === 0 && questions.length === 0 && screenHelps.length === 0) ? null : h('div', { className: 'bm-approvals' },
            screenHelps.map(help => h(ScreenHelpCard, {
              key: help.id,
              entry: help,
              onCommand: hostCommand,
              onTakeover: (entry) => { void openScreenTakeover(null, entry) },
            })),
            approvals.map(approval => h('div', { key: approval.id, className: 'bm-approval' },
              h('div', { className: 'bm-approval-text' },
                h('span', { className: 'bm-approval-name' }, approval.botName),
                h('span', { className: 'bm-approval-tool' }, approval.toolName),
                approval.reason ? h('span', { className: 'bm-approval-reason' }, approval.reason) : null),
              h('div', { className: 'bm-approval-actions' },
                h('button', { className: 'bm-btn small primary', onClick: () => hostCommand('approval.decide', { approvalId: approval.id, decision: 'once' }).catch(() => {}) }, t('approval.once')),
                !approval.roomId
                  ? h('button', { className: 'bm-btn small', onClick: () => hostCommand('approval.decide', { approvalId: approval.id, decision: 'session' }).catch(() => {}) }, t('approval.session'))
                  : null,
                !approval.roomId
                  ? h('button', { className: 'bm-btn small', onClick: () => hostCommand('approval.decide', { approvalId: approval.id, decision: 'always' }).catch(() => {}) }, t('approval.always'))
                  : null,
                h('button', { className: 'bm-btn small danger', onClick: () => hostCommand('approval.decide', { approvalId: approval.id, decision: 'deny' }).catch(() => {}) }, t('approval.deny'))))),
            questions.map(question => h(QuestionCard, { key: question.id, entry: question })))
          const paneChevron = h('svg', {
            width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
          }, h('path', {
            d: paneCollapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6',
            stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          }))
          const paneToggleLabel = t(paneCollapsed ? 'pane.expand' : 'pane.collapse')
          const paneCollapseButton = h('button', {
            type: 'button',
            className: 'bm-pane-collapse',
            title: paneToggleLabel,
            'aria-label': paneToggleLabel,
            'aria-expanded': paneCollapsed ? 'false' : 'true',
            onClick: () => setPaneCollapsed(value => !value),
          }, paneChevron)
          const paneRail = h('div', { className: 'bm-pane-rail' },
            visibleBots.length === 0
              ? h('span', { className: 'bm-pane-rail-empty' }, t('pane.empty'))
              : visibleBots.map(bot => h('button', {
                key: `rail-bot-${bot.id}`,
                type: 'button',
                className: 'bm-pane-rail-btn',
                title: bot.role ? `${bot.name} · ${bot.role}` : bot.name,
                'aria-label': bot.name,
                'data-active': Boolean(activeBot && activeBot.id === bot.id) || undefined,
                onClick: () => openBotEntry(bot),
              },
                h(BotAvatarBadge, { bot, size: 'sm' }),
                bot.running ? h('span', { className: 'bm-pane-rail-dot' }) : null)),
            visibleGroups.length > 0 ? h('span', { className: 'bm-pane-rail-sep' }) : null,
            visibleGroups.map(group => h('button', {
              key: `rail-group-${group.id}`,
              type: 'button',
              className: 'bm-pane-rail-btn',
              title: group.name,
              'aria-label': group.name,
              'data-active': Boolean(activeGroup && activeGroup.id === group.id) || undefined,
              onClick: () => openGroupEntry(group),
            },
              h('span', { className: 'bm-avatar bm-avatar-sm', style: { background: group.color || COLORS[3] } }, initialOf(group.name)),
              group.needsYou ? h('span', { className: 'bm-pane-rail-dot' }) : null)))
          const paneRailFoot = h('div', { className: 'bm-pane-rail-foot' },
            h('button', {
              type: 'button',
              className: 'bm-pane-rail-btn',
              title: t('page.new'),
              'aria-label': t('page.new'),
              onClick: () => setForm({ mode: 'create' }),
            }, h('svg', {
              width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
            }, h('path', {
              d: 'M12 5v14M5 12h14', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
            }))),
            h('button', {
              type: 'button',
              className: 'bm-pane-rail-btn',
              title: t('pane.settings'),
              'aria-label': t('pane.settings'),
              onClick: () => openSettingsView('soul'),
            }, h(SettingsIcon, { kind: 'gear' })),
            h('button', {
              type: 'button',
              className: 'bm-pane-rail-btn',
              title: t('foot.back'),
              'aria-label': t('foot.back'),
              onClick: toHarness,
            }, h(PanelIcon, { size: 17 })))
          const pane = h('aside', { className: 'bm-pane', 'data-collapsed': paneCollapsed ? 'true' : undefined },
            h('div', { className: 'bm-pane-head' },
              paneCollapsed ? null : h('span', { className: 'bm-pane-title' }, t('pane.title')),
              h('div', { className: 'bm-pane-actions' },
                paneCollapsed ? null : h('button', { className: 'bm-btn small primary', onClick: () => setForm({ mode: 'create' }) }, t('page.new')),
                paneCollapseButton)),
            paneCollapsed
              ? paneRail
              : h(React.Fragment, null,
                h('input', {
                  className: 'bm-search', value: query, placeholder: t('pane.search'),
                  onChange: event => setQuery(event.target.value),
                }),
                h('div', { className: 'bm-groups' },
                  h('div', { className: 'bm-section' },
                    h('span', null, t('pane.general'))),
                  visibleBots.length === 0
                    ? h('p', { className: 'bm-muted bm-pane-empty' }, t('pane.empty'))
                    : h('div', { className: 'bm-bot-group' }, visibleBots.map(botRow)),
                  h('div', { className: 'bm-section' },
                    h('span', null, t('pane.groups')),
                    h('button', { className: 'bm-section-add', onClick: () => setForm({ mode: 'group' }) }, t('pane.newGroup'))),
                  visibleGroups.length === 0
                    ? h('p', { className: 'bm-muted bm-pane-empty' }, t('group.none'))
                    : visibleGroups.map(groupRow))),
            paneCollapsed
              ? paneRailFoot
              : h('div', { className: 'bm-pane-foot' },
                h('button', {
                  type: 'button',
                  className: `bm-btn small${isSettingsView ? ' primary' : ''}`,
                  style: { display: 'inline-flex', alignItems: 'center', gap: '5px', flex: 1, justifyContent: 'center' },
                  onClick: () => openSettingsView('soul'),
                }, h(SettingsIcon, { kind: 'gear' }), t('pane.settings')),
                h('button', { type: 'button', className: 'bm-btn small', onClick: toHarness }, t('foot.back'))))

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
                      color: '',
                      avatar: null,
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
                      avatar: form.bot.avatar ? { ...form.bot.avatar } : defaultClientAvatar(form.bot.color),
                      sectionId: form.bot.sectionId || 'general',
                      model: form.bot.model || { provider: '', model: '', reasoningEffort: '' },
                      tools: form.bot.tools || { allow: [], deny: [] },
                      approvalPolicy: form.bot.approvalPolicy || 'ask',
                    },
                  onCancel: () => setForm(null),
                  onDone: () => setForm(null),
                })
            : isSettingsView
              ? h(SettingsView, {
                key: `settings-${selection && selection.botId ? selection.botId : 'all'}`,
                initialBotId: (selection && selection.botId) || '',
                initialModule: (selection && selection.module) || (selection && selection.kind === 'memory' ? 'memory' : 'soul'),
                bots,
                rooms: groups,
                routines,
                sections,
                models,
                memory: memoryHub,
                mcp: mcpInfo,
                webhooks: webhooksList,
                notificationLogs,
                settings: appSettings,
                usage: usageSummary,
                artifacts: artifactsList,
                tools: hostTools,
                runtime: runtimeInfo,
                screenGateway,
                systemInfo: (hostSnapshot.state && hostSnapshot.state.system) || null,
                onReloadModels: (force) => { void loadModels(force) },
                onCommand: hostCommand,
                onNewBot: () => setForm({ mode: 'create' }),
                onEditGroup: (room) => setForm({ mode: 'groupEdit', group: room }),
              })
            : activeGroup
              ? h(GroupChat, {
                key: activeGroup.id,
                group: activeGroup,
                bots,
                settings: appSettings,
                onEdit: () => setForm({ mode: 'groupEdit', group: activeGroup }),
              })
              : activeBot && activeSessionId
                ? h('div', { className: 'bm-workspace' },
                  h(ChatPane, {
                    key: activeSessionId,
                    sessionId: activeSessionId,
                    bot: activeBot,
                    models,
                    detail: detailBody,
                    railOpen,
                    onToggleRail: () => setRailOpen(v => !v),
                    onActivity: botActivity(activeBot),
                    onSeen: botSeen(activeBot),
                  }),
                  railOpen
                    ? h(RightScreenPanel, {
                      key: `rail-${activeBot.id}`,
                      bot: activeBot,
                      screen: screensMap[activeBot.id] || null,
                      screenGateway,
                      systemInfo: (hostSnapshot.state && hostSnapshot.state.system) || null,
                      hostScreenSupported: Boolean(hostSnapshot.state && 'screenGateway' in hostSnapshot.state),
                      gatewayAvailable: screenGateway.available === true,
                      routines: routines.filter(routine => routine.botId === activeBot.id),
                      onCommand: hostCommand,
                      onRefreshHost: () => { void refreshHost() },
                      onOpenSystemSettings: () => openSettingsView('system'),
                      onOpenTakeover: (b) => openScreenTakeover(b, screenHelps.find(s => s.botId === b.id) || null),
                    })
                    : null)
                : activeBot
                  ? h('section', { className: 'bm-detail-col' }, detailBody)
                  : h('section', { className: 'bm-empty bm-detail-empty' },
                  h('h2', null, t('page.empty.title')),
                  h('p', null, t('page.empty.body')),
                  h('button', { className: 'bm-btn primary', onClick: () => setForm({ mode: 'create' }) }, t('page.empty.cta')))

          const fullBleedRight = !form && (isSettingsView || activeGroup || (activeBot && activeSessionId))
          return h('div', { className: 'bm-page bm-page-split' },
            h('style', null, CSS),
            pane,
            h('section', {
              className: 'bm-detail-col',
              style: fullBleedRight ? { padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' } : undefined,
            }, hostNotice, approvalBanner, detail),
            h(ScreenTakeoverModal, {
              modal: takeoverModal,
              screen: takeoverModal ? (screensMap[takeoverModal.botId] || null) : null,
              onCommand: hostCommand,
              onScreenInput: sendScreenInput,
              onClose: () => setTakeoverModal(null),
            }))
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


        function RemoteIcon({ size = 15 }) {
          return h('svg', {
            width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true',
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round',
          },
            h('rect', { x: 2, y: 2, width: 4.6, height: 4.6, rx: 0.9 }),
            h('rect', { x: 9.4, y: 2, width: 4.6, height: 4.6, rx: 0.9 }),
            h('rect', { x: 2, y: 9.4, width: 4.6, height: 4.6, rx: 0.9 }),
            h('path', { d: 'M9.6 9.6h1.6v1.6H9.6zM12.6 12.6h1.2v1.2h-1.2zM12.6 9.6h1.2M9.6 12.9h1.6' }))
        }

        function RemoteDialog({ onClose }) {
          const t = useT()
          const [data, setData] = useState(null)
          const [busy, setBusy] = useState('')
          const [error, setError] = useState('')
          const [toast, setToast] = useState('')
          const toastTimer = useRef(null)

          const flash = (message) => {
            setToast(message)
            if (toastTimer.current) window.clearTimeout(toastTimer.current)
            toastTimer.current = window.setTimeout(() => setToast(''), 2200)
          }
          useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])

          const load = async (ensure = false) => {
            setError('')
            setBusy(ensure ? t('remote.starting') : '')
            try {
              let next = await hostRequest('remote')
              if (ensure && (!next.running || !next.healthy)) next = await hostCommand('remote.up')
              setData(next)
              if (!next.appLink) setError(t('remote.appDisabled'))
            } catch (failure) {
              setError(String(failure && failure.message ? failure.message : failure))
            } finally {
              setBusy('')
            }
          }

          useEffect(() => { void load(true) }, [])
          useEffect(() => {
            const onKey = (event) => { if (event.key === 'Escape') onClose() }
            window.addEventListener('keydown', onKey)
            return () => window.removeEventListener('keydown', onKey)
          }, [onClose])

          const rotateApp = async () => {
            setError('')
            setBusy(t('remote.rotating'))
            try {
              const next = await hostCommand('remote.rotateApp')
              setData(next)
              if (next && next.rotated) flash(t('remote.rotatedApp'))
              else if (next && next.error === 'app-bridge-disabled') setError(t('remote.appDisabled'))
            } catch (failure) {
              setError(String(failure && failure.message ? failure.message : failure))
            } finally {
              setBusy('')
            }
          }

          const stop = async () => {
            setError('')
            setBusy(t('remote.stoppedToast'))
            try {
              const next = await hostCommand('remote.down')
              setData(next)
              flash(t('remote.stoppedToast'))
            } catch (failure) {
              setError(String(failure && failure.message ? failure.message : failure))
            } finally {
              setBusy('')
            }
          }

          const copy = async () => {
            const value = data && data.appLink
            if (!value) return
            try {
              await navigator.clipboard.writeText(value)
              flash(t('remote.copied'))
            } catch {
              flash(t('remote.copyFailed'))
            }
          }

          const chips = []
          if (data) {
            chips.push(h('span', { className: 'bm-remote-chip', 'data-ok': data.running ? 'true' : 'false' },
              data.running ? t('remote.running') : t('remote.stopped')))
            if (data.running) {
              chips.push(h('span', { className: 'bm-remote-chip', 'data-ok': data.healthy ? 'true' : 'false' },
                data.healthy ? t('remote.healthy') : t('remote.unhealthy')))
            }
            if (data.tunnel && data.tunnel.mode) {
              chips.push(h('span', { className: 'bm-remote-chip' }, `${t('remote.tunnel')}: ${data.tunnel.mode} · ${data.tunnel.state || '-'}`))
            }
            if (data.pid) chips.push(h('span', { className: 'bm-remote-chip' }, `${t('remote.pid')}: ${data.pid}`))
          }

          const appPane = data && data.appLink
            ? h('div', { className: 'bm-remote-pane' },
              h('div', { className: 'bm-remote-qr-wrap' },
                data.appQrDataUrl
                  ? h('img', { className: 'bm-remote-qr', src: data.appQrDataUrl, alt: 'QR' })
                  : h('div', { className: 'bm-remote-empty' }, data.appQrError || t('remote.failed'))),
              h('div', { className: 'bm-remote-hint' }, t('remote.appLabel')),
              h('div', { className: 'bm-remote-link' }, data.appLink),
              h('div', { className: 'bm-remote-hint' }, t('remote.appHint')))
            : h('div', { className: 'bm-remote-empty' }, busy || t('remote.appDisabled'))

          const dialog = h('div', {
            className: 'bm-modal-backdrop bm-remote-backdrop',
            onClick: (event) => { if (event.target === event.currentTarget) onClose() },
          },
            h('div', { className: 'bm-remote-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('remote.title') },
              h('div', { className: 'bm-remote-head' },
                h('div', null,
                  h('div', { className: 'bm-remote-title' }, t('remote.title')),
                  h('div', { className: 'bm-remote-sub' }, t('remote.appSubtitle'))),
                h('button', { type: 'button', className: 'bm-remote-x', onClick: onClose, 'aria-label': t('remote.close') }, '×')),
              h('div', { className: 'bm-remote-body' },
                chips.length > 0 ? h('div', { className: 'bm-remote-meta' }, ...chips) : null,
                appPane,
                busy ? h('div', { className: 'bm-remote-busy' }, busy) : null,
                error ? h('div', { className: 'bm-remote-error' }, error) : null),
              h('div', { className: 'bm-remote-foot' },
                h('button', {
                  type: 'button', className: 'bm-remote-btn', 'data-primary': 'true',
                  onClick: copy, disabled: !(data && data.appLink),
                }, t('remote.copyApp')),
                h('button', { type: 'button', className: 'bm-remote-btn', onClick: () => load(false), disabled: Boolean(busy) }, t('remote.refresh')),
                h('button', { type: 'button', className: 'bm-remote-btn', onClick: rotateApp, disabled: Boolean(busy) || !(data && data.appLink) }, t('remote.rotateApp')),
                h('button', { type: 'button', className: 'bm-remote-btn', 'data-danger': 'true', onClick: stop, disabled: Boolean(busy) || !(data && data.running) }, t('remote.stop')),
                toast ? h('span', { className: 'bm-remote-toast' }, toast) : null)))

          // 侧边栏存在 transform 祖先，fixed 定位会被拽回；挂到 body 才是真正的全屏浮层
          return typeof ReactDOM?.createPortal === 'function' && document?.body
            ? ReactDOM.createPortal(h(React.Fragment, null, h('style', null, REMOTE_CSS), dialog), document.body)
            : dialog
        }

        function RemoteFooterButton(props) {
          const t = useT()
          const [open, setOpen] = useState(false)
          return h('div', { style: { display: 'contents' } },
            h('button', {
              type: 'button',
              className: 'bm-foot-toggle bm-remote-trigger',
              'data-wide': props.wide !== false,
              title: t('remote.button'),
              onClick: () => setOpen(true),
            },
              h(RemoteIcon, { size: 15 }),
              props.wide === false ? null : h('span', null, t('remote.button'))),
            open ? h(RemoteDialog, { onClose: () => setOpen(false) }) : null)
        }

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'botmode.remote',
          order: 11,
          label: () => (typeof locale.getLocale === 'function'
            ? (String((locale.getLocale() || {}).active || '').startsWith('zh') ? '远程访问' : 'Remote')
            : 'Remote'),
          locale: NS,
        }, RemoteFooterButton))

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