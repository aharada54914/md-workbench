//! Caller-owned subscriptions for bounded polling reads, not OS notifications.
use super::*;
use crate::file_access::GrantId;

const MAX_WATCHES_PER_WINDOW: usize = 128;
const MAX_WATCH_PATH_BYTES: usize = 1024 * 1024;
const MAX_WATCH_READ_BYTES: usize = 64 * 1024 * 1024;

pub(super) struct WatchSubscription {
    pub(super) owner: String,
    generation: Uuid,
    path: String,
    grant: GrantId,
    relative: String,
    reading: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeWatch {
    id: String,
    grant_id: String,
}

impl NativeState {
    fn subscribe_watch(
        &mut self,
        label: &str,
        generation: Uuid,
        path: &str,
        expected_grant_id: &str,
    ) -> Result<NativeWatch, String> {
        self.subscribe_watch_bounded(
            label,
            generation,
            path,
            expected_grant_id,
            MAX_WATCHES_PER_WINDOW,
            MAX_WATCH_PATH_BYTES,
        )
    }

    fn subscribe_watch_bounded(
        &mut self,
        label: &str,
        generation: Uuid,
        path: &str,
        expected_grant_id: &str,
        max_count: usize,
        max_bytes: usize,
    ) -> Result<NativeWatch, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        if path.len() > max_bytes {
            return Err("watch_limit_exceeded".into());
        }
        let (grant, relative) =
            self.resolve_expected_owned_path(label, path, false, Some(expected_grant_id))?;
        let mut count = 0;
        let mut bytes = path
            .len()
            .checked_add(relative.len())
            .ok_or("watch_limit_exceeded")?;
        for subscription in self.watches.values().filter(|entry| entry.owner == label) {
            count += 1;
            bytes = bytes
                .checked_add(subscription.path.len())
                .and_then(|size| size.checked_add(subscription.relative.len()))
                .ok_or("watch_limit_exceeded")?;
        }
        if count >= max_count || bytes > max_bytes {
            return Err("watch_limit_exceeded".into());
        }
        self.access
            .validate_regular_document(label, grant, Path::new(&relative))
            .map_err(|error| error.to_string())?;
        let id = Uuid::new_v4();
        self.watches.insert(
            id,
            WatchSubscription {
                owner: label.into(),
                generation,
                path: path.into(),
                grant,
                relative,
                reading: false,
            },
        );
        Ok(NativeWatch {
            id: id.to_string(),
            grant_id: grant.to_string(),
        })
    }

