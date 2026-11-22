//! AI Homework System server: REST API for teachers and students, plus an
//! Anthropic-compatible AI gateway that enforces each homework's AI settings
//! and records every conversation turn.

pub mod access;
pub mod app;
pub mod auth;
pub mod clock;
pub mod config;
pub mod error;
pub mod gateway;
pub mod ids;
pub mod models;
pub mod routes;
pub mod seed;
pub mod stats;
pub mod storage;

pub use app::{AppState, build_router};
