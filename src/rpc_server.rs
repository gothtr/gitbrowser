//! GitBrowser RPC Server — JSON-RPC over stdin/stdout for Electron integration.
//!
//! Protocol: one JSON object per line (newline-delimited JSON).
//! Request:  {"id":1, "method":"bookmark.add", "params":{"url":"...","title":"..."}}
//! Response: {"id":1, "result":{...}} or {"id":1, "error":"..."}

use std::sync::Mutex;
use std::io::{self, BufRead, Write};
use std::time::Instant;

use gitbrowser::app::App;
use gitbrowser::rpc_handler::handle_method;

use serde_json::{json, Value};

/// Simple rate limiter: max requests per second per method.
struct RateLimiter {
    window_start: Instant,
    request_count: u32,
    max_per_second: u32,
}

impl RateLimiter {
    fn new(max_per_second: u32) -> Self {
        Self { window_start: Instant::now(), request_count: 0, max_per_second }
    }

    /// Returns true if the request is allowed, false if rate-limited.
    fn check(&mut self) -> bool {
        let elapsed = self.window_start.elapsed();
        if elapsed.as_secs() >= 1 {
            self.window_start = Instant::now();
            self.request_count = 0;
        }
        self.request_count += 1;
        self.request_count <= self.max_per_second
    }
}

fn main() {
    // BUG-08: Use absolute path for DB — prefer GITBROWSER_DATA_DIR, fallback to exe directory
    let db_path = if let Ok(dir) = std::env::var("GITBROWSER_DATA_DIR") {
        std::path::PathBuf::from(dir).join("gitbrowser.db")
    } else if let Ok(exe) = std::env::current_exe() {
        exe.parent().unwrap_or(std::path::Path::new(".")).join("gitbrowser.db")
    } else {
        std::path::PathBuf::from("gitbrowser.db")
    };
    let app = Mutex::new(App::new(db_path.to_str().unwrap_or("gitbrowser.db")).expect("Failed to initialize GitBrowser"));

    // Signal ready
    let ready = json!({"event":"ready","version":env!("CARGO_PKG_VERSION")});
    println!("{}", ready);
    io::stdout().flush().unwrap();

    // 2.10: Rate limiting — max 200 RPC requests per second to prevent DoS
    let mut rate_limiter = RateLimiter::new(200);

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() { continue; }

        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let err = json!({"id":null,"error":format!("parse error: {}",e)});
                println!("{}", err);
                io::stdout().flush().unwrap();
                continue;
            }
        };

        let id = req.get("id").cloned().unwrap_or(Value::Null);

        // 2.10: Check rate limit before processing
        if !rate_limiter.check() {
            let response = json!({"id": id, "error": "rate limit exceeded"});
            println!("{}", response);
            io::stdout().flush().unwrap();
            continue;
        }

        let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or(json!({}));

        let result = handle_method(&app, method, &params);

        let response = match result {
            Ok(val) => json!({"id": id, "result": val}),
            Err(err) => json!({"id": id, "error": err}),
        };
        println!("{}", response);
        io::stdout().flush().unwrap();
    }
}
