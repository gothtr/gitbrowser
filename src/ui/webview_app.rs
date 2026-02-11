//! WebView-based browser application using `wry` + `tao`.
//!
//! Architecture:
//! - `with_initialization_script(TOOLBAR_JS)` injects the toolbar on EVERY page
//!   (both internal custom-protocol pages and external http/https sites).
//!   On Windows WebView2 this uses AddScriptToExecuteOnDocumentCreatedAsync.
//! - Internal pages (newtab, settings) are served via `gb://` custom protocol.
//! - External sites are loaded via `load_url()`.
//! - IPC from JS → Rust via `window.ipc.postMessage()`.

use std::sync::{Arc, Mutex};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

use crate::app::App;

#[derive(Debug)]
enum UserEvent {
    LoadUrl(String),
    EvalScript(String),
    /// Navigate to URL and update tab state (from new_window_req_handler)
    NavigateUrl(String),
}

struct BrowserState {
    app: App,
    /// When true, a navigation is in progress — ignore IPC from stale pages
    navigating: bool,
}

const TOOLBAR_JS: &str = include_str!("../../resources/ui/toolbar.js");

/// Build HTML for internal pages (newtab, settings).
/// Toolbar JS is INLINED because `with_initialization_script` does NOT run
/// on custom-protocol (`gb://`) pages on Windows WebView2.
fn internal_page(body: &str, extra_css: &str, extra_js: &str) -> String {
    let styles2 = include_str!("../../resources/ui/styles2.css");
    let mut html = String::with_capacity(body.len() + extra_css.len() + extra_js.len() + styles2.len() + TOOLBAR_JS.len() + 4000);
    html.push_str("<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><style>");
    html.push_str(":root{--bg-canvas:#0d1117;--bg-default:#161b22;--bg-subtle:#1c2128;--fg-default:#e6edf3;--fg-muted:#7d8590;--fg-subtle:#484f58;--border-default:#30363d;--border-muted:#21262d;--accent-fg:#58a6ff;--accent-emphasis:#1f6feb;--success-fg:#3fb950;--success-emphasis:#238636;--danger-fg:#f85149;--danger-emphasis:#da3633;--done-fg:#a371f7;--radius-sm:6px;--radius-md:8px;--radius-lg:12px;--shadow-md:0 3px 6px rgba(1,4,9,0.3);--transition-fast:120ms cubic-bezier(0.33,1,0.68,1);--transition-normal:200ms cubic-bezier(0.33,1,0.68,1);--font:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"Noto Sans\",Helvetica,Arial,sans-serif}");
    html.push_str("*{margin:0;padding:0;box-sizing:border-box}");
    html.push_str("body{font-family:var(--font);background:var(--bg-canvas);color:var(--fg-default);height:100vh;user-select:none}");
    html.push_str(styles2);
    html.push_str(extra_css);
    html.push_str("</style></head><body>");
    html.push_str(body);
    html.push_str("<script>");
    html.push_str(TOOLBAR_JS);
    html.push_str("</script>");
    if !extra_js.is_empty() {
        html.push_str("<script>");
        html.push_str(extra_js);
        html.push_str("</script>");
    }
    html.push_str("</body></html>");
    html
}

fn newtab_html() -> String {
    let body = r#"<div class="newtab-page" style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;overflow:hidden">
<div class="newtab-logo">GitBrowser</div>
<div class="newtab-subtitle">Fast. Private. Open.</div>
<div class="newtab-search">
<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--fg-subtle)"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 1 1-1.06 1.06l-3.04-3.04ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>
<input class="newtab-search-input" type="text" placeholder="Search the web or enter URL..." autofocus />
</div>
<div class="quick-links">
<div class="quick-link" data-url="https://github.com"><div class="quick-link-icon">G</div>GitHub</div>
<div class="quick-link" data-url="https://google.com"><div class="quick-link-icon">g</div>Google</div>
<div class="quick-link" data-url="https://youtube.com"><div class="quick-link-icon">Y</div>YouTube</div>
<div class="quick-link" data-url="https://reddit.com"><div class="quick-link-icon">R</div>Reddit</div>
<div class="quick-link" data-url="https://stackoverflow.com"><div class="quick-link-icon">S</div>Stack Overflow</div>
<div class="quick-link" data-url="https://wikipedia.org"><div class="quick-link-icon">W</div>Wikipedia</div>
</div>
</div>"#;

    let js = r#"
