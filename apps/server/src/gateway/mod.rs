//! Anthropic-compatible AI gateway (`/anthropic/v1/*`), the same endpoints chat-demo calls.
//! Checks access, enforces the homework's AI settings, streams the provider's reply straight
//! through, and archives every turn.

pub mod accumulate;
pub mod policy;
pub mod providers;
pub mod sse;

use crate::{
    AppState,
    access::{HomeworkAccess, load_files, load_homework_for},
    auth::CurrentUser,
    error::{AppError, AppResult},
    ids::new_id,
    models::{FileRow, Phase, phase_at},
    routes::uploads::{read_file_field, save_upload},
    stats::tokens_used,
};
use accumulate::MessageAccumulator;
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, post},
};
use futures::StreamExt;
use policy::{build_upstream_request, collect_file_ids, last_user_index, to_blocks};
use providers::{Provider, Upstream, UpstreamError, UpstreamFile};
use serde_json::{Value, json};
use sse::SseParser;
use std::{collections::HashMap, sync::Arc, time::Instant};

pub const HOMEWORK_HEADER: &str = "x-hw-homework-id";
pub const CONVERSATION_HEADER: &str = "x-hw-conversation-id";
pub const USER_MESSAGE_HEADER: &str = "x-hw-user-message-id";
pub const PARENT_MESSAGE_HEADER: &str = "x-hw-parent-message-id";
pub const ASSISTANT_MESSAGE_HEADER: &str = "x-hw-assistant-message-id";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/messages", post(messages))
        .route("/files", post(upload_file))
        .route("/files/{id}", delete(delete_file))
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// Students may only use the AI while the homework is open and within their quota; teacher previews are unlimited.
async fn assert_can_chat(state: &AppState, access: &HomeworkAccess, user_id: &str) -> AppResult<()> {
    if access.is_teacher {
        return Ok(());
    }
    let homework = &access.homework;
    match phase_at(homework.start_at, homework.due_at, state.clock.now()) {
        Phase::Upcoming => {
            return Err(AppError::forbidden("This homework has not started yet", "作业还没有开始，暂时不能使用 AI"));
        }
        Phase::Closed => return Err(AppError::forbidden("This homework is closed", "作业已截止，不能再使用 AI")),
        Phase::Open => {}
    }
    if let Some(budget) = homework.ai_config.0.token_budget
        && tokens_used(&state.db, &homework.id, user_id).await? >= budget
    {
        return Err(AppError::forbidden(
            "You have used up the AI quota for this homework. Please contact your teacher.",
            "本作业的 AI 使用额度已用完，请联系老师",
        ));
    }
    Ok(())
}

fn provider_for(state: &AppState, model: &str) -> AppResult<Arc<dyn Provider>> {
    state.providers.for_model(model).ok_or_else(|| {
        AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "api_error",
            format!("The model \"{model}\" configured for this homework is unavailable. Please contact your teacher."),
            format!("作业配置的模型「{model}」当前不可用，请联系老师"),
        )
    })
}

fn upload_purpose(row: &FileRow) -> Option<&'static str> {
    if row.mime_type.starts_with("image/") {
        return None;
    }
    let name = row.filename.to_lowercase();
    let rich = [".pdf", ".doc", ".docx", ".ppt", ".pptx"].iter().any(|ext| name.ends_with(ext));
    Some(if rich { "rich_layout_recognition" } else { "user_data" })
}

/// Reuses the provider's copy when there is one; after a provider change, re-uploads the stored original.
async fn ensure_provider_file(
    state: &AppState,
    provider: &dyn Provider,
    row: &FileRow,
) -> Result<String, GatewayError> {
    if let (Some(p), Some(id)) = (&row.provider, &row.provider_file_id)
        && p == provider.id()
    {
        return Ok(id.clone());
    }
    let data = state.storage.get(&row.storage_key).await.map_err(AppError::from)?;
    let provider_file_id = provider
        .upload_file(UpstreamFile {
            data,
            filename: row.filename.clone(),
            mime_type: row.mime_type.clone(),
            purpose: upload_purpose(row),
        })
        .await?;
    sqlx::query("UPDATE files SET provider = $1, provider_file_id = $2 WHERE id = $3")
        .bind(provider.id())
        .bind(&provider_file_id)
        .bind(&row.id)
        .execute(&state.db)
        .await
        .map_err(AppError::from)?;
    Ok(provider_file_id)
}

