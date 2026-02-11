use std::fmt;

// === TabError ===

/// Errors related to tab management operations.
#[derive(Debug)]
pub enum TabError {
    /// Tab with the given ID was not found.
    NotFound(String),
    /// A tab with the given ID already exists.
    AlreadyExists(String),
    /// The provided tab index is out of bounds.
    InvalidIndex(usize),
}

impl fmt::Display for TabError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TabError::NotFound(id) => write!(f, "Tab not found: {}", id),
            TabError::AlreadyExists(id) => write!(f, "Tab already exists: {}", id),
            TabError::InvalidIndex(index) => write!(f, "Invalid tab index: {}", index),
        }
    }
}

impl std::error::Error for TabError {}

// === CryptoError ===

/// Errors related to cryptographic operations.
#[derive(Debug)]
pub enum CryptoError {
    /// Failed to derive encryption key from password.
    KeyDerivation(String),
    /// Encryption operation failed.
    Encryption(String),
    /// Decryption operation failed.
    Decryption(String),
    /// Failed to generate random bytes.
    RandomGeneration(String),
    /// The provided key is invalid.
    InvalidKey(String),
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CryptoError::KeyDerivation(msg) => write!(f, "Key derivation failed: {}", msg),
            CryptoError::Encryption(msg) => write!(f, "Encryption failed: {}", msg),
            CryptoError::Decryption(msg) => write!(f, "Decryption failed: {}", msg),
            CryptoError::RandomGeneration(msg) => {
                write!(f, "Random generation failed: {}", msg)
            }
            CryptoError::InvalidKey(msg) => write!(f, "Invalid key: {}", msg),
        }
    }
}

impl std::error::Error for CryptoError {}

// === BookmarkError ===

/// Errors related to bookmark management operations.
#[derive(Debug)]
pub enum BookmarkError {
    /// Bookmark with the given ID was not found.
    NotFound(String),
    /// A bookmark with the same URL already exists.
    DuplicateUrl(String),
    /// The target folder was not found.
    FolderNotFound(String),
    /// Database operation failed.
    DatabaseError(String),
}

impl fmt::Display for BookmarkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BookmarkError::NotFound(id) => write!(f, "Bookmark not found: {}", id),
            BookmarkError::DuplicateUrl(url) => write!(f, "Duplicate bookmark URL: {}", url),
            BookmarkError::FolderNotFound(id) => write!(f, "Bookmark folder not found: {}", id),
            BookmarkError::DatabaseError(msg) => {
                write!(f, "Bookmark database error: {}", msg)
            }
        }
    }
}

impl std::error::Error for BookmarkError {}

// === HistoryError ===

/// Errors related to browsing history operations.
#[derive(Debug)]
pub enum HistoryError {
    /// History entry with the given ID was not found.
    NotFound(String),
    /// Database operation failed.
    DatabaseError(String),
}

impl fmt::Display for HistoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HistoryError::NotFound(id) => write!(f, "History entry not found: {}", id),
            HistoryError::DatabaseError(msg) => write!(f, "History database error: {}", msg),
        }
    }
}

impl std::error::Error for HistoryError {}

// === DownloadError ===

/// Errors related to download management operations.
#[derive(Debug)]
pub enum DownloadError {
    /// Download with the given ID was not found.
    NotFound(String),
    /// A network error occurred during download.
    NetworkError(String),
    /// A file system error occurred.
    FileSystemError(String),
    /// The download has already completed.
    AlreadyCompleted(String),
}

impl fmt::Display for DownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DownloadError::NotFound(id) => write!(f, "Download not found: {}", id),
            DownloadError::NetworkError(msg) => write!(f, "Download network error: {}", msg),
            DownloadError::FileSystemError(msg) => {
                write!(f, "Download file system error: {}", msg)
            }
            DownloadError::AlreadyCompleted(id) => {
                write!(f, "Download already completed: {}", id)
            }
        }
    }
}

impl std::error::Error for DownloadError {}

// === PermissionError ===

/// Errors related to site permission management.
#[derive(Debug)]
pub enum PermissionError {
    /// Permission entry was not found.
    NotFound(String),
    /// Database operation failed.
    DatabaseError(String),
    /// The provided origin is invalid.
    InvalidOrigin(String),
}

impl fmt::Display for PermissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PermissionError::NotFound(msg) => write!(f, "Permission not found: {}", msg),
            PermissionError::DatabaseError(msg) => {
                write!(f, "Permission database error: {}", msg)
            }
            PermissionError::InvalidOrigin(origin) => {
                write!(f, "Invalid origin: {}", origin)
            }
        }
    }
}

