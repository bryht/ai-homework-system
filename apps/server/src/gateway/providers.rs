use super::sse::encode;
use crate::{config::Config, models::ModelOption};
use async_trait::async_trait;
use bytes::Bytes;
use futures::{StreamExt, stream::BoxStream};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub type ByteStream = BoxStream<'static, Result<Bytes, std::io::Error>>;

/// What a provider returned for a chat request.
pub enum Upstream {
    /// A server-sent event stream in Anthropic Messages format, forwarded to the browser as-is.
    Stream(ByteStream),
    /// A non-2xx response, passed through so chat-demo can show the provider's message.
    Failed { status: u16, content_type: String, body: String },
}

pub struct UpstreamFile {
    pub data: Vec<u8>,
    pub filename: String,
    pub mime_type: String,
    /// DeepSeek Files API purpose; `None` for images.
    pub purpose: Option<&'static str>,
}

#[derive(Debug, thiserror::Error)]
#[error("upstream error {status}: {body}")]
pub struct UpstreamError {
    pub status: u16,
    pub body: String,
}

/// A model provider. The gateway only talks to this trait.
#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn models(&self) -> Vec<ModelOption>;
    async fn create_message(&self, body: Value, has_files: bool) -> anyhow::Result<Upstream>;
    async fn upload_file(&self, file: UpstreamFile) -> Result<String, UpstreamError>;
}

fn model(id: &str, label: &str, provider: &str, web_search: bool) -> ModelOption {
    ModelOption {
        id: id.into(),
        label: label.into(),
        provider: provider.into(),
        supports_thinking: true,
        supports_web_search: web_search,
        supports_files: true,
    }
}

const FILES_BETA: &str = "files-api-2025-04-14";

/// DeepSeek's Anthropic-compatible API, the same one chat-demo originally called directly.
pub struct DeepSeek {
    client: reqwest::Client,
    api_key: String,
    base: String,
}

impl DeepSeek {
    pub fn new(api_key: String, base_url: &str) -> Self {
        Self { client: reqwest::Client::new(), api_key, base: format!("{base_url}/anthropic/v1") }
    }
}

#[async_trait]
impl Provider for DeepSeek {
    fn id(&self) -> &'static str {
        "deepseek"
    }

    fn models(&self) -> Vec<ModelOption> {
        vec![
            model("deepseek-flash", "DeepSeek Flash", "deepseek", true),
            model("deepseek-v4-pro", "DeepSeek V4 Pro", "deepseek", true),
        ]
    }

    async fn create_message(&self, mut body: Value, has_files: bool) -> anyhow::Result<Upstream> {
        body["stream"] = json!(true);
        let mut request = self
            .client
            .post(format!("{}/messages", self.base))
            .header("x-api-key", &self.api_key)
            .header("accept", "text/event-stream")
            .json(&body);
        if has_files {
            request = request.header("anthropic-beta", FILES_BETA);
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            return Ok(Upstream::Failed { status: status.as_u16(), content_type, body: response.text().await? });
        }
        Ok(Upstream::Stream(response.bytes_stream().map(|r| r.map_err(std::io::Error::other)).boxed()))
    }

    async fn upload_file(&self, file: UpstreamFile) -> Result<String, UpstreamError> {
        let failed = |e: reqwest::Error| UpstreamError { status: 502, body: e.to_string() };
        let part = reqwest::multipart::Part::bytes(file.data)
            .file_name(file.filename)
            .mime_str(&file.mime_type)
            .map_err(failed)?;
        let mut form = reqwest::multipart::Form::new();
        if let Some(purpose) = file.purpose {
            form = form.text("purpose", purpose);
        }
        let response = self
            .client
            .post(format!("{}/files", self.base))
            .header("x-api-key", &self.api_key)
            .header("anthropic-beta", FILES_BETA)
            .multipart(form.part("file", part))
            .send()
            .await
            .map_err(failed)?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(failed)?;
        if !(200..300).contains(&status) {
            return Err(UpstreamError { status, body: text });
        }
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["id"].as_str().map(str::to_string))
            .ok_or(UpstreamError { status: 502, body: "upstream file upload returned no id".into() })
    }
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect(),
        _ => String::new(),
    }
}

/// Local mock model: calls nothing external and streams an explanation in Anthropic format.
/// The reply shows the teaching prompt the gateway injected, which makes configuration easy to check.
pub struct Mock {
    pub chunk_delay: Duration,
}

impl Default for Mock {
    fn default() -> Self {
        Self { chunk_delay: Duration::from_millis(15) }
    }
}

