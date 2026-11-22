//! Database rows and the JSON shapes shared with the frontend
//! (`packages/shared/src/index.ts` is the TypeScript side of the same contract).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, types::Json};

// ---------- Shared JSON types ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Teacher,
    Student,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Teacher => "teacher",
            Role::Student => "student",
        }
    }

    pub fn parse(value: &str) -> Self {
        if value == "teacher" { Role::Teacher } else { Role::Student }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub role: Role,
    pub name: String,
    pub username: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeachingMode {
    Socratic,
    Explain,
    Open,
    Custom,
}

/// Per-homework AI settings, enforced by the gateway.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub model: String,
    pub teaching_mode: TeachingMode,
    pub system_prompt: String,
    pub allow_web_search: bool,
    pub allow_file_upload: bool,
    pub allow_thinking: bool,
    /// Tokens (input + output) each student may use on this homework; `None` means unlimited.
    pub token_budget: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Upcoming,
    Open,
    Closed,
}

pub fn phase_at(start_at: DateTime<Utc>, due_at: DateTime<Utc>, now: DateTime<Utc>) -> Phase {
    if now < start_at {
        Phase::Upcoming
    } else if now > due_at {
        Phase::Closed
    } else {
        Phase::Open
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Homework {
    pub id: String,
    pub class_id: String,
    pub class_name: String,
    pub title: String,
    pub description: String,
    pub start_at: DateTime<Utc>,
    pub due_at: DateTime<Utc>,
    pub status: String,
    pub allow_late_submission: bool,
    pub ai_config: AiConfig,
    pub created_at: DateTime<Utc>,
    pub phase: Phase,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSwitches {
    pub allow_web_search: bool,
    pub allow_file_upload: bool,
    pub allow_thinking: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub tokens: i64,
    pub token_budget: Option<i64>,
}

/// What a student sees: no teaching prompt.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentHomework {
    pub id: String,
    pub class_id: String,
    pub class_name: String,
    pub title: String,
    pub description: String,
    pub start_at: DateTime<Utc>,
    pub due_at: DateTime<Utc>,
    pub status: String,
    pub allow_late_submission: bool,
    pub created_at: DateTime<Utc>,
    pub phase: Phase,
    pub ai: AiSwitches,
    pub usage: Usage,
    pub submission: Option<Submission>,
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ClassStudent {
    pub id: String,
    pub name: String,
    pub username: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCredential {
    pub id: String,
    pub name: String,
    pub username: String,
    /// `None` when an existing account was added to the class.
    pub password: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    pub id: String,
    pub content: String,
    pub files: Vec<FileInfo>,
    pub submitted_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_late: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grade {
    pub score: Option<f64>,
    pub comment: String,
    pub graded_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionSummary {
    pub submitted_at: DateTime<Utc>,
    pub is_late: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentProgress {
    pub student: ClassStudent,
    pub conversations: i64,
    pub turns: i64,
    pub tokens: i64,
    pub active_days: i64,
    pub first_active_at: Option<DateTime<Utc>>,
    pub last_active_at: Option<DateTime<Utc>>,
    pub submission: Option<SubmissionSummary>,
    pub grade: Option<Grade>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub user_message_id: Option<String>,
    pub parent_message_id: Option<String>,
    pub assistant_message_id: Option<String>,
    pub user_content: Vec<Value>,
    pub assistant_content: Vec<Value>,
    pub files: Vec<FileInfo>,
    pub model: String,
    pub input_tokens: i32,
    pub output_tokens: i32,
    pub latency_ms: Option<i32>,
    pub stop_reason: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub turns: Vec<Turn>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub supports_thinking: bool,
    pub supports_web_search: bool,
    pub supports_files: bool,
}

// ---------- Database rows ----------

#[derive(Clone, Debug, FromRow)]
pub struct UserRow {
    pub id: String,
    pub role: String,
    pub name: String,
    pub username: String,
    pub password_hash: String,
}

impl UserRow {
    pub fn to_user(&self) -> User {
        User {
            id: self.id.clone(),
            role: Role::parse(&self.role),
            name: self.name.clone(),
            username: self.username.clone(),
        }
    }
}

#[derive(Clone, Debug, FromRow)]
pub struct ClassRow {
    pub id: String,
    pub teacher_id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, FromRow)]
pub struct HomeworkRow {
    pub id: String,
    pub class_id: String,
    pub title: String,
    pub description: String,
    pub start_at: DateTime<Utc>,
    pub due_at: DateTime<Utc>,
    pub status: String,
    pub allow_late_submission: bool,
    pub ai_config: Json<AiConfig>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, FromRow)]
pub struct ConversationRow {
    pub id: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, FromRow)]
pub struct TurnRow {
    pub id: String,
    pub conversation_id: String,
    pub kind: String,
    pub status: String,
    pub user_message_id: Option<String>,
    pub parent_message_id: Option<String>,
    pub assistant_message_id: Option<String>,
    pub user_content: Json<Vec<Value>>,
    pub assistant_content: Json<Vec<Value>>,
    pub file_ids: Json<Vec<String>>,
    pub model: String,
    pub input_tokens: i32,
    pub output_tokens: i32,
    pub latency_ms: Option<i32>,
    pub stop_reason: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, FromRow)]
pub struct FileRow {
    pub id: String,
    pub owner_id: String,
    pub homework_id: Option<String>,
    pub purpose: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i32,
    pub sha256: String,
    pub storage_key: String,
    pub provider: Option<String>,
    pub provider_file_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl FileRow {
    pub fn info(&self) -> FileInfo {
        FileInfo {
            id: self.id.clone(),
            filename: self.filename.clone(),
            mime_type: self.mime_type.clone(),
            size: self.size,
            created_at: self.created_at,
        }
    }
}

#[derive(Clone, Debug, FromRow)]
pub struct SubmissionRow {
    pub id: String,
    pub student_id: String,
    pub content: String,
    pub file_ids: Json<Vec<String>>,
    pub is_late: bool,
    pub submitted_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, FromRow)]
pub struct EvaluationRow {
    pub student_id: String,
    pub teacher_score: Option<f64>,
    pub teacher_comment: String,
    pub graded_at: Option<DateTime<Utc>>,
}

impl EvaluationRow {
    pub fn grade(&self) -> Grade {
        Grade { score: self.teacher_score, comment: self.teacher_comment.clone(), graded_at: self.graded_at }
    }
}
