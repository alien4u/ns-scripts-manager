# Privacy Policy — NetSuite Scripts Manager

**Last updated:** February 19, 2026

## Data Collection

NetSuite Scripts Manager does **not** collect, transmit, or store any personal or sensitive data. Period.

## How It Works

All data is retrieved **live from the page context** via NetSuite's native APIs (SuiteScript 2.x and 1.0). The extension runs entirely within your browser and communicates only with the NetSuite page you are currently viewing.

## What Is Stored Locally

The extension uses your browser's local storage (`chrome.storage`) to persist the following **user preferences only**:

- Dark / Light mode selection
- Compact mode toggle
- Deployed-only filter state
- Sort order preference
- Drag-and-drop group ordering

These preferences are stored locally in your browser and are **never transmitted** to any external server.

## No External Servers

This extension does **not**:

- Send data to any external server or third-party service
- Use analytics, tracking, or telemetry of any kind
- Collect login credentials, tokens, or session data
- Store or cache any NetSuite record data beyond the current page view

## Permissions

| Permission | Purpose |
|------------|---------|
| `host_permissions: *.netsuite.com` | Inject scripts and interact with NetSuite pages |
| `activeTab` | Interact with the current record page when activated |
| `storage` | Persist user preferences (theme, filter, sort, group order) |
| `scripting` | Inject data-fetching script into NetSuite on demand |

All permissions are used exclusively for the extension's core functionality as described above.

## Open Source

This extension is fully open source. You can audit the complete source code at:

https://github.com/alien4u/ns-scripts-manager

## Contact

If you have questions or concerns about this privacy policy, please open an issue on the GitHub repository.

---

*Alien Technology LLC*
