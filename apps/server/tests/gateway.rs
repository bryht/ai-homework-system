mod common;

use ai_homework::models::AiConfig;
use axum::http::{Method, StatusCode};
use common::{Ctx, ai_config};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;

#[derive(sqlx::FromRow, Debug)]
struct TurnCheck {
    kind: String,
    status: String,
    model: String,
    stop_reason: Option<String>,
    user_content: sqlx::types::Json<Value>,
    assistant_content: sqlx::types::Json<Value>,
    output_tokens: i32,
    error: Option<String>,
}

async fn turns(db: &PgPool) -> Vec<TurnCheck> {
    sqlx::query_as::<_, TurnCheck>(
        "SELECT kind, status, model, stop_reason, user_content, assistant_content, output_tokens, error FROM turns ORDER BY created_at, seq",
    )
    .fetch_all(db)
    .await
    .unwrap()
}

fn with(f: impl FnOnce(&mut AiConfig)) -> AiConfig {
    let mut ai = ai_config();
    f(&mut ai);
    ai
}

#[sqlx::test]
async fn streams_the_reply_and_records_the_turn(db: PgPool) {
    let ctx = Ctx::new(db.clone());
    let s = ctx.setup_class(ai_config()).await;
    let res = ctx.chat(&s.student1, &s.homework_id, "How to solve x^2=4?").await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.headers["content-type"].to_str().unwrap().contains("text/event-stream"));
    assert!(res.text().contains("event: message_stop"));

    let turn = &turns(&db).await[0];
    assert_eq!((turn.status.as_str(), turn.kind.as_str(), turn.model.as_str()), ("ok", "new", "mock"));
    assert_eq!(turn.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(turn.user_content.0, json!([{ "type": "text", "text": "How to solve x^2=4?" }]));
    let text = turn.assistant_content.0.as_array().unwrap().iter().find(|b| b["type"] == "text").unwrap();
    assert!(text["text"].as_str().unwrap().contains("Mock reply"));
    assert!(turn.output_tokens > 0);

    let overview = ctx.get(&format!("/api/homeworks/{}/overview", s.homework_id), &s.teacher).await.json();
    let row = &overview["students"][0];
    assert_eq!(
        (row["turns"].as_i64(), row["conversations"].as_i64(), row["activeDays"].as_i64()),
        (Some(1), Some(1), Some(1))
    );
    let student_id = s.students[0]["id"].as_str().unwrap();
    let record = ctx.get(&format!("/api/homeworks/{}/students/{student_id}", s.homework_id), &s.teacher).await.json();
    assert_eq!(record["conversations"][0]["title"], "How to solve x^2=4?");
    assert_eq!(record["conversations"][0]["turns"][0]["userContent"][0]["text"], "How to solve x^2=4?");
}

#[sqlx::test]
async fn enforces_the_teacher_configuration_upstream(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx
        .setup_class(with(|ai| {
            ai.allow_web_search = false;
            ai.allow_thinking = false;
        }))
        .await;
    ctx.chat(&s.student1, &s.homework_id, "hi").await;
    let body = ctx.spy.calls.lock().unwrap()[0].clone();
    assert_eq!(body["model"], "mock");
    let system = body["system"].as_str().unwrap();
    assert!(system.contains("Do not give the final answer"));
    assert!(system.contains("Do exercises 1-5 in chapter 3"));
    assert!(!system.contains("DeepSeek"));
    assert!(body.get("tools").is_none());
    assert_eq!(body["thinking"], json!({ "type": "disabled" }));
    // chat-demo sends no max_tokens; the provider requires a positive one.
    assert_eq!(body["max_tokens"], json!(ai_homework::gateway::policy::MAX_OUTPUT_TOKENS));
}

#[sqlx::test]
async fn turns_off_switches_the_model_cannot_honour(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx
        .setup_class(with(|ai| {
            ai.model = "text-only".into();
            ai.allow_web_search = true;
        }))
        .await;
    let path = format!("/api/homeworks/{}", s.homework_id);
    let off = json!({ "allowWebSearch": false, "allowFileUpload": false, "allowThinking": false });
    assert_eq!(ctx.get(&path, &s.student1).await.json()["homework"]["ai"], off);
    let saved = ctx.get(&path, &s.teacher).await.json()["homework"]["aiConfig"].clone();
    assert_eq!(saved["model"], "text-only");
    for switch in ["allowWebSearch", "allowFileUpload", "allowThinking"] {
        assert_eq!(saved[switch], false, "{switch}");
    }
}

#[sqlx::test]
async fn keeps_tools_when_web_search_is_allowed(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(with(|ai| ai.allow_web_search = true)).await;
    ctx.chat(&s.student1, &s.homework_id, "hi").await;
    let body = ctx.spy.calls.lock().unwrap()[0].clone();
    assert_eq!(body["tools"].as_array().unwrap().len(), 2);
    assert_eq!(body["thinking"], json!({ "type": "enabled" }));
}

#[sqlx::test]
async fn blocks_chat_outside_the_homework_window(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    ctx.advance(20);
    let closed = ctx.chat(&s.student1, &s.homework_id, "hi").await;
    assert_eq!(closed.status, StatusCode::FORBIDDEN);
    assert_eq!(closed.json()["error"]["message"], "This homework is closed");
    ctx.advance(-30);
    assert_eq!(ctx.chat(&s.student1, &s.homework_id, "hi").await.status, StatusCode::FORBIDDEN);
    // Teacher previews ignore the window.
    assert_eq!(ctx.chat(&s.teacher, &s.homework_id, "hi").await.status, StatusCode::OK);
}

