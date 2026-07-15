use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;

pub const DEFAULT_MAX_TURNS: &str = "30";
const JEAN_PLAN_OPEN: &str = "<jean-plan>";
const JEAN_PLAN_CLOSE: &str = "</jean-plan>";
const PLAN_CONTRACT: &str = r#"<commandcode_plan_contract>
Jean runs Command Code headlessly, so native interactive plan-exit callbacks are unavailable.
- For normal answers, questions, greetings, and analysis that is not ready for implementation approval: respond normally.
- When you have a concrete implementation plan that should pause for Jean's Approve/YOLO controls: wrap only that plan in <jean-plan>...</jean-plan>.
- Do not call exit_plan_mode in this headless integration.
</commandcode_plan_contract>"#;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandCodeToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub output: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommandCodeContentBlock {
    Text { text: String },
    ToolUse { tool_call_id: String },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CommandCodeNativeTurn {
    pub tool_calls: Vec<CommandCodeToolCall>,
    pub content_blocks: Vec<CommandCodeContentBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandCodePlanOutput {
    pub content: String,
    pub waiting_for_plan: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandCodeInvocation {
    pub args: Vec<String>,
    pub prompt: String,
}

pub fn invocation(
    message: &str,
    system_context: Option<&str>,
    execution_mode: Option<&str>,
    model: Option<&str>,
    resume_session_id: Option<&str>,
    verbose: bool,
) -> CommandCodeInvocation {
    let mode = execution_mode.unwrap_or("plan");
    CommandCodeInvocation {
        args: arguments(execution_mode, model, resume_session_id, verbose),
        prompt: build_prompt(system_context, message, mode),
    }
}

pub fn arguments(
    execution_mode: Option<&str>,
    model: Option<&str>,
    resume_session_id: Option<&str>,
    verbose: bool,
) -> Vec<String> {
    let mode = execution_mode.unwrap_or("plan");
    let mut args = vec!["-p".to_string()];
    if verbose {
        args.push("--verbose".to_string());
    }
    args.extend([
        "--trust".to_string(),
        "--skip-onboarding".to_string(),
        "--max-turns".to_string(),
        DEFAULT_MAX_TURNS.to_string(),
    ]);
    if let Some(resume_id) = resume_session_id.filter(|value| !value.trim().is_empty()) {
        args.extend(["--resume".to_string(), resume_id.to_string()]);
    }
    if let Some(model) = model.and_then(normalize_model) {
        args.extend(["--model".to_string(), model]);
    }
    match mode {
        "yolo" => args.push("--yolo".to_string()),
        "build" => args.push("--auto-accept".to_string()),
        _ => args.extend(["--permission-mode".to_string(), "plan".to_string()]),
    }
    args
}

pub fn normalize_model(model: &str) -> Option<String> {
    let model = model.trim();
    if model.is_empty() || matches!(model, "commandcode/default" | "default") {
        return None;
    }
    Some(
        model
            .strip_prefix("commandcode/")
            .unwrap_or(model)
            .to_string(),
    )
}

pub fn parse_session_id(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|line| {
        let id = line.trim().strip_prefix("session:")?.trim();
        (!id.is_empty()).then(|| id.to_string())
    })
}

pub fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            if chars.peek().is_some_and(|next| *next == '[') {
                let _ = chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        output.push(character);
    }
    output
}

pub fn error_for_status(code: Option<i32>, stderr: &str) -> String {
    let message = match code {
        Some(3) => "Command Code is not authenticated. Run `cmd login`.",
        Some(4) => "Command Code denied a requested permission.",
        Some(5) => "Command Code rate limit exceeded.",
        Some(6) => "Command Code network failure.",
        Some(7) => "Command Code API server error.",
        Some(130) => "Command Code run interrupted.",
        _ => "Command Code run failed.",
    };
    let stderr = strip_ansi(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        message.to_string()
    } else {
        format!("{message}\n{stderr}")
    }
}

