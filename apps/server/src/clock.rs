use chrono::{DateTime, Utc};
use std::sync::Mutex;

/// Wall clock that tests can pin to a fixed time to exercise homework windows.
#[derive(Default)]
pub struct Clock {
    fixed: Mutex<Option<DateTime<Utc>>>,
}

impl Clock {
    pub fn now(&self) -> DateTime<Utc> {
        self.fixed.lock().unwrap().unwrap_or_else(Utc::now)
    }

    pub fn set(&self, at: DateTime<Utc>) {
        *self.fixed.lock().unwrap() = Some(at);
    }
}
