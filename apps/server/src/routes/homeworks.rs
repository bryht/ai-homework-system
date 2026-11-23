use crate::{
    AppState,
    access::*,
    app::JsonBody,
    auth::CurrentUser,
    error::{AppError, AppResult},
    ids::new_id,
    models::*,
    routes::{
        classes::class_students,
        uploads::{read_file_field, save_upload},
    },
    stats::{tokens_used, usage_by_student},
};
use axum::{
    Json, Router,
    extract::{Multipart, Path, State},
    http::header,
    response::IntoResponse,
    routing::{get, post, put},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use sqlx::types::Json as DbJson;
use std::collections::{HashMap, HashSet};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", get(detail).patch(update))
        .route("/{id}/overview", get(overview))
        .route("/{id}/export.csv", get(export_csv))
        .route("/{id}/students/{student_id}", get(student_record))
        .route("/{id}/students/{student_id}/grade", put(save_grade))
        .route("/{id}/submission", put(submit))
        .route("/{id}/submission/files", post(upload_submission_file))
}

#[derive(sqlx::FromRow)]
struct HomeworkWithClass {
    #[sqlx(flatten)]
    homework: HomeworkRow,
    class_name: String,
}

async fn list(State(state): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<impl IntoResponse> {
    let now = state.clock.now();
    if user.role == Role::Teacher {
        let rows = sqlx::query_as::<_, HomeworkWithClass>(
            "SELECT h.id, h.class_id, h.title, h.description, h.start_at, h.due_at, h.status, \
             h.allow_late_submission, h.ai_config, h.created_at, c.name AS class_name FROM homeworks h \
             JOIN classes c ON c.id = h.class_id WHERE c.teacher_id = $1 ORDER BY h.due_at DESC",
        )
        .bind(&user.id)
        .fetch_all(&state.db)
        .await?;
        let homeworks: Vec<Homework> = rows.iter().map(|r| to_homework(&r.homework, &r.class_name, now)).collect();
        return Ok(Json(json!({ "homeworks": homeworks })));
    }
    let rows = sqlx::query_as::<_, HomeworkWithClass>(
        "SELECT h.id, h.class_id, h.title, h.description, h.start_at, h.due_at, h.status, \
         h.allow_late_submission, h.ai_config, h.created_at, c.name AS class_name FROM homeworks h \
         JOIN classes c ON c.id = h.class_id JOIN class_members m ON m.class_id = c.id \
         WHERE m.student_id = $1 AND h.status = 'published' ORDER BY h.due_at DESC",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await?;
    let mut homeworks = Vec::new();
    for row in rows {
        let tokens = tokens_used(&state.db, &row.homework.id, &user.id).await?;
        let submission = load_submission(&state.db, &row.homework.id, &user.id).await?;
        homeworks.push(to_student_homework(&row.homework, &row.class_name, now, tokens, submission));
    }
    Ok(Json(json!({ "homeworks": homeworks })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HomeworkBody {
    class_id: Option<String>,
    title: Option<String>,
    description: Option<String>,
    start_at: Option<DateTime<Utc>>,
    due_at: Option<DateTime<Utc>>,
    status: Option<String>,
    allow_late_submission: Option<bool>,
    ai_config: Option<AiConfig>,
}

fn check_fields(state: &AppState, body: &HomeworkBody) -> AppResult<()> {
    if let Some(title) = &body.title {
        let len = title.trim().chars().count();
        if len == 0 || len > 200 {
            return Err(AppError::bad_request("Title must be 1-200 characters"));
        }
    }
    if body.description.as_ref().is_some_and(|d| d.chars().count() > 50_000) {
        return Err(AppError::bad_request("Instructions are too long"));
    }
    if body.status.as_deref().is_some_and(|s| s != "draft" && s != "published") {
        return Err(AppError::bad_request("Invalid status"));
    }
    if let Some(ai) = &body.ai_config {
        if state.providers.for_model(&ai.model).is_none() {
            return Err(AppError::bad_request(format!("Model \"{}\" is not available", ai.model)));
        }
        if ai.system_prompt.chars().count() > 20_000 {
            return Err(AppError::bad_request("The teaching prompt is too long"));
        }
        if ai.token_budget.is_some_and(|b| b <= 0) {
            return Err(AppError::bad_request("The token quota must be positive"));
        }
    }
    Ok(())
}

/// Turns off switches the chosen model cannot honour (e.g. file uploads on an Ollama model), so students
/// never get an option that fails. The editor greys these out but keeps their old value.
fn fit_to_model(state: &AppState, mut ai: AiConfig) -> AiConfig {
    if let Some(model) = state.providers.model(&ai.model) {
        ai.allow_file_upload &= model.supports_files;
        ai.allow_thinking &= model.supports_thinking;
        ai.allow_web_search &= model.supports_web_search;
    }
    ai
}

fn check_window(start_at: DateTime<Utc>, due_at: DateTime<Utc>) -> AppResult<()> {
    if due_at <= start_at {
        return Err(AppError::bad_request("The due date must be after the start date"));
    }
    Ok(())
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    JsonBody(body): JsonBody<HomeworkBody>,
) -> AppResult<impl IntoResponse> {
    let teacher = user.require(Role::Teacher)?;
    check_fields(&state, &body)?;
    let missing = || AppError::bad_request("Missing required fields");
    let class_id = body.class_id.clone().ok_or_else(missing)?;
    let (Some(title), Some(start_at), Some(due_at), Some(ai_config)) =
        (body.title.clone(), body.start_at, body.due_at, body.ai_config.clone())
    else {
        return Err(missing());
    };
    let class = load_class(&state.db, &class_id)
        .await?
        .filter(|c| c.teacher_id == teacher.id)
        .ok_or_else(|| AppError::not_found("Class not found"))?;
    check_window(start_at, due_at)?;
    let now = state.clock.now();
    let row = sqlx::query_as::<_, HomeworkRow>(
        "INSERT INTO homeworks (id, class_id, title, description, start_at, due_at, status, allow_late_submission, \
         ai_config, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) \
         RETURNING id, class_id, title, description, start_at, due_at, status, allow_late_submission, ai_config, created_at",
    )
    .bind(new_id("hw"))
    .bind(&class.id)
    .bind(title.trim())
    .bind(body.description.unwrap_or_default())
    .bind(start_at)
    .bind(due_at)
    .bind(body.status.unwrap_or_else(|| "draft".into()))
    .bind(body.allow_late_submission.unwrap_or(false))
    .bind(DbJson(fit_to_model(&state, ai_config)))
    .bind(now)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(json!({ "homework": to_homework(&row, &class.name, now) })))
}

async fn detail(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let access = load_homework_for(&state, &id, &user).await?;
    let now = state.clock.now();
    if access.is_teacher {
        return Ok(Json(json!({ "homework": to_homework(&access.homework, &access.class.name, now) })));
    }
    let tokens = tokens_used(&state.db, &id, &user.id).await?;
    let submission = load_submission(&state.db, &id, &user.id).await?;
    let homework = to_student_homework(&access.homework, &access.class.name, now, tokens, submission);
    Ok(Json(json!({ "homework": homework })))
}

async fn update(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<HomeworkBody>,
) -> AppResult<impl IntoResponse> {
    let access = load_homework_for_teacher(&state, &id, &user).await?;
    check_fields(&state, &body)?;
    let current = access.homework;
    let start_at = body.start_at.unwrap_or(current.start_at);
    let due_at = body.due_at.unwrap_or(current.due_at);
    check_window(start_at, due_at)?;
    let now = state.clock.now();
    let row = sqlx::query_as::<_, HomeworkRow>(
        "UPDATE homeworks SET title = $2, description = $3, start_at = $4, due_at = $5, status = $6, \
         allow_late_submission = $7, ai_config = $8, updated_at = $9 WHERE id = $1 \
         RETURNING id, class_id, title, description, start_at, due_at, status, allow_late_submission, ai_config, created_at",
    )
    .bind(&current.id)
    .bind(body.title.map(|t| t.trim().to_string()).unwrap_or(current.title))
    .bind(body.description.unwrap_or(current.description))
    .bind(start_at)
    .bind(due_at)
    .bind(body.status.unwrap_or(current.status))
    .bind(body.allow_late_submission.unwrap_or(current.allow_late_submission))
    .bind(DbJson(fit_to_model(&state, body.ai_config.unwrap_or(current.ai_config.0))))
    .bind(now)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(json!({ "homework": to_homework(&row, &access.class.name, now) })))
}

async fn all_submissions(state: &AppState, homework_id: &str) -> AppResult<HashMap<String, SubmissionRow>> {
    let rows = sqlx::query_as::<_, SubmissionRow>(
        "SELECT id, student_id, content, file_ids, is_late, submitted_at, updated_at FROM submissions WHERE homework_id = $1",
    )
    .bind(homework_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.student_id.clone(), r)).collect())
}

async fn all_grades(state: &AppState, homework_id: &str) -> AppResult<HashMap<String, EvaluationRow>> {
    let rows = sqlx::query_as::<_, EvaluationRow>(
        "SELECT student_id, teacher_score, teacher_comment, graded_at FROM evaluations WHERE homework_id = $1",
    )
    .bind(homework_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.student_id.clone(), r)).collect())
}