pub fn parse_plan_output(content: &str) -> CommandCodePlanOutput {
    let trimmed = content.trim();
    let Some(start) = trimmed.find(JEAN_PLAN_OPEN) else {
        return CommandCodePlanOutput {
            content: trimmed.to_string(),
            waiting_for_plan: false,
        };
    };
    let plan_start = start + JEAN_PLAN_OPEN.len();
    let Some(relative_end) = trimmed[plan_start..].find(JEAN_PLAN_CLOSE) else {
        return CommandCodePlanOutput {
            content: trimmed.to_string(),
            waiting_for_plan: false,
        };
    };
    let end = plan_start + relative_end;
    CommandCodePlanOutput {
        content: trimmed[plan_start..end].trim().to_string(),
        waiting_for_plan: true,
    }
}

pub fn parse_native_turn(jsonl: &str) -> Option<CommandCodeNativeTurn> {
    let entries = jsonl
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    let last_user_index = entries
        .iter()
        .rposition(|entry| entry.get("role").and_then(Value::as_str) == Some("user"))?;
    let mut turn = CommandCodeNativeTurn::default();

    for entry in entries.iter().skip(last_user_index + 1) {
        let role = entry.get("role").and_then(Value::as_str);
        let Some(content) = entry.get("content").and_then(Value::as_array) else {
            continue;
        };
        for block in content {
            match (role, block.get("type").and_then(Value::as_str)) {
                (Some("assistant"), Some("text")) => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        turn.content_blocks.push(CommandCodeContentBlock::Text {
                            text: text.to_string(),
                        });
                    }
                }
                (Some("assistant"), Some("tool-call")) => {
                    let Some(id) = first_string(block, &["toolCallId", "tool_call_id", "id"])
                    else {
                        continue;
                    };
                    let name = first_string(block, &["toolName", "name"]).unwrap_or("tool");
                    let (name, input) = normalize_tool_call(
                        name,
                        block.get("input").cloned().unwrap_or(Value::Null),
                    );
                    turn.tool_calls.push(CommandCodeToolCall {
                        id: id.to_string(),
                        name,
                        input,
                        output: None,
                    });
                    turn.content_blocks.push(CommandCodeContentBlock::ToolUse {
                        tool_call_id: id.to_string(),
                    });
                }
                (Some("tool"), Some("tool-result")) => {
                    let Some(id) = first_string(
                        block,
                        &["toolCallId", "tool_call_id", "toolUseId", "tool_use_id"],
                    ) else {
                        continue;
                    };
                    let output = block
                        .get("output")
                        .or_else(|| block.get("content"))
                        .and_then(output_to_string);
                    if let Some(tool_call) = turn.tool_calls.iter_mut().find(|call| call.id == id) {
                        tool_call.output = output;
                    }
                }
                _ => {}
            }
        }
    }

    (!turn.tool_calls.is_empty() || !turn.content_blocks.is_empty()).then_some(turn)
}

pub fn read_native_turn(session_id: &str) -> Option<CommandCodeNativeTurn> {
    let path = native_session_file(session_id)?;
    std::fs::read_to_string(path)
        .ok()
        .and_then(|jsonl| parse_native_turn(&jsonl))
}

pub fn native_session_file(session_id: &str) -> Option<PathBuf> {
    let projects_dir = dirs::home_dir()?.join(".commandcode").join("projects");
    for entry in std::fs::read_dir(projects_dir).ok()? {
        let path = entry.ok()?.path().join(format!("{session_id}.jsonl"));
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn build_prompt(system_context: Option<&str>, message: &str, mode: &str) -> String {
    let mut prompt = String::new();
    if let Some(context) = system_context
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        prompt.push_str("<jean_context>\n");
        prompt.push_str(context);
        prompt.push_str("\n</jean_context>\n\n");
    }
    if mode == "plan" {
        prompt.push_str(PLAN_CONTRACT);
        prompt.push_str("\n\n");
    }
    prompt.push_str(message);
    prompt
}

fn first_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
}

