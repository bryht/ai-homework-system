/// One complete server-sent event.
#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// Incremental SSE parser. The gateway forwards raw bytes to the browser and uses this
/// to rebuild the full reply for the archive. Works on bytes, so UTF-8 split across
/// network chunks is fine.
#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buffer.extend(chunk.iter().copied().filter(|b| *b != b'\r'));
        let mut events = Vec::new();
        while let Some(pos) = self.buffer.windows(2).position(|w| w == b"\n\n") {
            let raw: Vec<u8> = self.buffer.drain(..pos + 2).collect();
            if let Some(event) = parse_event(&String::from_utf8_lossy(&raw[..pos])) {
                events.push(event);
            }
        }
        events
    }
}

fn parse_event(raw: &str) -> Option<SseEvent> {
    let mut event = "message".to_string();
    let mut data = Vec::new();
    for line in raw.lines() {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => event = value.to_string(),
            "data" => data.push(value),
            _ => {}
        }
    }
    (!data.is_empty()).then(|| SseEvent { event, data: data.join("\n") })
}

pub fn encode(event: &str, data: &serde_json::Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_split_across_chunks() {
        let mut parser = SseParser::default();
        // Multi-byte UTF-8 (2- and 3-byte characters) split across chunks.
        let text = "event: a\ndata: {\"x\":\"café ✓\"}\r\n\r\n: keepalive\n\nevent: b\ndata: 1\ndata: 2\n\n";
        let bytes = text.as_bytes();
        let mut events = Vec::new();
        for chunk in bytes.chunks(3) {
            events.extend(parser.feed(chunk));
        }
        assert_eq!(
            events,
            vec![
                SseEvent { event: "a".into(), data: "{\"x\":\"café ✓\"}".into() },
                SseEvent { event: "b".into(), data: "1\n2".into() },
            ]
        );
    }
}
