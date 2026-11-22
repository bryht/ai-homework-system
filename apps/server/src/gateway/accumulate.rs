use serde_json::{Value, json};

/// Rebuilds the complete reply from Anthropic Messages stream events, for the archive.
#[derive(Default, Debug)]
pub struct MessageAccumulator {
    blocks: Vec<Option<Value>>,
    usage: serde_json::Map<String, Value>,
    pub stop_reason: Option<String>,
    pub title: Option<String>,
    pub error: Option<String>,
    pub done: bool,
}

fn append(block: &mut Value, key: &str, extra: &str) {
    let current = block.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    block[key] = Value::String(current + extra);
}

impl MessageAccumulator {
    pub fn apply(&mut self, event: &str, data: &str) {
        let Ok(payload) = serde_json::from_str::<Value>(data) else {
            if event == "error" {
                self.error = Some(data.to_string());
            }
            return;
        };
        if event == "error" || payload.get("error").is_some() {
            self.error = Some(
                payload
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| data.into()),
            );
            return;
        }
        match payload.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(usage) = payload.pointer("/message/usage").and_then(Value::as_object) {
                    self.usage = usage.clone();
                }
            }
            Some("content_block_start") => {
                let index = payload["index"].as_u64().unwrap_or(0) as usize;
                if self.blocks.len() <= index {
                    self.blocks.resize(index + 1, None);
                }
                self.blocks[index] = Some(payload["content_block"].clone());
            }
            Some("content_block_delta") => {
                let index = payload["index"].as_u64().unwrap_or(0) as usize;
                let delta = &payload["delta"];
                let Some(Some(block)) = self.blocks.get_mut(index) else { return };
                let text = |key: &str| delta.get(key).and_then(Value::as_str).unwrap_or("");
                match delta["type"].as_str() {
                    Some("text_delta") => append(block, "text", text("text")),
                    Some("thinking_delta") => append(block, "thinking", text("thinking")),
                    Some("input_json_delta") => append(block, "partial_json", text("partial_json")),
                    Some("signature_delta") => block["signature"] = delta["signature"].clone(),
                    Some("citations_delta") => {
                        if !block.get("citations").is_some_and(Value::is_array) {
                            block["citations"] = json!([]);
                        }
                        block["citations"].as_array_mut().unwrap().push(delta["citation"].clone());
                    }
                    _ => {}
                }
            }
            Some("message_delta") => {
                if let Some(reason) = payload.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(reason.to_string());
                }
                if let Some(title) = payload.pointer("/delta/title").and_then(Value::as_str).map(str::trim)
                    && !title.is_empty()
                {
                    self.title = Some(title.to_string());
                }
                // message_delta usage is cumulative for the whole turn
                if let Some(usage) = payload.get("usage").and_then(Value::as_object) {
                    self.usage.extend(usage.clone());
                }
            }
            Some("message_stop") => self.done = true,
            _ => {}
        }
    }

    pub fn content(&self) -> Vec<Value> {
        self.blocks.iter().flatten().cloned().collect()
    }

    fn usage_of(&self, key: &str) -> i64 {
        self.usage.get(key).and_then(Value::as_i64).unwrap_or(0)
    }

    pub fn input_tokens(&self) -> i64 {
        self.usage_of("input_tokens")
            + self.usage_of("cache_read_input_tokens")
            + self.usage_of("cache_creation_input_tokens")
    }

    pub fn output_tokens(&self) -> i64 {
        self.usage_of("output_tokens")
    }
}