async fn overview(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let access = load_homework_for_teacher(&state, &id, &user).await?;
    let students = class_students(&state, &access.class.id).await?;
    let usage = usage_by_student(&state.db, &id, &state.config.timezone).await?;
    let submissions = all_submissions(&state, &id).await?;
    let grades = all_grades(&state, &id).await?;
    let progress: Vec<StudentProgress> = students
        .into_iter()
        .map(|student| {
            let stats = usage.get(&student.id).cloned().unwrap_or_default();
            StudentProgress {
                conversations: stats.conversations,
                turns: stats.turns,
                tokens: stats.tokens,
                active_days: stats.active_days,
                first_active_at: stats.first_active_at,
                last_active_at: stats.last_active_at,
                submission: submissions
                    .get(&student.id)
                    .map(|s| SubmissionSummary { submitted_at: s.submitted_at, is_late: s.is_late }),
                grade: grades.get(&student.id).map(EvaluationRow::grade),
                student,
            }
        })
        .collect();
    Ok(Json(json!({
        "homework": to_homework(&access.homework, &access.class.name, state.clock.now()),
        "students": progress,
    })))
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

async fn export_csv(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let access = load_homework_for_teacher(&state, &id, &user).await?;
    let students = class_students(&state, &access.class.id).await?;
    let usage = usage_by_student(&state.db, &id, &state.config.timezone).await?;
    let submissions = all_submissions(&state, &id).await?;
    let grades = all_grades(&state, &id).await?;
    let mut lines = vec!["username,name,turns,tokens,active_days,submitted_at,late,score,comment".to_string()];
    for student in students {
        let stats = usage.get(&student.id).cloned().unwrap_or_default();
        let sub = submissions.get(&student.id);
        let grade = grades.get(&student.id);
        let cells = [
            student.username,
            student.name,
            stats.turns.to_string(),
            stats.tokens.to_string(),
            stats.active_days.to_string(),
            sub.map(|s| s.submitted_at.to_rfc3339()).unwrap_or_default(),
            sub.map(|s| if s.is_late { "yes" } else { "no" }.to_string()).unwrap_or_default(),
            grade.and_then(|g| g.teacher_score).map(|s| s.to_string()).unwrap_or_default(),
            grade.map(|g| g.teacher_comment.clone()).unwrap_or_default(),
        ];
        lines.push(cells.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
    }
    // The BOM makes Excel read UTF-8 (non-ASCII names) correctly.
    let body = format!("\u{FEFF}{}\r\n", lines.join("\r\n"));
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{id}.csv\"")),
        ],
        body,
    ))
}