document.querySelectorAll('.quick-link').forEach(function(l){
  l.addEventListener('click',function(){
    if(window.__gb_ipc)window.__gb_ipc('navigate',{url:l.dataset.url});
  });
});
var si=document.querySelector('.newtab-search-input');
if(si){si.addEventListener('keydown',function(e){
  if(e.key==='Enter'&&e.target.value.trim()){
    if(window.__gb_ipc)window.__gb_ipc('navigate',{url:e.target.value.trim()});
  }
});setTimeout(function(){si.focus()},100);}
"#;

    internal_page(body, "", js)
}

fn settings_html() -> String {
    let content = include_str!("../../resources/ui/settings_content.html");
    let extra_css = ".settings-page{padding:32px 48px;max-width:800px;overflow-y:auto;height:100%}";
    let body = format!("<div class=\"settings-page\">{}</div>", content);

    let js = r#"
function setSetting(k,v){if(window.__gb_ipc)window.__gb_ipc('set_setting',{key:k,value:v})}
function applySettingsData(d){
  if(!d)return;
  var sv=function(id,v){var e=document.getElementById(id);if(e)e.value=v};
  var st=function(id,v){var e=document.getElementById(id);if(e){if(v)e.classList.add('on');else e.classList.remove('on')}};
  if(d.general){sv('s-language',d.general.language);sv('s-startup',d.general.startup_behavior);sv('s-search',d.general.default_search_engine)}
  if(d.privacy){st('s-trackers',d.privacy.tracker_blocking);st('s-ads',d.privacy.ad_blocking);st('s-https',d.privacy.https_enforcement);st('s-doh',d.privacy.dns_over_https);st('s-fingerprint',d.privacy.anti_fingerprinting);st('s-clearonexit',d.privacy.clear_data_on_exit)}
  if(d.appearance){sv('s-theme',d.appearance.theme);sv('s-accent',d.appearance.accent_color);sv('s-fontsize',d.appearance.font_size)}
  if(d.performance){sv('s-suspend',d.performance.tab_suspend_timeout_minutes);st('s-lazyimg',d.performance.lazy_load_images)}
}
document.querySelectorAll('.toggle').forEach(function(t){
  t.addEventListener('click',function(){
    this.classList.toggle('on');
    var k=this.dataset.key;if(k)setSetting(k,this.classList.contains('on'));
  });
});
if(window.__gb_ipc)window.__gb_ipc('get_settings',{});
"#;

    internal_page(&body, extra_css, js)
}

// ─── IPC handler ───

