use crate::{
    AppState,
    app::JsonBody,
    auth::{CurrentUser, hash_password},
    error::{AppError, AppResult},
    ids::{new_id, new_password, random_digits},
    models::{ClassRow, ClassStudent, CreatedCredential, Role, User, UserRow},
};
use axum::{
    Json, Router,
    extract::{Path, State},
    response::IntoResponse,
    routing::{delete, get, patch, post},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{class_id}", patch(rename))
        .route("/{class_id}/students", get(students).post(add_students))
        .route("/{class_id}/students/{student_id}/reset-password", post(reset_password))
        .route("/{class_id}/students/{student_id}", delete(remove_student))
}

/// 2–32 characters: a-z, 0-9, ".", "_" and "-", starting with a letter or digit.
pub fn valid_username(name: &str) -> bool {
    let bytes = name.as_bytes();
    (2..=32).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(b))
}

/// "Alice Wang" -> "alice.wang"; names that do not convert (e.g. Chinese) get "s" + 5 random digits.
fn suggest_username(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('.') {
            out.push('.');
        }
    }
    let candidate = out.trim_matches('.').to_string();
    if valid_username(&candidate) { candidate } else { format!("s{}", random_digits(5)) }
}

async fn unique_username(state: &AppState, base: &str, taken: &HashSet<String>) -> AppResult<String> {
    for i in 0..50 {
        let candidate = if i == 0 { base.to_string() } else { format!("{base}{}", i + 1) };
        if taken.contains(&candidate) {
            continue;
        }
        let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE username = $1)")
            .bind(&candidate)
            .fetch_one(&state.db)
            .await?;
        if !exists {
            return Ok(candidate);
        }
    }
    Ok(format!("{base}{}", random_digits(5)))
}

async fn own_class(state: &AppState, teacher: &User, class_id: &str) -> AppResult<ClassRow> {
    sqlx::query_as::<_, ClassRow>(
        "SELECT id, teacher_id, name, created_at FROM classes WHERE id = $1 AND teacher_id = $2",
    )
    .bind(class_id)
    .bind(&teacher.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("Class not found", "班级不存在"))
}

#[derive(sqlx::FromRow, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClassInfo {
    id: String,
    name: String,
    student_count: i64,
    created_at: DateTime<Utc>,
}

async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<impl IntoResponse> {
    let teacher = user.require(Role::Teacher)?;
    let classes = sqlx::query_as::<_, ClassInfo>(
        "SELECT c.id, c.name, count(m.student_id) AS student_count, c.created_at \
         FROM classes c LEFT JOIN class_members m ON m.class_id = c.id \
         WHERE c.teacher_id = $1 GROUP BY c.id ORDER BY c.created_at",
    )
    .bind(&teacher.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "classes": classes })))
}

#[derive(Deserialize)]
struct ClassBody {
    name: String,
}

fn class_name(body: &ClassBody) -> AppResult<String> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::bad_request("Class name must be 1-100 characters", "班级名称需要 1–100 个字"));
    }
    Ok(name.to_string())
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    JsonBody(body): JsonBody<ClassBody>,
) -> AppResult<impl IntoResponse> {
    let teacher = user.require(Role::Teacher)?;
    let name = class_name(&body)?;
    let id = new_id("cls");
    let created_at = state.clock.now();
    sqlx::query("INSERT INTO classes (id, teacher_id, name, created_at) VALUES ($1, $2, $3, $4)")
        .bind(&id)
        .bind(&teacher.id)
        .bind(&name)
        .bind(created_at)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "class": ClassInfo { id, name, student_count: 0, created_at } })))
}

