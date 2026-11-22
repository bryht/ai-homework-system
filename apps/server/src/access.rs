//! Who may see which homework, plus conversions from rows to API shapes.

use crate::{
    AppState,
    error::{AppError, AppResult},
    models::*,
};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use std::collections::HashMap;

pub struct HomeworkAccess {
    pub homework: HomeworkRow,
    pub class: ClassRow,
    /// Teachers can try the AI in their own homework (preview): no time window,
    /// no quota, and not counted in student statistics.
    pub is_teacher: bool,
}

fn homework_not_found() -> AppError {
    AppError::not_found("Homework not found", "作业不存在")
}

pub async fn is_member(db: &PgPool, class_id: &str, student_id: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM class_members WHERE class_id = $1 AND student_id = $2)",
    )
    .bind(class_id)
    .bind(student_id)
    .fetch_one(db)
    .await?)
}

pub async fn load_class(db: &PgPool, class_id: &str) -> AppResult<Option<ClassRow>> {
    Ok(sqlx::query_as::<_, ClassRow>("SELECT id, teacher_id, name, created_at FROM classes WHERE id = $1")
        .bind(class_id)
        .fetch_optional(db)
        .await?)
}

pub async fn load_homework_row(db: &PgPool, homework_id: &str) -> AppResult<Option<HomeworkRow>> {
    Ok(sqlx::query_as::<_, HomeworkRow>(
        "SELECT h.id, h.class_id, h.title, h.description, h.start_at, h.due_at, h.status, \
         h.allow_late_submission, h.ai_config, h.created_at FROM homeworks h WHERE h.id = $1",
    )
    .bind(homework_id)
    .fetch_optional(db)
    .await?)
}

/// Teachers may open homework in their own classes; students only published homework in their classes.
pub async fn load_homework_for(state: &AppState, homework_id: &str, user: &User) -> AppResult<HomeworkAccess> {
    let homework = load_homework_row(&state.db, homework_id).await?.ok_or_else(homework_not_found)?;
    let class = load_class(&state.db, &homework.class_id).await?.ok_or_else(homework_not_found)?;
    match user.role {
        Role::Teacher if class.teacher_id == user.id => Ok(HomeworkAccess { homework, class, is_teacher: true }),
        Role::Student if homework.status == "published" && is_member(&state.db, &class.id, &user.id).await? => {
            Ok(HomeworkAccess { homework, class, is_teacher: false })
        }
        _ => Err(homework_not_found()),
    }
}

pub async fn load_homework_for_teacher(state: &AppState, homework_id: &str, user: &User) -> AppResult<HomeworkAccess> {
    if user.role != Role::Teacher {
        return Err(AppError::no_permission());
    }
    load_homework_for(state, homework_id, user).await
}

pub fn to_homework(row: &HomeworkRow, class_name: &str, now: DateTime<Utc>) -> Homework {
    Homework {
        id: row.id.clone(),
        class_id: row.class_id.clone(),
        class_name: class_name.to_string(),
        title: row.title.clone(),
        description: row.description.clone(),
        start_at: row.start_at,
        due_at: row.due_at,
        status: row.status.clone(),
        allow_late_submission: row.allow_late_submission,
        ai_config: row.ai_config.0.clone(),
        created_at: row.created_at,
        phase: phase_at(row.start_at, row.due_at, now),
    }
}

pub fn to_student_homework(
    row: &HomeworkRow,
    class_name: &str,
    now: DateTime<Utc>,
    tokens: i64,
    submission: Option<Submission>,
) -> StudentHomework {
    let ai = &row.ai_config.0;
    StudentHomework {
        id: row.id.clone(),
        class_id: row.class_id.clone(),
        class_name: class_name.to_string(),
        title: row.title.clone(),
        description: row.description.clone(),
        start_at: row.start_at,
        due_at: row.due_at,
        status: row.status.clone(),
        allow_late_submission: row.allow_late_submission,
        created_at: row.created_at,
        phase: phase_at(row.start_at, row.due_at, now),
        ai: AiSwitches {
            allow_web_search: ai.allow_web_search,
            allow_file_upload: ai.allow_file_upload,
            allow_thinking: ai.allow_thinking,
        },
        usage: Usage { tokens, token_budget: ai.token_budget },
        submission,
    }
}

pub async fn load_files(db: &PgPool, ids: &[String]) -> AppResult<Vec<FileRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_as::<_, FileRow>(
        "SELECT id, owner_id, homework_id, purpose, filename, mime_type, size, sha256, storage_key, \
         provider, provider_file_id, created_at FROM files WHERE id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(db)
    .await?)
}

pub async fn load_file_infos(db: &PgPool, ids: &[String]) -> AppResult<HashMap<String, FileInfo>> {
    Ok(load_files(db, ids).await?.into_iter().map(|row| (row.id.clone(), row.info())).collect())
}

pub fn submission_from_row(row: SubmissionRow, infos: &HashMap<String, FileInfo>) -> Submission {
    Submission {
        id: row.id,
        content: row.content,
        files: row.file_ids.0.iter().filter_map(|id| infos.get(id).cloned()).collect(),
        submitted_at: row.submitted_at,
        updated_at: row.updated_at,
        is_late: row.is_late,
    }
}

pub async fn load_submission(db: &PgPool, homework_id: &str, student_id: &str) -> AppResult<Option<Submission>> {
    let row = sqlx::query_as::<_, SubmissionRow>(
        "SELECT id, student_id, content, file_ids, is_late, submitted_at, updated_at \
         FROM submissions WHERE homework_id = $1 AND student_id = $2",
    )
    .bind(homework_id)
    .bind(student_id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let infos = load_file_infos(db, &row.file_ids.0).await?;
    Ok(Some(submission_from_row(row, &infos)))
}
