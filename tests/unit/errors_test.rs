use gitbrowser::types::errors::*;

// === TabError Tests ===

#[test]
fn tab_error_not_found_display() {
    let err = TabError::NotFound("tab-123".to_string());
    assert_eq!(err.to_string(), "Tab not found: tab-123");
}

#[test]
fn tab_error_already_exists_display() {
    let err = TabError::AlreadyExists("tab-456".to_string());
    assert_eq!(err.to_string(), "Tab already exists: tab-456");
}

#[test]
fn tab_error_invalid_index_display() {
    let err = TabError::InvalidIndex(99);
    assert_eq!(err.to_string(), "Invalid tab index: 99");
}

#[test]
fn tab_error_implements_error_trait() {
    let err: Box<dyn std::error::Error> = Box::new(TabError::NotFound("id".to_string()));
    assert!(err.source().is_none());
}

// === CryptoError Tests ===

#[test]
fn crypto_error_display_variants() {
    assert_eq!(
        CryptoError::KeyDerivation("bad salt".to_string()).to_string(),
        "Key derivation failed: bad salt"
    );
    assert_eq!(
        CryptoError::Encryption("data too large".to_string()).to_string(),
        "Encryption failed: data too large"
    );
    assert_eq!(
        CryptoError::Decryption("invalid tag".to_string()).to_string(),
        "Decryption failed: invalid tag"
    );
    assert_eq!(
        CryptoError::RandomGeneration("entropy exhausted".to_string()).to_string(),
        "Random generation failed: entropy exhausted"
    );
    assert_eq!(
        CryptoError::InvalidKey("wrong length".to_string()).to_string(),
        "Invalid key: wrong length"
    );
}

// === BookmarkError Tests ===

#[test]
fn bookmark_error_display_variants() {
    assert_eq!(
        BookmarkError::NotFound("bm-1".to_string()).to_string(),
        "Bookmark not found: bm-1"
    );
    assert_eq!(
        BookmarkError::DuplicateUrl("https://example.com".to_string()).to_string(),
        "Duplicate bookmark URL: https://example.com"
    );
    assert_eq!(
        BookmarkError::FolderNotFound("folder-1".to_string()).to_string(),
        "Bookmark folder not found: folder-1"
    );
    assert_eq!(
        BookmarkError::DatabaseError("connection lost".to_string()).to_string(),
        "Bookmark database error: connection lost"
    );
}

// === HistoryError Tests ===

#[test]
fn history_error_display_variants() {
    assert_eq!(
        HistoryError::NotFound("h-1".to_string()).to_string(),
        "History entry not found: h-1"
    );
    assert_eq!(
        HistoryError::DatabaseError("disk full".to_string()).to_string(),
        "History database error: disk full"
    );
}

// === DownloadError Tests ===

#[test]
fn download_error_display_variants() {
    assert_eq!(
        DownloadError::NotFound("dl-1".to_string()).to_string(),
        "Download not found: dl-1"
    );
    assert_eq!(
        DownloadError::NetworkError("timeout".to_string()).to_string(),
        "Download network error: timeout"
    );
    assert_eq!(
        DownloadError::FileSystemError("permission denied".to_string()).to_string(),
        "Download file system error: permission denied"
    );
    assert_eq!(
        DownloadError::AlreadyCompleted("dl-2".to_string()).to_string(),
        "Download already completed: dl-2"
    );
}

// === PermissionError Tests ===

#[test]
fn permission_error_display_variants() {
    assert_eq!(
        PermissionError::NotFound("perm-1".to_string()).to_string(),
        "Permission not found: perm-1"
    );
    assert_eq!(
        PermissionError::DatabaseError("locked".to_string()).to_string(),
        "Permission database error: locked"
    );
    assert_eq!(
        PermissionError::InvalidOrigin("not-a-url".to_string()).to_string(),
        "Invalid origin: not-a-url"
    );
}

// === ShortcutError Tests ===

#[test]
fn shortcut_error_display_variants() {
    assert_eq!(
        ShortcutError::NotFound("copy".to_string()).to_string(),
        "Shortcut not found for action: copy"
    );
    assert_eq!(
        ShortcutError::Conflict("Ctrl+T already bound to new_tab".to_string()).to_string(),
        "Shortcut conflict: Ctrl+T already bound to new_tab"
    );
    assert_eq!(
        ShortcutError::InvalidKeys("???".to_string()).to_string(),
        "Invalid shortcut keys: ???"
    );
}

