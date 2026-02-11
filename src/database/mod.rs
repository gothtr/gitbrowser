//! GitBrowser database layer.
//!
//! Provides SQLite connection management and schema migrations.
//!
//! # Usage
//!
//! ```no_run
//! use gitbrowser::database::Database;
//!
//! // Open a persistent database
//! let db = Database::open("gitbrowser.db").expect("failed to open database");
//!
//! // Or use an in-memory database for testing
//! let db = Database::open_in_memory().expect("failed to open in-memory database");
//!
//! // Access the underlying connection for queries
//! let conn = db.connection();
//! ```

pub mod connection;
pub mod migrations;

pub use connection::Database;
