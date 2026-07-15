use tauri::AppHandle;

use super::github_issues::IssueContext;

pub use jean_core::{
    LinearIssue, LinearIssueContext, LinearIssueContextContent, LinearIssueDetail,
    LinearIssueListResult, LinearTeam, LoadedLinearIssueContext,
};

// =============================================================================
// Helpers
// =============================================================================

/// Extract numeric part from Linear identifier (e.g., "ENG-123" → 123)
pub fn parse_linear_identifier_number(identifier: &str) -> u32 {
    identifier
        .rsplit_once('-')
        .and_then(|(_, num)| num.parse::<u32>().ok())
        .unwrap_or(0)
}

/// Generate branch name from Linear issue identifier and title
pub fn generate_branch_name_from_linear_issue(identifier: &str, title: &str) -> String {
    jean_core::generate_branch_name_from_linear_issue(identifier, title)
}

/// Convert a LinearIssueDetail to the shared IssueContext for create_worktree
pub fn linear_issue_to_issue_context(detail: &LinearIssueDetail) -> IssueContext {
    use super::github_issues::GitHubComment;

    let comments = detail
        .comments
        .iter()
        .map(|c| GitHubComment {
            body: c.body.clone(),
            author: super::github_issues::GitHubAuthor {
                login: c
                    .user
                    .as_ref()
                    .map(|u| u.display_name.clone())
                    .unwrap_or_else(|| "Unknown".to_string()),
            },
            created_at: c.created_at.clone(),
        })
        .collect();

    IssueContext {
        number: parse_linear_identifier_number(&detail.identifier),
        title: detail.title.clone(),
        body: detail.description.clone(),
        comments,
    }
}

// =============================================================================
// Tauri Commands
// =============================================================================

/// List Linear teams for a project
#[tauri::command]
pub async fn list_linear_teams(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<LinearTeam>, String> {
    crate::backend_runtime::linear_service(&app)?
        .list_teams(&project_id)
        .await
        .map_err(|error| error.to_string())
}

/// List Linear issues for a project (active states only)
#[tauri::command]
pub async fn list_linear_issues(
    app: AppHandle,
    project_id: String,
) -> Result<LinearIssueListResult, String> {
    crate::backend_runtime::linear_service(&app)?
        .list_issues(&project_id)
        .await
        .map_err(|error| error.to_string())
}

/// Search Linear issues
#[tauri::command]
pub async fn search_linear_issues(
    app: AppHandle,
    project_id: String,
    query: String,
) -> Result<Vec<LinearIssue>, String> {
    crate::backend_runtime::linear_service(&app)?
        .search_issues(&project_id, &query)
        .await
        .map_err(|error| error.to_string())
}

/// Get a single Linear issue with comments
#[tauri::command]
pub async fn get_linear_issue(
    app: AppHandle,
    project_id: String,
    issue_id: String,
) -> Result<LinearIssueDetail, String> {
    crate::backend_runtime::linear_service(&app)?
        .issue(&project_id, &issue_id)
        .await
        .map_err(|error| error.to_string())
}

/// Get a single Linear issue by its number (e.g., #12 → ENG-12)
#[tauri::command]
pub async fn get_linear_issue_by_number(
    app: AppHandle,
    project_id: String,
    issue_number: i64,
) -> Result<Option<LinearIssue>, String> {
    crate::backend_runtime::linear_service(&app)?
        .issue_by_number(&project_id, issue_number)
        .await
        .map_err(|error| error.to_string())
}

/// Load/refresh Linear issue context for a session
#[tauri::command]
pub async fn load_linear_issue_context(
    app: AppHandle,
    session_id: String,
    project_id: String,
    issue_id: String,
) -> Result<LoadedLinearIssueContext, String> {
    crate::backend_runtime::context_service(&app)?
        .load_linear_issue(
            &crate::backend_runtime::linear_service(&app)?,
            &session_id,
            &project_id,
            &issue_id,
        )
        .await
        .map_err(|error| error.to_string())
}

/// List all loaded Linear issue contexts for a session
#[tauri::command]
pub async fn list_loaded_linear_issue_contexts(
    app: AppHandle,
    session_id: String,
    worktree_id: Option<String>,
    project_id: String,
) -> Result<Vec<LoadedLinearIssueContext>, String> {
    crate::backend_runtime::context_service(&app)?
        .list_linear_issues(
            &crate::backend_runtime::linear_service(&app)?,
            &session_id,
            worktree_id.as_deref(),
            &project_id,
        )
        .map_err(|error| error.to_string())
}

/// Return the full markdown content of each loaded Linear issue context file.
/// Used to embed context directly into investigation prompts (Claude CLI cannot access Linear API).
#[tauri::command]
pub async fn get_linear_issue_context_contents(
    app: AppHandle,
    session_id: String,
    worktree_id: Option<String>,
    project_id: String,
) -> Result<Vec<LinearIssueContextContent>, String> {
    crate::backend_runtime::context_service(&app)?
        .linear_issue_contents(
            &crate::backend_runtime::linear_service(&app)?,
            &session_id,
            worktree_id.as_deref(),
            &project_id,
        )
        .map_err(|error| error.to_string())
}

/// Remove a loaded Linear issue context from a session
#[tauri::command]
pub async fn remove_linear_issue_context(
    app: AppHandle,
    session_id: String,
    project_id: String,
    identifier: String,
) -> Result<(), String> {
    crate::backend_runtime::context_service(&app)?
        .remove_linear_issue(
            &crate::backend_runtime::linear_service(&app)?,
            &session_id,
            &project_id,
            &identifier,
        )
        .map_err(|error| error.to_string())
}

// =============================================================================
// Context Reference Tracking
// =============================================================================

/// Get all Linear issue keys referenced by a session
pub fn get_session_linear_refs(app: &AppHandle, session_id: &str) -> Result<Vec<String>, String> {
    crate::backend_runtime::context_service(app)?
        .linear_keys(session_id)
        .map_err(|error| error.to_string())
}

/// Get Linear issue identifiers (e.g. "ENG-123") referenced by a session, filtered by project name.
pub fn get_session_linear_identifiers(
    app: &AppHandle,
    session_id: &str,
    project_name: &str,
) -> Result<Vec<String>, String> {
    crate::backend_runtime::context_service(app)?
        .linear_identifiers(session_id, project_name)
        .map_err(|error| error.to_string())
}
