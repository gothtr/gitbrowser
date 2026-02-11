# GitBrowser

A privacy-focused minimal web browser with GitHub-style UI, built with Rust + Electron.

> 🚧 **Work in progress** — actively in development, not yet ready for release builds.

## Architecture

- **Rust backend** — core logic: database, bookmarks, history, downloads, sessions, password manager, crypto, privacy engine, extensions framework
- **Electron frontend** — UI shell, tab management, webview rendering
- **RPC bridge** — Electron ↔ Rust communication via JSON-RPC over stdin/stdout

## Features

- 🔒 Privacy engine with ad blocking and tracker protection
- 📑 Tab management with session persistence
- 🔖 Bookmarks with folders
- 📜 Browsing history
- ⬇️ Download manager
- 🔑 Built-in password manager (encrypted storage)
- 🌙 Dark / Light theme
- 🌐 Localization (English, Russian)
- 🐙 GitHub integration
- 🤖 AI assistant
- 📖 Reader mode
- 🧩 Extension framework (WIP)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Core | Rust (rusqlite, ring, reqwest, tokio) |
| UI | Electron, HTML/CSS/JS |
| Database | SQLite (bundled) |
| Crypto | ring (AES-GCM, PBKDF2) |

## Project Structure

```
src/              — Rust source code
  database/       — SQLite connection & migrations
  managers/       — Tab, bookmark, history, download, session managers
  services/       — AI, crypto, privacy, themes, localization, passwords
  types/          — Data types and error definitions
  platform/       — OS-specific code (Windows, macOS, Linux)
  ui/             — Webview app (wry/tao)
  rpc_server.rs   — JSON-RPC server for Electron bridge
electron/         — Electron app
  ui/             — Internal pages (newtab, settings, history, etc.)
resources/        — Shared UI assets (styles, scripts, icons)
locales/          — i18n translation files
tests/            — Unit and property-based tests
```

## Development

### Prerequisites

- Rust toolchain (stable)
- Node.js 18+
- npm

### Build & Run

```bash
# Build Rust backend
cargo build

# Install Electron dependencies
cd electron && npm install && cd ..

# Run the browser
cd electron && npm start
```

### Run Tests

```bash
cargo test
```

## License

MIT
