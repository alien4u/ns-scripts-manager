> **Disclaimer:** This is a personal project shared under the [FSL-1.1-MIT License](LICENSE). It is not intended to replace, compete with, or serve as an alternative to any other similar plugin, extension, or tool, commercial or otherwise. Use it as you see fit, at your own risk.
>
> The idea of viewing script deployments from a browser extension was inspired by [**NetSuite Scripted Records**](https://chromewebstore.google.com/detail/netsuite-scripted-records/jbbdkpibfpmkdhekgblfdicjpbkjfpno) by [Marcel Pestana](https://marcelpestana.com). NetSuite Scripts Manager is a completely independent, ground-up implementation using a different architecture (N/query + N/search APIs vs. page scraping), a different UI (card-based layout vs. tables), and additional features not found in the original, but the original idea of surfacing this information in an extension popup belongs to Marcel.
>
> In response to [Oracle's security notification regarding Chrome extensions](https://community.oracle.com/netsuite/english/discussion/4512418/security-notification-chrome-extensions), this extension has been made fully open source so that anyone can audit the code, verify its behavior, and confirm that it does not collect, transmit, or store any sensitive data. Transparency is the best security policy.

---

# NetSuite Scripts Manager

**Instantly view all deployed scripts and workflows on any NetSuite record. Sort by execution order, filter, and jump to source code in one click.**

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-FSL--1.1--MIT-green)
![Manifest](https://img.shields.io/badge/manifest-v3-orange)

## Store Availability

| Store | Version | Link |
|-------|---------|------|
| Chrome Web Store | v1.0.0 | *Coming soon* |
| Edge Add-ons | v1.0.0 | *Coming soon* |
| Firefox Add-ons | v1.0.0 | *Coming soon* |

## Overview

NetSuite Scripts Manager is a browser extension for NetSuite administrators, developers, and consultants. It gives you instant visibility into every script deployment and workflow attached to any record type you're viewing in NetSuite. No more digging through script deployment lists or the workflow manager.

Open any record, click the icon, and get a clean, organized breakdown of everything running on that page.

## Features

### Script & Workflow Explorer

- 📜 **Auto-Detect Record Type** · Reads the record type from the page and retrieves all relevant SuiteScript deployments and workflows. Works on standard records, custom records, and custom transactions.

- ⚡ **Dual API Support** · Uses SuiteScript 2.x (`N/query`, `N/search`, `N/currentRecord`) as the primary engine, with automatic SuiteScript 1.0 fallback for pages where 2.x modules aren't available.

- 🎯 **On-Demand Execution** · Scripts only run when you click the extension icon, not on every page load. Zero impact on your daily NetSuite browsing and no wasted governance.

- 📊 **Stack Order Sorting** · Default sort by actual execution order, scraped from NetSuite's Scripted Records page. See exactly which scripts fire first across server, client, and localized layers.

- 🔤 **Alphabetical Sort** · Sort scripts A-Z or Z-A within their type groups.

- 🏷️ **Entry Point Tags** · Each card shows which entry points are defined (beforeLoad, afterSubmit, pageInit, fieldChanged, etc.) so you can see at a glance what each script does.

- ✅ **Deployed-Only Filter** · Show only deployed scripts and released workflows.

- ⚠️ **Script Count Warnings** · Visual badges warn when a record type approaches or exceeds NetSuite's recommended script limits (10 Client Scripts per record, high User Event counts).

- 🔒 **Bundle Lock Indicator** · Scripts hidden in bundles are marked with a lock icon so you know which ones you can't modify.

- 🔗 **One-Click Access** · Open script records, edit them, view source files, or open workflow definitions directly from each card.

- ℹ️ **Info Tooltips** · Hover for API version, description, and script file name.

- 🔀 **Drag-and-Drop Group Ordering** · Arrange script type groups (User Event, Client, Mass Update, etc.) in your preferred priority. Your order is saved automatically.

- 🌙 **Dark / Light Mode**

- 📐 **Compact Mode** · Condensed layout for smaller screens.

- 🔲 **Resizable Popup** · Drag the bottom-left corner to resize the popup window. Dimensions are saved automatically.

- 🔄 **Refresh** · Force a fresh data fetch at any time.

- 💡 **Smart Icon** · The extension icon is only active on NetSuite pages. It grays out automatically on non-NetSuite sites.

### Scheduled Deployments Sync

- 🕐 **Collect** · Gather all Scheduled and Map/Reduce deployments with status "Scheduled" from your production environment.

- 🔍 **Check** · Compare stored deployment statuses against the current environment (sandbox, preview) to see what changed after a refresh.

- 🚀 **Apply** · Re-apply "Scheduled" status to selected deployments in the target environment with progress tracking and per-item error reporting.

- 🛡️ **Safety Warning Gate** · A detailed risk assessment and acknowledgment checklist is shown before any apply operation, explaining why NetSuite resets deployment statuses during sandbox refreshes.

- 🌐 **Environment Detection** · Automatically detects Production, Sandbox, and Preview environments from the URL.

- 🔄 **Cross-Environment ID Resolution** · Handles internal ID mismatches between environments via script ID fallback lookups.

## Script Details

| Field | Description |
|-------|-------------|
| Script Name | Clickable link to the script record |
| Script Type | User Event, Client, Mass Update, Workflow Action, Custom GL Lines, etc. |
| Deployed | Green dot indicator for active deployments |
| Status | Released, Testing, etc. (shown as badge) |
| Entry Points | Tags showing defined hooks (beforeLoad, afterSubmit, pageInit, etc.) |
| Info (hover) | Script file name, API version, description |

## Workflow Details

| Field | Description |
|-------|-------------|
| Workflow Name | Clickable link to the workflow definition |
| Status | Released, Testing, Not Initiating, Suspended (shown as badge) |
| Edit | Direct link to open the workflow in edit mode |
| Info (hover) | Description |

## How It Works

### Script & Workflow Explorer

1. Navigate to any record page in NetSuite.
2. Click the extension icon (it lights up on NetSuite pages).
3. View grouped sections for Script Deployments and Workflows.
4. Click any name to open the script record. Use the edit icon for edit mode, or the code icon for the source file.
5. Hover the info icon for API version, description, and file name.

All data is retrieved live from the page context via NetSuite's native APIs. No external data collection, no login prompts, no storage of sensitive info.

### Scheduled Deployments Sync

1. Open any NetSuite record in your **production** environment.
2. Click the extension icon, then the 🕐 **Scheduler** button.
3. Click **Collect** to gather all Scheduled/Map-Reduce deployments.
4. Switch to your **sandbox** or **preview** environment.
5. Click **Check** to compare statuses, then **Apply** to restore selected deployments.

## Architecture

```
[User clicks icon]
        |
        v
    popup.html / popup.js
        |
        +-- INJECT_AND_GET_DATA -> background.js
        |                              |
        |                   chrome.scripting.executeScript
        |                       (injects content.js)
        |                              |
        |                        content.js (ISOLATED world)
        |                 (injects nsmain.js via <script>)
        |                              |
        |                         nsmain.js (MAIN world)
        |                  (runs in page context)
        |                  +-- Try SS 2.x (N/query, N/search)
        |                  +-- Fallback: SS 1.0 (nlapiSearchRecord)
        |                              |
        |                  window.postMessage(SCRIPTS_DATA)
        |                              |
        |                        content.js stores it
        |                              |
        +-- Poll GET_SCRIPTS_DATA ---->|
        |                              |
        <-- Response ------------------+
        |
        +-- fetch(scriptedrecord.nl) -> Parse stack order
        +-- Apply sort / filter
        +-- Render as cards


[Scheduler Sync]
        |
    popup.js -> INJECT_SCHEDULER -> background.js
        |                              |
        |                   chrome.scripting.executeScript
        |                       (injects content.js)
        |                              |
        |                        content.js
        |                 (injects nsscheduler.js via <script>)
        |                              |
        |                     nsscheduler.js (MAIN world)
        |                  +-- collect: N/search scheduled deployments
        |                  +-- check: lookup current statuses
        |                  +-- apply: N/record.submitFields per item
        |                              |
        |                  window.postMessage(SCHEDULER_*_RESULT)
        |                              |
        +-- Poll results ------------->|
```

## Installation

### From Source (Developer Mode)

1. Clone this repository
2. Open your browser's extension management page:
   - **Chrome:** `chrome://extensions`
   - **Edge:** `edge://extensions`
   - **Firefox:** `about:debugging#/runtime/this-firefox`
3. Enable **Developer Mode**
4. Click **Load unpacked** and select the project folder

> **Firefox users:** Before loading, rename `manifest_firefox.json` to `manifest.json` (replacing the original). The Firefox manifest includes the required `background.scripts` fallback and `browser_specific_settings` for Firefox compatibility.

### Permissions

| Permission | Purpose |
|------------|---------|
| `host_permissions: *.netsuite.com` | Inject scripts and interact with NetSuite pages |
| `activeTab` | Interact with the current record page when activated |
| `storage` | Persist preferences (theme, filter, sort, group order, scheduler data) |
| `scripting` | Inject data-fetching scripts into NetSuite on demand |

## Browser Compatibility

Chrome, Edge, Firefox (MV3, 121+), and Safari (via Web Extension wrapper).

> The default `manifest.json` targets Chrome and Edge. A `manifest_firefox.json` is included for Firefox, which adds the `background.scripts` fallback and `browser_specific_settings` required by Firefox's extension platform.

## Acknowledgments

- Icons and store images co-authored with **Gemini NanoBanana Pro**
- Code co-authored with **Claude Code**
- Sponsored by **[SuiteMigration](https://suitemigration.com/netsuite-extension-alien/)**

## License

[FSL-1.1-MIT](LICENSE) -- Free to use for any non-competing purpose. Converts to MIT automatically after two years.

---

*By [Alien Technology LLC](https://www.alientechnologyllc.com/)*
