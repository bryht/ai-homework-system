use crate::{
    AppState,
    error::{AppError, AppResult},
    ids::new_token,
    models::{Role, User, UserRow},
};
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::{
    extract::FromRequestParts,
    http::{HeaderMap, HeaderValue, header, request::Parts},
};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};

pub const SESSION_COOKIE: &str = "hw_session";

pub async fn hash_password(password: &str) -> anyhow::Result<String> {
    let password = password.to_owned();
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes())
            .map(|hash| hash.to_string())
            .map_err(|e| anyhow::anyhow!("hash password: {e}"))
    })
    .await?
}

pub async fn verify_password(password: &str, stored: &str) -> bool {
    let (password, stored) = (password.to_owned(), stored.to_owned());
    tokio::task::spawn_blocking(move || Argon2::default().verify_password(password.as_bytes(), stored.as_str()).is_ok())
        .await
        .unwrap_or(false)
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn session_cookie(state: &AppState, value: &str, max_age: i64) -> HeaderValue {
    let secure = if state.config.cookie_secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
    ))
    .expect("valid cookie header")
}

/// Creates a session and returns the `Set-Cookie` header value.
pub async fn start_session(state: &AppState, user_id: &str) -> AppResult<HeaderValue> {
    let token = new_token();
    let max_age = state.config.session_days * 86_400;
    let expires_at: DateTime<Utc> = state.clock.now() + chrono::Duration::seconds(max_age);
    sqlx::query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)")
        .bind(hash_token(&token))
        .bind(user_id)
        .bind(expires_at)
        .execute(&state.db)
        .await?;
    Ok(session_cookie(state, &token, max_age))
}

pub async fn end_session(state: &AppState, headers: &HeaderMap) -> AppResult<HeaderValue> {
    if let Some(token) = session_token(headers) {
        sqlx::query("DELETE FROM sessions WHERE id = $1").bind(hash_token(&token)).execute(&state.db).await?;
    }
    Ok(session_cookie(state, "", 0))
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, value)| *name == SESSION_COOKIE && !value.is_empty())
        .map(|(_, value)| value.to_string())
}

#[derive(sqlx::FromRow)]
struct SessionUser {
    #[sqlx(flatten)]
    user: UserRow,
    expires_at: DateTime<Utc>,
}

pub async fn user_from_headers(state: &AppState, headers: &HeaderMap) -> AppResult<Option<User>> {
    let Some(token) = session_token(headers) else {
        return Ok(None);
    };
    let row = sqlx::query_as::<_, SessionUser>(
        "SELECT u.id, u.role, u.name, u.username, u.password_hash, s.expires_at \
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1",
    )
    .bind(hash_token(&token))
    .fetch_optional(&state.db)
    .await?;
    Ok(row.filter(|r| r.expires_at > state.clock.now()).map(|r| r.user.to_user()))
}

/// The signed-in user; rejects with 401 otherwise.
pub struct CurrentUser(pub User);

/// The signed-in user, if any.
pub struct MaybeUser(pub Option<User>);

impl FromRequestParts<AppState> for MaybeUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(Self(user_from_headers(state, &parts.headers).await?))
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        user_from_headers(state, &parts.headers).await?.map(Self).ok_or_else(AppError::unauthorized)
    }
}

impl CurrentUser {
    pub fn require(self, role: Role) -> AppResult<User> {
        if self.0.role == role { Ok(self.0) } else { Err(AppError::no_permission()) }
    }
}

/// At most 10 failed sign-ins per IP + username every 10 minutes.
#[derive(Default)]
pub struct LoginLimiter {
    attempts: Mutex<HashMap<String, (u32, DateTime<Utc>)>>,
}

impl LoginLimiter {
    pub fn blocked(&self, key: &str, now: DateTime<Utc>) -> bool {
        self.attempts.lock().unwrap().get(key).is_some_and(|(count, reset)| *reset > now && *count >= 10)
    }

    pub fn fail(&self, key: &str, now: DateTime<Utc>) {
        let mut attempts = self.attempts.lock().unwrap();
        let entry = attempts.entry(key.to_string()).or_insert((0, now));
        if entry.1 <= now {
            *entry = (0, now + chrono::Duration::minutes(10));
        }
        entry.0 += 1;
    }

    pub fn reset(&self, key: &str) {
        self.attempts.lock().unwrap().remove(key);
    }
}