// === SessionError Tests ===

#[test]
fn session_error_display_variants() {
    assert_eq!(
        SessionError::SerializationError("invalid json".to_string()).to_string(),
        "Session serialization error: invalid json"
    );
    assert_eq!(
        SessionError::DatabaseError("corrupt".to_string()).to_string(),
        "Session database error: corrupt"
    );
    assert_eq!(
        SessionError::CryptoError("bad key".to_string()).to_string(),
        "Session crypto error: bad key"
    );
}

// === SettingsError Tests ===

#[test]
fn settings_error_display_variants() {
    assert_eq!(
        SettingsError::IoError("file not found".to_string()).to_string(),
        "Settings I/O error: file not found"
    );
    assert_eq!(
        SettingsError::SerializationError("malformed json".to_string()).to_string(),
        "Settings serialization error: malformed json"
    );
    assert_eq!(
        SettingsError::InvalidKey("unknown.key".to_string()).to_string(),
        "Invalid settings key: unknown.key"
    );
    assert_eq!(
        SettingsError::InvalidValue("negative number".to_string()).to_string(),
        "Invalid settings value: negative number"
    );
}

// === AIError Tests ===

#[test]
fn ai_error_display_variants() {
    assert_eq!(AIError::NoProvider.to_string(), "No AI provider configured");
    assert_eq!(
        AIError::InvalidApiKey("expired".to_string()).to_string(),
        "Invalid API key: expired"
    );
    assert_eq!(
        AIError::NetworkError("connection refused".to_string()).to_string(),
        "AI network error: connection refused"
    );
    assert_eq!(
        AIError::RateLimited("retry after 60s".to_string()).to_string(),
        "AI rate limited: retry after 60s"
    );
    assert_eq!(
        AIError::ProviderError("internal server error".to_string()).to_string(),
        "AI provider error: internal server error"
    );
}

// === PrivacyError Tests ===

#[test]
fn privacy_error_display_variants() {
    assert_eq!(
        PrivacyError::FilterListError("parse failed".to_string()).to_string(),
        "Filter list error: parse failed"
    );
    assert_eq!(
        PrivacyError::DnsError("resolver timeout".to_string()).to_string(),
        "DNS error: resolver timeout"
    );
    assert_eq!(
        PrivacyError::ClearDataError("in use".to_string()).to_string(),
        "Clear data error: in use"
    );
}

// === ExtensionError Tests ===

#[test]
fn extension_error_display_variants() {
    assert_eq!(
        ExtensionError::NotFound("ext-1".to_string()).to_string(),
        "Extension not found: ext-1"
    );
    assert_eq!(
        ExtensionError::InvalidManifest("missing name".to_string()).to_string(),
        "Invalid extension manifest: missing name"
    );
    assert_eq!(
        ExtensionError::PermissionDenied("network access".to_string()).to_string(),
        "Extension permission denied: network access"
    );
    assert_eq!(
        ExtensionError::LoadError("file corrupt".to_string()).to_string(),
        "Extension load error: file corrupt"
    );
}

// === ReaderError Tests ===

#[test]
fn reader_error_display_variants() {
    assert_eq!(
        ReaderError::ExtractionFailed("no content found".to_string()).to_string(),
        "Content extraction failed: no content found"
    );
    assert_eq!(ReaderError::NotAnArticle.to_string(), "Page is not an article");
}

// === ThemeError Tests ===

#[test]
fn theme_error_display_variants() {
    assert_eq!(
        ThemeError::InvalidColor("xyz".to_string()).to_string(),
        "Invalid color: xyz"
    );
    assert_eq!(
        ThemeError::CssError("unexpected token".to_string()).to_string(),
        "CSS error: unexpected token"
    );
}

// === LocaleError Tests ===

#[test]
fn locale_error_display_variants() {
    assert_eq!(
        LocaleError::UnsupportedLocale("fr".to_string()).to_string(),
        "Unsupported locale: fr"
    );
    assert_eq!(
        LocaleError::MissingKey("tabs.new_tab".to_string()).to_string(),
        "Missing locale key: tabs.new_tab"
    );
    assert_eq!(
        LocaleError::FileNotFound("locales/fr.json".to_string()).to_string(),
        "Locale file not found: locales/fr.json"
    );
}

