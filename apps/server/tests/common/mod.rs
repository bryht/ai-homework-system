#![allow(dead_code)]

use ai_homework::{
    AppState, build_router,
    config::Config,
    gateway::providers::{Mock, Provider, ProviderRegistry, Upstream, UpstreamError, UpstreamFile},
    models::{AiConfig, ModelOption, TeachingMode},
    storage::MemoryStorage,
};
use async_trait::async_trait;
use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Method, Request, Response, StatusCode, header},
};
use chrono::{DateTime, Duration, TimeZone, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

/// Mock provider that records what the gateway sends upstream.
#[derive(Default)]
pub struct Spy {
    inner: Mock,
    pub calls: Mutex<Vec<Value>>,
    pub uploads: Mutex<Vec<String>>,
    pub fail_with: Mutex<Option<(u16, String)>>,
}

#[async_trait]
impl Provider for Spy {
    fn id(&self) -> &'static str {
        "mock"
    }
    fn models(&self) -> Vec<ModelOption> {
        self.inner.models()
    }
    async fn create_message(&self, body: Value, has_files: bool) -> anyhow::Result<Upstream> {
        self.calls.lock().unwrap().push(body.clone());
        if let Some((status, body)) = self.fail_with.lock().unwrap().clone() {
            return Ok(Upstream::Failed { status, content_type: "application/json".into(), body });
        }
        self.inner.create_message(body, has_files).await
    }
    async fn upload_file(&self, file: UpstreamFile) -> Result<String, UpstreamError> {
        self.uploads.lock().unwrap().push(file.filename.clone());
        self.inner.upload_file(file).await
    }
}

pub fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap()
}

pub struct Ctx {
    pub app: Router,
    pub state: AppState,
    pub spy: Arc<Spy>,
    pub db: PgPool,
}

pub struct Res {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Res {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

pub struct Setup {
    pub teacher: String,
    pub class_id: String,
    pub homework_id: String,
    pub students: Vec<Value>,
    pub student1: String,
    pub student2: String,
}

pub fn ai_config() -> AiConfig {
    AiConfig {
        model: "mock".into(),
        teaching_mode: TeachingMode::Socratic,
        system_prompt: "你是一名耐心的学习引导者。\n- 不要直接给出作业的最终答案、完整代码或完整文章。".into(),
        allow_web_search: false,
        allow_file_upload: true,
        allow_thinking: true,
        token_budget: Some(500_000),
    }
}

impl Ctx {
    pub fn new(db: PgPool) -> Self {
        let spy = Arc::new(Spy { inner: Mock { chunk_delay: std::time::Duration::ZERO }, ..Default::default() });
        let config = Config::for_tests(String::new());
        let state = AppState::new(
            db.clone(),
            config,
            Arc::new(MemoryStorage::default()),
            ProviderRegistry::new(vec![spy.clone() as Arc<dyn Provider>]),
        );
        state.clock.set(t0());
        Self { app: build_router(state.clone()), state, spy, db }
    }

    pub fn advance(&self, days: i64) {
        self.state.clock.set(self.state.clock.now() + Duration::days(days));
    }

    pub async fn send(&self, request: Request<Body>) -> Response<Body> {
        self.app.clone().oneshot(request).await.unwrap()
    }

