use axum::{
    Json,
    extract::Request,
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::borrow::Cow;

/// API error with an English and a Chinese message. The response body follows the
/// Anthropic error format (`{ "error": { "type", "message" } }`) so chat-demo can show it as-is.
#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub kind: &'static str,
    pub en: Cow<'static, str>,
    pub zh: Cow<'static, str>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(
        status: StatusCode,
        kind: &'static str,
        en: impl Into<Cow<'static, str>>,
        zh: impl Into<Cow<'static, str>>,
    ) -> Self {
        Self { status, kind, en: en.into(), zh: zh.into() }
    }

    pub fn bad_request(en: impl Into<Cow<'static, str>>, zh: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request_error", en, zh)
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "authentication_error", "Please sign in again", "登录已过期，请重新登录")
    }

    pub fn forbidden(en: impl Into<Cow<'static, str>>, zh: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "permission_error", en, zh)
    }

    pub fn no_permission() -> Self {
        Self::forbidden("You do not have permission to do this", "没有权限执行此操作")
    }

    pub fn not_found(en: impl Into<Cow<'static, str>>, zh: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found_error", en, zh)
    }

    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!("{error}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "api_error", "Internal server error", "服务器内部错误")
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

/// Chinese text carried to the localization middleware.
#[derive(Clone)]
struct ChineseText(Cow<'static, str>, &'static str);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut response =
            (self.status, Json(json!({ "error": { "type": self.kind, "message": self.en } }))).into_response();
        response.extensions_mut().insert(ChineseText(self.zh, self.kind));
        response
    }
}

pub fn wants_chinese(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim().to_ascii_lowercase().starts_with("zh"))
}

/// Errors are English by default; requests with `Accept-Language: zh...` get the Chinese text.
pub async fn localize_errors(request: Request, next: Next) -> Response {
    let chinese = wants_chinese(request.headers());
    let response = next.run(request).await;
    if !chinese {
        return response;
    }
    match response.extensions().get::<ChineseText>().cloned() {
        Some(ChineseText(text, kind)) => {
            (response.status(), Json(json!({ "error": { "type": kind, "message": text } }))).into_response()
        }
        None => response,
    }
}
