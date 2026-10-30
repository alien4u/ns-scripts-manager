# Privacy Policy — NetSuite Scripts Manager

**Last updated:** October 30, 2026

## Data Collection

NetSuite Scripts Manager does **not** collect, transmit, or store any personal or sensitive data. Period.

## How It Works

All data is retrieved **live from the page context** via NetSuite's native APIs (SuiteScript 2.x and 1.0). The extension runs entirely within your browser and communicates only with the NetSuite page you are currently viewing.

## What Is Stored Locally

The extension uses your browser's local storage (`chrome.storage.local`) to persist:

- Dark / Light mode selection, compact mode, Deployed-only filter, sort order and group ordering
- Popup size
- Scheduled Deployments Sync data you collect: the deployment IDs, script IDs, titles and script names of scheduled
  deployments, with the collection date, source environment and NetSuite account ID, kept until you clear
  them in the Sync panel

## Session Cache (memory only)

To avoid re-reading the same information on every click, the extension keeps a short-lived cache in the
browser's session storage (`chrome.storage.session`): the script deployment, workflow and form-script
metadata of a record type (names, IDs, statuses, links), keyed by NetSuite account URL, role and record type.

- Each entry is used for at most **2 minutes**; the Refresh button always bypasses it
- Session storage is held **in memory only**, is **never written to disk**, and is cleared when the browser closes
- No record field values or record data are cached

Nothing stored locally or in the session cache is **ever transmitted** to any external server.

## No External Servers

This extension does **not**:

- Send data to any external server or third-party service
- Use analytics, tracking, or telemetry of any kind
- Collect login credentials, tokens, or session data
- Store or cache any NetSuite record data (only the script metadata described above, for at most 2 minutes)

## Permissions

| Permission | Purpose |
|------------|---------|
| `activeTab` | Interact with the current record page when activated |
| `storage` | Persist user preferences and Sync data; 2-minute in-memory session cache of record-type script metadata |
| `scripting` | Inject data-fetching script into NetSuite on demand |

All permissions are used exclusively for the extension's core functionality as described above.

## Open Source

This extension is fully open source. You can audit the complete source code at:

https://github.com/alien4u/ns-scripts-manager

## Contact

If you have questions or concerns about this privacy policy, please open an issue on the GitHub repository.

---

*Alien Technology LLC*