fn output_to_string(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(text) = value
        .get("value")
        .or_else(|| value.get("text"))
        .and_then(Value::as_str)
    {
        return Some(text.to_string());
    }
    (!value.is_null()).then(|| value.to_string())
}

fn normalize_tool_call(name: &str, input: Value) -> (String, Value) {
    let Some(input_object) = input.as_object() else {
        return (name.to_string(), input);
    };
    match name {
        "read_file" => (
            "Read".to_string(),
            selected_fields(
                input_object,
                &[
                    ("file_path", &["absolutePath", "filePath", "path"]),
                    ("limit", &["limit"]),
                    ("offset", &["offset"]),
                ],
            ),
        ),
        "write_file" => (
            "Write".to_string(),
            selected_fields(
                input_object,
                &[
                    ("file_path", &["filePath", "absolutePath", "path"]),
                    ("content", &["content"]),
                ],
            ),
        ),
        "read_multiple_files" => (
            "ReadMultipleFiles".to_string(),
            selected_fields(
                input_object,
                &[
                    ("path", &["targetDirectory", "path"]),
                    ("include", &["include"]),
                ],
            ),
        ),
        "shell_command" => ("Bash".to_string(), input),
        "read_directory" | "list" => ("List".to_string(), input),
        "glob" => ("Glob".to_string(), input),
        "grep" => ("Grep".to_string(), input),
        _ => (name.to_string(), input),
    }
}

fn selected_fields(input: &Map<String, Value>, fields: &[(&str, &[&str])]) -> Value {
    let mut normalized = Map::new();
    for (target, sources) in fields {
        if let Some(value) = sources.iter().find_map(|source| input.get(*source)) {
            normalized.insert((*target).to_string(), value.clone());
        }
    }
    Value::Object(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invocation_preserves_resume_model_mode_and_plan_contract() {
        let invocation = invocation(
            "message",
            Some("context"),
            Some("plan"),
            Some("commandcode/gpt-5"),
            Some("native-id"),
            true,
        );
        assert_eq!(
            invocation.args,
            [
                "-p",
                "--verbose",
                "--trust",
                "--skip-onboarding",
                "--max-turns",
                "30",
                "--resume",
                "native-id",
                "--model",
                "gpt-5",
                "--permission-mode",
                "plan",
            ]
        );
        assert!(invocation.prompt.contains("<jean_context>"));
        assert!(invocation.prompt.contains("<commandcode_plan_contract>"));
    }

    #[test]
    fn plan_and_session_parsing_match_the_native_contract() {
        let parsed = parse_plan_output("intro<jean-plan>\n1. Test\n</jean-plan>");
        assert_eq!(parsed.content, "1. Test");
        assert!(parsed.waiting_for_plan);
        assert_eq!(
            parse_session_id("noise\nsession: native-id\nmore").as_deref(),
            Some("native-id")
        );
    }

    #[test]
    fn native_turn_preserves_order_and_normalizes_tools() {
        let jsonl = r#"{"role":"user","content":"run"}
{"role":"assistant","content":[{"type":"text","text":"Running"},{"type":"tool-call","toolCallId":"call-1","toolName":"read_file","input":{"absolutePath":"/tmp/a","limit":20}}]}
{"role":"tool","content":[{"type":"tool-result","toolCallId":"call-1","output":{"value":"contents"}}]}
{"role":"assistant","content":[{"type":"text","text":"Done"}]}"#;
        let turn = parse_native_turn(jsonl).unwrap();
        assert_eq!(turn.tool_calls[0].name, "Read");
        assert_eq!(
            turn.tool_calls[0].input,
            serde_json::json!({"file_path":"/tmp/a","limit":20})
        );
        assert_eq!(turn.tool_calls[0].output.as_deref(), Some("contents"));
        assert!(matches!(
            turn.content_blocks.as_slice(),
            [
                CommandCodeContentBlock::Text { .. },
                CommandCodeContentBlock::ToolUse { .. },
                CommandCodeContentBlock::Text { .. }
            ]
        ));
    }
}
