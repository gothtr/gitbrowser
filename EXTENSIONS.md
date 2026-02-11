# GitBrowser Extension API — Developer Guide

## Overview

GitBrowser extensions are directories containing a `manifest.json` file and associated scripts/styles. Extensions can inject content scripts into web pages, add toolbar buttons, and access browser APIs for tabs, bookmarks, storage, and notifications.

## manifest.json

Every extension must have a `manifest.json` in its root directory.

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "A sample GitBrowser extension",
  "author": "Your Name",
  "homepage_url": "https://github.com/you/my-extension",
  "min_browser_version": "1.0.0",
  "permissions": ["pageContent", "storage", "tabs", "bookmarks", "notifications"],
  "background": "background.js",
  "content_scripts": [
    {
      "matches": ["*://*.example.com/*"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ],
  "toolbar_button": {
    "icon": "icon.svg",
    "title": "My Extension",
    "popup": "popup.html"
  }
}
```

## Manifest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique extension identifier |
| `name` | string | Yes | Display name |
| `version` | string | Yes | Semver version string |
| `description` | string | No | Short description |
| `author` | string | No | Author name |
| `homepage_url` | string | No | Extension homepage URL |
| `min_browser_version` | string | No | Minimum GitBrowser version |
| `permissions` | string[] | Yes | Required permissions (see below) |
| `background` | string | No | Path to background script |
| `content_scripts` | object[] | No | Content scripts to inject |
| `toolbar_button` | object | No | Toolbar button config |

## Permissions

| Permission | Description |
|------------|-------------|
| `pageContent` | Access page DOM via content scripts |
| `storage` | Local key-value storage for the extension |
| `toolbar` | Add a button to the browser toolbar |
| `tabs` | Access tab management APIs |
| `network` | Make network requests from background scripts |
| `bookmarks` | Read and modify bookmarks |
| `notifications` | Show desktop notifications |

## Content Scripts

Content scripts are JavaScript and CSS files injected into web pages that match specified URL patterns.

### URL Match Patterns

Patterns follow the format: `<scheme>://<host>/<path>`

| Pattern | Matches |
|---------|---------|
| `*://*.github.com/*` | All pages on github.com and subdomains |
| `https://example.com/*` | All HTTPS pages on example.com |
| `*://*/api/*` | Any page with `/api/` in the path |
| `<all_urls>` | All HTTP and HTTPS pages |

### run_at

Controls when the content script is injected:

| Value | Description |
|-------|-------------|
| `document_start` | Injected before any page scripts run (DOM not ready) |
| `document_end` | Injected after DOM is ready but before all resources load |
| `document_idle` | (Default) Injected after the page fully loads |

### Example Content Script

**manifest.json:**
```json
{
  "content_scripts": [
    {
      "matches": ["*://*.github.com/*"],
      "js": ["github-enhancer.js"],
      "css": ["github-styles.css"],
      "run_at": "document_idle"
    }
  ]
}
```

**github-enhancer.js:**
```javascript
// Content scripts run in an isolated scope
(function() {
  // Access the page DOM
  const header = document.querySelector('.Header');
  if (header) {
    console.log('[MyExtension] GitHub header found');
  }

  // Communicate with the extension background via custom events
  document.dispatchEvent(new CustomEvent('gb-ext-message', {
    detail: { type: 'page-loaded', url: location.href }
  }));
})();
```

**github-styles.css:**
```css
/* Injected into matching pages */
.Header {
  border-bottom: 2px solid #0366d6;
}
```

## Available APIs

Extensions can access browser functionality through the APIs below. These are available in background scripts and (where noted) in content scripts.

### Tabs API

Requires `tabs` permission.

```javascript
// Available via RPC from background scripts
// Methods: tabs.query, tabs.get, tabs.create, tabs.update, tabs.remove

// Example: create a new tab
gb.tabs.create({ url: 'https://example.com' });

// Example: get all tabs
const tabs = await gb.tabs.query({});
```

### Bookmarks API

Requires `bookmarks` permission.

```javascript
// Methods: bookmark.add, bookmark.list, bookmark.search, bookmark.delete

// Example: add a bookmark
gb.bookmarks.create({ url: 'https://example.com', title: 'Example' });

// Example: search bookmarks
const results = await gb.bookmarks.search({ query: 'github' });
```

### Storage API

Requires `storage` permission.

```javascript
// Methods: storage.get, storage.set, storage.remove

// Example: store data
await gb.storage.set({ key: 'my-setting', value: 'dark-mode' });

// Example: retrieve data
const result = await gb.storage.get({ key: 'my-setting' });
console.log(result.value); // 'dark-mode'
```

### Notifications API

Requires `notifications` permission.

```javascript
// Methods: notifications.create, notifications.clear

// Example: show a notification
gb.notifications.create({
  title: 'Download Complete',
  message: 'file.zip has been downloaded'
});
```

## Extension Lifecycle

1. **Install**: User selects extension directory via Extensions page. GitBrowser reads `manifest.json`, validates permissions, and registers the extension.

2. **Enable/Disable**: Extensions can be toggled on/off from the Extensions page. Disabled extensions do not inject content scripts or run background scripts.

3. **Content Script Injection**: When a page loads, GitBrowser checks all enabled extensions for matching content script patterns. Matched scripts are injected according to their `run_at` timing.

4. **Uninstall**: Removes the extension registration. Content scripts already injected into open pages remain until those pages are reloaded.

## Example Extension: Dark Mode

A complete example extension that adds dark mode to all websites.

### Directory Structure

```
dark-mode-extension/
├── manifest.json
├── darkmode.js
└── darkmode.css
```

### manifest.json
```json
{
  "id": "dark-mode",
  "name": "Universal Dark Mode",
  "version": "1.0.0",
  "description": "Applies dark mode to all websites",
  "permissions": ["pageContent"],
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "css": ["darkmode.css"],
      "run_at": "document_start"
    }
  ]
}
```

### darkmode.css
```css
html {
  filter: invert(1) hue-rotate(180deg);
}
img, video, canvas, svg {
  filter: invert(1) hue-rotate(180deg);
}
```

## Security Model

- Content scripts run in an isolated JavaScript context — they can access the page DOM but not the page's JavaScript variables.
- Extensions must declare all required permissions in `manifest.json`.
- Network requests from extensions are subject to the same CORS rules as regular web pages.
- Extension files are read from the local filesystem; only files within the extension directory are accessible.
