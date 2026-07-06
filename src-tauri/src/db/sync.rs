// Sync queue, server metadata, and local<->server ID mapping
use rusqlite::{params, Connection, OptionalExtension, Result};

use super::models::{SyncQueueEntry, Track};

// =============================================================================
// SYNC QUEUE & METADATA OPERATIONS
// =============================================================================

/// Enqueue a change to the sync queue.
pub fn enqueue_sync_change(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    operation: &str,
    payload: Option<&str>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload)
         VALUES (?1, ?2, ?3, ?4)",
        params![entity_type, entity_id, operation, payload],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Get all pending sync queue entries, ordered by id.
pub fn get_sync_queue(conn: &Connection) -> Result<Vec<SyncQueueEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, entity_type, entity_id, operation, payload, created_at, retry_count
         FROM sync_queue
         ORDER BY id",
    )?;

    let entries = stmt
        .query_map([], |row| {
            Ok(SyncQueueEntry {
                id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_id: row.get(2)?,
                operation: row.get(3)?,
                payload: row.get(4)?,
                created_at: row.get(5)?,
                retry_count: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(entries)
}

/// Get the count of pending sync queue entries.
pub fn get_sync_queue_count(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM sync_queue", [], |row| row.get(0))
}

/// Delete processed sync queue entries (by their IDs).
pub fn delete_sync_queue_entries(conn: &Connection, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "DELETE FROM sync_queue WHERE id IN ({})",
        placeholders.join(",")
    );
    let params: Vec<&dyn rusqlite::types::ToSql> = ids
        .iter()
        .map(|id| id as &dyn rusqlite::types::ToSql)
        .collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

/// Increment retry_count for failed sync queue entries.
pub fn increment_sync_retry(conn: &Connection, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "UPDATE sync_queue SET retry_count = retry_count + 1 WHERE id IN ({})",
        placeholders.join(",")
    );
    let params: Vec<&dyn rusqlite::types::ToSql> = ids
        .iter()
        .map(|id| id as &dyn rusqlite::types::ToSql)
        .collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

/// Clear the entire sync queue (e.g., on logout).
pub fn clear_sync_queue(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM sync_queue", [])?;
    Ok(())
}

// ─── Sync Metadata (key-value store) ────────────────────────────────────────

/// Get a sync metadata value by key.
pub fn get_sync_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM sync_metadata WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
}

/// Helper: check if user is logged in (for sync enqueuing)
pub fn is_logged_in(conn: &Connection) -> bool {
    get_sync_meta(conn, "access_token").ok().flatten().is_some()
        && get_sync_meta(conn, "user_id").ok().flatten().is_some()
}

/// Set a sync metadata value (upsert).
pub fn set_sync_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Delete a sync metadata key.
pub fn delete_sync_meta(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM sync_metadata WHERE key = ?1", params![key])?;
    Ok(())
}

/// Clear all sync metadata (e.g., on logout).
pub fn clear_sync_metadata(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM sync_metadata", [])?;
    Ok(())
}

// ─── Playlist sync helpers ──────────────────────────────────────────────────

/// Get a playlist's server_id mapping.
pub fn get_playlist_server_id(conn: &Connection, local_id: i64) -> Result<Option<String>> {
    conn.query_row(
        "SELECT server_id FROM playlists WHERE id = ?1",
        params![local_id],
        |row| row.get(0),
    )
    .optional()
}

/// Set a playlist's server_id mapping.
pub fn set_playlist_server_id(conn: &Connection, local_id: i64, server_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE playlists SET server_id = ?1 WHERE id = ?2",
        params![server_id, local_id],
    )?;
    Ok(())
}

/// Find a local playlist by its server_id.
pub fn find_playlist_by_server_id(conn: &Connection, server_id: &str) -> Result<Option<i64>> {
    conn.query_row(
        "SELECT id FROM playlists WHERE server_id = ?1",
        params![server_id],
        |row| row.get(0),
    )
    .optional()
}

/// Soft-delete a playlist (mark as deleted without removing from DB).
pub fn soft_delete_playlist(conn: &Connection, playlist_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE playlists SET deleted = 1 WHERE id = ?1",
        params![playlist_id],
    )?;
    Ok(())
}