async fn rename(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<String>,
    JsonBody(body): JsonBody<ClassBody>,
) -> AppResult<impl IntoResponse> {
    let teacher = user.require(Role::Teacher)?;
    let class = own_class(&state, &teacher, &class_id).await?;
    sqlx::query("UPDATE classes SET name = $1 WHERE id = $2")
        .bind(class_name(&body)?)
        .bind(&class.id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn class_students(state: &AppState, class_id: &str) -> AppResult<Vec<ClassStudent>> {
    Ok(sqlx::query_as::<_, ClassStudent>(
        "SELECT u.id, u.name, u.username FROM class_members m JOIN users u ON u.id = m.student_id \
         WHERE m.class_id = $1 ORDER BY m.created_at, u.username",
    )
    .bind(class_id)
    .fetch_all(&state.db)
    .await?)
}

async fn students(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let teacher = user.require(Role::Teacher)?;
    let class = own_class(&state, &teacher, &class_id).await?;
    Ok(Json(json!({ "students": class_students(&state, &class.id).await? })))
}

#[derive(Deserialize)]
struct NewStudent {
    name: String,
    username: Option<String>,
}

#[derive(Deserialize)]
struct StudentsBody {
    students: Vec<NewStudent>,
}

async fn add_member(state: &AppState, class_id: &str, student_id: &str) -> AppResult<()> {
    // Real insertion time (not the injectable clock) keeps the roster in the order students were added.
    sqlx::query("INSERT INTO class_members (class_id, student_id, created_at) VALUES ($1, $2, clock_timestamp()) ON CONFLICT DO NOTHING")
        .bind(class_id)
        .bind(student_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

async fn add_students(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(class_id): Path<String>,
    JsonBody(body): JsonBody<StudentsBody>,
) -> AppResult<impl IntoResponse> {
    let teacher = user.require(Role::Teacher)?;
    let class = own_class(&state, &teacher, &class_id).await?;
    if body.students.is_empty() || body.students.len() > 200 {
        return Err(AppError::bad_request("Add between 1 and 200 students at a time", "一次添加 1–200 名学生"));
    }
    let mut created = Vec::new();
    let mut taken = HashSet::new();
    for entry in body.students {
        let name = entry.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(AppError::bad_request("Each student needs a name", "每个学生都需要姓名"));
        }
        let requested = entry.username.map(|u| u.trim().to_lowercase()).filter(|u| !u.is_empty());
        if let Some(username) = &requested {
            if !valid_username(username) {
                return Err(AppError::bad_request(
                    format!("Username \"{username}\" may only contain a-z, 0-9, \".\", \"_\" and \"-\" (2-32 chars)"),
                    format!("用户名「{username}」只能包含小写字母、数字、点、下划线和连字符（2–32 位）"),
                ));
            }
            let existing = sqlx::query_as::<_, UserRow>(
                "SELECT id, role, name, username, password_hash FROM users WHERE username = $1",
            )
            .bind(username)
            .fetch_optional(&state.db)
            .await?;
            if let Some(existing) = existing {
                if existing.role != "student" {
                    return Err(AppError::bad_request(
                        format!("Username \"{username}\" is taken"),
                        format!("用户名「{username}」已被占用"),
                    ));
                }
                add_member(&state, &class.id, &existing.id).await?;
                taken.insert(existing.username.clone());
                created.push(CreatedCredential {
                    id: existing.id,
                    name: existing.name,
                    username: existing.username,
                    password: None,
                });
                continue;
            }
        }
        let username = match requested {
            Some(u) => u,
            None => unique_username(&state, &suggest_username(&name), &taken).await?,
        };
        taken.insert(username.clone());
        let password = new_password();
        let id = new_id("usr");
        sqlx::query("INSERT INTO users (id, role, name, username, password_hash) VALUES ($1, 'student', $2, $3, $4)")
            .bind(&id)
            .bind(&name)
            .bind(&username)
            .bind(hash_password(&password).await?)
            .execute(&state.db)
            .await?;
        add_member(&state, &class.id, &id).await?;
        created.push(CreatedCredential { id, name, username, password: Some(password) });
    }
    Ok(Json(json!({ "credentials": created })))
}

async fn reset_password(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((class_id, student_id)): Path<(String, String)>,
) -> AppResult<impl IntoResponse> {
    let teacher = user.require(Role::Teacher)?;
    let class = own_class(&state, &teacher, &class_id).await?;
    let student = sqlx::query_as::<_, UserRow>(
        "SELECT u.id, u.role, u.name, u.username, u.password_hash FROM class_members m \
         JOIN users u ON u.id = m.student_id WHERE m.class_id = $1 AND m.student_id = $2",
    )
    .bind(&class.id)
    .bind(&student_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("Student is not in this class", "学生不在这个班级"))?;
    let password = new_password();
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(hash_password(&password).await?)
        .bind(&student.id)
        .execute(&state.db)
        .await?;
    // Sign the student out everywhere so the old password's sessions stop working.
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&student.id).execute(&state.db).await?;
    let credential =
        CreatedCredential { id: student.id, name: student.name, username: student.username, password: Some(password) };
    Ok(Json(json!({ "credential": credential })))
}

async fn remove_student(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((class_id, student_id)): Path<(String, String)>,
) -> AppResult<impl IntoResponse> {
    let teacher = user.require(Role::Teacher)?;
    let class = own_class(&state, &teacher, &class_id).await?;
    sqlx::query("DELETE FROM class_members WHERE class_id = $1 AND student_id = $2")
        .bind(&class.id)
        .bind(&student_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}
