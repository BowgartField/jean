//! Command Code CLI execution engine.
//!
//! Uses documented headless mode (`cmd -p`) which is final-output-only. With
//! `--verbose` the native session id is written to stderr (`session: <uuid>`);
//! Jean captures it and resumes the exact conversation on the next turn via
//! `--resume <id>`. Jean still injects transcript/context into the prompt and
//! emits one synthetic final chunk for frontend compatibility.
//! Docs: https://commandcode.ai/docs/core-concepts/headless

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use jean_core::commandcode;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use tauri::AppHandle;

#[derive(serde::Serialize, Clone)]
struct ChunkEvent {
    session_id: String,
    worktree_id: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct DoneEvent {
    session_id: String,
    worktree_id: String,
    waiting_for_plan: bool,
}

pub struct CommandCodeResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub waiting_for_plan: bool,
    pub usage: Option<UsageData>,
}

fn preview_for_log(text: &str) -> String {
    const MAX_CHARS: usize = 2_000;
    let mut preview: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        preview.push_str("…");
    }
    preview.replace('\n', "\\n")
}

fn read_native_commandcode_turn(session_id: &str) -> Option<commandcode::CommandCodeNativeTurn> {
    let parsed = commandcode::read_native_turn(session_id);
    if parsed.is_none() {
        log::debug!(
            "Command Code native session file had no parseable turn session={}",
            session_id
        );
    }
    parsed
}

