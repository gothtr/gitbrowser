//! GitBrowser UI layer.
//!
//! Uses `wry` for cross-platform WebView rendering:
//! - Windows: WebView2 (Chromium-based, maximum performance)
//! - Linux: WebKitGTK (non-Chromium)
//! - macOS: WKWebView (WebKit, non-Chromium)
//!
//! The entire browser UI is rendered as HTML/CSS/JS inside the WebView.
//! Communication between the Rust backend and JS frontend uses wry IPC.

pub mod webview_app;
