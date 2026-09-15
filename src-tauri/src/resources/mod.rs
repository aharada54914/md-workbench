//! Private transaction metadata only; no filesystem or renderer authority.
pub(crate) mod journal_frame;
pub(crate) mod journal_replay;
pub(crate) mod recovery;
pub(crate) mod transaction;

// Inactive native storage: no command or Save caller.
#[allow(dead_code)]
pub(crate) mod private_store;
