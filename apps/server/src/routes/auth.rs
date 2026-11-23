use crate::{
    AppState,
    app::JsonBody,
    auth::{CurrentUser, MaybeUser, end_session, hash_password, start_session, verify_password},
    error::{AppError, AppResult},
    models::UserRow,
};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
        .route("/password", post(change_password))
}

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<LoginBody>,
) -> AppResult<impl IntoResponse> {
    let username = body.username.trim().to_lowercase();
    if username.is_empty() || body.password.is_empty() {
        return Err(AppError::bad_request("Username and password are required"));
    }
    let ip = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).unwrap_or("");
    let key = format!("{ip}:{username}");
    let now = state.clock.now();
    if state.login_limiter.blocked(&key, now) {
        return Err(AppError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limit_error",
            "Too many attempts. Try again in 10 minutes.",
        ));
    }
    let row =
        sqlx::query_as::<_, UserRow>("SELECT id, role, name, username, password_hash FROM users WHERE username = $1")
            .bind(&username)
            .fetch_optional(&state.db)
            .await?;
    let Some(row) = row else {
        state.login_limiter.fail(&key, now);
        return Err(wrong_credentials());
    };
    if !verify_password(&body.password, &row.password_hash).await {
        state.login_limiter.fail(&key, now);
        return Err(wrong_credentials());
    }
    state.login_limiter.reset(&key);
    let (token, cookie) = start_session(&state, &row.id).await?;
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "user": row.to_user(), "token": token }))))
}

fn wrong_credentials() -> AppError {
    AppError::new(StatusCode::UNAUTHORIZED, "authentication_error", "Wrong username or password")
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<impl IntoResponse> {
    let cookie = end_session(&state, &headers).await?;
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))))
}

async fn me(MaybeUser(user): MaybeUser) -> impl IntoResponse {
    Json(json!({ "user": user }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordBody {
    current_password: String,
    new_password: String,
}

async fn change_password(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    JsonBody(body): JsonBody<PasswordBody>,
) -> AppResult<impl IntoResponse> {
    if body.new_password.chars().count() < 8 || body.new_password.len() > 200 {
        return Err(AppError::bad_request("The new password must be at least 8 characters"));
    }
    let stored: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1").bind(&user.id).fetch_one(&state.db).await?;
    if !verify_password(&body.current_password, &stored).await {
        return Err(AppError::bad_request("Current password is incorrect"));
    }
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(hash_password(&body.new_password).await?)
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}