enum GatewayError {
    App(AppError),
    Upstream(UpstreamError),
}

impl From<AppError> for GatewayError {
    fn from(e: AppError) -> Self {
        Self::App(e)
    }
}

impl From<UpstreamError> for GatewayError {
    fn from(e: UpstreamError) -> Self {
        Self::Upstream(e)
    }
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        match self {
            Self::App(e) => e.into_response(),
            Self::Upstream(e) => (
                StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_GATEWAY),
                [(header::CONTENT_TYPE, "application/json")],
                e.body,
            )
                .into_response(),
        }
    }
}

async fn infer_kind(
    state: &AppState,
    conversation_id: &str,
    messages: &[Value],
    user_message_id: Option<&str>,
    parent_message_id: Option<&str>,
) -> AppResult<&'static str> {
    if messages.last().is_some_and(|m| m["role"] == "assistant") {
        return Ok("continue");
    }
    let Some(user_message_id) = user_message_id else {
        return Ok("new");
    };
    let same: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM turns WHERE conversation_id = $1 AND user_message_id = $2)")
            .bind(conversation_id)
            .bind(user_message_id)
            .fetch_one(&state.db)
            .await?;
    if same {
        return Ok("regenerate");
    }
    let sibling: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM turns WHERE conversation_id = $1 AND parent_message_id IS NOT DISTINCT FROM $2)",
    )
    .bind(conversation_id)
    .bind(parent_message_id)
    .fetch_one(&state.db)
    .await?;
    Ok(if sibling { "edit" } else { "new" })
}

/// Archives one turn. If the browser disconnects (the student pressed stop or closed the page),
/// the response stream is dropped and `Drop` records the turn as aborted.
struct Recorder {
    state: AppState,
    turn_id: String,
    conversation_id: String,
    conversation_has_title: bool,
    parser: SseParser,
    acc: MessageAccumulator,
    started: Instant,
    finished: bool,
}

struct TurnResult {
    status: &'static str,
    error: Option<String>,
    content: Vec<Value>,
    input_tokens: i64,
    output_tokens: i64,
    stop_reason: Option<String>,
    title: Option<String>,
    latency_ms: i64,
}

impl Recorder {
    fn feed(&mut self, chunk: &[u8]) {
        for event in self.parser.feed(chunk) {
            self.acc.apply(&event.event, &event.data);
        }
    }

    fn result(&mut self, status: &'static str, error: Option<String>) -> TurnResult {
        self.finished = true;
        TurnResult {
            status,
            error: error.or_else(|| self.acc.error.clone()),
            content: self.acc.content(),
            input_tokens: self.acc.input_tokens(),
            output_tokens: self.acc.output_tokens(),
            stop_reason: self.acc.stop_reason.clone(),
            title: self.acc.title.clone().filter(|_| !self.conversation_has_title),
            latency_ms: self.started.elapsed().as_millis() as i64,
        }
    }

    /// Final status once the upstream stream has ended normally.
    fn completed(&mut self) -> TurnResult {
        if self.acc.done || self.acc.stop_reason.is_some() {
            self.result("ok", None)
        } else {
            let error = self.acc.error.clone().unwrap_or_else(|| "stream ended before message_stop".into());
            self.result("error", Some(error))
        }
    }