impl std::error::Error for PermissionError {}

// === ShortcutError ===

/// Errors related to keyboard shortcut management.
#[derive(Debug)]
pub enum ShortcutError {
    /// Shortcut for the given action was not found.
    NotFound(String),
    /// The shortcut keys conflict with an existing binding.
    Conflict(String),
    /// The provided key combination is invalid.
    InvalidKeys(String),
}

impl fmt::Display for ShortcutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ShortcutError::NotFound(action) => {
                write!(f, "Shortcut not found for action: {}", action)
            }
            ShortcutError::Conflict(msg) => write!(f, "Shortcut conflict: {}", msg),
            ShortcutError::InvalidKeys(keys) => write!(f, "Invalid shortcut keys: {}", keys),
        }
    }
}

impl std::error::Error for ShortcutError {}

// === SessionError ===

/// Errors related to session management operations.
#[derive(Debug)]
pub enum SessionError {
    /// Failed to serialize or deserialize session data.
    SerializationError(String),
    /// Database operation failed.
    DatabaseError(String),
    /// Cryptographic operation failed during session encryption/decryption.
    CryptoError(String),
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SessionError::SerializationError(msg) => {
                write!(f, "Session serialization error: {}", msg)
            }
            SessionError::DatabaseError(msg) => {
                write!(f, "Session database error: {}", msg)
            }
            SessionError::CryptoError(msg) => {
                write!(f, "Session crypto error: {}", msg)
            }
        }
    }
}

impl std::error::Error for SessionError {}

// === SettingsError ===

/// Errors related to settings management.
#[derive(Debug)]
pub enum SettingsError {
    /// An I/O error occurred while reading or writing settings.
    IoError(String),
    /// Failed to serialize or deserialize settings.
    SerializationError(String),
    /// The provided settings key is invalid.
    InvalidKey(String),
    /// The provided settings value is invalid.
    InvalidValue(String),
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SettingsError::IoError(msg) => write!(f, "Settings I/O error: {}", msg),
            SettingsError::SerializationError(msg) => {
                write!(f, "Settings serialization error: {}", msg)
            }
            SettingsError::InvalidKey(key) => write!(f, "Invalid settings key: {}", key),
            SettingsError::InvalidValue(msg) => {
                write!(f, "Invalid settings value: {}", msg)
            }
        }
    }
}

impl std::error::Error for SettingsError {}

// === AIError ===

/// Errors related to AI assistant operations.
#[derive(Debug)]
pub enum AIError {
    /// No AI provider has been configured.
    NoProvider,
    /// The provided API key is invalid.
    InvalidApiKey(String),
    /// A network error occurred while communicating with the AI provider.
    NetworkError(String),
    /// The AI provider rate-limited the request.
    RateLimited(String),
    /// The AI provider returned an error.
    ProviderError(String),
}

impl fmt::Display for AIError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AIError::NoProvider => write!(f, "No AI provider configured"),
            AIError::InvalidApiKey(msg) => write!(f, "Invalid API key: {}", msg),
            AIError::NetworkError(msg) => write!(f, "AI network error: {}", msg),
            AIError::RateLimited(msg) => write!(f, "AI rate limited: {}", msg),
            AIError::ProviderError(msg) => write!(f, "AI provider error: {}", msg),
        }
    }
}

impl std::error::Error for AIError {}

// === PrivacyError ===

/// Errors related to privacy engine operations.
#[derive(Debug)]
pub enum PrivacyError {
    /// Failed to load or parse filter lists.
    FilterListError(String),
    /// DNS-over-HTTPS configuration or resolution failed.
    DnsError(String),
    /// Failed to clear private browsing data.
    ClearDataError(String),
}

impl fmt::Display for PrivacyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PrivacyError::FilterListError(msg) => write!(f, "Filter list error: {}", msg),
            PrivacyError::DnsError(msg) => write!(f, "DNS error: {}", msg),
            PrivacyError::ClearDataError(msg) => write!(f, "Clear data error: {}", msg),
        }
    }
}

impl std::error::Error for PrivacyError {}

// === ExtensionError ===

/// Errors related to extension framework operations.
#[derive(Debug)]
pub enum ExtensionError {
    /// Extension with the given ID was not found.
    NotFound(String),
    /// The extension manifest is invalid.
    InvalidManifest(String),
    /// The extension does not have the required permissions.
    PermissionDenied(String),
    /// Failed to load the extension.
    LoadError(String),
}

