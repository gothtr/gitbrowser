//! GitBrowser — a privacy-focused minimal web browser with GitHub-style UI.
//!
//! This library crate exposes all modules for use by the binary and integration tests.

pub mod app;
pub mod database;
pub mod managers;
pub mod platform;
pub mod services;
pub mod rpc_handler;
pub mod types;

#[cfg(feature = "gui")]
pub mod ui;
