# Privacy policy

## Short version

ShapeShift does not collect, transmit, sell, or share any data. It has no
network permissions, no analytics, and no remote configuration.

## What the extension stores

Everything is kept in `chrome.storage.local`, which never leaves your device
and is not synced to your Google account:

| Key | What it is |
|---|---|
| `ss_salt` | A random value generated once per install. It seeds the per-origin noise. |
| `ssConfig` | The switches and strengths you chose in Settings. |
| `ss_stats` | Counters of how many fingerprint reads were intercepted, and the list of origins they came from. |
| `ss_site_settings` | Origins where you explicitly paused protection. |
| `ss_rotation_info` | When the identity was last rotated and how many times. |

## What the extension does not do

- No `fetch`, `XMLHttpRequest`, WebSocket, or beacon calls from any runtime file.
- No `host_permissions` beyond the content script injection needed to perturb
  page APIs on the sites you visit.
- No external servers, no telemetry, no crash reporting, no advertising ID.
- No reading of browsing history, bookmarks, cookies, or form data.

## Permissions and why they exist

| Permission | Reason |
|---|---|
| `storage` | Save your settings, the salt, the counters, and the per-site pause list. |
| `tabs` | Read the active tab origin so the popup can show the current site and reload tabs after an identity rotation. |
| `alarms` | Schedule the automatic fingerprint rotation interval. |
| `notifications` | Announce that an automatic rotation happened. |

## Removing your data

Disabling or removing the extension deletes all of the keys above. You can also
clear them at any time from `chrome://extensions` -> ShapeShift -> Site data, or
by removing the extension and loading it again.
