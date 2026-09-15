//! Strict private journal v1. Display paths are labels, never filesystem authority.
//! Stage updates record host-reported facts; this module proves no IO durability,
//! authorization, source revision CAS, or exclusion of external writers.
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

pub const JOURNAL_VERSION: u32 = 1;
pub const MAX_JOURNAL_BYTES: usize = 64 * 1024;
pub const MAX_ASSETS: usize = 64;
pub const MAX_DISPLAY_PATH_BYTES: usize = 4096;
pub const MAX_TARGET_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JournalError {
    InvalidSchema,
    UnsupportedVersion,
    LimitExceeded,
    InvalidTransition,
}
impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidSchema => "invalid journal schema",
            Self::UnsupportedVersion => "unsupported journal version",
            Self::LimitExceeded => "journal limit exceeded",
            Self::InvalidTransition => "invalid journal transition",
        })
    }
}
impl std::error::Error for JournalError {}

/// Canonical lowercase SHA-256 hex of exact bytes, without normalization.
/// Validation is structural only; the host storage adapter must compute it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct Sha256Digest(String);
impl Sha256Digest {
    pub fn parse(value: &str) -> Result<Self, JournalError> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(JournalError::InvalidSchema);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for Sha256Digest {
    type Error = JournalError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct TransactionId(String);
impl TransactionId {
    pub fn parse(value: &str) -> Result<Self, JournalError> {
        let id = Uuid::parse_str(value).map_err(|_| JournalError::InvalidSchema)?;
        if id.is_nil() || id.hyphenated().to_string() != value {
            return Err(JournalError::InvalidSchema);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for TransactionId {
    type Error = JournalError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PriorState {
    Missing,
    Hash { hash: Sha256Digest },
}

// An internally tagged unit variant silently ignores extra fields in serde.
// Use an empty struct variant on the wire to reject metadata on Missing too.
impl<'de> Deserialize<'de> for PriorState {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
        enum WirePrior {
            Missing {},
            Hash { hash: Sha256Digest },
        }
        Ok(match WirePrior::deserialize(deserializer)? {
            WirePrior::Missing {} => Self::Missing,
            WirePrior::Hash { hash } => Self::Hash { hash },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetRecord {
    display_path: String,
    prior: PriorState,
    new_hash: Sha256Digest,
    byte_len: u64,
}
impl TargetRecord {
    pub fn new(
        display_path: String,
        prior: PriorState,
        new_hash: Sha256Digest,
        byte_len: u64,
    ) -> Result<Self, JournalError> {
        let target = Self {
            display_path,
            prior,
            new_hash,
            byte_len,
        };
        target.validate()?;
        Ok(target)
    }
    fn validate(&self) -> Result<(), JournalError> {
        if self.display_path.len() > MAX_DISPLAY_PATH_BYTES || self.byte_len > MAX_TARGET_BYTES {
            return Err(JournalError::LimitExceeded);
        }
        if self.display_path.is_empty() || self.display_path.chars().any(char::is_control) {
            return Err(JournalError::InvalidSchema);
        }
        Ok(())
    }
    pub fn display_path(&self) -> &str {
        &self.display_path
    }
    pub fn prior(&self) -> &PriorState {
        &self.prior
    }
    pub fn new_hash(&self) -> &Sha256Digest {
        &self.new_hash
    }
    pub fn byte_len(&self) -> u64 {
        self.byte_len
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Stage {
    Prepared,
    AssetDurable,
    DocumentDurable,
    Completed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AssetState {
    Planned,
    Durable,
}

/// Missing prior identifies a planned new asset; Hash identifies a pre-existing
/// asset. Neither this metadata nor matching contents proves deletion ownership.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetRecord {
    target: TargetRecord,
    state: AssetState,
}
impl AssetRecord {
    pub fn new(target: TargetRecord) -> Self {
        Self {
            target,
            state: AssetState::Planned,
        }
    }
    pub fn target(&self) -> &TargetRecord {
        &self.target
    }
    pub fn state(&self) -> AssetState {
        self.state
    }
}

// Deserialize through a private wire representation so callers cannot obtain
// a JournalRecord without whole-record validation and the bounded byte parser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JournalRecord {
    version: u32,
    transaction_id: TransactionId,
    document: TargetRecord,
    assets: Vec<AssetRecord>,
    stage: Stage,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRecord {
    version: u32,
    transaction_id: TransactionId,
    document: TargetRecord,
    assets: Vec<AssetRecord>,
    stage: Stage,
}
impl JournalRecord {
    pub fn new(
        transaction_id: TransactionId,
        document: TargetRecord,
        assets: Vec<AssetRecord>,
    ) -> Result<Self, JournalError> {
        let record = Self {
            version: JOURNAL_VERSION,
            transaction_id,
            document,
            assets,
            stage: Stage::Prepared,
        };
        record.to_json()?;
        Ok(record)
    }
    pub fn parse_json(bytes: &[u8]) -> Result<Self, JournalError> {
        if bytes.len() > MAX_JOURNAL_BYTES {
            return Err(JournalError::LimitExceeded);
        }
        let wire: WireRecord =
            serde_json::from_slice(bytes).map_err(|_| JournalError::InvalidSchema)?;
        let record = Self {
            version: wire.version,
            transaction_id: wire.transaction_id,
            document: wire.document,
            assets: wire.assets,
            stage: wire.stage,
        };
        record.validate()?;
        Ok(record)
    }
    fn validate(&self) -> Result<(), JournalError> {
        if self.version != JOURNAL_VERSION {
            return Err(JournalError::UnsupportedVersion);
        }
        if self.assets.len() > MAX_ASSETS {
            return Err(JournalError::LimitExceeded);
        }
        self.document.validate()?;
        for asset in &self.assets {
            asset.target.validate()?;
        }
        if self.stage != Stage::Prepared
            && self.assets.iter().any(|a| a.state != AssetState::Durable)
        {
            return Err(JournalError::InvalidSchema);
        }
        Ok(())
    }
    pub fn to_json(&self) -> Result<Vec<u8>, JournalError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| JournalError::InvalidSchema)?;
        if bytes.len() > MAX_JOURNAL_BYTES {
            return Err(JournalError::LimitExceeded);
        }
        Ok(bytes)
    }
    pub fn id(&self) -> &TransactionId {
        &self.transaction_id
    }
    pub fn document(&self) -> &TargetRecord {
        &self.document
    }
    pub fn assets(&self) -> &[AssetRecord] {
        &self.assets
    }
    pub fn stage(&self) -> Stage {
        self.stage
    }
    /// Record an independently verified, durable asset. Does not perform IO.
    pub fn mark_asset_durable(&mut self, index: usize) -> Result<(), JournalError> {
        if self.stage != Stage::Prepared {
            return Err(JournalError::InvalidTransition);
        }
        let asset = self
            .assets
            .get_mut(index)
            .ok_or(JournalError::InvalidTransition)?;
        asset.state = AssetState::Durable;
        Ok(())
    }
    /// The caller must first finish the named durability boundary. No skipping,
    /// regression, automatic recovery update, or forced rollback is provided.
    pub fn advance(&mut self, next: Stage) -> Result<(), JournalError> {
        let allowed = match (self.stage, next) {
            (Stage::Prepared, Stage::AssetDurable) => {
                self.assets.iter().all(|a| a.state == AssetState::Durable)
            }
            (Stage::AssetDurable, Stage::DocumentDurable)
            | (Stage::DocumentDurable, Stage::Completed) => true,
            _ => false,
        };
        if !allowed {
            return Err(JournalError::InvalidTransition);
        }
        let previous = self.stage;
        self.stage = next;
        // A longer stage name must not make a formerly bounded record unwritable.
        if let Err(error) = self.to_json() {
            self.stage = previous;
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "transaction_tests.rs"]
pub(super) mod tests;
