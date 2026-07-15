use crate::{
    BackendError, BackendErrorCode, GitHubAuthor, GitHubComment, GitHubReview, PullRequestContext,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Output};
use std::sync::Arc;

const MAX_DIFF_SIZE: usize = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubLabel {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullRequestDetail {
    pub number: u32,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub is_draft: bool,
    pub created_at: String,
    pub author: GitHubAuthor,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub labels: Vec<GitHubLabel>,
    #[serde(default)]
    pub comments: Vec<GitHubComment>,
    #[serde(default)]
    pub reviews: Vec<GitHubReview>,
}

pub type GhRunner =
    Arc<dyn Fn(&str, &[&str]) -> Result<Output, BackendError> + Send + Sync + 'static>;

#[derive(Clone)]
pub struct GitHubService {
    runner: GhRunner,
}

impl Default for GitHubService {
    fn default() -> Self {
        Self {
            runner: Arc::new(native_gh),
        }
    }
}

impl GitHubService {
    pub fn new(runner: GhRunner) -> Self {
        Self { runner }
    }

    pub fn pull_request_detail(
        &self,
        project_path: &str,
        number: u32,
    ) -> Result<GitHubPullRequestDetail, BackendError> {
        let number_arg = number.to_string();
        let output = (self.runner)(
            project_path,
            &[
                "pr",
                "view",
                &number_arg,
                "--json",
                "number,title,body,state,headRefName,baseRefName,isDraft,createdAt,author,url,labels,comments,reviews",
            ],
        )?;
        if !output.status.success() {
            return Err(gh_pr_failure(output, number));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            BackendError::new(
                BackendErrorCode::InvalidArgument,
                format!("Failed to parse gh response: {error}"),
            )
        })
    }

    pub fn pull_request_diff(
        &self,
        project_path: &str,
        number: u32,
    ) -> Result<String, BackendError> {
        let number_arg = number.to_string();
        let output = (self.runner)(
            project_path,
            &["pr", "diff", &number_arg, "--color", "never"],
        )?;
        if !output.status.success() {
            return Ok(String::new());
        }
        let diff = String::from_utf8_lossy(&output.stdout).into_owned();
        if diff.len() <= MAX_DIFF_SIZE {
            return Ok(diff);
        }
        let end = diff
            .char_indices()
            .take_while(|(index, _)| *index < MAX_DIFF_SIZE)
            .last()
            .map(|(index, character)| index + character.len_utf8())
            .unwrap_or(MAX_DIFF_SIZE.min(diff.len()));
        Ok(format!(
            "{}...\n\n[Diff truncated at 100KB - {} bytes total. Run `gh pr diff {number}` to see the full diff.]",
            &diff[..end],
            diff.len()
        ))
    }

    pub fn pull_request_context(
        &self,
        project_path: &str,
        number: u32,
    ) -> Result<PullRequestContext, BackendError> {
        let detail = self.pull_request_detail(project_path, number)?;
        Ok(PullRequestContext {
            number: detail.number,
            title: detail.title,
            body: detail.body,
            head_ref_name: detail.head_ref_name,
            base_ref_name: detail.base_ref_name,
            comments: detail.comments,
            reviews: detail.reviews,
            diff: Some(self.pull_request_diff(project_path, number)?),
        })
    }
}

fn native_gh(project_path: &str, args: &[&str]) -> Result<Output, BackendError> {
    let mut command = Command::new("gh");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .args(args)
        .current_dir(Path::new(project_path))
        .output()
        .map_err(|error| {
            BackendError::new(BackendErrorCode::Io, format!("Failed to run gh: {error}"))
        })
}

fn gh_failure(output: Output, operation: &str) -> BackendError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lower = stderr.to_lowercase();
    let message = if lower.contains("gh auth login")
        || lower.contains("not authenticated")
        || lower.contains("requires authentication")
        || lower.contains("authentication required")
        || lower.contains("bad credentials")
    {
        "GitHub CLI not authenticated. Run 'gh auth login' first.".to_string()
    } else {
        format!("{operation} failed: {stderr}")
    };
    BackendError::new(BackendErrorCode::Io, message)
}

fn gh_pr_failure(output: Output, number: u32) -> BackendError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("Could not resolve") || stderr.contains("not found") {
        BackendError::new(
            BackendErrorCode::InvalidArgument,
            format!("PR #{number} not found"),
        )
    } else {
        gh_failure(output, "gh pr view")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn pull_request_context_uses_one_shared_gh_pipeline() {
        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let observed = calls.clone();
        let runner: GhRunner = Arc::new(move |_path, args| {
            observed
                .lock()
                .unwrap()
                .push(args.iter().map(|arg| (*arg).to_string()).collect());
            let mut output = Command::new("git").arg("--version").output().unwrap();
            output.stdout = if args.get(1) == Some(&"view") {
                br#"{"number":42,"title":"Shared PR","body":"body","state":"OPEN","headRefName":"feature","baseRefName":"main","isDraft":false,"createdAt":"2026-01-01","author":{"login":"octo"},"comments":[],"reviews":[]}"#.to_vec()
            } else {
                b"diff --git a/file b/file\n".to_vec()
            };
            Ok(output)
        });

        let context = GitHubService::new(runner)
            .pull_request_context("/repo", 42)
            .unwrap();

        assert_eq!(context.number, 42);
        assert_eq!(context.head_ref_name, "feature");
        assert_eq!(context.diff.as_deref(), Some("diff --git a/file b/file\n"));
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(&calls[0][..3], ["pr", "view", "42"]);
        assert_eq!(&calls[1][..3], ["pr", "diff", "42"]);
    }
}