    async fn save(state: AppState, turn_id: String, conversation_id: String, r: TurnResult) {
        let now = state.clock.now();
        let saved = sqlx::query(
            "UPDATE turns SET status = $2, error = $3, assistant_content = $4, input_tokens = $5, output_tokens = $6, \
             stop_reason = $7, latency_ms = $8, completed_at = $9 WHERE id = $1",
        )
        .bind(&turn_id)
        .bind(r.status)
        .bind(&r.error)
        .bind(sqlx::types::Json(&r.content))
        .bind(r.input_tokens as i32)
        .bind(r.output_tokens as i32)
        .bind(&r.stop_reason)
        .bind(r.latency_ms as i32)
        .bind(now)
        .execute(&state.db)
        .await;
        if let Err(e) = saved {
            tracing::error!("failed to save turn {turn_id}: {e}");
        }
        if let Some(title) = r.title {
            let _ = sqlx::query("UPDATE conversations SET title = $1 WHERE id = $2 AND title = ''")
                .bind(title)
                .bind(&conversation_id)
                .execute(&state.db)
                .await;
        }
    }

    async fn finish(&mut self, result: TurnResult) {
        Self::save(self.state.clone(), self.turn_id.clone(), self.conversation_id.clone(), result).await;
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if !self.finished {
            let result = self.result("aborted", None);
            tokio::spawn(Self::save(self.state.clone(), self.turn_id.clone(), self.conversation_id.clone(), result));
        }
    }
}

async fn messages(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, GatewayError> {
    let (Some(homework_id), Some(client_session_id)) =
        (header_value(&headers, HOMEWORK_HEADER), header_value(&headers, CONVERSATION_HEADER))
    else {
        return Err(AppError::bad_request(
            "Missing homework or conversation. Please reload the page.",
            "缺少作业或会话信息，请刷新页面",
        )
        .into());
    };
    let access = load_homework_for(&state, &homework_id, &user).await?;
    assert_can_chat(&state, &access, &user.id).await?;
    let homework = &access.homework;
    let provider = provider_for(&state, &homework.ai_config.0.model)?;

    let client: Value =
        serde_json::from_slice(&body).map_err(|_| AppError::bad_request("Invalid JSON body", "请求格式错误"))?;
    let messages = client["messages"].as_array().cloned().unwrap_or_default();
    let Some(last_user) = last_user_index(&messages) else {
        return Err(AppError::bad_request("Messages must not be empty", "消息不能为空").into());
    };

    // Students can only reference files they uploaded to this homework.
    let referenced = collect_file_ids(&messages);
    let files: Vec<FileRow> = load_files(&state.db, &referenced)
        .await?
        .into_iter()
        .filter(|f| f.owner_id == user.id && f.homework_id.as_deref() == Some(homework.id.as_str()))
        .collect();
    let mut file_map = HashMap::new();
    if homework.ai_config.0.allow_file_upload {
        for row in &files {
            file_map.insert(row.id.clone(), ensure_provider_file(&state, provider.as_ref(), row).await?);
        }
    }
    let (upstream_body, has_files) = build_upstream_request(&client, homework, &file_map)?;

    let now = state.clock.now();
    let (conversation_id, conversation_title): (String, String) = sqlx::query_as(
        "INSERT INTO conversations (id, homework_id, user_id, client_session_id, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (homework_id, user_id, client_session_id) \
         DO UPDATE SET updated_at = $5 RETURNING id, title",
    )
    .bind(new_id("conv"))
    .bind(&homework.id)
    .bind(&user.id)
    .bind(&client_session_id)
    .bind(now)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::from)?;

    let user_message_id = header_value(&headers, USER_MESSAGE_HEADER);
    let parent_message_id = header_value(&headers, PARENT_MESSAGE_HEADER);
    let kind =
        infer_kind(&state, &conversation_id, &messages, user_message_id.as_deref(), parent_message_id.as_deref())
            .await?;
    let user_message = &messages[last_user];
    let turn_file_ids: Vec<String> = collect_file_ids(std::slice::from_ref(user_message))
        .into_iter()
        .filter(|id| files.iter().any(|f| &f.id == id))
        .collect();
    let turn_id = new_id("turn");
    sqlx::query(
        "INSERT INTO turns (id, conversation_id, homework_id, user_id, kind, status, user_message_id, parent_message_id, \
         assistant_message_id, user_content, file_ids, model, request_meta, created_at) \
         VALUES ($1, $2, $3, $4, $5, 'streaming', $6, $7, $8, $9, $10, $11, $12, $13)",
    )
    .bind(&turn_id)
    .bind(&conversation_id)
    .bind(&homework.id)
    .bind(&user.id)
    .bind(kind)
    .bind(&user_message_id)
    .bind(&parent_message_id)
    .bind(header_value(&headers, ASSISTANT_MESSAGE_HEADER))
    .bind(sqlx::types::Json(to_blocks(&user_message["content"])))
    .bind(sqlx::types::Json(&turn_file_ids))
    .bind(&homework.ai_config.0.model)
    .bind(sqlx::types::Json(json!({
        "thinking": upstream_body["thinking"]["type"] == "enabled",
        "webSearch": upstream_body["tools"].as_array().is_some_and(|t| !t.is_empty()),
        "preview": access.is_teacher,
    })))
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(AppError::from)?;

    let mut recorder = Recorder {
        state: state.clone(),
        turn_id,
        conversation_id,
        conversation_has_title: !conversation_title.is_empty(),
        parser: SseParser::default(),
        acc: MessageAccumulator::default(),
        started: Instant::now(),
        finished: false,
    };

    let upstream = match provider.create_message(upstream_body, has_files).await {
        Ok(upstream) => upstream,
        Err(e) => {
            let result = recorder.result("error", Some(e.to_string()));
            recorder.finish(result).await;
            return Err(AppError::new(
                StatusCode::BAD_GATEWAY,
                "api_error",
                "The AI service is temporarily unavailable. Please try again.",
                "AI 服务暂时不可用，请稍后重试",
            )
            .into());
        }
    };
    let mut stream = match upstream {
        Upstream::Stream(stream) => stream,
        Upstream::Failed { status, content_type, body } => {
            let detail: String = body.chars().take(2000).collect();
            let result = recorder.result("error", Some(format!("upstream {status}: {detail}")));
            recorder.finish(result).await;
            return Ok((
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                [(header::CONTENT_TYPE, content_type)],
                body,
            )
                .into_response());
        }
    };

    let body = async_stream::stream! {
        let mut recorder = recorder;
        loop {
            match stream.next().await {
                Some(Ok(chunk)) => {
                    recorder.feed(&chunk);
                    yield Ok::<Bytes, std::io::Error>(chunk);
                }
                Some(Err(e)) => {
                    let result = recorder.result("error", Some(e.to_string()));
                    recorder.finish(result).await;
                    yield Err(e);
                    break;
                }
                None => {
                    let result = recorder.completed();
                    recorder.finish(result).await;
                    break;
                }
            }
        }
    };
    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(body),
    )
        .into_response())
}

