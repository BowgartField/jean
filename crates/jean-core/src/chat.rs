use crate::{BackendContext, BackendError, BackendErrorCode};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
pub struct ChatRunManager {
    runs: Mutex<HashMap<String, CancellationToken>>,
}

impl ChatRunManager {
    pub fn register(&self, session_id: &str) -> Result<CancellationToken, BackendError> {
        let mut runs = self.runs.lock().unwrap_or_else(|error| error.into_inner());
        if runs.contains_key(session_id) {
            return Err(BackendError::new(
                BackendErrorCode::InvalidArgument,
                "Session already has an active request",
            ));
        }
        let token = CancellationToken::new();
        runs.insert(session_id.to_string(), token.clone());
        Ok(token)
    }

    pub fn unregister(&self, session_id: &str) {
        self.runs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(session_id);
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.runs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(session_id)
    }

    pub fn active_ids(&self) -> Vec<String> {
        self.runs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .keys()
            .cloned()
            .collect()
    }

    pub fn cancel(&self, session_id: &str) -> bool {
        let token = self
            .runs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(session_id)
            .cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub fn cancel_all(&self) -> usize {
        let runs = self.runs.lock().unwrap_or_else(|error| error.into_inner());
        let count = runs.len();
        for token in runs.values() {
            token.cancel();
        }
        count
    }
}

#[derive(Clone)]
pub struct ChatService {
    context: BackendContext,
}

impl ChatService {
    pub fn new(context: BackendContext) -> Self {
        Self { context }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send(
        &self,
        session_id: &str,
        worktree_id: &str,
        worktree_path: &str,
        message: &str,
        backend_override: Option<&str>,
        model: Option<&str>,
        execution_mode: Option<&str>,
        thinking_level: Option<&str>,
        effort_level: Option<&str>,
    ) -> Result<Value, BackendError> {
        if message.trim().is_empty() {
            return Err(invalid("Message cannot be empty"));
        }
        if !Path::new(worktree_path).is_dir() {
            return Err(invalid("Worktree path does not exist"));
        }
        let metadata = self
            .context
            .persistence
            .load_session_metadata(session_id)?
            .ok_or_else(|| invalid("Session not found"))?;
        if metadata.get("worktree_id").and_then(Value::as_str) != Some(worktree_id) {
            return Err(invalid("Session does not belong to this worktree"));
        }
        let backend = backend_override
            .or_else(|| metadata.get("backend").and_then(Value::as_str))
            .unwrap_or("claude")
            .to_string();
        let resume_session_id = metadata
            .get(resume_id_field(&backend))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let cancellation = self.context.state.chat_runs.register(session_id)?;
        let unregister = RunRegistration {
            manager: self.context.state.chat_runs.clone(),
            session_id: session_id.to_string(),
        };
        let run_id = Uuid::new_v4().to_string();
        let user_message_id = Uuid::new_v4().to_string();
        let started_at = now();
        let run = serde_json::json!({
            "run_id": run_id,
            "user_message_id": user_message_id,
            "user_message": message,
            "model": model,
            "execution_mode": execution_mode,
            "thinking_level": thinking_level,
            "effort_level": effort_level,
            "backend": backend,
            "started_at": started_at,
            "status": "running",
            "cancelled": false,
            "recovered": false,
        });
        self.update_metadata(session_id, |metadata| {
            let object = object_mut(metadata)?;
            object.insert("backend".to_string(), Value::String(backend.clone()));
            insert_optional(object, "selected_model", model);
            insert_optional(object, "selected_execution_mode", execution_mode);
            insert_optional(object, "selected_thinking_level", thinking_level);
            insert_optional(object, "selected_effort_level", effort_level);
            object
                .entry("runs")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .ok_or_else(|| invalid_data("runs"))?
                .push(run.clone());
            Ok(())
        })?;
        self.context.events.emit_json(
            "chat:sending",
            serde_json::json!({"session_id":session_id,"worktree_id":worktree_id,"user_message":message,"run_id":run_id}),
        )?;

        let execution = self
            .execute_backend(
                &backend,
                worktree_path,
                message,
                model,
                execution_mode,
                effort_level,
                session_id,
                worktree_id,
                &run_id,
                resume_session_id.as_deref(),
                cancellation,
            )
            .await;
        drop(unregister);

        match execution {
            Ok(output) => {
                let assistant_id = Uuid::new_v4().to_string();
                let assistant = assistant_message(&assistant_id, session_id, &output);
                self.complete_run(session_id, worktree_id, &run_id, &assistant_id, &output)?;
                if output.cancelled {
                    self.context.events.emit_json(
                        "chat:cancelled",
                        serde_json::json!({"session_id":session_id,"worktree_id":worktree_id,"undo_send":output.content.is_empty(),"emitted_at_ms":now_millis(),"run_id":run_id}),
                    )?;
                } else {
                    self.context.events.emit_json(
                        "chat:done",
                        serde_json::json!({"session_id":session_id,"worktree_id":worktree_id,"run_id":run_id,"waiting_for_plan":output.waiting_for_plan}),
                    )?;
                }
                Ok(assistant)
            }
            Err(error) => {
                self.fail_run(session_id, &run_id)?;
                self.context.events.emit_json(
                    "chat:error",
                    serde_json::json!({"session_id":session_id,"worktree_id":worktree_id,"error":error.message,"run_id":run_id}),
                )?;
                Err(error)
            }
        }
    }

    pub fn cancel(&self, session_id: &str, worktree_id: &str) -> Result<bool, BackendError> {
        let cancelled = self.context.state.chat_runs.cancel(session_id);
        if !cancelled {
            self.context.events.emit_json(
                "chat:cancelled",
                serde_json::json!({"session_id":session_id,"worktree_id":worktree_id,"undo_send":false,"emitted_at_ms":now_millis()}),
            )?;
        }
        Ok(cancelled)
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_backend(
        &self,
        backend: &str,
        cwd: &str,
        message: &str,
        model: Option<&str>,
        execution_mode: Option<&str>,
        effort_level: Option<&str>,
        session_id: &str,
        worktree_id: &str,
        run_id: &str,
        resume_session_id: Option<&str>,
        cancellation: CancellationToken,
    ) -> Result<BackendOutput, BackendError> {
        let (mut command, stdin_prompt) = backend_command(
            backend,
            cwd,
            message,
            model,
            execution_mode,
            effort_level,
            resume_session_id,
        )?;
        command
            .current_dir(cwd)
            .stdin(if stdin_prompt.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("JEAN_SESSION_ID", session_id)
            .env("JEAN_WORKTREE_ID", worktree_id);
        configure_silent(&mut command);
        let mut child = command.spawn().map_err(|error| {
            BackendError::new(
                BackendErrorCode::Io,
                format!("Failed to start {backend}: {error}"),
            )
        })?;
        if let Some(prompt) = stdin_prompt {
            let mut stdin = child.stdin.take().ok_or_else(|| {
                BackendError::new(BackendErrorCode::Internal, "Missing backend stdin")
            })?;
            stdin.write_all(prompt.as_bytes()).await?;
            stdin.shutdown().await?;
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BackendError::new(BackendErrorCode::Internal, "Missing stdout"))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| BackendError::new(BackendErrorCode::Internal, "Missing stderr"))?;
        let events = self.context.events.clone();
        let sid = session_id.to_string();
        let wid = worktree_id.to_string();
        let rid = run_id.to_string();
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut raw = String::new();
            let mut streamed = String::new();
            while let Some(line) = lines.next_line().await? {
                raw.push_str(&line);
                raw.push('\n');
                if let Some(content) = extract_stream_text(&line) {
                    streamed.push_str(&content);
                    let _ = events.emit_json(
                        "chat:chunk",
                        serde_json::json!({"session_id":sid,"worktree_id":wid,"content":content,"run_id":rid}),
                    );
                }
            }
            Ok::<_, std::io::Error>((raw, streamed))
        });
        let stderr_reader = tokio::spawn(async move {
            let mut output = String::new();
            stderr.read_to_string(&mut output).await?;
            Ok::<_, std::io::Error>(output)
        });
        let (cancelled, status) = tokio::select! {
            status = child.wait() => {
                let status = status?;
                (false, status)
            }
            () = cancellation.cancelled() => {
                terminate_child(&mut child).await?;
                (true, child.wait().await?)
            }
        };
        let cancelled = cancelled || (backend == "commandcode" && status.code() == Some(130));
        let (raw, streamed) = reader.await.map_err(join_error)??;
        let stderr = stderr_reader.await.map_err(join_error)??;
        if !status.success() && !cancelled {
            let message = if backend == "commandcode" {
                crate::commandcode::error_for_status(status.code(), &stderr)
            } else {
                format!("{backend} exited with {status}: {}", stderr.trim())
            };
            return Err(BackendError::new(BackendErrorCode::Io, message));
        }
        let mut output = BackendOutput {
            cancelled,
            content: if streamed.is_empty() {
                extract_final_text(&raw).unwrap_or_else(|| raw.trim().to_string())
            } else {
                streamed
            },
            ..BackendOutput::default()
        };
        if backend == "commandcode" {
            let parsed = crate::commandcode::parse_plan_output(&output.content);
            output.content = parsed.content;
            output.waiting_for_plan =
                execution_mode.unwrap_or("plan") == "plan" && parsed.waiting_for_plan;
            output.resume_session_id = crate::commandcode::parse_session_id(&stderr)
                .or_else(|| resume_session_id.map(ToOwned::to_owned));
            let native_turn = if cancelled {
                None
            } else {
                output
                    .resume_session_id
                    .as_deref()
                    .and_then(crate::commandcode::read_native_turn)
            };
            if let Some(native_turn) = native_turn {
                output.tool_calls = serde_json::to_value(native_turn.tool_calls)?;
                output.content_blocks = serde_json::to_value(native_turn.content_blocks)?;
            }
            emit_commandcode_tools(
                self.context.events.as_ref(),
                session_id,
                worktree_id,
                run_id,
                &output.tool_calls,
            )?;
        }
        if output.content_blocks.as_array().is_some_and(Vec::is_empty) && !output.content.is_empty()
        {
            output.content_blocks = serde_json::json!([{
                "type":"text",
                "text":output.content,
            }]);
        }
        if !output.content.is_empty()
            && !cancelled
            && !raw.lines().any(|line| extract_stream_text(line).is_some())
        {
            self.context.events.emit_json(
                "chat:chunk",
                serde_json::json!({"session_id":session_id,"worktree_id":worktree_id,"content":output.content,"run_id":run_id}),
            )?;
        }
        Ok(output)
    }