    fn check_watch(
        &self,
        label: &str,
        generation: Uuid,
        id: Uuid,
    ) -> Result<&WatchSubscription, String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        self.watches
            .get(&id)
            .filter(|subscription| {
                subscription.owner == label && subscription.generation == generation
            })
            .ok_or_else(|| "permission_required".into())
    }

    fn validate_watch_binding(
        &self,
        label: &str,
        generation: Uuid,
        id: Uuid,
    ) -> Result<(), String> {
        let subscription = self.check_watch(label, generation, id)?;
        let current = self.resolve_owned_path(label, &subscription.path, false)?;
        if current.0 != subscription.grant || current.1 != subscription.relative {
            return Err("permission_required".into());
        }
        // Do not read by token alone or resurrect revoked core authority.
        let info = self
            .access
            .describe(label, subscription.grant)
            .map_err(|error| error.to_string())?;
        if !info.rights.can_read()
            || !matches!(info.kind, GrantKind::Document | GrantKind::Workspace)
        {
            return Err("permission_required".into());
        }
        Ok(())
    }

    fn begin_watch_read(
        &mut self,
        label: &str,
        generation: Uuid,
        id: Uuid,
        limit: usize,
    ) -> Result<(), String> {
        self.check_watch(label, generation, id)?;
        if let Err(error) = self.validate_watch_binding(label, generation, id) {
            self.watches.remove(&id);
            return Err(error);
        }
        if limit == 0 || limit > MAX_WATCH_READ_BYTES {
            return Err("file_too_large".into());
        }
        let subscription = self.watches.get_mut(&id).ok_or("permission_required")?;
        if subscription.reading {
            return Err("watch_busy".into());
        }
        subscription.reading = true;
        Ok(())
    }

    fn read_watch(
        &mut self,
        label: &str,
        generation: Uuid,
        id: Uuid,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        self.check_watch(label, generation, id)?;
        if let Err(error) = self.validate_watch_binding(label, generation, id) {
            self.watches.remove(&id);
            return Err(error);
        }
        let subscription = self.watches.get(&id).ok_or("permission_required")?;
        if !subscription.reading {
            return Err("permission_required".into());
        }
        let result = self
            .access
            .validate_regular_document(label, subscription.grant, Path::new(&subscription.relative))
            .and_then(|()| {
                self.access.read(
                    label,
                    subscription.grant,
                    Path::new(&subscription.relative),
                    limit,
                )
            })
            .map_err(|error| error.to_string());
        if matches!(
            result.as_ref().err().map(String::as_str),
            Some("permission_required" | "invalid_grant_kind")
        ) {
            self.watches.remove(&id);
        } else if let Some(subscription) = self.watches.get_mut(&id) {
            subscription.reading = false;
        }
        result
    }

    fn unsubscribe_watch(&mut self, label: &str, generation: Uuid, id: Uuid) -> Result<(), String> {
        if self.generation(label)? != generation {
            return Err("permission_required".into());
        }
        // Unknown, removed and foreign tokens produce the same result. Never
        // remove another owner's token and never retain cancellation tombstones.
        if self
            .watches
            .get(&id)
            .is_some_and(|entry| entry.owner == label && entry.generation == generation)
        {
            self.watches.remove(&id);
        }
        Ok(())
    }
}

fn parse_watch_id(id: &str) -> Result<Uuid, NativeCommandError> {
    Uuid::parse_str(id).map_err(|_| NativeCommandError::from("permission_required"))
}

#[tauri::command]
pub(crate) async fn native_watch_subscribe(
    window: tauri::Window,
    path: String,
    expected_grant_id: String,
) -> Result<NativeWatch, NativeCommandError> {
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
            .subscribe_watch(&label, generation, &path, &expected_grant_id)
            .map_err(Into::into)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}

#[tauri::command]
pub(crate) async fn native_watch_read(
    window: tauri::Window,
    id: String,
    limit: usize,
) -> Result<Vec<u8>, NativeCommandError> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let id = parse_watch_id(&id)?;
    let generation = {
        let managed = app.state::<NativeFiles>();
        let mut state = managed.0.lock().map_err(|_| "native_state_unavailable")?;
        let generation = state.generation(&label)?;
        // Reserve before dispatch, so overlapping requests cannot accumulate
        // blocking tasks for this token. Spawned work runs even if its awaiter
        // disappears; teardown still revokes the token before its actual read.
        state.begin_watch_read(&label, generation, id, limit)?;
        generation
    };
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeFiles>()
            .0
            .lock()
            .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
            .read_watch(&label, generation, id, limit)
            .map_err(Into::into)
    })
    .await
    .map_err(|_| NativeCommandError::from("native_state_unavailable"))?
}

#[tauri::command]
pub(crate) fn native_watch_unsubscribe(
    window: tauri::Window,
    id: String,
) -> Result<(), NativeCommandError> {
    let id = parse_watch_id(&id)?;
    let managed = window.state::<NativeFiles>();
    let mut state = managed.0.lock().map_err(|_| "native_state_unavailable")?;
    let generation = state.generation(window.label())?;
    state
        .unsubscribe_watch(window.label(), generation, id)
        .map_err(Into::into)
}

#[cfg(test)]
#[path = "native_files_watch_tests.rs"]
mod tests;