async fn upload_file(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Response, GatewayError> {
    let homework_id = header_value(&headers, HOMEWORK_HEADER).ok_or_else(|| {
        AppError::bad_request("Missing homework. Please reload the page.", "缺少作业信息，请刷新页面")
    })?;
    let access = load_homework_for(&state, &homework_id, &user).await?;
    assert_can_chat(&state, &access, &user.id).await?;
    if !access.homework.ai_config.0.allow_file_upload {
        return Err(AppError::forbidden("File uploads are disabled for this homework", "本作业不允许上传文件").into());
    }
    let provider = provider_for(&state, &access.homework.ai_config.0.model)?;
    let file = read_file_field(multipart).await?;
    let row = save_upload(&state, &user.id, &homework_id, "chat", file).await?;
    ensure_provider_file(&state, provider.as_ref(), &row).await?;
    Ok(Json(json!({
        "id": row.id,
        "type": "file",
        "size_bytes": row.size,
        "created_at": row.created_at,
        "filename": row.filename,
        "mime_type": row.mime_type,
    }))
    .into_response())
}

/// The original and the record stay for the teacher; the browser is only told the delete succeeded.
async fn delete_file(CurrentUser(_user): CurrentUser, Path(id): Path<String>) -> impl IntoResponse {
    Json(json!({ "id": id, "type": "file_deleted", "deleted": true }))
}