/// Get the content_hash for a track by ID (used to identify tracks across devices).
pub fn get_track_content_hash(conn: &Connection, track_id: i64) -> Result<Option<String>> {
    conn.query_row(
        "SELECT content_hash FROM tracks WHERE id = ?1",
        params![track_id],
        |row| row.get(0),
    )
    .optional()
}

/// Get basic track info for sync payload (denormalized).
pub fn get_track_sync_info(
    conn: &Connection,
    track_id: i64,
) -> Result<
    Option<(
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i32>,
        Option<String>,
    )>,
> {
    conn.query_row(
        "SELECT COALESCE(content_hash, ''), title, artist, album, duration, cover_url
         FROM tracks WHERE id = ?1",
        params![track_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    )
    .optional()
}

// =============================================================================
// SYNC ID MAPPING (local integer IDs ↔ server UUIDs)
// =============================================================================

/// Get or create a server UUID for a local entity ID.
/// If a mapping already exists, returns it; otherwise generates a new UUID.
pub fn get_or_create_server_id(
    conn: &Connection,
    local_id: &str,
    entity_type: &str,
) -> Result<String> {
    // Check if mapping already exists
    let existing: Option<String> = conn
        .query_row(
            "SELECT server_id FROM sync_id_map WHERE local_id = ?1 AND entity_type = ?2",
            params![local_id, entity_type],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(server_id) = existing {
        return Ok(server_id);
    }

    // Generate new UUID
    let server_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO sync_id_map (local_id, entity_type, server_id) VALUES (?1, ?2, ?3)",
        params![local_id, entity_type, server_id],
    )?;

    Ok(server_id)
}

/// Get server ID for a local entity (returns None if not mapped).
pub fn get_server_id(
    conn: &Connection,
    local_id: &str,
    entity_type: &str,
) -> Result<Option<String>> {
    conn.query_row(
        "SELECT server_id FROM sync_id_map WHERE local_id = ?1 AND entity_type = ?2",
        params![local_id, entity_type],
        |row| row.get(0),
    )
    .optional()
}

/// Get local ID from server ID.
pub fn get_local_id_from_server(
    conn: &Connection,
    server_id: &str,
    entity_type: &str,
) -> Result<Option<String>> {
    conn.query_row(
        "SELECT local_id FROM sync_id_map WHERE server_id = ?1 AND entity_type = ?2",
        params![server_id, entity_type],
        |row| row.get(0),
    )
    .optional()
}

/// Store a server-to-local ID mapping (used when applying server changes).
pub fn store_id_mapping(
    conn: &Connection,
    local_id: &str,
    entity_type: &str,
    server_id: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sync_id_map (local_id, entity_type, server_id) VALUES (?1, ?2, ?3)",
        params![local_id, entity_type, server_id],
    )?;
    Ok(())
}

/// Clear all sync ID mappings (e.g., on logout).
pub fn clear_sync_id_map(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM sync_id_map", [])?;
    Ok(())
}

/// Helper: build a track hash for sync payloads (title|artist|album)
pub fn build_track_hash_str(
    title: Option<&str>,
    artist: Option<&str>,
    album: Option<&str>,
) -> String {
    format!(
        "{}|{}|{}",
        title.unwrap_or(""),
        artist.unwrap_or(""),
        album.unwrap_or("")
    )
}

/// Enqueue a library track sync change.
pub fn enqueue_track_sync_change(conn: &Connection, track: &Track, operation: &str) -> Result<()> {
    if !is_logged_in(conn) {
        return Ok(());
    }

    let track_hash = build_track_hash_str(
        track.title.as_deref(),
        track.artist.as_deref(),
        track.album.as_deref(),
    );

    let payload = serde_json::json!({
        "trackHash": track_hash,
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "duration": track.duration,
        "externalId": track.external_id,
        "sourceType": track.source_type,
        "coverUrl": track.cover_url,
        "trackNumber": track.track_number,
        "discNumber": track.disc_number,
        "format": track.format,
        "bitrate": track.bitrate,
    });

    let _ = enqueue_sync_change(
        conn,
        "library_track",
        &format!("local_lib_{}", track.id),
        operation,
        Some(&payload.to_string()),
    );

    Ok(())
}
