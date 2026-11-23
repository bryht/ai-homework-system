use std::{env, path::PathBuf};

#[derive(Clone, Debug)]
pub struct DeepSeekConfig {
    pub api_key: Option<String>,
    pub base_url: String,
}

/// Ollama (ollama.com, or a self-hosted server): every model on the account is offered to teachers.
#[derive(Clone, Debug)]
pub struct OllamaConfig {
    pub api_key: Option<String>,
    pub base_url: String,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    /// Uploaded files live under `<data_dir>/uploads`.
    pub data_dir: PathBuf,
    /// Built frontend (`apps/web/dist`), served from the same origin as the API.
    pub web_dist: PathBuf,
    /// IANA time zone used to count "active days".
    pub timezone: String,
    pub session_days: i64,
    pub cookie_secure: bool,
    pub deepseek: DeepSeekConfig,
    pub ollama: OllamaConfig,
    /// The mock model is enabled automatically when no real model is configured.
    pub enable_mock: bool,
    /// Origins allowed to call the API from another site, e.g. `https://bryht.github.io` for GitHub Pages.
    pub cors_origins: Vec<String>,
}

fn var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.trim().is_empty())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let production = var("APP_ENV").as_deref() == Some("production");
        let api_key = var("DEEPSEEK_API_KEY");
        let ollama_key = var("OLLAMA_API_KEY");
        let has_real_model = api_key.is_some() || ollama_key.is_some();
        Ok(Self {
            port: var("PORT").map(|p| p.parse()).transpose()?.unwrap_or(8787),
            database_url: var("DATABASE_URL").ok_or_else(|| {
                anyhow::anyhow!("DATABASE_URL is not set (e.g. postgres://homework:homework@localhost:5432/homework)")
            })?,
            data_dir: PathBuf::from(var("DATA_DIR").unwrap_or_else(|| "./data".into())),
            web_dist: PathBuf::from(var("WEB_DIST").unwrap_or_else(|| "../web/dist".into())),
            timezone: var("APP_TIMEZONE").unwrap_or_else(|| "UTC".into()),
            session_days: var("SESSION_DAYS").map(|d| d.parse()).transpose()?.unwrap_or(14),
            cookie_secure: var("COOKIE_SECURE").map(|v| v == "true").unwrap_or(production),
            enable_mock: var("ENABLE_MOCK_AI").map(|v| v == "true").unwrap_or(!has_real_model),
            cors_origins: var("CORS_ORIGINS")
                .map(|v| {
                    v.split(',').map(|o| o.trim().trim_end_matches('/').to_string()).filter(|o| !o.is_empty()).collect()
                })
                .unwrap_or_default(),
            deepseek: DeepSeekConfig {
                api_key,
                base_url: var("DEEPSEEK_BASE_URL")
                    .unwrap_or_else(|| "https://api.deepseek.com".into())
                    .trim_end_matches('/')
                    .to_string(),
            },
            ollama: OllamaConfig {
                api_key: ollama_key,
                base_url: var("OLLAMA_BASE_URL")
                    .unwrap_or_else(|| "https://ollama.com".into())
                    .trim_end_matches('/')
                    .to_string(),
            },
        })
    }

    /// Settings for tests: everything local, mock model only.
    pub fn for_tests(database_url: String) -> Self {
        Self {
            port: 0,
            database_url,
            data_dir: PathBuf::from("/nonexistent"),
            web_dist: PathBuf::from("/nonexistent"),
            timezone: "UTC".into(),
            session_days: 365,
            cookie_secure: false,
            deepseek: DeepSeekConfig { api_key: None, base_url: String::new() },
            ollama: OllamaConfig { api_key: None, base_url: String::new() },
            enable_mock: true,
            cors_origins: vec!["https://school.github.io".into()],
        }
    }
}
