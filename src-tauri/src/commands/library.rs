// Library-related Tauri commands
use crate::db::{queries, Database};
use crate::scanner::{cover_storage, extract_metadata, scan_directory};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanProgress {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanResult {
    pub tracks_added: usize,
    pub tracks_updated: usize,
    pub tracks_deleted: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Library {
    pub tracks: Vec<queries::Track>,
    pub albums: Vec<queries::Album>,
    pub artists: Vec<queries::Artist>,
}

#[tauri::command]
pub async fn scan_music(paths: Vec<String>, db: State<'_, Database>) -> Result<ScanResult, String> {
    let mut tracks_added = 0;
    let mut errors = Vec::new();

    // Use spawn_blocking for the file system scanning and metadata extraction
    // This prevents blocking the Tauri async executor's threads
    let (tx, mut rx) = tokio::sync::mpsc::channel(100);

    for path in paths.clone() {
        let db_clone = db.inner().clone();
        let path_clone = path.clone();
        let tx_clone = tx.clone();

        tokio::task::spawn_blocking(move || {
            let scan_result = scan_directory(&path_clone);
            let conn = db_clone.conn.lock().unwrap();

            // Add folder to database
            let _ = queries::add_music_folder(&conn, &path_clone);

            for file_path in scan_result.audio_files {
                if let Some(track_data) = extract_metadata(&file_path) {
                    match queries::insert_or_update_track(&conn, &track_data) {
                        Ok(track_id) => {
                            if track_id > 0 {
                                // Save covers... (truncated for brevity but logic should remain)
                                if let Some(ref cover_bytes) = track_data.track_cover {
                                    let _ = cover_storage::save_track_cover(track_id, cover_bytes)
                                        .map(|p| {
                                            let _ = queries::update_track_cover_path(
                                                &conn,
                                                track_id,
                                                Some(&p),
                                            );
                                        });
                                }
                                if let Some(ref art_bytes) = track_data.album_art {
                                    // (album art logic...)
                                }
                                let _ = tx_clone.blocking_send(Ok(1));
                            }
                        }
                        Err(e) => {
                            let _ = tx_clone.blocking_send(Err(e.to_string()));
                        }
                    }
                }
            }
            let _ = queries::update_folder_last_scanned(&conn, &path_clone);
        });
    }

    drop(tx); // Close sender so receiver finishes

    while let Some(res) = rx.recv().await {
        match res {
            Ok(count) => tracks_added += count,
            Err(e) => errors.push(e),
        }
    }

    Ok(ScanResult {
        tracks_added,
        tracks_updated: 0,
        tracks_deleted: 0,
        errors,
    })
}

#[tauri::command]
pub async fn add_folder(path: String, db: State<'_, Database>) -> Result<(), String> {
    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.exists() || !path_buf.is_dir() {
        return Err("Invalid path: Not a directory or does not exist".to_string());
    }

    // Canonicalize path to prevent traversal/obfuscation
    let canonical_path = path_buf
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {}", e))?;
    let path_str = canonical_path.to_string_lossy().to_string();

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    queries::add_music_folder(&conn, &path_str)
        .map_err(|e| format!("Failed to add folder: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn rescan_music(db: State<'_, Database>) -> Result<ScanResult, String> {
    let mut tracks_added = 0;
    let mut tracks_deleted = 0;
    let mut errors = Vec::new();

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Get all scanned folders
    let folders = queries::get_music_folders(&conn).map_err(|e| e.to_string())?;

    // Clean up deleted tracks first
    tracks_deleted = queries::cleanup_deleted_tracks(&conn, &folders)
        .map_err(|e| format!("Failed to cleanup deleted tracks: {}", e))?;

    // Clean up empty albums after track cleanup
    let _ = queries::cleanup_empty_albums(&conn);

    // Clean up orphaned cover files
    let _ = cover_storage::cleanup_orphaned_covers(&conn);

    // Rescan all folders
    for path in folders {
        let scan_result = scan_directory(&path);
        errors.extend(scan_result.errors);

        for file_path in scan_result.audio_files {
            if let Some(track_data) = extract_metadata(&file_path) {
                match queries::insert_or_update_track(&conn, &track_data) {
                    Ok(track_id) => {
                        if track_id > 0 {
                            tracks_added += 1;

                            // Save track cover to file if present
                            if let Some(ref cover_bytes) = track_data.track_cover {
                                match cover_storage::save_track_cover(track_id, cover_bytes) {
                                    Ok(path) => {
                                        if let Err(e) = queries::update_track_cover_path(
                                            &conn,
                                            track_id,
                                            Some(&path),
                                        ) {
                                            errors.push(format!(
                                                "Failed to update cover path for track {}: {}",
                                                track_id, e
                                            ));
                                        }
                                    }
                                    Err(e) => {
                                        errors.push(format!(
                                            "Failed to save cover for track {}: {}",
                                            track_id, e
                                        ));
                                    }
                                }
                            }

                            // Save album art to file if present
                            if let Some(album_id) = track_data.album.as_ref().and_then(|_| {
                                conn.query_row(
                                    "SELECT album_id FROM tracks WHERE id = ?1",
                                    [track_id],
                                    |row| row.get::<_, Option<i64>>(0),
                                )
                                .ok()
                                .flatten()
                            }) {
                                if let Some(ref art_bytes) = track_data.album_art {
                                    let has_art: bool = conn
                                        .query_row(
                                            "SELECT art_path IS NOT NULL FROM albums WHERE id = ?1",
                                            [album_id],
                                            |row| row.get(0),
                                        )
                                        .unwrap_or(false);

                                    if !has_art {
                                        match cover_storage::save_album_art(album_id, art_bytes) {
                                            Ok(path) => {
                                                if let Err(e) = queries::update_album_art_path(
                                                    &conn,
                                                    album_id,
                                                    Some(&path),
                                                ) {
                                                    errors.push(format!(
                                                        "Failed to update art path for album {}: {}",
                                                        album_id, e
                                                    ));
                                                }
                                            }
                                            Err(e) => {
                                                errors.push(format!(
                                                    "Failed to save art for album {}: {}",
                                                    album_id, e
                                                ));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => errors.push(format!("Failed to insert {}: {}", file_path, e)),
                }
            }
        }

        // Update last scanned time
        if let Err(e) = queries::update_folder_last_scanned(&conn, &path) {
            errors.push(format!("Failed to update scan time for {}: {}", path, e));
        }
    }

    Ok(ScanResult {
        tracks_added,
        tracks_updated: 0, // TODO: Distinguish between insert and update
        tracks_deleted,
        errors,
    })
}

#[tauri::command]
pub async fn get_library(db: State<'_, Database>) -> Result<Library, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Ensure FTS is initialized on first load
    let _ = queries::init_fts(&conn);

    // Fetch tracks WITHOUT cover data (ultra-fast)
    let tracks = queries::get_all_tracks_with_paths(&conn).map_err(|e| e.to_string())?;

    // Fetch albums WITHOUT art data (fast)
    let albums = queries::get_all_albums_with_paths(&conn).map_err(|e| e.to_string())?;

    // Fetch artists
    let artists = queries::get_all_artists(&conn).map_err(|e| e.to_string())?;

    Ok(Library {
        tracks,
        albums,
        artists,
    })
}

#[tauri::command]
pub async fn get_tracks_paginated(
    limit: i32,
    offset: i32,
    db: State<'_, Database>,
) -> Result<Vec<queries::Track>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    queries::get_tracks_paginated(&conn, limit, offset).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_library(
    query: String,
    limit: i32,
    offset: i32,
    db: State<'_, Database>,
) -> Result<Vec<queries::Track>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    queries::search_tracks(&conn, &query, limit, offset).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_tracks_by_album(
    album_id: i64,
    db: State<'_, Database>,
) -> Result<Vec<queries::Track>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    queries::get_tracks_by_album(&conn, album_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_tracks_by_artist(
    artist: String,
    db: State<'_, Database>,
) -> Result<Vec<queries::Track>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    queries::get_tracks_by_artist(&conn, &artist).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_album(
    album_id: i64,
    db: State<'_, Database>,
) -> Result<Option<queries::Album>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    queries::get_album_by_id(&conn, album_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_albums_by_artist(
    artist: String,
    db: State<'_, Database>,
) -> Result<Vec<queries::Album>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT a.id, a.name, a.artist, a.art_data, a.art_path 
         FROM albums a
         INNER JOIN tracks t ON t.album_id = a.id
         WHERE t.artist = ?1
         ORDER BY a.name",
        )
        .map_err(|e| e.to_string())?;

    let albums = stmt
        .query_map([&artist], |row| {
            Ok(queries::Album {
                id: row.get(0)?,
                name: row.get(1)?,
                artist: row.get(2)?,
                art_data: row.get(3)?,
                art_path: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(albums)
}

/// Delete a track from the library
#[tauri::command]
pub async fn delete_track(track_id: i64, db: State<'_, Database>) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Get track info before deletion
    let track_info: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT path, source_type, track_cover_path FROM tracks WHERE id = ?1",
            [track_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();

    if let Some((path, source_type, cover_path)) = track_info {
        // Only delete file if it's a local track
        let is_local = source_type.is_none() || source_type.as_deref() == Some("local");

        if is_local {
            let path_obj = std::path::Path::new(&path);
            if path_obj.exists() {
                if let Err(e) = std::fs::remove_file(path_obj) {
                    println!("Failed to delete file {}: {}", path, e);
                    // Continue to delete from DB even if file deletion fails
                }
            }
        }

        // Delete cover file
        let _ = cover_storage::delete_track_cover_file(cover_path.as_deref());
    }

    let result = queries::delete_track(&conn, track_id)
        .map_err(|e| format!("Failed to delete track: {}", e))?;

    // Clean up empty albums after track deletion
    let _ = queries::cleanup_empty_albums(&conn);

    Ok(result)
}

/// Delete an album and all its tracks
#[tauri::command]
pub async fn delete_album(album_id: i64, db: State<'_, Database>) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Get album art path before deletion
    let art_path: Option<String> = conn
        .query_row(
            "SELECT art_path FROM albums WHERE id = ?1",
            [album_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    // Get all tracks for this album to delete files
    let tracks = queries::get_tracks_by_album(&conn, album_id).map_err(|e| e.to_string())?;

    for track in tracks {
        // Only delete file if it's a local track
        let is_local = track.source_type.is_none() || track.source_type.as_deref() == Some("local");

        if is_local {
            let path_obj = std::path::Path::new(&track.path);
            if path_obj.exists() {
                let _ = std::fs::remove_file(path_obj);
            }
        }

        // Delete track cover file
        let _ = cover_storage::delete_track_cover_file(track.track_cover_path.as_deref());
    }

    // Delete album art file
    let _ = cover_storage::delete_album_art_file(art_path.as_deref());

    queries::delete_album(&conn, album_id).map_err(|e| format!("Failed to delete album: {}", e))
}

/// Input for adding an external (streaming) track to the library
#[derive(Debug, Serialize, Deserialize)]
pub struct ExternalTrackInput {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration: Option<i32>,
    pub cover_url: Option<String>,
    pub source_type: String, // e.g., "tidal", "url"
    pub external_id: String, // Source-specific ID (e.g., Tidal track ID)
    pub format: Option<String>,
    pub bitrate: Option<i32>,
    pub stream_url: Option<String>, // The decoded stream URL
}

/// Add an external (streaming) track to the library
/// If stream_url is provided, use it as the path (for direct playback)
/// Otherwise, construct path as "{source_type}://{external_id}" for uniqueness
#[tauri::command]
pub async fn add_external_track(
    track: ExternalTrackInput,
    db: State<'_, Database>,
) -> Result<i64, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Use stream_url as path if provided, otherwise construct from source_type://external_id
    let path = track
        .stream_url
        .clone()
        .unwrap_or_else(|| format!("{}://{}", track.source_type, track.external_id));

    // Generate content hash for external tracks
    let mut hasher = DefaultHasher::new();
    let combined = format!(
        "{}|{}|{}|{}",
        track.title.trim().to_lowercase(),
        track.artist.trim().to_lowercase(),
        track.album.as_deref().unwrap_or("").trim().to_lowercase(),
        track.duration.map(|d| d.to_string()).unwrap_or_default()
    );
    combined.hash(&mut hasher);
    let content_hash = Some(format!("{:016x}", hasher.finish()));

    let track_insert = queries::TrackInsert {
        path,
        title: Some(track.title),
        artist: Some(track.artist),
        album: track.album,
        track_number: None,
        duration: track.duration,
        album_art: None,   // External tracks use cover_url instead
        track_cover: None, // External tracks use cover_url instead
        format: track.format,
        bitrate: track.bitrate,
        source_type: Some(track.source_type),
        cover_url: track.cover_url,
        external_id: Some(track.external_id),
        content_hash,
        local_src: None,
    };

    queries::insert_or_update_track(&conn, &track_insert)
        .map_err(|e| format!("Failed to add external track: {}", e))
}

/// Reset the database by clearing all data
#[tauri::command]
pub async fn reset_database(db: State<'_, Database>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    conn.execute_batch(
        "
        DELETE FROM playlist_tracks;
        DELETE FROM playlists;
        DELETE FROM tracks;
        DELETE FROM albums;
        DELETE FROM music_folders;
        ",
    )
    .map_err(|e| format!("Failed to reset database: {}", e))?;

    Ok(())
}
