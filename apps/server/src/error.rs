use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::borrow::Cow;

/// API error. The response body follows the Anthropic error format
/// (`{ "error": { "type", "message" } }`) so chat-demo can show it as-is.
#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub kind: &'static str,
    pub message: Cow<'static, str>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(status: StatusCode, kind: &'static str, message: impl Into<Cow<'static, str>>) -> Self {
        Self { status, kind, message: message.into() }
    }

    pub fn bad_request(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request_error", message)
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "authentication_error", "Please sign in again")
    }

    pub fn forbidden(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "permission_error", message)
    }

    pub fn no_permission() -> Self {
        Self::forbidden("You do not have permission to do this")
    }

    pub fn not_found(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found_error", message)
    }

    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!("{error}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "api_error", "Internal server error")
    }
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        Self::internal(error)
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        Self::internal(error)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": { "type": self.kind, "message": self.message } }))).into_response()
    }
}