// === CrashError Tests ===

#[test]
fn crash_error_display_variants() {
    assert_eq!(
        CrashError::DatabaseError("table missing".to_string()).to_string(),
        "Crash recovery database error: table missing"
    );
    assert_eq!(
        CrashError::RecoveryFailed("session corrupt".to_string()).to_string(),
        "Crash recovery failed: session corrupt"
    );
}

// === UpdateError Tests ===

#[test]
fn update_error_display_variants() {
    assert_eq!(
        UpdateError::NetworkError("dns failure".to_string()).to_string(),
        "Update network error: dns failure"
    );
    assert_eq!(
        UpdateError::ChecksumMismatch("expected abc, got def".to_string()).to_string(),
        "Update checksum mismatch: expected abc, got def"
    );
    assert_eq!(
        UpdateError::InstallFailed("permission denied".to_string()).to_string(),
        "Update installation failed: permission denied"
    );
    assert_eq!(
        UpdateError::ParseError("invalid semver".to_string()).to_string(),
        "Update parse error: invalid semver"
    );
}

// === GitHubError Tests ===

#[test]
fn github_error_display_variants() {
    assert_eq!(
        GitHubError::AuthFailed("bad credentials".to_string()).to_string(),
        "GitHub authentication failed: bad credentials"
    );
    assert_eq!(
        GitHubError::TokenExpired.to_string(),
        "GitHub access token expired"
    );
    assert_eq!(
        GitHubError::NetworkError("timeout".to_string()).to_string(),
        "GitHub network error: timeout"
    );
    assert_eq!(
        GitHubError::ApiError("rate limit exceeded".to_string()).to_string(),
        "GitHub API error: rate limit exceeded"
    );
    assert_eq!(
        GitHubError::NotAuthenticated.to_string(),
        "Not authenticated with GitHub"
    );
}

// === Cross-cutting: all errors implement std::error::Error ===

#[test]
fn all_errors_implement_std_error() {
    // Verify each error type can be used as a trait object
    let errors: Vec<Box<dyn std::error::Error>> = vec![
        Box::new(TabError::NotFound("id".to_string())),
        Box::new(CryptoError::Encryption("msg".to_string())),
        Box::new(BookmarkError::NotFound("id".to_string())),
        Box::new(HistoryError::NotFound("id".to_string())),
        Box::new(DownloadError::NotFound("id".to_string())),
        Box::new(PermissionError::NotFound("id".to_string())),
        Box::new(ShortcutError::NotFound("action".to_string())),
        Box::new(SessionError::DatabaseError("msg".to_string())),
        Box::new(SettingsError::IoError("msg".to_string())),
        Box::new(AIError::NoProvider),
        Box::new(PrivacyError::DnsError("msg".to_string())),
        Box::new(ExtensionError::NotFound("id".to_string())),
        Box::new(ReaderError::NotAnArticle),
        Box::new(ThemeError::InvalidColor("color".to_string())),
        Box::new(LocaleError::MissingKey("key".to_string())),
        Box::new(CrashError::DatabaseError("msg".to_string())),
        Box::new(UpdateError::NetworkError("msg".to_string())),
        Box::new(GitHubError::NotAuthenticated),
    ];

    // All 18 error types should be present
    assert_eq!(errors.len(), 18);

    // Each error should have a non-empty display string
    for err in &errors {
        assert!(!err.to_string().is_empty());
    }
}

// === Debug trait verification ===

#[test]
fn all_errors_implement_debug() {
    // Verify Debug formatting works for each error type
    let debug_str = format!("{:?}", TabError::NotFound("test".to_string()));
    assert!(debug_str.contains("NotFound"));

    let debug_str = format!("{:?}", CryptoError::InvalidKey("test".to_string()));
    assert!(debug_str.contains("InvalidKey"));

    let debug_str = format!("{:?}", AIError::NoProvider);
    assert!(debug_str.contains("NoProvider"));

    let debug_str = format!("{:?}", GitHubError::TokenExpired);
    assert!(debug_str.contains("TokenExpired"));

    let debug_str = format!("{:?}", ReaderError::NotAnArticle);
    assert!(debug_str.contains("NotAnArticle"));
}