fn handle_ipc(state: &mut BrowserState, message: &str) -> Option<UserEvent> {
    let msg: serde_json::Value = serde_json::from_str(message).ok()?;
    let cmd = msg.get("cmd")?.as_str()?;

    match cmd {
        "ui_ready" => {
            // Toolbar just loaded on a page — send current tabs state
            Some(UserEvent::EvalScript(build_tabs_update(state)))
        }

        "new_tab" => {
            use crate::managers::tab_manager::TabManagerTrait;
            state.app.tab_manager.create_tab(Some("about:newtab"), true);
            Some(UserEvent::LoadUrl("gb://localhost/newtab".to_string()))
        }

        "close_tab" => {
            use crate::managers::tab_manager::TabManagerTrait;
            if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                let _ = state.app.tab_manager.close_tab(id);
            }
            navigate_to_active(state)
        }

        "close_active_tab" => {
            use crate::managers::tab_manager::TabManagerTrait;
            if let Some(tab) = state.app.tab_manager.get_active_tab() {
                let id = tab.id.clone();
                let _ = state.app.tab_manager.close_tab(&id);
            }
            navigate_to_active(state)
        }

        "switch_tab" => {
            use crate::managers::tab_manager::TabManagerTrait;
            if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                let _ = state.app.tab_manager.switch_tab(id);
            }
            navigate_to_active(state)
        }

        "navigate" => {
            let input = msg.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let url = normalize_url(input);

            use crate::managers::tab_manager::TabManagerTrait;
            if let Some(tab) = state.app.tab_manager.get_active_tab() {
                let tid = tab.id.clone();
                let title = extract_title(&url);
                let _ = state.app.tab_manager.update_tab_url(&tid, &url);
                let _ = state.app.tab_manager.update_tab_title(&tid, &title);
            }

            if !url.starts_with("about:") {
                let conn = state.app.db.connection();
                let mut hmgr = crate::managers::history_manager::HistoryManager::new(conn);
                use crate::managers::history_manager::HistoryManagerTrait;
                let _ = hmgr.record_visit(&url, &extract_title(&url));
            }

            url_to_event(&url)
        }

        "open_settings" => {
            use crate::managers::tab_manager::TabManagerTrait;
            state.app.tab_manager.create_tab(Some("about:settings"), true);
            Some(UserEvent::LoadUrl("gb://localhost/settings".to_string()))
        }

        "add_bookmark" => {
            if let (Some(url), Some(title)) = (
                msg.get("url").and_then(|v| v.as_str()),
                msg.get("title").and_then(|v| v.as_str()),
            ) {
                let conn = state.app.db.connection();
                let mut mgr = crate::managers::bookmark_manager::BookmarkManager::new(conn);
                use crate::managers::bookmark_manager::BookmarkManagerTrait;
                let _ = mgr.add_bookmark(url, title, None);
            }
            Some(UserEvent::EvalScript("if(window.__gb_showToast)__gb_showToast('Bookmark added')".into()))
        }

        "get_settings" => {
            use crate::services::settings_engine::SettingsEngineTrait;
            let json = serde_json::to_string(state.app.settings_engine.get_settings()).unwrap_or_default();
            Some(UserEvent::EvalScript(format!("if(typeof applySettingsData==='function')applySettingsData({})", json)))
        }

        "set_setting" => {
            if let (Some(key), Some(value)) = (msg.get("key").and_then(|v| v.as_str()), msg.get("value")) {
                use crate::services::settings_engine::SettingsEngineTrait;
                let _ = state.app.settings_engine.set_value(key, value.clone());
            }
            None
        }

        "reset_settings" => {
            use crate::services::settings_engine::SettingsEngineTrait;
            let _ = state.app.settings_engine.reset();
            let json = serde_json::to_string(state.app.settings_engine.get_settings()).unwrap_or_default();
            Some(UserEvent::EvalScript(format!("if(typeof applySettingsData==='function')applySettingsData({})", json)))
        }

        "url_changed" => {
            // JS detected a URL change (SPA navigation, redirect, etc.)
            if let Some(url) = msg.get("url").and_then(|v| v.as_str()) {
                let title = msg.get("title").and_then(|v| v.as_str()).unwrap_or("");
                use crate::managers::tab_manager::TabManagerTrait;
                if let Some(tab) = state.app.tab_manager.get_active_tab() {
                    let tid = tab.id.clone();
                    let _ = state.app.tab_manager.update_tab_url(&tid, url);
                    if !title.is_empty() {
                        let _ = state.app.tab_manager.update_tab_title(&tid, title);
                    }
                }
            }
            Some(UserEvent::EvalScript(build_tabs_update(state)))
        }

        _ => None,
    }
}

fn url_to_event(url: &str) -> Option<UserEvent> {
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(UserEvent::LoadUrl(url.to_string()))
    } else if url == "about:settings" {
        Some(UserEvent::LoadUrl("gb://localhost/settings".to_string()))
    } else {
        Some(UserEvent::LoadUrl("gb://localhost/newtab".to_string()))
    }
}

fn navigate_to_active(state: &mut BrowserState) -> Option<UserEvent> {
    use crate::managers::tab_manager::TabManagerTrait;
    let url = state.app.tab_manager.get_active_tab()
        .map(|t| t.url.clone()).unwrap_or_else(|| "about:newtab".into());
    url_to_event(&url)
}

fn build_tabs_update(state: &BrowserState) -> String {
    use crate::managers::tab_manager::TabManagerTrait;
    let tabs: Vec<serde_json::Value> = state.app.tab_manager.get_all_tabs().iter().map(|t| {
        serde_json::json!({"id": t.id, "title": t.title, "url": t.url, "pinned": t.pinned})
    }).collect();
    let aid = state.app.tab_manager.get_active_tab().map(|t| t.id.clone()).unwrap_or_default();
    format!("if(window.__gb_updateTabs)__gb_updateTabs({})", serde_json::json!({"tabs":tabs,"activeId":aid}))
}

// ─── Helpers ───

