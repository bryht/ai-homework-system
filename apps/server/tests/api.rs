mod common;

use axum::http::{Method, StatusCode};
use common::{Ctx, ai_config};
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test]
async fn logs_in_reports_user_and_logs_out(db: PgPool) {
    let ctx = Ctx::new(db);
    let cookie = ctx.create_teacher("teacher").await;
    let me = ctx.get("/api/auth/me", &cookie).await.json();
    assert_eq!(me["user"]["username"], "teacher");
    assert_eq!(me["user"]["role"], "teacher");
    ctx.call(Method::POST, "/api/auth/logout", Some(&cookie), None, &[]).await;
    assert!(ctx.get("/api/auth/me", &cookie).await.json()["user"].is_null());
}

#[sqlx::test]
async fn rejects_wrong_password(db: PgPool) {
    let ctx = Ctx::new(db);
    ctx.create_teacher("teacher").await;
    let body = json!({ "username": "teacher", "password": "nope" });
    let res = ctx.call(Method::POST, "/api/auth/login", None, Some(body), &[]).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.json()["error"]["message"], "Wrong username or password");
}

#[sqlx::test]
async fn rejects_cross_site_writes(db: PgPool) {
    let ctx = Ctx::new(db);
    let cookie = ctx.create_teacher("teacher").await;
    let res = ctx
        .call(
            Method::POST,
            "/api/classes",
            Some(&cookie),
            Some(json!({ "name": "x" })),
            &[("origin", "https://evil.example"), ("host", "school.example")],
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let same = ctx
        .call(
            Method::POST,
            "/api/classes",
            Some(&cookie),
            Some(json!({ "name": "x" })),
            &[("origin", "https://school.example"), ("host", "school.example")],
        )
        .await;
    assert_eq!(same.status, StatusCode::OK);
}

#[sqlx::test]
async fn changes_password(db: PgPool) {
    let ctx = Ctx::new(db);
    let cookie = ctx.create_teacher("teacher").await;
    let res = ctx
        .post(
            "/api/auth/password",
            &cookie,
            json!({ "currentPassword": "teacher-pass", "newPassword": "a-new-password" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(ctx.login("teacher", "a-new-password").await.starts_with("hw_session="));
}

#[sqlx::test]
async fn creates_student_accounts_with_one_time_passwords(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    assert_eq!(s.students[0]["username"], "samlee");
    assert_eq!(s.students[1]["username"], "alice.wang");
    assert_eq!(s.students[0]["password"].as_str().unwrap().len(), 10);

    let list = ctx.get(&format!("/api/classes/{}/students", s.class_id), &s.teacher).await.json();
    let names: Vec<&str> =
        list["students"].as_array().unwrap().iter().map(|x| x["username"].as_str().unwrap()).collect();
    assert_eq!(names, ["samlee", "alice.wang"]);

    let student_id = s.students[0]["id"].as_str().unwrap();
    let reset = ctx
        .call(
            Method::POST,
            &format!("/api/classes/{}/students/{student_id}/reset-password", s.class_id),
            Some(&s.teacher),
            None,
            &[],
        )
        .await
        .json();
    // Old sessions stop working after a reset.
    assert_eq!(ctx.get("/api/homeworks", &s.student1).await.status, StatusCode::UNAUTHORIZED);
    ctx.login("samlee", reset["credential"]["password"].as_str().unwrap()).await;
}

#[sqlx::test]
async fn students_cannot_manage_classes(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    assert_eq!(ctx.post("/api/classes", &s.student1, json!({ "name": "x" })).await.status, StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn students_see_a_safe_view_without_the_teaching_prompt(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    let res = ctx.get(&format!("/api/homeworks/{}", s.homework_id), &s.student1).await;
    let hw = &res.json()["homework"];
    assert_eq!(hw["phase"], "open");
    assert!(hw.get("aiConfig").is_none());
    assert_eq!(hw["ai"], json!({ "allowWebSearch": false, "allowFileUpload": true, "allowThinking": true }));
    assert!(!res.text().contains("patient learning guide"));
}

#[sqlx::test]
async fn hides_drafts_and_other_classes(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    ctx.patch(&format!("/api/homeworks/{}", s.homework_id), &s.teacher, json!({ "status": "draft" })).await;
    assert_eq!(ctx.get(&format!("/api/homeworks/{}", s.homework_id), &s.student1).await.status, StatusCode::NOT_FOUND);
    assert_eq!(ctx.get("/api/homeworks", &s.student1).await.json()["homeworks"], json!([]));

    let other = ctx.create_teacher("teacher2").await;
    assert_eq!(ctx.get(&format!("/api/homeworks/{}", s.homework_id), &other).await.status, StatusCode::NOT_FOUND);
    assert_eq!(ctx.get(&format!("/api/classes/{}/students", s.class_id), &other).await.status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn validates_time_window_and_model(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    let path = format!("/api/homeworks/{}", s.homework_id);
    assert_eq!(
        ctx.patch(&path, &s.teacher, json!({ "dueAt": "2020-01-01T00:00:00Z" })).await.status,
        StatusCode::BAD_REQUEST
    );
    let mut ai = ai_config();
    ai.model = "gpt-x".into();
    assert_eq!(ctx.patch(&path, &s.teacher, json!({ "aiConfig": ai })).await.status, StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn accepts_submissions_in_window_and_rejects_after_due(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    let path = format!("/api/homeworks/{}/submission", s.homework_id);
    let ok = ctx.put(&path, &s.student1, json!({ "content": "My answer: x = 2" })).await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.json()["submission"]["content"], "My answer: x = 2");
    assert_eq!(ok.json()["submission"]["isLate"], false);
    ctx.advance(20);
    assert_eq!(
        ctx.put(&path, &s.student1, json!({ "content": "Changed my mind" })).await.status,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test]
async fn flags_late_submissions_when_allowed(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    ctx.patch(&format!("/api/homeworks/{}", s.homework_id), &s.teacher, json!({ "allowLateSubmission": true })).await;
    ctx.advance(20);
    let res = ctx
        .put(&format!("/api/homeworks/{}/submission", s.homework_id), &s.student1, json!({ "content": "late" }))
        .await;
    assert_eq!(res.json()["submission"]["isLate"], true);
}

#[sqlx::test]
async fn attaches_files_and_lets_the_teacher_download_them(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    let upload = ctx
        .upload(
            &format!("/api/homeworks/{}/submission/files", s.homework_id),
            &s.student1,
            "homework notes.txt",
            "text/plain",
            b"hello",
            &[],
        )
        .await;
    assert_eq!(upload.status, StatusCode::OK, "{}", upload.text());
    let file_id = upload.json()["file"]["id"].as_str().unwrap().to_string();
    let path = format!("/api/homeworks/{}/submission", s.homework_id);

    // Someone else's file cannot be attached.
    let stolen = ctx.put(&path, &s.student2, json!({ "content": "x", "fileIds": [file_id] })).await;
    assert_eq!(stolen.status, StatusCode::BAD_REQUEST);

    ctx.put(&path, &s.student1, json!({ "content": "see attachment", "fileIds": [file_id] })).await;
    let student_id = s.students[0]["id"].as_str().unwrap();
    let record = ctx.get(&format!("/api/homeworks/{}/students/{student_id}", s.homework_id), &s.teacher).await.json();
    assert_eq!(record["submission"]["files"][0]["filename"], "homework notes.txt");

    assert_eq!(ctx.get(&format!("/api/files/{file_id}"), &s.teacher).await.text(), "hello");
    assert_eq!(ctx.get(&format!("/api/files/{file_id}"), &s.student2).await.status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn stores_grades_and_exports_csv(db: PgPool) {
    let ctx = Ctx::new(db);
    let s = ctx.setup_class(ai_config()).await;
    let student_id = s.students[0]["id"].as_str().unwrap();
    let res = ctx
        .put(
            &format!("/api/homeworks/{}/students/{student_id}/grade", s.homework_id),
            &s.teacher,
            json!({ "score": 92, "comment": "Clear reasoning, \"good\"" }),
        )
        .await;
    assert_eq!(res.json()["grade"]["score"], 92.0);
    let csv = ctx.get(&format!("/api/homeworks/{}/export.csv", s.homework_id), &s.teacher).await.text();
    assert!(csv.contains("samlee,Sam Lee,0,0,0,,,92,\"Clear reasoning, \"\"good\"\"\""), "{csv}");
}

#[sqlx::test]
async fn bearer_tokens_work_for_a_web_app_on_another_origin(db: PgPool) {
    let ctx = Ctx::new(db);
    ctx.create_teacher("teacher").await;
    let pages = ("origin", "https://school.github.io");
    let login = ctx
        .call(
            Method::POST,
            "/api/auth/login",
            None,
            Some(json!({ "username": "teacher", "password": "teacher-pass" })),
            &[pages, ("host", "api.school.example")],
        )
        .await;
    assert_eq!(login.status, StatusCode::OK);
    assert_eq!(login.headers["access-control-allow-origin"], "https://school.github.io");
    let auth = format!("Bearer {}", login.json()["token"].as_str().unwrap());

    let me = ctx.call(Method::GET, "/api/auth/me", None, None, &[("authorization", &auth)]).await.json();
    assert_eq!(me["user"]["username"], "teacher");
    // Writes from the allowed origin pass the cross-site check.
    let created = ctx
        .call(
            Method::POST,
            "/api/classes",
            None,
            Some(json!({ "name": "x" })),
            &[("authorization", &auth), pages, ("host", "api.school.example")],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK);
    // Preflight answers only for configured origins.
    let preflight = ctx
        .call(
            Method::OPTIONS,
            "/anthropic/v1/messages",
            None,
            None,
            &[
                pages,
                ("access-control-request-method", "POST"),
                ("access-control-request-headers", "authorization,x-hw-homework-id"),
            ],
        )
        .await;
    assert_eq!(preflight.headers["access-control-allow-origin"], "https://school.github.io");
    let other = ctx.call(Method::GET, "/api/health", None, None, &[("origin", "https://evil.example")]).await;
    assert!(other.headers.get("access-control-allow-origin").is_none());
}