    fn complete_run(
        &self,
        session_id: &str,
        worktree_id: &str,
        run_id: &str,
        assistant_id: &str,
        output: &BackendOutput,
    ) -> Result<(), BackendError> {
        self.update_metadata(session_id, |metadata| {
            let object = object_mut(metadata)?;
            let runs = object
                .get_mut("runs")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| invalid_data("runs"))?;
            let run = runs
                .iter_mut()
                .find(|run| run.get("run_id").and_then(Value::as_str) == Some(run_id))
                .ok_or_else(|| invalid_data("run"))?;
            let run = object_mut(run)?;
            run.insert(
                "status".to_string(),
                Value::String(
                    if output.cancelled {
                        "cancelled"
                    } else {
                        "completed"
                    }
                    .to_string(),
                ),
            );
            run.insert("ended_at".to_string(), Value::from(now()));
            run.insert(
                "assistant_message_id".to_string(),
                Value::String(assistant_id.to_string()),
            );
            run.insert("cancelled".to_string(), Value::Bool(output.cancelled));
            if let Some(resume_session_id) = &output.resume_session_id {
                object.insert(
                    "commandcode_session_id".to_string(),
                    Value::String(resume_session_id.clone()),
                );
            }
            object.insert(
                "waiting_for_input".to_string(),
                Value::Bool(output.waiting_for_plan),
            );
            object.insert(
                "waiting_for_input_type".to_string(),
                if output.waiting_for_plan {
                    Value::String("plan".to_string())
                } else {
                    Value::Null
                },
            );
            object.insert("updated_at".to_string(), Value::from(now()));
            object.insert("last_message_at".to_string(), Value::from(now()));
            Ok(())
        })?;
        let path = self.context.persistence.run_log_path(session_id, run_id)?;
        let line = serde_json::to_string(&serde_json::json!({
            "type":"assistant",
            "message":{
                "content":output.content_blocks,
                "tool_calls":output.tool_calls,
                "text":output.content,
            }
        }))?;
        std::fs::write(path, format!("{line}\n"))?;
        self.context.persistence.update_session_index(
            worktree_id,
            serde_json::json!({"worktree_id":worktree_id,"active_session_id":session_id,"sessions":[],"version":1}),
            |index| {
                if let Some(entry) = object_mut(index)?
                    .get_mut("sessions")
                    .and_then(Value::as_array_mut)
                    .and_then(|sessions| {
                        sessions.iter_mut().find(|entry| {
                            entry.get("id").and_then(Value::as_str) == Some(session_id)
                        })
                    })
                {
                    let entry = object_mut(entry)?;
                    let count = entry
                        .get("message_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        + 2;
                    entry.insert("message_count".to_string(), Value::from(count));
                }
                Ok(())
            },
        )?;
        Ok(())
    }