fn normalize_url(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return "about:newtab".to_string();
    }
    if trimmed == "about:newtab" || trimmed == "about:settings" || trimmed == "about:blank" {
        return trimmed.to_string();
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    if trimmed.contains('.') && !trimmed.contains(' ') {
        return format!("https://{}", trimmed);
    }
    format!("https://www.google.com/search?q={}", urlencoding(trimmed))
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(char::from(b"0123456789ABCDEF"[(b >> 4) as usize]));
                out.push(char::from(b"0123456789ABCDEF"[(b & 0xf) as usize]));
            }
        }
    }
    out
}

fn extract_title(url: &str) -> String {
    if url.starts_with("about:") {
        return match url {
            "about:newtab" => "New Tab".to_string(),
            "about:settings" => "Settings".to_string(),
            _ => "New Tab".to_string(),
        };
    }
    url.trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.")
        .split('/')
        .next()
        .unwrap_or(url)
        .to_string()
}

// ─── Main entry point ───

pub fn run() {
    let app = App::new("gitbrowser.db").expect("Failed to initialize GitBrowser");
    let state = Arc::new(Mutex::new(BrowserState { app, navigating: false }));

    {
        let mut s = state.lock().unwrap();
        use crate::managers::tab_manager::TabManagerTrait;
        s.app.tab_manager.create_tab(Some("about:newtab"), true);
        s.app.startup();
    }

    let event_loop: EventLoop<UserEvent> = EventLoopBuilder::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("GitBrowser")
        .with_inner_size(tao::dpi::LogicalSize::new(1280.0, 800.0))
        .build(&event_loop)
        .expect("Failed to create window");

    let ipc_state = state.clone();
    let ipc_proxy = proxy.clone();
    let nw_proxy = proxy.clone();

    let builder = WebViewBuilder::new()
        .with_custom_protocol("gb".into(), move |_wv_id, request| {
            let path = request.uri().path();
            let html = match path {
                "/newtab" | "/" => newtab_html(),
                "/settings" => settings_html(),
                _ => newtab_html(),
            };
            wry::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(html.into_bytes().into())
                .unwrap()
        })
        // with_initialization_script uses AddScriptToExecuteOnDocumentCreatedAsync on Windows.
        // It runs on every http/https navigation automatically.
        // For gb:// custom protocol pages it does NOT run on Windows,
        // so those pages have toolbar inlined in their HTML via internal_page().
        .with_initialization_script(TOOLBAR_JS)
        .with_url("gb://localhost/newtab")
        .with_ipc_handler(move |msg: wry::http::Request<String>| {
            let body = msg.body().as_str();
            eprintln!("[IPC] {}", &body[..body.len().min(200)]);
            let mut s = ipc_state.lock().unwrap();
            if let Some(event) = handle_ipc(&mut s, body) {
                let _ = ipc_proxy.send_event(event);
            }
        })
        .with_new_window_req_handler(move |url, _features| {
            eprintln!("[NW] {}", url);
            if url.starts_with("http://") || url.starts_with("https://") {
                let _ = nw_proxy.send_event(UserEvent::NavigateUrl(url));
            }
            wry::NewWindowResponse::Deny
        })
        .with_devtools(cfg!(debug_assertions));

    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().expect("Failed to get GTK vbox");
        builder.build_gtk(vbox).expect("Failed to create WebView")
    };

    #[cfg(not(target_os = "linux"))]
    let webview = builder.build(&window).expect("Failed to create WebView");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                let mut s = state.lock().unwrap();
                s.app.shutdown();
                *control_flow = ControlFlow::Exit;
            }

            Event::UserEvent(user_event) => {
                match user_event {
                    UserEvent::NavigateUrl(url) => {
                        eprintln!("[NAV] {}", url);
                        {
                            let mut s = state.lock().unwrap();
                            use crate::managers::tab_manager::TabManagerTrait;
                            if let Some(tab) = s.app.tab_manager.get_active_tab() {
                                let tid = tab.id.clone();
                                let title = extract_title(&url);
                                let _ = s.app.tab_manager.update_tab_url(&tid, &url);
                                let _ = s.app.tab_manager.update_tab_title(&tid, &title);
                            }
                        }
                        let _ = webview.load_url(&url);
                    }
                    UserEvent::LoadUrl(url) => {
                        eprintln!("[LOAD] {}", url);
                        let _ = webview.load_url(&url);
                    }
                    UserEvent::EvalScript(js) => {
                        let _ = webview.evaluate_script(&js);
                    }
                }
            }

            _ => {}
        }
    });
}
