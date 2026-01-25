//! Background Task tailing for sub-agent tool calls
//!
//! When a Task tool runs with `run_in_background: true`, its sub-tools are written
//! to a separate output file. This module provides functionality to tail that file
//! and emit tool events with the proper `parent_tool_use_id` for UI grouping.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::tail::{NdjsonTailer, POLL_INTERVAL};

/// Payload for tool use events sent to frontend (matches claude.rs)
#[derive(serde::Serialize, Clone)]
struct ToolUseEvent {
    session_id: String,
    worktree_id: String,
    id: String,
    name: String,
    input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_tool_use_id: Option<String>,
}

/// Payload for tool result events sent to frontend
#[derive(serde::Serialize, Clone)]
struct ToolResultEvent {
    session_id: String,
    worktree_id: String,
    tool_use_id: String,
    output: String,
}

/// Handle for a running background Task tailer
pub struct BackgroundTailerHandle {
    /// The Task tool's tool_use_id (becomes parent_tool_use_id for sub-tools)
    #[allow(dead_code)]
    pub task_tool_use_id: String,
    /// Channel to signal cancellation
    pub cancel_sender: Sender<()>,
}

/// Collection of background tailers for a session
pub type BackgroundTailers = Arc<Mutex<HashMap<String, BackgroundTailerHandle>>>;