#[async_trait]
impl Provider for Mock {
    fn id(&self) -> &'static str {
        "mock"
    }

    fn models(&self) -> Vec<ModelOption> {
        vec![model("mock", "Mock (local testing)", "mock", false)]
    }

    async fn create_message(&self, body: Value, _has_files: bool) -> anyhow::Result<Upstream> {
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        let last_user = messages.iter().rev().find(|m| m["role"] == "user");
        let question = last_user.map(|m| text_of(&m["content"])).unwrap_or_default().trim().to_string();
        let file_count = last_user
            .and_then(|m| m["content"].as_array())
            .map(|blocks| blocks.iter().filter(|b| b["type"] == "image" || b["type"] == "document").count())
            .unwrap_or(0);
        let system = body["system"].as_str().unwrap_or("").to_string();
        let chinese = format!("{question}{system}").chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
        let thinking = body["thinking"]["type"] == "enabled";
        let first_line = system.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
        let quoted = if question.is_empty() {
            (if chinese { "（空）" } else { "(empty)" }).to_string()
        } else {
            question.chars().take(200).collect::<String>().replace('\n', "\n> ")
        };
        let reply = if chinese {
            let files = if file_count > 0 { format!("\n收到 {file_count} 个附件。\n") } else { String::new() };
            format!(
                "**（模拟回复）** 这是本地开发用的模拟模型，没有调用真实的 AI。\n\n你的问题：\n> {quoted}\n{files}\n\
                 网关注入的教学提示词（第一行）：「{first_line}」\n\n配置 `DEEPSEEK_API_KEY` 后，作业会使用真实的 DeepSeek 模型。"
            )
        } else {
            let files =
                if file_count > 0 { format!("\nReceived {file_count} attachment(s).\n") } else { String::new() };
            format!(
                "**(Mock reply)** This is the local mock model. No real AI was called.\n\nYour question:\n> {quoted}\n{files}\n\
                 Teaching prompt injected by the gateway (first line): \"{first_line}\"\n\n\
                 Set `DEEPSEEK_API_KEY` to use the real DeepSeek model."
            )
        };
        let input_tokens = ((system.len() + body["messages"].to_string().len()) / 3) as i64;
        let output_tokens = (reply.chars().count() / 2).max(1) as i64;
        let title = (body["title"]["enabled"] == true).then(|| {
            let t: String = question.chars().take(20).collect();
            if t.is_empty() { "New chat".to_string() } else { t }
        });
        let model = body["model"].clone();
        let delay = self.chunk_delay;

        let stream = async_stream::stream! {
            let usage = json!({ "input_tokens": input_tokens, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 });
            let mut start_usage = usage.clone();
            start_usage["output_tokens"] = json!(0);
            yield Ok(Bytes::from(encode("message_start", &json!({
                "type": "message_start",
                "message": { "id": crate::ids::new_id("msg"), "model": model, "usage": start_usage },
            }))));
            let mut index = 0;
            if thinking {
                let thought = if chinese { "模拟模型正在“思考”……" } else { "The mock model is \"thinking\"..." };
                for (name, data) in [
                    ("content_block_start", json!({ "type": "content_block_start", "index": index, "content_block": { "type": "thinking", "thinking": "", "signature": "" } })),
                    ("content_block_delta", json!({ "type": "content_block_delta", "index": index, "delta": { "type": "thinking_delta", "thinking": thought } })),
                    ("content_block_delta", json!({ "type": "content_block_delta", "index": index, "delta": { "type": "signature_delta", "signature": "mock" } })),
                    ("content_block_stop", json!({ "type": "content_block_stop", "index": index })),
                ] {
                    yield Ok(Bytes::from(encode(name, &data)));
                }
                index += 1;
            }
            yield Ok(Bytes::from(encode("content_block_start", &json!({ "type": "content_block_start", "index": index, "content_block": { "type": "text", "text": "" } }))));
            let chars: Vec<char> = reply.chars().collect();
            for piece in chars.chunks(12) {
                let text: String = piece.iter().collect();
                yield Ok(Bytes::from(encode("content_block_delta", &json!({ "type": "content_block_delta", "index": index, "delta": { "type": "text_delta", "text": text } }))));
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
            }
            yield Ok(Bytes::from(encode("content_block_stop", &json!({ "type": "content_block_stop", "index": index }))));
            let mut delta = json!({ "stop_reason": "end_turn", "stop_sequence": null });
            if let Some(title) = &title {
                delta["title"] = json!(title);
            }
            let mut end_usage = usage.clone();
            end_usage["output_tokens"] = json!(output_tokens);
            yield Ok(Bytes::from(encode("message_delta", &json!({ "type": "message_delta", "delta": delta, "usage": end_usage }))));
            yield Ok(Bytes::from(encode("message_stop", &json!({ "type": "message_stop" }))));
        };
        Ok(Upstream::Stream(stream.boxed()))
    }

    async fn upload_file(&self, _file: UpstreamFile) -> Result<String, UpstreamError> {
        Ok(crate::ids::new_id("mockfile"))
    }
}

#[derive(Clone, Default)]
pub struct ProviderRegistry {
    providers: Vec<Arc<dyn Provider>>,
}

impl ProviderRegistry {
    pub fn new(providers: Vec<Arc<dyn Provider>>) -> Self {
        Self { providers }
    }

    pub fn from_config(config: &Config) -> Self {
        let mut providers: Vec<Arc<dyn Provider>> = Vec::new();
        if let Some(key) = &config.deepseek.api_key {
            providers.push(Arc::new(DeepSeek::new(key.clone(), &config.deepseek.base_url)));
        }
        if config.enable_mock {
            providers.push(Arc::new(Mock::default()));
        }
        Self { providers }
    }

    pub fn models(&self) -> Vec<ModelOption> {
        self.providers.iter().flat_map(|p| p.models()).collect()
    }

    pub fn for_model(&self, model: &str) -> Option<Arc<dyn Provider>> {
        self.providers.iter().find(|p| p.models().iter().any(|m| m.id == model)).cloned()
    }
}