impl fmt::Display for ExtensionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ExtensionError::NotFound(id) => write!(f, "Extension not found: {}", id),
            ExtensionError::InvalidManifest(msg) => {
                write!(f, "Invalid extension manifest: {}", msg)
            }
            ExtensionError::PermissionDenied(msg) => {
                write!(f, "Extension permission denied: {}", msg)
            }
            ExtensionError::LoadError(msg) => write!(f, "Extension load error: {}", msg),
        }
    }
}

impl std::error::Error for ExtensionError {}

// === ReaderError ===

/// Errors related to reader mode operations.
#[derive(Debug)]
pub enum ReaderError {
    /// Failed to extract article content from the page.
    ExtractionFailed(String),
    /// The page does not contain article content.
    NotAnArticle,
}

impl fmt::Display for ReaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReaderError::ExtractionFailed(msg) => {
                write!(f, "Content extraction failed: {}", msg)
            }
            ReaderError::NotAnArticle => write!(f, "Page is not an article"),
        }
    }
}

impl std::error::Error for ReaderError {}

// === ThemeError ===

/// Errors related to theme engine operations.
#[derive(Debug)]
pub enum ThemeError {
    /// The provided color value is invalid.
    InvalidColor(String),
    /// Failed to parse or apply CSS.
    CssError(String),
}

impl fmt::Display for ThemeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ThemeError::InvalidColor(color) => write!(f, "Invalid color: {}", color),
            ThemeError::CssError(msg) => write!(f, "CSS error: {}", msg),
        }
    }
}

impl std::error::Error for ThemeError {}

// === LocaleError ===

/// Errors related to localization engine operations.
#[derive(Debug)]
pub enum LocaleError {
    /// The requested locale is not supported.
    UnsupportedLocale(String),
    /// A translation key is missing from the locale file.
    MissingKey(String),
    /// The locale file was not found.
    FileNotFound(String),
}

impl fmt::Display for LocaleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LocaleError::UnsupportedLocale(locale) => {
                write!(f, "Unsupported locale: {}", locale)
            }
            LocaleError::MissingKey(key) => write!(f, "Missing locale key: {}", key),
            LocaleError::FileNotFound(path) => write!(f, "Locale file not found: {}", path),
        }
    }
}

impl std::error::Error for LocaleError {}

// === CrashError ===

/// Errors related to crash recovery operations.
#[derive(Debug)]
pub enum CrashError {
    /// Database operation failed.
    DatabaseError(String),
    /// Failed to recover from a crash.
    RecoveryFailed(String),
}

impl fmt::Display for CrashError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CrashError::DatabaseError(msg) => {
                write!(f, "Crash recovery database error: {}", msg)
            }
            CrashError::RecoveryFailed(msg) => write!(f, "Crash recovery failed: {}", msg),
        }
    }
}

impl std::error::Error for CrashError {}

// === UpdateError ===

/// Errors related to update manager operations.
#[derive(Debug)]
pub enum UpdateError {
    /// A network error occurred while checking for or downloading updates.
    NetworkError(String),
    /// The downloaded file's checksum does not match the expected value.
    ChecksumMismatch(String),
    /// Failed to install the update.
    InstallFailed(String),
    /// Failed to parse update information.
    ParseError(String),
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UpdateError::NetworkError(msg) => write!(f, "Update network error: {}", msg),
            UpdateError::ChecksumMismatch(msg) => {
                write!(f, "Update checksum mismatch: {}", msg)
            }
            UpdateError::InstallFailed(msg) => {
                write!(f, "Update installation failed: {}", msg)
            }
            UpdateError::ParseError(msg) => write!(f, "Update parse error: {}", msg),
        }
    }
}

impl std::error::Error for UpdateError {}

// === GitHubError ===

/// Errors related to GitHub integration operations.
#[derive(Debug)]
pub enum GitHubError {
    /// GitHub authentication failed.
    AuthFailed(String),
    /// The GitHub access token has expired.
    TokenExpired,
    /// A network error occurred while communicating with GitHub.
    NetworkError(String),
    /// The GitHub API returned an error.
    ApiError(String),
    /// The user is not authenticated with GitHub.
    NotAuthenticated,
}

impl fmt::Display for GitHubError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GitHubError::AuthFailed(msg) => {
                write!(f, "GitHub authentication failed: {}", msg)
            }
            GitHubError::TokenExpired => write!(f, "GitHub access token expired"),
            GitHubError::NetworkError(msg) => write!(f, "GitHub network error: {}", msg),
            GitHubError::ApiError(msg) => write!(f, "GitHub API error: {}", msg),
            GitHubError::NotAuthenticated => write!(f, "Not authenticated with GitHub"),
        }
    }
}

impl std::error::Error for GitHubError {}
