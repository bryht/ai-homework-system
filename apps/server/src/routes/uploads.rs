use crate::{
    AppState,
    error::{AppError, AppResult},
    ids::new_id,
    models::FileRow,
};
use axum::{extract::Multipart, http::StatusCode};
use sha2::{Digest, Sha256};

pub const MAX_UPLOAD_BYTES: usize = 30 * 1024 * 1024;

pub struct UploadedFile {
    pub filename: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

/// Reads the `file` field of a multipart upload (other fields such as `purpose` are ignored).
pub async fn read_file_field(mut multipart: Multipart) -> AppResult<UploadedFile> {
    let invalid = || AppError::bad_request("Invalid upload");
    while let Some(field) = multipart.next_field().await.map_err(|_| invalid())? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().filter(|n| !n.is_empty()).unwrap_or("file").to_string();
        let mime_type = field.content_type().unwrap_or("application/octet-stream").to_string();
        let data = field.bytes().await.map_err(|_| invalid())?.to_vec();
        return Ok(UploadedFile { filename, mime_type, data });
    }
    Err(AppError::bad_request("No file received"))
}

/// Stores the original file (deduplicated by SHA-256) and records it in `files`.
pub async fn save_upload(
    state: &AppState,
    owner_id: &str,
    homework_id: &str,
    purpose: &str,
    file: UploadedFile,
) -> AppResult<FileRow> {
    if file.data.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_request_error",
            format!("Files must be smaller than {} MB", MAX_UPLOAD_BYTES / 1024 / 1024),
        ));
    }
    let sha256 = hex::encode(Sha256::digest(&file.data));
    let storage_key = format!("files/{}/{}", &sha256[..2], sha256);
    state.storage.put(&storage_key, &file.data).await?;
    Ok(sqlx::query_as::<_, FileRow>(
        "INSERT INTO files (id, owner_id, homework_id, purpose, filename, mime_type, size, sha256, storage_key, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
         RETURNING id, owner_id, homework_id, purpose, filename, mime_type, size, sha256, storage_key, provider, provider_file_id, created_at",
    )
    .bind(new_id("file"))
    .bind(owner_id)
    .bind(homework_id)
    .bind(purpose)
    .bind(&file.filename)
    .bind(&file.mime_type)
    .bind(file.data.len() as i32)
    .bind(&sha256)
    .bind(&storage_key)
    .bind(state.clock.now())
    .fetch_one(&state.db)
    .await?)
}
