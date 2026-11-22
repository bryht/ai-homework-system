//! Demo data and account management used by the CLI.

use crate::{
    auth::hash_password,
    ids::{new_id, new_password},
    models::{AiConfig, TeachingMode},
};
use chrono::{Duration, Utc};
use sqlx::PgPool;

pub const DEMO_PASSWORD: &str = "demo1234";

const SOCRATIC_PROMPT: &str = "You are a patient learning guide helping a student with their homework.
- Never give the final answer, complete code or a complete essay for the homework.
- Guide the student with questions: first check they understand the task, then break it into small steps and move one step at a time.
- When the student is wrong, point out the problem in their reasoning and let them fix it.
- If the student asks for the answer directly, politely decline and give a hint for the next step.
- You may explain related concepts and use examples that differ from the homework.";

/// One teacher, one class, three students and an open homework. Safe to run twice.
pub async fn seed_demo(db: &PgPool) -> anyhow::Result<bool> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE username = 'teacher')").fetch_one(db).await?;
    if exists {
        return Ok(false);
    }
    let hash = hash_password(DEMO_PASSWORD).await?;
    let teacher_id = new_id("usr");
    sqlx::query("INSERT INTO users (id, role, name, username, password_hash) VALUES ($1, 'teacher', 'Ms. Taylor', 'teacher', $2)")
        .bind(&teacher_id)
        .bind(&hash)
        .execute(db)
        .await?;
    let class_id = new_id("cls");
    sqlx::query("INSERT INTO classes (id, teacher_id, name) VALUES ($1, $2, 'Pilot Class')")
        .bind(&class_id)
        .bind(&teacher_id)
        .execute(db)
        .await?;
    for (i, name) in ["Emma Chen", "Liam Patel", "Sofia Garcia"].iter().enumerate() {
        let id = new_id("usr");
        sqlx::query("INSERT INTO users (id, role, name, username, password_hash) VALUES ($1, 'student', $2, $3, $4)")
            .bind(&id)
            .bind(name)
            .bind(format!("student{}", i + 1))
            .bind(&hash)
            .execute(db)
            .await?;
        sqlx::query("INSERT INTO class_members (class_id, student_id) VALUES ($1, $2)")
            .bind(&class_id)
            .bind(&id)
            .execute(db)
            .await?;
    }
    let model =
        if std::env::var("DEEPSEEK_API_KEY").is_ok_and(|k| !k.trim().is_empty()) { "deepseek-flash" } else { "mock" };
    let ai = AiConfig {
        model: model.into(),
        teaching_mode: TeachingMode::Socratic,
        system_prompt: SOCRATIC_PROMPT.into(),
        allow_web_search: false,
        allow_file_upload: true,
        allow_thinking: true,
        token_budget: Some(500_000),
    };
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO homeworks (id, class_id, title, description, start_at, due_at, status, ai_config) \
         VALUES ($1, $2, $3, $4, $5, $6, 'published', $7)",
    )
    .bind(new_id("hw"))
    .bind(&class_id)
    .bind("Exploring quadratic equations")
    .bind(
        "Solve **x² − 5x + 6 = 0** using at least two different methods, then answer:\n\n\
         1. What are the key steps of each method?\n\
         2. When is completing the square a better choice than factoring?\n\
         3. Write your own equation, solve it with the quadratic formula and check your answer.\n\n\
         You may use the AI assistant, but include your own reasoning in your submission.",
    )
    .bind(now - Duration::days(1))
    .bind(now + Duration::days(13))
    .bind(sqlx::types::Json(&ai))
    .execute(db)
    .await?;
    Ok(true)
}

/// Creates a teacher account and returns the password (generated when not given).
pub async fn create_teacher(
    db: &PgPool,
    username: &str,
    name: &str,
    password: Option<String>,
) -> anyhow::Result<String> {
    let username = username.trim().to_lowercase();
    anyhow::ensure!(crate::routes::classes::valid_username(&username), "invalid username: {username}");
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE username = $1)")
        .bind(&username)
        .fetch_one(db)
        .await?;
    anyhow::ensure!(!exists, "user \"{username}\" already exists");
    let password = password.unwrap_or_else(new_password);
    sqlx::query("INSERT INTO users (id, role, name, username, password_hash) VALUES ($1, 'teacher', $2, $3, $4)")
        .bind(new_id("usr"))
        .bind(name)
        .bind(&username)
        .bind(hash_password(&password).await?)
        .execute(db)
        .await?;
    Ok(password)
}