#[sqlx::test]
async fn stops_a_student_once_the_quota_is_used(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(with(|ai| ai.token_budget = Some(10))).await;
    ctx.chat(&s.student1, &s.homework_id, "hi").await;
    let res = ctx.chat(&s.student1, &s.homework_id, "hi").await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert!(res.json()["error"]["message"].as_str().unwrap().contains("quota"));
    // The quota is per student.
    assert_eq!(ctx.chat(&s.student2, &s.homework_id, "hi").await.status, StatusCode::OK);
}

#[sqlx::test]
async fn rejects_students_from_other_classes(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    let other = ctx.create_teacher("teacher2").await;
    let class = ctx.post("/api/classes", &other, json!({ "name": "B" })).await.json();
    let created = ctx
        .post(
            &format!("/api/classes/{}/students", class["class"]["id"].as_str().unwrap()),
            &other,
            json!({ "students": [{ "name": "Bob", "username": "bob" }] }),
        )
        .await
        .json();
    let bob = ctx.login("bob", created["credentials"][0]["password"].as_str().unwrap()).await;
    assert_eq!(ctx.chat(&bob, &s.homework_id, "hi").await.status, StatusCode::NOT_FOUND);
    assert_eq!(ctx.chat("", &s.homework_id, "hi").await.status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn infers_regenerate_edit_and_continue(db: PgPool) {
    let ctx = Ctx::new(db.clone());
    let s = ctx.setup_class(ai_config()).await;
    let ask = json!([{ "role": "user", "content": "How do I start?" }]);
    ctx.chat_with(&s.student1, &s.homework_id, "u1", None, ask.clone()).await;
    ctx.chat_with(&s.student1, &s.homework_id, "u1", None, ask.clone()).await;
    ctx.chat_with(&s.student1, &s.homework_id, "u1-edited", None, ask.clone()).await;
    ctx.chat_with(
        &s.student1,
        &s.homework_id,
        "u1",
        None,
        json!([{ "role": "user", "content": "How do I start?" }, { "role": "assistant", "content": [{ "type": "text", "text": "First" }] }]),
    )
    .await;
    ctx.chat_with(&s.student1, &s.homework_id, "u2", Some("a1"), ask).await;
    let kinds: Vec<String> = turns(&db).await.into_iter().map(|t| t.kind).collect();
    assert_eq!(kinds, ["new", "regenerate", "edit", "continue", "new"]);
}

#[sqlx::test]
async fn records_aborted_turns_when_the_student_stops(db: PgPool) {
    let ctx = Ctx::new(db.clone());
    let s = ctx.setup_class(ai_config()).await;
    let response = ctx
        .send(ctx.chat_request(&s.student1, &s.homework_id, "u1", None, json!([{ "role": "user", "content": "hi" }])))
        .await;
    let mut body = response.into_body();
    body.frame().await.unwrap().unwrap();
    drop(body);
    for _ in 0..50 {
        if turns(&db).await[0].status == "aborted" {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("turn was not recorded as aborted: {:?}", turns(&db).await);
}

#[sqlx::test]
async fn maps_uploaded_files_to_provider_ids(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    let headers = [("x-hw-homework-id", s.homework_id.as_str())];
    let upload = ctx.upload("/anthropic/v1/files", &s.student1, "notes.txt", "text/plain", b"x^2 = 4", &headers).await;
    assert_eq!(upload.status, StatusCode::OK, "{}", upload.text());
    let file_id = upload.json()["id"].as_str().unwrap().to_string();
    assert!(file_id.starts_with("file_"));
    assert_eq!(*ctx.spy.uploads.lock().unwrap(), ["notes.txt"]);

    let messages = json!([{ "role": "user", "content": [
        { "type": "document", "source": { "type": "file", "file_id": file_id } },
        { "type": "text", "text": "Take a look" }
    ] }]);
    ctx.chat_with(&s.student1, &s.homework_id, "u1", None, messages.clone()).await;
    let sent = ctx.spy.calls.lock().unwrap()[0].clone();
    let provider_id = sent["messages"][0]["content"][0]["source"]["file_id"].as_str().unwrap();
    assert!(provider_id.starts_with("mockfile_"));

    let student_id = s.students[0]["id"].as_str().unwrap();
    let record = ctx.get(&format!("/api/homeworks/{}/students/{student_id}", s.homework_id), &s.teacher).await.json();
    assert_eq!(record["conversations"][0]["turns"][0]["files"][0]["filename"], "notes.txt");

    // Other students cannot reference the file.
    assert_eq!(ctx.chat_with(&s.student2, &s.homework_id, "u9", None, messages).await.status, StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn rejects_uploads_when_disabled(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(with(|ai| ai.allow_file_upload = false)).await;
    let headers = [("x-hw-homework-id", s.homework_id.as_str())];
    let res = ctx.upload("/anthropic/v1/files", &s.student1, "a.txt", "text/plain", b"x", &headers).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn passes_upstream_errors_through(db: PgPool) {
    let ctx = Ctx::new(db.clone());
    let s = ctx.setup_class(ai_config()).await;
    *ctx.spy.fail_with.lock().unwrap() =
        Some((429, json!({ "error": { "type": "rate_limit_error", "message": "slow down" } }).to_string()));
    let res = ctx.chat(&s.student1, &s.homework_id, "hi").await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.json()["error"]["message"], "slow down");
    let turn = &turns(&db).await[0];
    assert_eq!(turn.status, "error");
    assert!(turn.error.as_deref().unwrap().contains("429"));
}

#[sqlx::test]
async fn disables_voice_endpoints(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    let res = ctx.call(Method::POST, "/v1/tools/asr", Some(&s.student1), None, &[]).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}
