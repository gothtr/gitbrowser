use serde::{Deserialize, Serialize};

/// OAuth Device Flow code response from GitHub.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthDeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u32,
    pub interval: u32,
}

/// GitHub user profile information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubProfile {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
    pub html_url: String,
}

/// A GitHub notification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubNotification {
    pub id: String,
    pub title: String,
    pub repo_full_name: String,
    pub notification_type: String,
    pub unread: bool,
    pub updated_at: String,
    pub url: String,
}

/// A GitHub repository summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRepo {
    pub full_name: String,
    pub description: Option<String>,
    pub html_url: String,
    pub stargazers_count: u32,
    pub language: Option<String>,
    pub updated_at: String,
}

/// A GitHub pull request summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubPullRequest {
    pub id: u64,
    pub title: String,
    pub repo_full_name: String,
    pub state: String,
    pub html_url: String,
    pub created_at: String,
    pub user_login: String,
}
