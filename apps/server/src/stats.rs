use crate::error::AppResult;
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;

#[derive(Clone, Debug, Default, FromRow)]
pub struct UsageStats {
    pub user_id: String,
    pub conversations: i64,
    pub turns: i64,
    pub tokens: i64,
    pub active_days: i64,
    pub first_active_at: Option<DateTime<Utc>>,
    pub last_active_at: Option<DateTime<Utc>>,
}

/// AI usage per student for one homework. Active days are counted in the configured time zone.
pub async fn usage_by_student(
    db: &PgPool,
    homework_id: &str,
    timezone: &str,
) -> AppResult<HashMap<String, UsageStats>> {
    let rows = sqlx::query_as::<_, UsageStats>(
        "SELECT user_id, \
                count(DISTINCT conversation_id) AS conversations, \
                count(*) AS turns, \
                coalesce(sum(input_tokens + output_tokens), 0)::bigint AS tokens, \
                count(DISTINCT (created_at AT TIME ZONE $2)::date) AS active_days, \
                min(created_at) AS first_active_at, \
                max(created_at) AS last_active_at \
         FROM turns WHERE homework_id = $1 GROUP BY user_id",
    )
    .bind(homework_id)
    .bind(timezone)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.user_id.clone(), r)).collect())
}

pub async fn tokens_used(db: &PgPool, homework_id: &str, user_id: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT coalesce(sum(input_tokens + output_tokens), 0)::bigint FROM turns WHERE homework_id = $1 AND user_id = $2",
    )
    .bind(homework_id)
    .bind(user_id)
    .fetch_one(db)
    .await?)
}