async fn teacher_student(
    state: &AppState,
    user: &User,
    homework_id: &str,
    student_id: &str,
) -> AppResult<(HomeworkAccess, ClassStudent)> {
    let access = load_homework_for_teacher(state, homework_id, user).await?;
    let student = sqlx::query_as::<_, ClassStudent>("SELECT id, name, username FROM users WHERE id = $1")
        .bind(student_id)
        .fetch_optional(&state.db)
        .await?;
    match student {
        Some(student) if is_member(&state.db, &access.class.id, student_id).await? => Ok((access, student)),
        _ => Err(AppError::not_found("Student is not in this class")),
    }
}

async fn student_record(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path((id, student_id)): Path<(String, String)>,
) -> AppResult<impl IntoResponse> {
    let (access, student) = teacher_student(&state, &user, &id, &student_id).await?;
    let conversations = sqlx::query_as::<_, ConversationRow>(
        "SELECT id, title, created_at FROM conversations WHERE homework_id = $1 AND user_id = $2 ORDER BY created_at",
    )
    .bind(&id)
    .bind(&student.id)
    .fetch_all(&state.db)
    .await?;
    let turns = sqlx::query_as::<_, TurnRow>(
        "SELECT id, conversation_id, kind, status, user_message_id, parent_message_id, assistant_message_id, \
         user_content, assistant_content, file_ids, model, input_tokens, output_tokens, latency_ms, stop_reason, \
         error, created_at FROM turns WHERE homework_id = $1 AND user_id = $2 ORDER BY created_at, seq",
    )
    .bind(&id)
    .bind(&student.id)
    .fetch_all(&state.db)
    .await?;
    let file_ids: Vec<String> =
        turns.iter().flat_map(|t| t.file_ids.0.iter().cloned()).collect::<HashSet<_>>().into_iter().collect();
    let infos = load_file_infos(&state.db, &file_ids).await?;
    let mut by_conversation: HashMap<String, Vec<Turn>> = HashMap::new();
    for t in turns {
        by_conversation.entry(t.conversation_id.clone()).or_default().push(Turn {
            files: t.file_ids.0.iter().filter_map(|id| infos.get(id).cloned()).collect(),
            id: t.id,
            kind: t.kind,
            status: t.status,
            user_message_id: t.user_message_id,
            parent_message_id: t.parent_message_id,
            assistant_message_id: t.assistant_message_id,
            user_content: t.user_content.0,
            assistant_content: t.assistant_content.0,
            model: t.model,
            input_tokens: t.input_tokens,
            output_tokens: t.output_tokens,
            latency_ms: t.latency_ms,
            stop_reason: t.stop_reason,
            error: t.error,
            created_at: t.created_at,
        });
    }
    let conversations: Vec<Conversation> = conversations
        .into_iter()
        .map(|c| Conversation {
            turns: by_conversation.remove(&c.id).unwrap_or_default(),
            id: c.id,
            title: c.title,
            created_at: c.created_at,
        })
        .collect();
    let grade = all_grades(&state, &id).await?.get(&student.id).map(EvaluationRow::grade);
    Ok(Json(json!({
        "homework": to_homework(&access.homework, &access.class.name, state.clock.now()),
        "conversations": conversations,
        "submission": load_submission(&state.db, &id, &student.id).await?,
        "grade": grade,
        "student": student,
    })))
}

