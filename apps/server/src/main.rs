use ai_homework::{
    AppState, build_router, config::Config, gateway::providers::ProviderRegistry, seed, storage::DiskStorage,
};
use clap::{Parser, Subcommand};
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "ai-homework", about = "AI Homework System server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the web server (default)
    Serve,
    /// Apply database migrations and exit
    Migrate,
    /// Create demo accounts and a sample homework (password: demo1234)
    Seed,
    /// Create a teacher account
    CreateTeacher {
        #[arg(long)]
        username: String,
        #[arg(long)]
        name: String,
        /// Generated and printed when omitted
        #[arg(long)]
        password: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::from_filename("../../.env").or_else(|_| dotenvy::dotenv());
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();
    let cli = Cli::parse();
    let config = Config::from_env()?;
    let db = PgPoolOptions::new().max_connections(10).connect(&config.database_url).await?;
    sqlx::migrate!("./migrations").run(&db).await?;

    match cli.command.unwrap_or(Command::Serve) {
        Command::Migrate => println!("Migrations applied."),
        Command::Seed => {
            if seed::seed_demo(&db).await? {
                println!(
                    "Demo data created. Accounts: teacher / student1 / student2 / student3, password {}",
                    seed::DEMO_PASSWORD
                );
            } else {
                println!("Demo data already exists. Accounts: teacher / student1..3, password {}", seed::DEMO_PASSWORD);
            }
        }
        Command::CreateTeacher { username, name, password } => {
            let shown = password.is_none();
            let password = seed::create_teacher(&db, &username, &name, password).await?;
            println!("Teacher created: {username}");
            if shown {
                println!("Password: {password}");
            }
        }
        Command::Serve => {
            let providers = ProviderRegistry::from_config(&config);
            let storage = Arc::new(DiskStorage::new(config.data_dir.join("uploads")));
            let models: Vec<String> = providers.models().into_iter().map(|m| m.id).collect();
            let port = config.port;
            let web = config.web_dist.display().to_string();
            let state = AppState::new(db, config, storage, providers);
            let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
            tracing::info!("AI Homework server listening on http://localhost:{port}");
            tracing::info!("models: {}", if models.is_empty() { "(none)".into() } else { models.join(", ") });
            tracing::info!("web: {web}");
            axum::serve(listener, build_router(state)).with_graceful_shutdown(shutdown()).await?;
        }
    }
    Ok(())
}

async fn shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    let term = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}
