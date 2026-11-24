use crate::{
    AppState,
    access::{load_files, load_homework_for_teacher},
    auth::CurrentUser,
    error::{AppError, AppResult},
    models::Role,
};
use axum::{
    Router,
    extract::{Path, Query, State},
    http::header,
    response::IntoResponse,
    routing::get,
};
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new().route("/{id}", get(download))
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Only the uploader and the homework's teacher may download a file.
async fn download(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<impl IntoResponse> {
    let not_found = || AppError::not_found("File not found");
    let row = load_files(&state.db, std::slice::from_ref(&id)).await?.pop().ok_or_else(not_found)?;
    if row.owner_id != user.id {
        let homework_id = row.homework_id.as_deref().filter(|_| user.role == Role::Teacher).ok_or_else(not_found)?;
        load_homework_for_teacher(&state, homework_id, &user).await?;
    }
    let data = state.storage.get(&row.storage_key).await?;
    let inline = !query.contains_key("download")
        && (row.mime_type.starts_with("image/")
            || row.mime_type == "application/pdf"
            || row.mime_type.starts_with("text/plain"));
    let disposition =
        format!("{}; filename*=UTF-8''{}", if inline { "inline" } else { "attachment" }, percent_encode(&row.filename));
    Ok((
        [
            (header::CONTENT_TYPE, row.mime_type),
            (header::CONTENT_DISPOSITION, disposition),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox".into(),
            ),
        ],
        data,
    ))
}
