//! Workspace trees read only through an existing caller-owned directory grant.
use super::*;
use crate::file_access::{GrantId, MAX_DIRECTORY_ENTRIES};

const WORKSPACE_TREE_MAX_DEPTH: usize = 50;
const WORKSPACE_TREE_MAX_ENTRIES: usize = 50_000;
const WORKSPACE_TREE_MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
// JSON may escape one input byte as six bytes (\uXXXX). This allowance also
// covers keys, kind, null/array punctuation, separators and a full u64 mtime.
const JSON_STRING_MAX_EXPANSION: usize = 6;
const NODE_JSON_OVERHEAD: usize = 256;

fn node_output_cost(name_bytes: usize, path_bytes: usize) -> Result<usize, String> {
    name_bytes
        .checked_add(path_bytes)
        .and_then(|bytes| bytes.checked_mul(JSON_STRING_MAX_EXPANSION))
        .and_then(|bytes| bytes.checked_add(NODE_JSON_OVERHEAD))
        .ok_or_else(|| "file_too_large".into())
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceNode {
    name: String,
    path: String,
    kind: &'static str,
    children: Option<Vec<WorkspaceNode>>,
    /// Milliseconds since the Unix epoch; 0 when unavailable.
    modified: u64,
}

fn is_workspace_visible(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    crate::is_workspace_markdown(name)
        || [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp"]
            .iter()
            .any(|extension| lower.ends_with(extension))
}

struct TreeReader<'a> {
    access: &'a FileAccess,
    owner: &'a str,
    grant: GrantId,
    remaining: usize,
    max_depth: usize,
    remaining_output_bytes: usize,
}
impl TreeReader<'_> {
    fn reserve_node(&mut self, name: &str, path: &str) -> Result<(), String> {
        self.remaining_output_bytes = self
            .remaining_output_bytes
            .checked_sub(node_output_cost(name.len(), path.len())?)
            .ok_or_else(|| "file_too_large".to_owned())?;
        Ok(())
    }
    fn directory(
        &mut self,
        relative: &str,
        display: &Path,
        depth: usize,
    ) -> Result<WorkspaceNode, String> {
        if depth > self.max_depth {
            return Err("file_too_large".into());
        }
        let path = display.to_string_lossy();
        let name = display
            .file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_else(|| path.clone());
        // Charge the root/directory before reading children or constructing its
        // DTO; every child has its own reservation before insertion.
        self.reserve_node(&name, &path)?;
        let listing = self
            .access
            .list_directory(
                self.owner,
                self.grant,
                Path::new(relative),
                self.remaining.min(MAX_DIRECTORY_ENTRIES),
            )
            .map_err(|error| error.to_string())?;
        // Count omitted, hidden and non-document entries before applying UI
        // filters, so wide irrelevant subtrees cannot bypass the global bound.
        self.remaining -= listing.entries.len() + listing.omitted;
        let mut entries = listing.entries;
        entries.retain(|entry| {
            !crate::is_workspace_hidden(&entry.name)
                && (entry.is_directory || is_workspace_visible(&entry.name))
        });
        entries.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then_with(|| {
                    a.name
                        .to_ascii_lowercase()
                        .cmp(&b.name.to_ascii_lowercase())
                })
                .then_with(|| a.name.cmp(&b.name))
        });
        let mut children = Vec::new();
        for entry in entries {
            // This path is display/routing metadata only. Host I/O always uses
            // the clean relative string and the original retained grant below.
            let child_display = display.join(&entry.name);
            if entry.is_directory {
                let child_relative = if relative.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{relative}/{}", entry.name)
                };
                children.push(self.directory(&child_relative, &child_display, depth + 1)?);
            } else {
                let child_path = child_display.to_string_lossy();
                self.reserve_node(&entry.name, &child_path)?;
                children.push(WorkspaceNode {
                    name: entry.name,
                    path: child_path.into_owned(),
                    kind: "file",
                    children: None,
                    modified: entry.modified,
                });
            }
        }
        Ok(WorkspaceNode {
            name: name.into_owned(),
            path: path.into_owned(),
            kind: "folder",
            children: Some(children),
            modified: listing.modified,
        })
    }
}
impl NativeState {
    fn workspace_tree(
        &self,
        label: &str,
        generation: Uuid,
        root: &str,
        max_depth: usize,
        max_entries: usize,
        output_budget: usize,
    ) -> Result<WorkspaceNode, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        let (grant, relative) = self.resolve_owned_path(label, root, true)?;
        TreeReader {
            access: &self.access,
            owner: label,
            grant,
            remaining: max_entries,
            max_depth,
            remaining_output_bytes: output_budget,
        }
        .directory(&relative, Path::new(root), 0)
    }
}

#[tauri::command]
pub(crate) async fn read_workspace_tree(
    window: tauri::Window,
    root: String,
) -> Result<WorkspaceNode, NativeCommandError> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let generation = app
        .state::<NativeFiles>()
        .0
        .lock()
        .map_err(|_| "native_state_unavailable")?
        .generation(&label)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeFiles>()
            .0
            .lock()
            .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
            .workspace_tree(
                &label,
                generation,
                &root,
                WORKSPACE_TREE_MAX_DEPTH,
                WORKSPACE_TREE_MAX_ENTRIES,
                WORKSPACE_TREE_MAX_OUTPUT_BYTES,
            )
            .map_err(Into::into)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}

#[cfg(test)]
#[path = "native_files_workspace_tests.rs"]
mod tests;