pub fn execute_commandcode_headless(
    app: &AppHandle,
    jean_session_id: &str,
    worktree_id: &str,
    run_id: &str,
    working_dir: &Path,
    execution_mode: Option<&str>,
    model: Option<&str>,
    message: &str,
    system_context: Option<&str>,
    resume_session_id: Option<&str>,
    pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
) -> Result<(u32, CommandCodeResponse), String> {
    let binary_path = crate::commandcode_cli::resolve_cli_binary(app);
    if !binary_path.exists() {
        log::warn!(
            "Command Code CLI not found for session={} worktree={} resolved_path={}",
            jean_session_id,
            worktree_id,
            binary_path.display()
        );
        return Err("Command Code CLI not found. Install it with `npm install -g command-code` and run `cmd login`.".to_string());
    }

    let mode = execution_mode.unwrap_or("plan");
    log::info!(
        "Starting Command Code headless run session={} worktree={} mode={} binary={} cwd={} streaming=false",
        jean_session_id,
        worktree_id,
        mode,
        binary_path.display(),
        working_dir.display()
    );
    log::debug!(
        "Command Code prompt inputs session={} message_bytes={} system_context_bytes={} selected_model={:?}",
        jean_session_id,
        message.len(),
        system_context.map(str::len).unwrap_or(0),
        model
    );

    let invocation = commandcode::invocation(
        message,
        system_context,
        execution_mode,
        model,
        resume_session_id,
        true,
    );
    let mut command =
        crate::platform::cli_command(&binary_path.to_string_lossy(), Some(working_dir));
    command.args(&invocation.args);
    if let Some(resume_id) = resume_session_id {
        log::info!(
            "Command Code run session={} resuming native session {}",
            jean_session_id,
            resume_id
        );
    }
    let cli_model = model.and_then(commandcode::normalize_model);
    if let Some(cli_model) = &cli_model {
        log::info!(
            "Command Code run session={} using --model {} max_turns={}",
            jean_session_id,
            cli_model,
            commandcode::DEFAULT_MAX_TURNS
        );
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn Command Code CLI: {e}"))?;
    let pid = child.id();
    log::info!(
        "Spawned Command Code process session={} worktree={} pid={} (output is final-only; waiting for process exit)",
        jean_session_id,
        worktree_id,
        pid
    );
    if let Some(cb) = pid_callback {
        cb(pid);
    }

    if let Some(mut stdin) = child.stdin.take() {
        log::debug!(
            "Writing Command Code stdin session={} prompt_bytes={} prompt_preview=\"{}\"",
            jean_session_id,
            invocation.prompt.len(),
            preview_for_log(&invocation.prompt)
        );
        stdin
            .write_all(invocation.prompt.as_bytes())
            .map_err(|e| format!("Failed to write Command Code prompt: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Command Code CLI: {e}"))?;
    let stdout = commandcode::strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = commandcode::strip_ansi(&String::from_utf8_lossy(&output.stderr));

    // Prefer the native session id from `--verbose` stderr; fall back to the id we
    // resumed with so a turn that omits the verbose line still persists a resume id.
    let native_session_id = commandcode::parse_session_id(&stderr)
        .or_else(|| resume_session_id.map(str::to_string))
        .unwrap_or_default();
    log::info!(
        "Command Code native session id session={} resolved={:?}",
        jean_session_id,
        native_session_id
    );

    log::info!(
        "Command Code process exited session={} worktree={} pid={} success={} code={:?} stdout_bytes={} stderr_bytes={}",
        jean_session_id,
        worktree_id,
        pid,
        output.status.success(),
        output.status.code(),
        stdout.len(),
        stderr.len()
    );
    if !stdout.trim().is_empty() {
        log::debug!(
            "Command Code stdout session={} preview=\"{}\"",
            jean_session_id,
            preview_for_log(stdout.trim())
        );
    }
    if !stderr.trim().is_empty() {
        log::debug!(
            "Command Code stderr session={} preview=\"{}\"",
            jean_session_id,
            preview_for_log(stderr.trim())
        );
    }

    if !output.status.success() && output.status.code() == Some(130) {
        let waiting_for_plan = false;
        match app.emit_all(
            "chat:done",
            &DoneEvent {
                session_id: jean_session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                waiting_for_plan,
            },
        ) {
            Ok(_) => log::debug!(
                "Emitted Command Code cancellation chat:done session={} waiting_for_plan={}",
                jean_session_id,
                waiting_for_plan
            ),
            Err(error) => log::warn!(
                "Failed to emit Command Code cancellation chat:done session={}: {}",
                jean_session_id,
                error
            ),
        }
        return Ok((
            pid,
            CommandCodeResponse {
                content: String::new(),
                session_id: native_session_id.clone(),
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: true,
                waiting_for_plan,
                usage: None,
            },
        ));
    }

    if !output.status.success() {
        return Err(commandcode::error_for_status(output.status.code(), &stderr));
    }

    let parsed_output = commandcode::parse_plan_output(stdout.trim());
    let content = parsed_output.content;
    let waiting_for_plan = mode == "plan" && parsed_output.waiting_for_plan;
    let native_turn = (!native_session_id.is_empty())
        .then(|| read_native_commandcode_turn(&native_session_id))
        .flatten();
    if !content.is_empty() {
        match app.emit_all(
            "chat:chunk",
            &ChunkEvent {
                session_id: jean_session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                content: content.clone(),
                run_id: Some(run_id.to_string()),
            },
        ) {
            Ok(_) => log::debug!(
                "Emitted Command Code synthetic chat:chunk session={} bytes={}",
                jean_session_id,
                content.len()
            ),
            Err(error) => log::warn!(
                "Failed to emit Command Code chat:chunk session={}: {}",
                jean_session_id,
                error
            ),
        }
    } else {
        log::warn!(
            "Command Code completed with empty stdout session={} worktree={}",
            jean_session_id,
            worktree_id
        );
    }
    match app.emit_all(
        "chat:done",
        &DoneEvent {
            session_id: jean_session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            waiting_for_plan,
        },
    ) {
        Ok(_) => log::debug!(
            "Emitted Command Code chat:done session={} waiting_for_plan={}",
            jean_session_id,
            waiting_for_plan
        ),
        Err(error) => log::warn!(
            "Failed to emit Command Code chat:done session={}: {}",
            jean_session_id,
            error
        ),
    }

    let (tool_calls, content_blocks) = if let Some(native_turn) = native_turn {
        log::debug!(
            "Parsed Command Code native turn session={} tool_calls={} content_blocks={}",
            jean_session_id,
            native_turn.tool_calls.len(),
            native_turn.content_blocks.len()
        );
        (
            native_turn
                .tool_calls
                .into_iter()
                .map(|call| ToolCall {
                    id: call.id,
                    name: call.name,
                    input: call.input,
                    output: call.output,
                    parent_tool_use_id: None,
                })
                .collect(),
            native_turn
                .content_blocks
                .into_iter()
                .map(|block| match block {
                    commandcode::CommandCodeContentBlock::Text { text } => {
                        ContentBlock::Text { text }
                    }
                    commandcode::CommandCodeContentBlock::ToolUse { tool_call_id } => {
                        ContentBlock::ToolUse { tool_call_id }
                    }
                })
                .collect(),
        )
    } else if content.is_empty() {
        (vec![], vec![])
    } else {
        (
            vec![],
            vec![ContentBlock::Text {
                text: content.clone(),
            }],
        )
    };
    Ok((
        pid,
        CommandCodeResponse {
            content,
            session_id: native_session_id,
            tool_calls,
            content_blocks,
            cancelled: false,
            waiting_for_plan,
            usage: None,
        },
    ))
}

pub fn execute_one_shot_commandcode(
    app: &AppHandle,
    prompt: &str,
    working_dir: Option<&str>,
    execution_mode: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    let binary_path = crate::commandcode_cli::resolve_cli_binary(app);
    if !binary_path.exists() {
        log::warn!(
            "Command Code CLI not found for one-shot resolved_path={}",
            binary_path.display()
        );
        return Err(
            "Command Code CLI not found. Install it with `npm install -g command-code`."
                .to_string(),
        );
    }
    log::info!(
        "Starting Command Code one-shot mode={} binary={} cwd={:?} streaming=false prompt_bytes={} selected_model={:?}",
        execution_mode.unwrap_or("plan"),
        binary_path.display(),
        working_dir,
        prompt.len(),
        model
    );
    let cwd = working_dir.map(Path::new);
    let mut command = crate::platform::cli_command(&binary_path.to_string_lossy(), cwd);
    command.args(commandcode::arguments(execution_mode, model, None, false));
    let cli_model = model.and_then(commandcode::normalize_model);
    if let Some(cli_model) = &cli_model {
        log::info!("Command Code one-shot using --model {}", cli_model);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn Command Code CLI: {e}"))?;
    let pid = child.id();
    log::info!("Spawned Command Code one-shot pid={}", pid);
    if let Some(mut stdin) = child.stdin.take() {
        log::debug!(
            "Writing Command Code one-shot stdin pid={} prompt_preview=\"{}\"",
            pid,
            preview_for_log(prompt)
        );
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("Failed to write Command Code prompt: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Command Code CLI: {e}"))?;
    let stdout = commandcode::strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = commandcode::strip_ansi(&String::from_utf8_lossy(&output.stderr));
    log::info!(
        "Command Code one-shot exited pid={} success={} code={:?} stdout_bytes={} stderr_bytes={}",
        pid,
        output.status.success(),
        output.status.code(),
        stdout.len(),
        stderr.len()
    );
    if !stdout.trim().is_empty() {
        log::debug!(
            "Command Code one-shot stdout pid={} preview=\"{}\"",
            pid,
            preview_for_log(stdout.trim())
        );
    }
    if !stderr.trim().is_empty() {
        log::debug!(
            "Command Code one-shot stderr pid={} preview=\"{}\"",
            pid,
            preview_for_log(stderr.trim())
        );
    }
    if !output.status.success() {
        return Err(commandcode::error_for_status(output.status.code(), &stderr));
    }
    Ok(stdout.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commandcode_plan_detection_does_not_wait_for_plain_chat() {
        let output =
            commandcode::parse_plan_output("Doing well, thanks. What are we working on today?");

        assert_eq!(
            output.content,
            "Doing well, thanks. What are we working on today?"
        );
        assert!(!output.waiting_for_plan);
    }

    #[test]
    fn commandcode_plan_detection_waits_for_marked_plan() {
        let output = commandcode::parse_plan_output(
            "I found the issue.\n\n<jean-plan>\n1. Add regression test\n2. Fix parser\n</jean-plan>",
        );

        assert_eq!(output.content, "1. Add regression test\n2. Fix parser");
        assert!(output.waiting_for_plan);
    }

    #[test]
    fn commandcode_session_id_parsed_from_verbose_stderr() {
        let stderr = "some startup noise\nsession: f2d6faed-4c9e-4f59-bb8d-b45a9a79eb3c\nmore logs";
        assert_eq!(
            commandcode::parse_session_id(stderr).as_deref(),
            Some("f2d6faed-4c9e-4f59-bb8d-b45a9a79eb3c")
        );
    }

    #[test]
    fn commandcode_session_id_absent_returns_none() {
        assert!(commandcode::parse_session_id("no id here\njust logs").is_none());
    }

    #[test]
    fn commandcode_plan_prompt_guidance_is_only_added_in_plan_mode() {
        let plan_prompt =
            commandcode::invocation("message", Some("context"), Some("plan"), None, None, false)
                .prompt;
        assert!(plan_prompt.contains("<commandcode_plan_contract>"));
        assert!(plan_prompt.contains("<jean-plan>"));

        let build_prompt =
            commandcode::invocation("message", Some("context"), Some("build"), None, None, false)
                .prompt;
        assert!(!build_prompt.contains("<commandcode_plan_contract>"));
    }

    #[test]
    fn native_commandcode_turn_parses_tool_call_and_result_blocks() {
        let jsonl = r#"{"role":"user","content":"you can run it"}
{"role":"assistant","content":[{"type":"text","text":"I'll run the date command."},{"type":"tool-call","toolCallId":"call_1","toolName":"shell_command","input":{"command":"date"}},{"type":"tool-call","toolCallId":"call_2","toolName":"read_file","input":{"absolutePath":"/tmp/package.json","limit":20}},{"type":"tool-call","toolCallId":"call_3","toolName":"write_file","input":{"filePath":"/tmp/demo.md","content":"hello"}},{"type":"tool-call","toolCallId":"call_4","toolName":"read_multiple_files","input":{"targetDirectory":"/tmp","include":["*.md"]}}]}
{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_1","toolName":"shell_command","output":{"type":"text","value":"Fri Jun 26 23:56:08 CEST 2026"}},{"type":"tool-result","toolCallId":"call_2","toolName":"read_file","output":{"type":"text","value":"package contents"}},{"type":"tool-result","toolCallId":"call_3","toolName":"write_file","output":{"type":"text","value":"wrote file"}},{"type":"tool-result","toolCallId":"call_4","toolName":"read_multiple_files","output":{"type":"text","value":"read files"}}]}
{"role":"assistant","content":[{"type":"text","text":"It's Fri Jun 26 23:56:08 CEST 2026."}]}"#;

        let parsed = commandcode::parse_native_turn(jsonl).expect("native turn parsed");

        assert_eq!(parsed.tool_calls.len(), 4);
        assert_eq!(parsed.tool_calls[0].id, "call_1");
        assert_eq!(parsed.tool_calls[0].name, "Bash");
        assert_eq!(
            parsed.tool_calls[0].input,
            serde_json::json!({"command": "date"})
        );
        assert_eq!(
            parsed.tool_calls[0].output.as_deref(),
            Some("Fri Jun 26 23:56:08 CEST 2026")
        );
        assert_eq!(parsed.tool_calls[1].id, "call_2");
        assert_eq!(parsed.tool_calls[1].name, "Read");
        assert_eq!(
            parsed.tool_calls[1].input,
            serde_json::json!({"file_path": "/tmp/package.json", "limit": 20})
        );
        assert_eq!(parsed.tool_calls[2].name, "Write");
        assert_eq!(
            parsed.tool_calls[2].input,
            serde_json::json!({"file_path": "/tmp/demo.md", "content": "hello"})
        );
        assert_eq!(parsed.tool_calls[3].name, "ReadMultipleFiles");
        assert_eq!(
            parsed.tool_calls[3].input,
            serde_json::json!({"path": "/tmp", "include": ["*.md"]})
        );
        assert!(matches!(
            parsed.content_blocks.as_slice(),
            [
                commandcode::CommandCodeContentBlock::Text { .. },
                commandcode::CommandCodeContentBlock::ToolUse { tool_call_id },
                commandcode::CommandCodeContentBlock::ToolUse { .. },
                commandcode::CommandCodeContentBlock::ToolUse { .. },
                commandcode::CommandCodeContentBlock::ToolUse { .. },
                commandcode::CommandCodeContentBlock::Text { .. },
            ] if tool_call_id == "call_1"
        ));
    }
}
