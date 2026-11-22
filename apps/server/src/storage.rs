use async_trait::async_trait;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Storage for uploaded files. Local disk (a Docker volume) is enough for the pilot;
/// an S3-compatible backend can implement the same trait later.
#[async_trait]
pub trait Storage: Send + Sync {
    async fn put(&self, key: &str, data: &[u8]) -> anyhow::Result<()>;
    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>>;
}

pub struct DiskStorage {
    root: PathBuf,
}

impl DiskStorage {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn resolve(&self, key: &str) -> anyhow::Result<PathBuf> {
        let relative = Path::new(key);
        anyhow::ensure!(
            relative.components().all(|c| matches!(c, std::path::Component::Normal(_))),
            "invalid storage key: {key}"
        );
        Ok(self.root.join(relative))
    }
}

#[async_trait]
impl Storage for DiskStorage {
    async fn put(&self, key: &str, data: &[u8]) -> anyhow::Result<()> {
        let path = self.resolve(key)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(path, data).await?;
        Ok(())
    }

    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        Ok(tokio::fs::read(self.resolve(key)?).await?)
    }
}

#[derive(Default)]
pub struct MemoryStorage {
    blobs: Mutex<HashMap<String, Vec<u8>>>,
}

#[async_trait]
impl Storage for MemoryStorage {
    async fn put(&self, key: &str, data: &[u8]) -> anyhow::Result<()> {
        self.blobs.lock().unwrap().insert(key.to_string(), data.to_vec());
        Ok(())
    }

    async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        self.blobs.lock().unwrap().get(key).cloned().ok_or_else(|| anyhow::anyhow!("missing file: {key}"))
    }
}
