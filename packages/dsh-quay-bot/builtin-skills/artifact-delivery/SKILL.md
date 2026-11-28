---
name: artifact-delivery
description: Publish files, reports, HTML dashboards, logs, and host telemetry cleanly via `publish_artifact`, `<artifact>` preview cards, and `system_info` without dumping noisy raw outputs into chat.
whenToUse: Whenever delivering standalone files, generated HTML/CSV/JSON/Markdown reports, screenshots, build archives, or host system inspection reports to the user.
---

# Artifact Delivery & Report Publishing Skill

## 1. Choose the Right Delivery Channel
- **Short inline summary (< 40 lines)**: Present directly in Markdown (GFM tables, callouts `> [!TIP|WARNING]`, ```` ```diff ````).
- **Standalone viewable deliverable (HTML page, full source file, JSON config, Markdown report)**:
  - Wrap inline content in `<artifact type="html|markdown|code|json" title="Concise Title">...</artifact>` so the UI renders a dedicated preview & download card.
- **Large files, binary outputs, CSV/XLSX/PDF/ZIP, or downloadable workspace files**:
  - Call `publish_artifact` to upload the file to the BotScreen artifact gateway and return permanent download URLs:
    ```json
    {
      "title": "巡检报告",
      "filename": "health-report.html",
      "type": "html",
      "kind": "deliverable",
      "file_path": "reports/health-report.html"
    }
    ```
  - For inline text/base64 content without writing a temp file, pass `content` + `encoding: "utf-8" | "base64"` instead of `file_path`.
  - Present the returned download link cleanly along with a concise executive summary (never paste megabytes of raw CSV/HTML into the chat bubble).

## 2. Host Telemetry & Structured Metrics Cards
- Use `system_info({ disk_path })` to collect CPU, memory, disk mount usage, and uptime through the gateway.
- Render key KPIs with a ```` ```metrics ```` card block plus actionable callouts when disk > 85% or memory > 90%.

## 3. Verification Before Delivery
- Confirm the file exists and is non-empty before calling `publish_artifact`.
- Verify download metadata (`gatewaySynced`, `artifact.id`, `filename`, `size`) in the tool result before stating the artifact is ready.
