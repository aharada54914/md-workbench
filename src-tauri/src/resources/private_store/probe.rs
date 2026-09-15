//! Explicit diagnostic seams only. No process, environment, path or IPC operations.
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Boundary {
    Bootstrap,
    PartialAppend,
    FlushedBeforeAck,
    AfterAck,
}
pub const FIRST_FRAGMENT: usize = 17;
type Callback = fn(Boundary, Option<&str>);
static CALLBACK: OnceLock<Callback> = OnceLock::new();
pub fn install(callback: Callback) -> Result<(), Callback> {
    CALLBACK.set(callback)
}
pub(super) fn write_limit(offset: u64, length: usize) -> usize {
    if CALLBACK.get().is_some() && offset < FIRST_FRAGMENT as u64 {
        length.min(FIRST_FRAGMENT - offset as usize)
    } else {
        length
    }
}
pub fn notify(boundary: Boundary, identifier: Option<&str>) {
    if let Some(callback) = CALLBACK.get() {
        callback(boundary, identifier);
    }
}