    fn fail_run(&self, session_id: &str, run_id: &str) -> Result<(), BackendError> {
        self.update_metadata(session_id, |metadata| {
            if let Some(run) = object_mut(metadata)?
                .get_mut("runs")
                .and_then(Value::as_array_mut)
                .and_then(|runs| {
                    runs.iter_mut()
                        .find(|run| run.get("run_id").and_then(Value::as_str) == Some(run_id))
                })
            {
                let run = object_mut(run)?;
                run.insert("status".to_string(), Value::String("crashed".to_string()));
                run.insert("ended_at".to_string(), Value::from(now()));
            }
            Ok(())
        })
    }

    fn update_metadata(
        &self,
        session_id: &str,
        update: impl FnOnce(&mut Value) -> Result<(), BackendError>,
    ) -> Result<(), BackendError> {
        let existing = self
            .context
            .persistence
            .load_session_metadata(session_id)?
            .ok_or_else(|| invalid("Session not found"))?;
        self.context
            .persistence
            .update_session_metadata(session_id, existing, update)
    }
}

struct RunRegistration {
    manager: Arc<ChatRunManager>,
    session_id: String,
}

impl Drop for RunRegistration {
    fn drop(&mut self) {
        self.manager.unregister(&self.session_id);
    }
}

struct BackendOutput {
    content: String,
    cancelled: bool,
    waiting_for_plan: bool,
    resume_session_id: Option<String>,
    tool_calls: Value,
    content_blocks: Value,
}

impl Default for BackendOutput {
    fn default() -> Self {
        Self {
            content: String::new(),
            cancelled: false,
            waiting_for_plan: false,
            resume_session_id: None,
            tool_calls: Value::Array(Vec::new()),
            content_blocks: Value::Array(Vec::new()),
        }
    }
}

fn backend_command(
    backend: &str,
    cwd: &str,
    message: &str,
    model: Option<&str>,
    execution_mode: Option<&str>,
    effort_level: Option<&str>,
    resume_session_id: Option<&str>,
) -> Result<(Command, Option<String>), BackendError> {
    let mut stdin_prompt = None;
    let mut command = match backend {
        "claude" => {
            let mut command = Command::new(backend_program("claude"));
            command.args(["--print", "--output-format", "stream-json", "--verbose"]);
            if let Some(model) = model {
                command.args(["--model", model]);
            }
            if execution_mode == Some("yolo") {
                command.arg("--dangerously-skip-permissions");
            }
            command.arg(message);
            command
        }
        "codex" => {
            let mut command = Command::new(backend_program("codex"));
            command.args(["exec", "--json"]);
            if let Some(model) = model {
                command.args(["--model", model]);
            }
            command.args([
                "--sandbox",
                if execution_mode == Some("yolo") {
                    "danger-full-access"
                } else {
                    "workspace-write"
                },
            ]);
            command.arg(message);
            command
        }
        "opencode" => {
            let mut command = Command::new(backend_program("opencode"));
            command.args(["run", "--format", "json"]);
            if let Some(model) = model {
                command.args(["--model", model]);
            }
            command.arg(message);
            command
        }
        "cursor" => {
            let mut command = Command::new(backend_program("cursor"));
            command.args([
                "--print",
                "--output-format",
                "stream-json",
                "--trust",
                "--workspace",
                cwd,
            ]);
            if let Some(model) = model {
                command.args(["--model", model]);
            }
            command.arg(message);
            command
        }
        "pi" => {
            let mut command = Command::new(backend_program("pi"));
            command.args(["--mode", "json", "--no-session"]);
            if let Some(model) = model {
                command.args(["--model", model]);
            }
            if let Some(effort) = effort_level {
                command.args(["--thinking", effort]);
            }
            command.arg(message);
            command
        }
        "commandcode" => {
            let mut command = Command::new(backend_program("commandcode"));
            let invocation = crate::commandcode::invocation(
                message,
                None,
                execution_mode,
                model,
                resume_session_id,
                true,
            );
            command.args(invocation.args);
            stdin_prompt = Some(invocation.prompt);
            command
        }
        "grok" => {
            let mut command = Command::new(backend_program("grok"));
            command.args([
                "--no-auto-update",
                "-p",
                message,
                "--output-format",
                "json",
                "--cwd",
                cwd,
                "--permission-mode",
                "dontAsk",
            ]);
            if let Some(model) = model {
                command.args(["--model", model]);
            }
            if let Some(effort) = effort_level {
                command.args(["--effort", effort]);
            }
            command
        }
        other => return Err(BackendError::unsupported(format!("chat backend {other}"))),
    };
    command.kill_on_drop(true);
    Ok((command, stdin_prompt))
}

fn backend_program(backend: &str) -> String {
    let variable = format!("JEAN_{}_BINARY", backend.to_ascii_uppercase());
    std::env::var(variable).unwrap_or_else(|_| match backend {
        "cursor" => "cursor-agent".to_string(),
        "commandcode" => "command-code".to_string(),
        other => other.to_string(),
    })
}

fn extract_stream_text(line: &str) -> Option<String> {
    let value: Value = serde_json::from_str(line).ok()?;
    let candidates = [
        value.pointer("/event/delta/text"),
        value.pointer("/assistantMessageEvent/delta/text"),
        value.pointer("/assistantMessageEvent/delta"),
        value.pointer("/delta/text"),
        value.get("delta"),
        value.pointer("/part/text"),
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Some(text) = candidate.as_str().filter(|text| !text.is_empty()) {
            return Some(text.to_string());
        }
    }
    if value.get("type").and_then(Value::as_str) == Some("item.completed") {
        return value
            .pointer("/item/text")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
    }
    None
}

fn extract_final_text(raw: &str) -> Option<String> {
    for line in raw.lines().rev() {
        let value: Value = serde_json::from_str(line).ok()?;
        for candidate in [
            value.get("result"),
            value.get("content"),
            value.pointer("/message/content/0/text"),
            value.pointer("/message/content"),
        ] {
            if let Some(text) = candidate
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn assistant_message(id: &str, session_id: &str, output: &BackendOutput) -> Value {
    serde_json::json!({"id":id,"session_id":session_id,"role":"assistant","content":output.content,"timestamp":now(),"tool_calls":output.tool_calls,"content_blocks":output.content_blocks,"cancelled":output.cancelled,"plan_approved":false,"recovered":false})
}

fn emit_commandcode_tools(
    events: &dyn crate::EventSink,
    session_id: &str,
    worktree_id: &str,
    run_id: &str,
    tool_calls: &Value,
) -> Result<(), BackendError> {
    for tool_call in tool_calls.as_array().into_iter().flatten() {
        let Some(id) = tool_call.get("id").and_then(Value::as_str) else {
            continue;
        };
        events.emit_json(
            "chat:tool-use",
            serde_json::json!({
                "session_id":session_id,
                "worktree_id":worktree_id,
                "run_id":run_id,
                "id":id,
                "name":tool_call.get("name"),
                "input":tool_call.get("input"),
            }),
        )?;
        if let Some(output) = tool_call.get("output").and_then(Value::as_str) {
            events.emit_json(
                "chat:tool-result",
                serde_json::json!({
                    "session_id":session_id,
                    "worktree_id":worktree_id,
                    "run_id":run_id,
                    "tool_use_id":id,
                    "output":output,
                }),
            )?;
        }
    }
    Ok(())
}

fn resume_id_field(backend: &str) -> &'static str {
    match backend {
        "codex" => "codex_thread_id",
        "opencode" => "opencode_session_id",
        "cursor" => "cursor_chat_id",
        "pi" => "pi_session_id",
        "commandcode" => "commandcode_session_id",
        "grok" => "grok_session_id",
        _ => "claude_session_id",
    }
}

fn insert_optional(object: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        object.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn object_mut(value: &mut Value) -> Result<&mut Map<String, Value>, BackendError> {
    value.as_object_mut().ok_or_else(|| invalid_data("object"))
}

fn invalid(message: &str) -> BackendError {
    BackendError::new(BackendErrorCode::InvalidArgument, message)
}
fn invalid_data(field: &str) -> BackendError {
    BackendError::new(
        BackendErrorCode::Internal,
        format!("Invalid persisted chat field '{field}'"),
    )
}
fn join_error(error: tokio::task::JoinError) -> BackendError {
    BackendError::new(BackendErrorCode::Internal, error.to_string())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(windows)]
fn configure_silent(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.as_std_mut().creation_flags(0x08000000);
}

#[cfg(unix)]
fn configure_silent(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.as_std_mut().process_group(0);
}

#[cfg(not(any(unix, windows)))]
fn configure_silent(_command: &mut Command) {}

#[cfg(unix)]
async fn terminate_child(child: &mut tokio::process::Child) -> Result<(), std::io::Error> {
    if let Some(pid) = child.id() {
        // SAFETY: the child is placed in a process group whose id is its pid.
        // A negative pid targets only that group, including CLI descendants.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    child.wait().await.map(|_| ())
}

#[cfg(not(unix))]
async fn terminate_child(child: &mut tokio::process::Child) -> Result<(), std::io::Error> {
    child.kill().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BackendState, ResolvedAppPaths, ServerEventSink, SessionService, WsBroadcaster};

    #[test]
    fn extracts_streaming_formats_without_tauri() {
        assert_eq!(
            extract_stream_text(r#"{"event":{"delta":{"text":"a"}}}"#).as_deref(),
            Some("a")
        );
        assert_eq!(
            extract_stream_text(r#"{"type":"item.completed","item":{"text":"done"}}"#).as_deref(),
            Some("done")
        );
        assert_eq!(
            extract_final_text("{\"result\":\"final\"}\n").as_deref(),
            Some("final")
        );
    }

    #[test]
    fn run_registry_is_exclusive_and_cancellable() {
        let registry = ChatRunManager::default();
        let token = registry.register("s1").unwrap();
        assert!(registry.register("s1").is_err());
        assert!(registry.cancel("s1"));
        assert!(token.is_cancelled());
        registry.unregister("s1");
        assert!(!registry.contains("s1"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn chat_streams_persists_and_cancels_without_tauri() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("fake-claude");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '%s\\n' '{\"event\":{\"delta\":{\"text\":\"hello\"}}}'\ncase \"$*\" in *slow*) sleep 10;; esac\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        std::env::set_var("JEAN_CLAUDE_BINARY", &script);

        let broadcaster = Arc::new(WsBroadcaster::new());
        broadcaster.set_active(true);
        let context = BackendContext::new(
            Arc::new(ResolvedAppPaths::new(
                temp.path().join("data"),
                temp.path().join("config"),
                temp.path().join("cache"),
                temp.path().join("resources"),
            )),
            Arc::new(ServerEventSink::new(broadcaster.clone())),
            Arc::new(BackendState::new(broadcaster.clone())),
        );
        let sessions = SessionService::new(context.persistence.clone());
        let session = sessions
            .create("w1", None, Some("claude"), None, None, None, None, None)
            .unwrap();
        let session_id = session["id"].as_str().unwrap().to_string();
        let service = ChatService::new(context.clone());
        let response = service
            .send(
                &session_id,
                "w1",
                temp.path().to_str().unwrap(),
                "normal",
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(response["content"], "hello");
        let persisted = sessions.get("w1", &session_id).unwrap();
        assert_eq!(persisted["messages"].as_array().unwrap().len(), 2);
        assert_eq!(persisted["messages"][1]["content"], "hello");

        let slow_service = service.clone();
        let slow_session = session_id.clone();
        let cwd = temp.path().to_string_lossy().into_owned();
        let task = tokio::spawn(async move {
            slow_service
                .send(
                    &slow_session,
                    "w1",
                    &cwd,
                    "slow",
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .await
        });
        for _ in 0..50 {
            if context.state.chat_runs.contains(&session_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(service.cancel(&session_id, "w1").unwrap());
        assert!(task.await.unwrap().unwrap()["cancelled"].as_bool().unwrap());
        std::env::remove_var("JEAN_CLAUDE_BINARY");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn commandcode_uses_shared_plan_and_resume_contract_without_tauri() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("fake-command-code");
        let args_log = temp.path().join("args.log");
        let prompt_log = temp.path().join("prompt.log");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\ncat > '{}'\nprintf '%s\\n' 'session: native-commandcode' >&2\nprintf '%s\\n' '<jean-plan>Implement the shared backend</jean-plan>'\n",
                args_log.display(),
                prompt_log.display(),
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        std::env::set_var("JEAN_COMMANDCODE_BINARY", &script);

        let broadcaster = Arc::new(WsBroadcaster::new());
        broadcaster.set_active(true);
        let context = BackendContext::new(
            Arc::new(ResolvedAppPaths::new(
                temp.path().join("data"),
                temp.path().join("config"),
                temp.path().join("cache"),
                temp.path().join("resources"),
            )),
            Arc::new(ServerEventSink::new(broadcaster.clone())),
            Arc::new(BackendState::new(broadcaster)),
        );
        let sessions = SessionService::new(context.persistence.clone());
        let session = sessions
            .create(
                "w1",
                None,
                Some("commandcode"),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        let session_id = session["id"].as_str().unwrap();
        let service = ChatService::new(context);

        let response = service
            .send(
                session_id,
                "w1",
                temp.path().to_str().unwrap(),
                "plan this",
                None,
                Some("commandcode/default"),
                Some("plan"),
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(response["content"], "Implement the shared backend");
        assert_eq!(response["content_blocks"][0]["type"], "text");
        let persisted = sessions.get("w1", session_id).unwrap();
        assert_eq!(persisted["commandcode_session_id"], "native-commandcode");
        assert_eq!(persisted["waiting_for_input"], true);
        assert_eq!(persisted["waiting_for_input_type"], "plan");
        assert!(std::fs::read_to_string(&prompt_log)
            .unwrap()
            .contains("<commandcode_plan_contract>"));

        service
            .send(
                session_id,
                "w1",
                temp.path().to_str().unwrap(),
                "continue",
                None,
                None,
                Some("build"),
                None,
                None,
            )
            .await
            .unwrap();
        let args = std::fs::read_to_string(args_log).unwrap();
        assert!(args
            .lines()
            .last()
            .unwrap()
            .contains("--resume native-commandcode"));
        assert!(args.lines().last().unwrap().contains("--auto-accept"));
        std::env::remove_var("JEAN_COMMANDCODE_BINARY");
    }
}
