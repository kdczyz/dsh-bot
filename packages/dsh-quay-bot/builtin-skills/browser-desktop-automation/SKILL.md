---
name: browser-desktop-automation
description: Unified browser & desktop automation workflow with progressive circuit-breaker escalation (L1 CLI/HTTP -> L2 open-source agent-browser/Playwright -> L3 BotScreen virtual desktop GUI -> L4 human takeover via screen_request_help on repeated failures or hard blockers).
whenToUse: Whenever a task requires web browsing, page scraping, form filling, web app testing, GUI/desktop interaction, Electron app operation, or handling CAPTCHA/MFA/login/payment blockers.
---

# Browser & Desktop Automation (Progressive Circuit-Breaker Escalation)

Follow the **L1 → L2 → L3 → L4** escalation ladder strictly. Never get trapped repeating the same failing action; trigger circuit-breaker escalation immediately when thresholds are met.

---

## L1 · Zero-UI Fast Path (CLI / HTTP / API First)
Before launching any browser or GUI window, check if the task can be solved deterministically without UI:
- Static pages / public docs / REST APIs → use `web_fetch`, `web_search`, or `bash` (`curl`, `python3`).
- Local files / service management → use `read`, `grep`, `bash`.
- **Escalate to L2** if the target requires JS rendering, interactive DOM state, cookies/login sessions, or visual verification.

---

## L2 · Open-Source Browser Automation (`agent-browser` / Shared OSS Skills)
For web pages, SaaS portals, and Electron apps, prefer fast headless/CDP automation via open-source tools before pixel clicking:
1. **Primary CLI (`agent-browser`)**:
   - First load its up-to-date workflow if needed (`skill({ name: "agent-browser" })` or `agent-browser skills get core`).
   - On Linux ARM64 where Chrome for Testing is unavailable, ensure Chrome points to system Chrome (`--executable-path /usr/bin/google-chrome` or `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome`).
   - Core loop:
     ```bash
     agent-browser open "<url>"
     agent-browser snapshot              # Accessibility tree with deterministic [ref=eN]
     agent-browser click @eN             # Prefer @eN refs over brittle CSS selectors
     agent-browser fill @eN "value"
     agent-browser press Enter
     agent-browser screenshot /tmp/page.png
     ```
2. **Alternative shared OSS browser skills** (available via shared normal-mode skills at secondary priority):
   - Use `skill({ name: "webapp-testing" })` (Playwright) for scripted local web app E2E verification.
3. **L2 → L3 Circuit-Breaker Thresholds** (escalate immediately if ANY holds):
   - The same navigation/locator step fails **2 consecutive times** (e.g. shadow DOM / canvas / iframe / dynamic anti-bot DOM).
   - Anti-bot challenge, real Chrome profile persistence, or visual canvas interaction is required.
   - The task involves native Linux desktop apps, file dialogs, OS popups, or non-browser GUIs.

---

## L3 · Dedicated Virtual Desktop Visual Automation (BotScreen `screen_*`)
Every Bot owns an isolated 1280×720 Linux virtual desktop. Operate strictly in an **Observe → Act → Verify** loop:
1. Launch / inspect:
   - `screen_open_app({ app: "chrome" | "terminal" | "files", url })`
   - `screen_windows()` to verify focus and active window geometry.
   - `screen_screenshot({ include_focus: true })` to inspect current pixels (auto-wakes frozen screens; if `resumedFromLongFreeze: true`, refresh expired tabs).
2. Interact cleanly:
   - Click / double-click / right-click: `screen_click({ x, y, button, double, observe: true })`
   - Text input (supports Chinese & emoji via clipboard):
     - Browsers / GUI fields: `screen_type({ text, press_enter, paste_key: "ctrl+v", observe: true })`
     - Terminal windows: **MUST** use `paste_key: "shift+Insert"`!
   - Shortcuts & navigation: `screen_key({ combo: "ctrl+l" | "Return" | "Escape" | "Page_Down", observe: true })`
   - Scroll / drag: `screen_scroll({ x, y, clicks, observe: true })`, `screen_drag({ x1, y1, x2, y2, observe: true })`
3. **Anti-Loop Verification Rule**:
   - Always pass `observe: true` on mutating GUI actions or take a follow-up screenshot to confirm pixel/state change.
   - If a screenshot looks identical (stale frame or unmapped window), check `screen_windows()` or capture PNG once before retrying.
4. **L3 → L4 Circuit-Breaker Thresholds** (escalate immediately if ANY holds):
   - **Hard human-only blocker encountered** (do NOT waste retries):
     - Real CAPTCHA / slider / puzzle / turnstile verification (`category: "captcha"`)
     - QR code scan / SMS / hardware-key / 2FA / MFA login (`category: "login"` or `"mfa"`)
     - Real payment / financial checkout confirmation (`category: "payment"`)
     - Irreversible destructive / privileged external authorization (`category: "confirm"`)
   - **Repeated failure circuit breaker**:
     - The same GUI step fails **3 consecutive times** despite adjusting coordinates, focus, or fallback shortcuts (`category: "manual"`).

---

## L4 · Human Takeover & Seamless Resume (`screen_request_help`)
When L3 trips the circuit breaker:
1. Call `screen_request_help` with **structured, actionable context**:
   ```json
   {
     "category": "captcha | login | mfa | payment | confirm | manual",
     "reason": "Exact blocker on screen and the exact action the human needs to perform.",
     "tried": "Concrete L2/L3 steps already attempted and why they failed."
   }
   ```
2. **Wait cleanly**: The tool pops a live takeover card for the human operator, pauses until the human finishes and hands control back, and returns the updated post-takeover screenshot.
3. **Post-Takeover Verification & Memory Persistence**:
   - Inspect the returned screenshot to confirm the blocker is cleared before continuing.
   - If you discovered a durable environmental fact (e.g., working Chrome path, login URL quirk, stable shortcut, site-specific anti-bot workaround), persist a concise 1–2 line fact via `memory_save` so future runs skip trial-and-error.
