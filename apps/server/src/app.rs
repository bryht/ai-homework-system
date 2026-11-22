use crate::{
    auth::{LoginLimiter, MaybeUser},
    clock::Clock,
    config::Config,
    error::{AppError, AppResult, localize_errors},
    gateway::{self, providers::ProviderRegistry},
    routes,
    storage::Storage,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, FromRequest, Request, State},
    http::{Method, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use serde::de::DeserializeOwned;
use serde_json::json;
use sqlx::PgPool;
use std::{ops::Deref, sync::Arc};
use tower_http::services::{ServeDir, ServeFile};

pub struct AppStateInner {
    pub db: PgPool,
    pub config: Config,
    pub storage: Arc<dyn Storage>,
    pub providers: ProviderRegistry,
    pub clock: Clock,
    pub login_limiter: LoginLimiter,
}

#[derive(Clone)]
pub struct AppState(pub Arc<AppStateInner>);

impl Deref for AppState {
    type Target = AppStateInner;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AppState {
    pub fn new(db: PgPool, config: Config, storage: Arc<dyn Storage>, providers: ProviderRegistry) -> Self {
        Self(Arc::new(AppStateInner {
            db,
            config,
            storage,
            providers,
            clock: Clock::default(),
            login_limiter: LoginLimiter::default(),
        }))
    }
}

/// JSON body extractor whose errors use the API error format instead of axum's plain text.
pub struct JsonBody<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for JsonBody<T> {
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(AppError::bad_request(
                format!("Invalid request: {}", rejection.body_text()),
                format!("请求参数错误：{}", rejection.body_text()),
            )),
        }
    }
}

/// CSRF protection: writes must come from the same host (together with SameSite=Lax cookies).
async fn same_origin_writes(request: Request, next: Next) -> Response {
    let unsafe_method = matches!(*request.method(), Method::POST | Method::PUT | Method::PATCH | Method::DELETE);
    if let (true, Some(origin)) = (unsafe_method, request.headers().get(header::ORIGIN)) {
        let host = request
            .headers()
            .get("x-forwarded-host")
            .or_else(|| request.headers().get(header::HOST))
            .and_then(|h| h.to_str().ok());
        let origin_host = origin
            .to_str()
            .ok()
            .and_then(|o| o.split_once("://"))
            .map(|(_, rest)| rest.split('/').next().unwrap_or(rest));
        if host.is_none() || origin_host != host {
            return AppError::forbidden("Cross-site request rejected", "跨站请求被拒绝").into_response();
        }
    }
    next.run(request).await
}

async fn models(State(state): State<AppState>, MaybeUser(user): MaybeUser) -> AppResult<impl IntoResponse> {
    user.ok_or_else(AppError::unauthorized)?;
    Ok(Json(json!({ "models": state.providers.models() })))
}

async fn api_not_found() -> AppError {
    AppError::not_found("Not found", "接口不存在")
}

async fn voice_disabled() -> AppError {
    AppError::forbidden("Voice features are not available", "语音功能暂未开放")
}

pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .nest("/auth", routes::auth::router())
        .nest("/classes", routes::classes::router())
        .nest("/homeworks", routes::homeworks::router())
        .nest("/files", routes::files::router())
        .route("/models", get(models))
        .route("/health", get(|| async { Json(json!({ "ok": true })) }))
        .fallback(api_not_found);

    let mut router = Router::new()
        .nest("/api", api)
        .nest("/anthropic/v1", gateway::router())
        .route("/anthropic/{*rest}", any(api_not_found))
        // chat-demo's speech recognition and read-aloud endpoints are not offered in phase 1
        .route("/v1/tools/{*rest}", any(voice_disabled));

    // The built frontend is served from the same origin, which keeps cookie auth simple.
    let index = state.config.web_dist.join("index.html");
    if index.exists() {
        router = router.fallback_service(ServeDir::new(&state.config.web_dist).fallback(ServeFile::new(index)));
    }

    router
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(middleware::from_fn(same_origin_writes))
        .layer(middleware::from_fn(localize_errors))
        .with_state(state)
}