    pub async fn call(
        &self,
        method: Method,
        path: &str,
        cookie: Option<&str>,
        json: Option<Value>,
        headers: &[(&str, &str)],
    ) -> Res {
        let mut builder = Request::builder().method(method).uri(path);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let body = match json {
            Some(value) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = self.send(builder.body(body).unwrap()).await;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        Res { status, headers, body }
    }

    pub async fn get(&self, path: &str, cookie: &str) -> Res {
        self.call(Method::GET, path, Some(cookie), None, &[]).await
    }

    pub async fn post(&self, path: &str, cookie: &str, json: Value) -> Res {
        self.call(Method::POST, path, Some(cookie), Some(json), &[]).await
    }

    pub async fn put(&self, path: &str, cookie: &str, json: Value) -> Res {
        self.call(Method::PUT, path, Some(cookie), Some(json), &[]).await
    }

    pub async fn patch(&self, path: &str, cookie: &str, json: Value) -> Res {
        self.call(Method::PATCH, path, Some(cookie), Some(json), &[]).await
    }

    pub async fn upload(
        &self,
        path: &str,
        cookie: &str,
        filename: &str,
        mime: &str,
        data: &[u8],
        headers: &[(&str, &str)],
    ) -> Res {
        let boundary = "----hwtestboundary";
        let mut body = Vec::new();
        body.extend(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nuser_data\r\n").as_bytes(),
        );
        body.extend(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n")
                .as_bytes(),
        );
        body.extend(data);
        body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri(path)
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"));
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let response = self.send(builder.body(Body::from(body)).unwrap()).await;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        Res { status, headers, body }
    }

    pub async fn login(&self, username: &str, password: &str) -> String {
        let res = self
            .call(
                Method::POST,
                "/api/auth/login",
                None,
                Some(json!({ "username": username, "password": password })),
                &[],
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "login failed: {}", res.text());
        let cookie = res.headers[header::SET_COOKIE].to_str().unwrap();
        cookie.split(';').next().unwrap().to_string()
    }

    pub async fn create_teacher(&self, username: &str) -> String {
        ai_homework::seed::create_teacher(&self.db, username, "Teacher", Some("teacher-pass".into())).await.unwrap();
        self.login(username, "teacher-pass").await
    }

    /// Teacher + class + two students + a published homework that is open for 14 days.
    pub async fn setup_class(&self, ai: AiConfig) -> Setup {
        let teacher = self.create_teacher("teacher").await;
        let class = self.post("/api/classes", &teacher, json!({ "name": "七年级一班" })).await.json();
        let class_id = class["class"]["id"].as_str().unwrap().to_string();
        let created = self
            .post(
                &format!("/api/classes/{class_id}/students"),
                &teacher,
                json!({ "students": [{ "name": "张三", "username": "zhangsan" }, { "name": "Alice Wang" }] }),
            )
            .await
            .json();
        let students = created["credentials"].as_array().unwrap().clone();
        let now = self.state.clock.now();
        let hw = self
            .post(
                "/api/homeworks",
                &teacher,
                json!({
                    "classId": class_id,
                    "title": "一元二次方程",
                    "description": "完成课本第 3 章习题 1-5",
                    "startAt": now - Duration::days(1),
                    "dueAt": now + Duration::days(14),
                    "status": "published",
                    "allowLateSubmission": false,
                    "aiConfig": ai,
                }),
            )
            .await;
        assert_eq!(hw.status, StatusCode::OK, "create homework failed: {}", hw.text());
        let homework_id = hw.json()["homework"]["id"].as_str().unwrap().to_string();
        let student1 =
            self.login(students[0]["username"].as_str().unwrap(), students[0]["password"].as_str().unwrap()).await;
        let student2 =
            self.login(students[1]["username"].as_str().unwrap(), students[1]["password"].as_str().unwrap()).await;
        Setup { teacher, class_id, homework_id, students, student1, student2 }
    }

    pub fn chat_request(
        &self,
        cookie: &str,
        homework_id: &str,
        user_message_id: &str,
        parent: Option<&str>,
        messages: Value,
    ) -> Request<Body> {
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri("/anthropic/v1/messages")
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-hw-homework-id", homework_id)
            .header("x-hw-conversation-id", "session-1")
            .header("x-hw-user-message-id", user_message_id)
            .header("x-hw-assistant-message-id", format!("a-{user_message_id}"));
        if let Some(parent) = parent {
            builder = builder.header("x-hw-parent-message-id", parent);
        }
        let body = json!({
            "model": "deepseek-flash",
            "system": "该助手为DeepSeek，由深度求索公司创造。",
            "messages": messages,
            "thinking": { "type": "enabled" },
            "tools": [
                { "type": "deepseek_read_url", "name": "deepseek_read_url" },
                { "type": "deepseek_web_search", "name": "deepseek_web_search" }
            ],
            "safety_check": { "level": "high" },
            "title": { "enabled": true },
        });
        builder.body(Body::from(body.to_string())).unwrap()
    }

    pub async fn chat(&self, cookie: &str, homework_id: &str, text: &str) -> Res {
        self.chat_with(
            cookie,
            homework_id,
            &format!("u-{}", rand_suffix()),
            None,
            json!([{ "role": "user", "content": text }]),
        )
        .await
    }

    pub async fn chat_with(
        &self,
        cookie: &str,
        homework_id: &str,
        user_message_id: &str,
        parent: Option<&str>,
        messages: Value,
    ) -> Res {
        let response = self.send(self.chat_request(cookie, homework_id, user_message_id, parent, messages)).await;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        Res { status, headers, body }
    }
}

fn rand_suffix() -> String {
    ai_homework::ids::new_id("m")
}