/// Create a new BackgroundTailers collection
pub fn new_background_tailers() -> BackgroundTailers {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Parse a Task tool_result to extract the output_file path for background tasks.
///
/// The tool_result content is plain text in the format:
/// ```text
/// Async agent launched successfully.
/// agentId: ab2b9e8 (internal ID - do not mention to user...)
/// output_file: /path/to/output.jsonl
/// The agent is working in the background...
/// ```
///
/// Returns None if not a background task or if parsing fails.
pub fn parse_background_task_result(content: &str) -> Option<PathBuf> {
    // Look for "output_file: " prefix in the text
    const PREFIX: &str = "output_file: ";

    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(path_str) = trimmed.strip_prefix(PREFIX) {
            let path = path_str.trim();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }

    None
}

/// Start tailing a background Task's output file.
///
/// Spawns a thread that:
/// 1. Waits for the output file to exist
/// 2. Tails the file for new NDJSON lines
/// 3. Emits `chat:tool_use` events with the parent Task's ID
/// 4. Stops when the agent emits a "result" message or is cancelled
pub fn spawn_background_tailer(
    app: AppHandle,
    session_id: String,
    worktree_id: String,
    parent_tool_use_id: String,
    output_file: PathBuf,
    tailers: BackgroundTailers,
) {
    let (cancel_tx, cancel_rx) = mpsc::channel();
    let task_id = parent_tool_use_id.clone();

    // Store handle for cleanup
    {
        let mut tailers_guard = tailers.lock().unwrap();
        tailers_guard.insert(
            task_id.clone(),
            BackgroundTailerHandle {
                task_tool_use_id: task_id.clone(),
                cancel_sender: cancel_tx,
            },
        );
    }

    // Clone for the thread
    let tailers_cleanup = tailers.clone();

    thread::spawn(move || {
        log::debug!(
            "Background tailer started for task {task_id}, output: {output_file:?}"
        );

        // Wait for the file to exist (with timeout)
        let max_wait = Duration::from_secs(30);
        let start = std::time::Instant::now();

        while !output_file.exists() {
            if cancel_rx.try_recv().is_ok() {
                log::debug!("Background tailer {task_id} cancelled while waiting for file");
                return;
            }
            if start.elapsed() > max_wait {
                log::warn!(
                    "Background tailer {task_id} timed out waiting for file: {output_file:?}"
                );
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }

        // Create tailer
        let mut tailer = match NdjsonTailer::new_from_start(&output_file) {
            Ok(t) => t,
            Err(e) => {
                log::error!("Background tailer {task_id} failed to open file: {e}");
                return;
            }
        };

        log::debug!("Background tailer {task_id} now tailing {output_file:?}");

        // Track tool calls for this background agent
        let mut tool_calls: HashMap<String, ()> = HashMap::new();

        // Main tailing loop
        loop {
            // Check for cancellation
            if cancel_rx.try_recv().is_ok() {
                log::debug!("Background tailer {task_id} cancelled");
                break;
            }

            // Poll for new lines
            let lines = match tailer.poll() {
                Ok(l) => l,
                Err(e) => {
                    log::error!("Background tailer {task_id} poll error: {e}");
                    break;
                }
            };

            if !lines.is_empty() {
                log::debug!("Background tailer {task_id} read {} lines", lines.len());
            }

            for line in lines {
                if line.trim().is_empty() {
                    continue;
                }

                // Skip metadata
                if line.contains("\"_run_meta\"") {
                    continue;
                }

                // Parse JSON
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(m) => m,
                    Err(e) => {
                        log::debug!("Background tailer {task_id} failed to parse line: {e}");
                        log::debug!("Line content: {}", &line[..line.len().min(200)]);
                        continue;
                    }
                };

                let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
                log::debug!("Background tailer {task_id} processing message type: {msg_type}");

                match msg_type {
                    "assistant" => {
                        // Process tool_use blocks
                        if let Some(message) = msg.get("message") {
                            if let Some(blocks) = message.get("content").and_then(|c| c.as_array())
                            {
                                for block in blocks {
                                    let block_type =
                                        block.get("type").and_then(|v| v.as_str()).unwrap_or("");

                                    if block_type == "tool_use" {
                                        let id = block
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let name = block
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let input = block
                                            .get("input")
                                            .cloned()
                                            .unwrap_or(Value::Null);

                                        // Track this tool call
                                        tool_calls.insert(id.clone(), ());

                                        // Emit tool_use event with parent_tool_use_id
                                        let event = ToolUseEvent {
                                            session_id: session_id.clone(),
                                            worktree_id: worktree_id.clone(),
                                            id: id.clone(),
                                            name: name.clone(),
                                            input,
                                            parent_tool_use_id: Some(parent_tool_use_id.clone()),
                                        };

                                        if let Err(e) = app.emit("chat:tool_use", &event) {
                                            log::error!(
                                                "Background tailer {task_id} failed to emit tool_use: {e}"
                                            );
                                        } else {
                                            log::debug!(
                                                "Background tailer {task_id} emitted tool_use: {name} ({id})"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                    "user" => {
                        // Process tool_result blocks
                        if let Some(message) = msg.get("message") {
                            if let Some(blocks) = message.get("content").and_then(|c| c.as_array())
                            {
                                for block in blocks {
                                    let block_type =
                                        block.get("type").and_then(|v| v.as_str()).unwrap_or("");

                                    if block_type == "tool_result" {
                                        let tool_use_id = block
                                            .get("tool_use_id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        // Content can be a string OR an array of content blocks
                                        let output = block
                                            .get("content")
                                            .map(|v| {
                                                if let Some(s) = v.as_str() {
                                                    s.to_string()
                                                } else if let Some(arr) = v.as_array() {
                                                    arr.iter()
                                                        .filter_map(|item| {
                                                            if item.get("type").and_then(|t| t.as_str())
                                                                == Some("text")
                                                            {
                                                                item.get("text")
                                                                    .and_then(|t| t.as_str())
                                                                    .map(|s| s.to_string())
                                                            } else {
                                                                None
                                                            }
                                                        })
                                                        .collect::<Vec<_>>()
                                                        .join("\n")
                                                } else {
                                                    String::new()
                                                }
                                            })
                                            .unwrap_or_default();

                                        // Only emit if we emitted the tool_use
                                        if tool_calls.contains_key(&tool_use_id) {
                                            let event = ToolResultEvent {
                                                session_id: session_id.clone(),
                                                worktree_id: worktree_id.clone(),
                                                tool_use_id: tool_use_id.clone(),
                                                output,
                                            };

                                            if let Err(e) = app.emit("chat:tool_result", &event) {
                                                log::error!(
                                                    "Background tailer {task_id} failed to emit tool_result: {e}"
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    "result" => {
                        // Agent completed
                        log::debug!("Background tailer {task_id} agent completed");
                        break;
                    }
                    _ => {}
                }
            }

            thread::sleep(POLL_INTERVAL);
        }

        // Remove from tailers map
        if let Ok(mut tailers_guard) = tailers_cleanup.lock() {
            tailers_guard.remove(&task_id);
        }

        log::debug!("Background tailer {task_id} finished");
    });
}

/// Stop all background tailers for a session
pub fn stop_all_background_tailers(tailers: &BackgroundTailers) {
    if let Ok(mut tailers_guard) = tailers.lock() {
        for (task_id, handle) in tailers_guard.drain() {
            log::debug!("Stopping background tailer for task {task_id}");
            let _ = handle.cancel_sender.send(());
        }
    }
}

/// Stop a specific background tailer
#[allow(dead_code)]
pub fn stop_background_tailer(tailers: &BackgroundTailers, task_tool_use_id: &str) {
    if let Ok(mut tailers_guard) = tailers.lock() {
        if let Some(handle) = tailers_guard.remove(task_tool_use_id) {
            log::debug!("Stopping background tailer for task {task_tool_use_id}");
            let _ = handle.cancel_sender.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_background_task_result_valid() {
        let content = r#"Async agent launched successfully.
agentId: ab2b9e8 (internal ID - do not mention to user. Use to resume later if needed.)
output_file: /tmp/agent-output.jsonl
The agent is working in the background."#;
        let result = parse_background_task_result(content);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), PathBuf::from("/tmp/agent-output.jsonl"));
    }

    #[test]
    fn test_parse_background_task_result_real_format() {
        let content = "Async agent launched successfully.\nagentId: ab2b9e8 (internal ID - do not mention to user. Use to resume later if needed.)\noutput_file: /private/tmp/claude/-Users-jean-benoit-jean-theme-scheduler-test-sweet-bison/tasks/ab2b9e8.output\nThe agent is working in the background. You will be notified when it completes—no need to check. Continue with other tasks.\nTo check progress before completion (optional), use Read or Bash tail on the output file.";
        let result = parse_background_task_result(content);
        assert!(result.is_some());
        assert_eq!(
            result.unwrap(),
            PathBuf::from("/private/tmp/claude/-Users-jean-benoit-jean-theme-scheduler-test-sweet-bison/tasks/ab2b9e8.output")
        );
    }

    #[test]
    fn test_parse_background_task_result_no_output_file() {
        let content = "Task completed successfully.\nNo background agent was launched.";
        let result = parse_background_task_result(content);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_background_task_result_empty() {
        let content = "";
        let result = parse_background_task_result(content);
        assert!(result.is_none());
    }

    #[test]
    fn test_new_background_tailers() {
        let tailers = new_background_tailers();
        assert!(tailers.lock().unwrap().is_empty());
    }
}