#[derive(Deserialize)]
struct GradeBody {
    score: Option<f64>,
    comment: String,
}

async fn save_grade(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path((id, student_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<GradeBody>,
) -> AppResult<impl IntoResponse> {
    let (_, student) = teacher_student(&state, &user, &id, &student_id).await?;
    if body.score.is_some_and(|s| !(0.0..=1000.0).contains(&s)) || body.comment.chars().count() > 20_000 {
        return Err(AppError::bad_request("Invalid score or comment"));
    }
    sqlx::query(
        "INSERT INTO evaluations (id, homework_id, student_id, teacher_score, teacher_comment, graded_at) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (homework_id, student_id) \
         DO UPDATE SET teacher_score = $4, teacher_comment = $5, graded_at = $6",
    )
    .bind(new_id("eval"))
    .bind(&id)
    .bind(&student.id)
    .bind(body.score)
    .bind(&body.comment)
    .bind(state.clock.now())
    .execute(&state.db)
    .await?;
    let grade = all_grades(&state, &id).await?.get(&student.id).map(EvaluationRow::grade);
    Ok(Json(json!({ "grade": grade })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionBody {
    content: String,
    #[serde(default)]
    file_ids: Vec<String>,
}

async fn submit(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<SubmissionBody>,
) -> AppResult<impl IntoResponse> {
    let student = user.require(Role::Student)?;
    let access = load_homework_for(&state, &id, &student).await?;
    let homework = access.homework;
    let now = state.clock.now();
    if now < homework.start_at {
        return Err(AppError::forbidden("This homework has not started yet"));
    }
    let is_late = now > homework.due_at;
    if is_late && !homework.allow_late_submission {
        return Err(AppError::forbidden("This homework is closed for submissions"));
    }
    if body.content.chars().count() > 200_000 || body.file_ids.len() > 20 {
        return Err(AppError::bad_request("The submission is too large"));
    }
    if body.content.trim().is_empty() && body.file_ids.is_empty() {
        return Err(AppError::bad_request("The submission is empty"));
    }
    let unique: HashSet<&String> = body.file_ids.iter().collect();
    let owned = load_files(&state.db, &body.file_ids)
        .await?
        .into_iter()
        .filter(|f| {
            f.owner_id == student.id && f.homework_id.as_deref() == Some(&*homework.id) && f.purpose == "submission"
        })
        .count();
    if owned != unique.len() {
        return Err(AppError::bad_request("Invalid attachment, please upload it again"));
    }
    sqlx::query(
        "INSERT INTO submissions (id, homework_id, student_id, content, file_ids, is_late, submitted_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (homework_id, student_id) \
         DO UPDATE SET content = $4, file_ids = $5, is_late = $6, updated_at = $7",
    )
    .bind(new_id("sub"))
    .bind(&homework.id)
    .bind(&student.id)
    .bind(&body.content)
    .bind(DbJson(&body.file_ids))
    .bind(is_late)
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "submission": load_submission(&state.db, &homework.id, &student.id).await? })))
}

async fn upload_submission_file(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    multipart: Multipart,
) -> AppResult<impl IntoResponse> {
    let student = user.require(Role::Student)?;
    let homework = load_homework_for(&state, &id, &student).await?.homework;
    if state.clock.now() > homework.due_at && !homework.allow_late_submission {
        return Err(AppError::forbidden("This homework is closed"));
    }
    let file = read_file_field(multipart).await?;
    let row = save_upload(&state, &student.id, &homework.id, "submission", file).await?;
    Ok(Json(json!({ "file": row.info() })))
}
