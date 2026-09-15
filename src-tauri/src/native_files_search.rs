//! Bounded content search within already-owned workspace directory capabilities.
use super::*;
use crate::file_access::{AccessError, GrantId, MAX_DIRECTORY_ENTRIES};
use std::time::{Duration, Instant};

#[derive(Debug, Serialize)]
pub(crate) struct ContentSearchHit {
    path: String,
    /// One-based line number.
    line: usize,
    snippet: String,
}

#[derive(Clone, Copy)]
struct SearchLimits {
    roots: usize,
    root_bytes: usize,
    query_bytes: usize,
    depth: usize,
    entries: usize,
    files: usize,
    file_bytes: usize,
    hits: usize,
    output_bytes: usize,
    duration: Duration,
}
const SEARCH_LIMITS: SearchLimits = SearchLimits {
    roots: 32,
    root_bytes: 128 * 1024,
    query_bytes: 4096,
    depth: 50,
    entries: 50_000,
    files: 5_000,
    file_bytes: 512 * 1024,
    hits: 200,
    output_bytes: 32 * 1024 * 1024,
    duration: Duration::from_secs(4),
};
const SNIPPET_CHARS: usize = 240;
const JSON_STRING_MAX_EXPANSION: usize = 6;
const HIT_JSON_OVERHEAD: usize = 256;

fn hit_output_cost(path_bytes: usize, snippet_bytes: usize) -> Result<usize, String> {
    path_bytes
        .checked_add(snippet_bytes)
        .and_then(|bytes| bytes.checked_mul(JSON_STRING_MAX_EXPANSION))
        .and_then(|bytes| bytes.checked_add(HIT_JSON_OVERHEAD))
        .ok_or_else(|| "file_too_large".into())
}

struct SearchReader<'a> {
    access: &'a FileAccess,
    owner: &'a str,
    query: &'a str,
    limits: SearchLimits,
    start: Instant,
    remaining_entries: usize,
    remaining_files: usize,
    remaining_output: usize,
    hits: Vec<ContentSearchHit>,
}
impl SearchReader<'_> {
    fn check_time(&self) -> Result<(), String> {
        if self.start.elapsed() >= self.limits.duration {
            Err("file_too_large".into())
        } else {
            Ok(())
        }
    }
    fn directory(
        &mut self,
        grant: GrantId,
        relative: &str,
        display: &Path,
        depth: usize,
    ) -> Result<(), String> {
        self.check_time()?;
        if depth > self.limits.depth {
            return Err("file_too_large".into());
        }
        let listing = self
            .access
            .list_directory(
                self.owner,
                grant,
                Path::new(relative),
                self.remaining_entries.min(MAX_DIRECTORY_ENTRIES),
            )
            .map_err(|error| error.to_string())?;
        self.check_time()?;
        // Even omitted/hidden/non-Markdown entries consume the scan budget.
        self.remaining_entries -= listing.entries.len() + listing.omitted;
        for entry in listing.entries {
            self.check_time()?;
            if crate::is_workspace_hidden(&entry.name) {
                continue;
            }
            if !entry.is_directory && !crate::is_workspace_markdown(&entry.name) {
                continue;
            }
            let child_relative = if relative.is_empty() {
                entry.name.clone()
            } else {
                format!("{relative}/{}", entry.name)
            };
            // Display metadata never becomes a path used for host filesystem I/O.
            let child_display = display.join(&entry.name);
            if entry.is_directory {
                self.directory(grant, &child_relative, &child_display, depth + 1)?;
            } else {
                self.file(grant, &child_relative, &child_display)?;
            }
        }
        Ok(())
    }
    fn file(&mut self, grant: GrantId, relative: &str, display: &Path) -> Result<(), String> {
        self.check_time()?;
        self.remaining_files = self
            .remaining_files
            .checked_sub(1)
            .ok_or_else(|| "file_too_large".to_owned())?;
        let result = self.access.read(
            self.owner,
            grant,
            Path::new(relative),
            self.limits.file_bytes,
        );
        self.check_time()?;
        let bytes = match result {
            // Search eligibility excludes oversized files, rather than scanning
            // a misleading prefix. Other I/O errors invalidate the whole search.
            Err(AccessError::TooLarge) => return Ok(()),
            Err(error) => return Err(error.to_string()),
            Ok(bytes) => bytes,
        };
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return Ok(());
        };
        for (index, line) in text.lines().enumerate() {
            self.check_time()?;
            if !line.to_ascii_lowercase().contains(self.query) {
                continue;
            }
            // Do not stop at exactly N hits: look for N+1 to distinguish a
            // completed search from an incomplete success with missing matches.
            if self.hits.len() >= self.limits.hits {
                return Err("file_too_large".into());
            }
            let mut characters = line.trim().chars();
            let mut snippet: String = characters.by_ref().take(SNIPPET_CHARS).collect();
            if characters.next().is_some() {
                snippet.push('…');
            }
            let path = display.to_string_lossy();
            self.remaining_output = self
                .remaining_output
                .checked_sub(hit_output_cost(path.len(), snippet.len())?)
                .ok_or_else(|| "file_too_large".to_owned())?;
            self.hits.push(ContentSearchHit {
                path: path.into_owned(),
                line: index + 1,
                snippet,
            });
        }
        self.check_time()
    }
}

impl NativeState {
    fn search_content(
        &self,
        label: &str,
        generation: Uuid,
        roots: &[String],
        query: &str,
        limits: SearchLimits,
    ) -> Result<Vec<ContentSearchHit>, String> {
        let start = Instant::now();
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        if roots.len() > limits.roots || query.len() > limits.query_bytes {
            return Err("file_too_large".into());
        }
        let mut root_bytes = limits.root_bytes;
        for root in roots {
            root_bytes = root_bytes
                .checked_sub(root.len())
                .ok_or_else(|| "file_too_large".to_owned())?;
        }
        let query = query.trim().to_ascii_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        // Resolve every requested root before any filesystem I/O. Exact document
        // grants, foreign grants and renderer-restored paths cannot grant search.
        let owned_roots: Vec<_> = roots
            .iter()
            .map(|root| self.resolve_owned_path(label, root, true))
            .collect::<Result<_, _>>()?;
        let mut reader = SearchReader {
            access: &self.access,
            owner: label,
            query: &query,
            limits,
            start,
            remaining_entries: limits.entries,
            remaining_files: limits.files,
            remaining_output: limits
                .output_bytes
                .checked_sub(2) // JSON array brackets, including an empty result.
                .ok_or_else(|| "file_too_large".to_owned())?,
            hits: Vec::new(),
        };
        for (root, (grant, relative)) in roots.iter().zip(owned_roots) {
            reader.directory(grant, &relative, Path::new(root), 0)?;
        }
        reader.check_time()?;
        Ok(reader.hits)
    }
}

#[tauri::command]
pub(crate) async fn search_workspace_content(
    window: tauri::Window,
    roots: Vec<String>,
    query: String,
) -> Result<Vec<ContentSearchHit>, NativeCommandError> {
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
            .search_content(&label, generation, &roots, &query, SEARCH_LIMITS)
            .map_err(Into::into)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}

#[cfg(test)]
#[path = "native_files_search_tests.rs"]
mod tests;
