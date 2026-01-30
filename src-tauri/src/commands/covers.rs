// Cover management Tauri commands
use crate::db::{queries, Database};
use crate::scanner::cover_storage::{
    cleanup_orphaned_covers, get_album_art_file_path, get_track_cover_file_path,
    save_album_art_from_base64, save_track_cover_from_base64,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct MigrationProgress {
    pub total: usize,
    pub processed: usize,
    pub tracks_migrated: usize,
    pub albums_migrated: usize,
    pub errors: Vec<String>,
}

/// Migrate all existing base64 covers to files
#[tauri::command]
pub async fn migrate_covers_to_files(db: State<'_, Database>) -> Result<MigrationProgress, String> {
    println!("[MIGRATION] Starting cover migration...");
    let start = std::time::Instant::now();

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Get all tracks with base64 covers
    println!("[MIGRATION] Fetching tracks from database...");
    let tracks = queries::get_all_tracks(&conn).map_err(|e| e.to_string())?;
    println!("[MIGRATION] Found {} total tracks", tracks.len());

    // Get all albums with base64 art
    println!("[MIGRATION] Fetching albums from database...");
    let albums = queries::get_all_albums(&conn).map_err(|e| e.to_string())?;
    println!("[MIGRATION] Found {} total albums", albums.len());

    let total = tracks.len() + albums.len();
    let mut processed = 0;
    let mut tracks_migrated = 0;
    let mut albums_migrated = 0;
    let mut errors = Vec::new();

    println!("[MIGRATION] Starting track migration...");

    // Migrate track covers
    for track in tracks {
        println!("Cover path: {:?}", track.track_cover_path);

        // Check if track has base64 cover data
        match &track.track_cover {
            Some(cover_data) => {
                println!(
                    "[MIGRATION]  Has base64 cover (length: {})",
                    cover_data.len()
                );

                // Skip if already has a path
                if track.track_cover_path.is_some() {
                    println!("[MIGRATION]  Already has path, skipping");
                    processed += 1;
                    continue;
                }

                println!("[MIGRATION]  Saving cover to file...");
                match save_track_cover_from_base64(track.id, cover_data) {
                    Ok(path) => {
                        println!("[MIGRATION]  Cover saved to: {}", path);

                        // Update database with file path
                        println!("[MIGRATION]  Updating database path...");
                        if let Err(e) =
                            queries::update_track_cover_path(&conn, track.id, Some(&path))
                        {
                            let error_msg =
                                format!("Failed to update track {} path: {}", track.id, e);
                            println!("[MIGRATION]   {}", error_msg);
                            errors.push(error_msg);
                        } else {
                            tracks_migrated += 1;
                            println!("[MIGRATION]   Database updated successfully");
                        }
                    }
                    Err(e) => {
                        let error_msg = format!("Failed to save track {} cover: {}", track.id, e);
                        println!("[MIGRATION]   {}", error_msg);
                        errors.push(error_msg);
                    }
                }
            }
            None => {
                println!("[MIGRATION]   No base64 cover data found");
            }
        }
        processed += 1;
    }

    println!("[MIGRATION] Starting album migration...");

    // Migrate album art
    for album in albums {
        println!("[MIGRATION] Album {}: {}", album.id, album.name);

        match &album.art_data {
            Some(art_data) => {
                println!("[MIGRATION]   Has base64 art (length: {})", art_data.len());

                // Skip if already has a path
                if album.art_path.is_some() {
                    println!("[MIGRATION]   Already has path, skipping");
                    processed += 1;
                    continue;
                }

                println!("[MIGRATION]   Saving art to file...");
                match save_album_art_from_base64(album.id, art_data) {
                    Ok(path) => {
                        println!("[MIGRATION]   Art saved to: {}", path);

                        // Update database with file path
                        println!("[MIGRATION]   Updating database path...");
                        if let Err(e) = queries::update_album_art_path(&conn, album.id, Some(&path))
                        {
                            let error_msg =
                                format!("Failed to update album {} path: {}", album.id, e);
                            println!("[MIGRATION]   {}", error_msg);
                            errors.push(error_msg);
                        } else {
                            albums_migrated += 1;
                            println!("[MIGRATION]   Database updated successfully");
                        }
                    }
                    Err(e) => {
                        let error_msg = format!("Failed to save album {} art: {}", album.id, e);
                        println!("[MIGRATION]   {}", error_msg);
                        errors.push(error_msg);
                    }
                }
            }
            None => {
                println!("[MIGRATION]   No base64 art data found");
            }
        }
        processed += 1;
    }

    let elapsed = start.elapsed();
    println!("[MIGRATION] MIGRATION COMPLETE");
    println!("[MIGRATION]   Total processed: {}", processed);
    println!("[MIGRATION]   Tracks migrated: {}", tracks_migrated);
    println!("[MIGRATION]   Albums migrated: {}", albums_migrated);
    println!("[MIGRATION]   Errors: {}", errors.len());
    println!("[MIGRATION]   Duration: {:?}", elapsed);

    if !errors.is_empty() {
        println!("[MIGRATION] Errors encountered:");
        for error in &errors {
            println!("[MIGRATION]   - {}", error);
        }
    }

    Ok(MigrationProgress {
        total,
        processed,
        tracks_migrated,
        albums_migrated,
        errors,
    })
}

/// Get a single track's cover path
#[tauri::command]
pub async fn get_track_cover_path(
    track_id: i64,
    db: State<'_, Database>,
) -> Result<Option<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    get_track_cover_file_path(&conn, track_id).map_err(|e| e.to_string())
}

/// Get batch cover paths for multiple tracks
#[tauri::command]
pub async fn get_batch_cover_paths(
    track_ids: Vec<i64>,
    db: State<'_, Database>,
) -> Result<HashMap<i64, String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    queries::get_batch_cover_paths(&conn, &track_ids).map_err(|e| e.to_string())
}

/// Get album art path
#[tauri::command]
pub async fn get_album_art_path(
    album_id: i64,
    db: State<'_, Database>,
) -> Result<Option<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    get_album_art_file_path(&conn, album_id).map_err(|e| e.to_string())
}

/// Convert file path to asset URL for browser
#[tauri::command]
pub async fn get_cover_as_asset_url(file_path: String) -> Result<String, String> {
    Ok(file_path)
}

/// Preload covers - for the fture
#[tauri::command]
pub async fn preload_covers(_track_ids: Vec<i64>, _db: State<'_, Database>) -> Result<(), String> {
    Ok(())
}

/// Clean up orphaned cover files
#[tauri::command]
pub async fn cleanup_orphaned_cover_files(db: State<'_, Database>) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    cleanup_orphaned_covers(&conn).map_err(|e| e.to_string())
}

/// Clear all base64 data after successful migration
/// imp : Only run this after verifying all covers have been migrated to files
#[tauri::command]
pub async fn clear_base64_covers(db: State<'_, Database>) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Clear track covers
    let tracks_cleared = conn
        .execute(
            "UPDATE tracks SET track_cover = NULL WHERE track_cover_path IS NOT NULL",
            [],
        )
        .map_err(|e| format!("Failed to clear track covers: {}", e))?;

    // Clear album art
    let albums_cleared = conn
        .execute(
            "UPDATE albums SET art_data = NULL WHERE art_path IS NOT NULL",
            [],
        )
        .map_err(|e| format!("Failed to clear album art: {}", e))?;

    let total_cleared = tracks_cleared + albums_cleared;
    println!(
        "[CLEANUP] Cleared {} base64 entries from database",
        total_cleared
    );

    Ok(total_cleared)
}

#[tauri::command]
pub async fn sync_cover_paths_from_files(
    db: State<'_, Database>,
    app_handle: tauri::AppHandle,
) -> Result<MigrationProgress, String> {
    println!("[SYNC] Syncing cover paths from existing files...");
    let start = std::time::Instant::now();

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    use tauri::Manager;

    // Get app data directory

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let covers_dir = app_data_dir.join("covers");
    let tracks_dir = covers_dir.join("tracks");
    let albums_dir = covers_dir.join("albums");

    println!("[SYNC] Covers directory: {:?}", covers_dir);
    println!("[SYNC] Tracks directory: {:?}", tracks_dir);
    println!("[SYNC] Albums directory: {:?}", albums_dir);

    let mut tracks_synced = 0;
    let mut albums_synced = 0;
    let mut errors = Vec::new();

    // Sync track covers
    println!("[SYNC] Scanning track covers...");

    if tracks_dir.exists() {
        match fs::read_dir(&tracks_dir) {
            Ok(entries) => {
                for entry in entries {
                    if let Ok(entry) = entry {
                        let path = entry.path();

                        // Check if it's a file with image extension
                        if path.is_file() {
                            if let Some(extension) = path.extension() {
                                let ext_str = extension.to_string_lossy().to_lowercase();
                                if ext_str == "jpg"
                                    || ext_str == "jpeg"
                                    || ext_str == "png"
                                    || ext_str == "webp"
                                {
                                    // Extract track ID from filename
                                    if let Some(stem) = path.file_stem() {
                                        if let Ok(track_id) = stem.to_string_lossy().parse::<i64>()
                                        {
                                            let path_str = path.to_string_lossy().to_string();

                                            println!(
                                                "[SYNC] Track {}: Found cover at {}",
                                                track_id, path_str
                                            );

                                            // Update database
                                            match conn.execute(
                                                "UPDATE tracks SET track_cover_path = ?1 WHERE id = ?2",
                                                rusqlite::params![&path_str, track_id],
                                            ) {
                                                Ok(updated) => {
                                                    if updated > 0 {
                                                        println!("[SYNC]    Updated database");
                                                        tracks_synced += 1;
                                                    } else {
                                                        println!("[SYNC]    Track {} not found in database", track_id);
                                                    }
                                                }
                                                Err(e) => {
                                                    let error_msg = format!("Failed to update track {}: {}", track_id, e);
                                                    println!("[SYNC]    {}", error_msg);
                                                    errors.push(error_msg);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let error_msg = format!("Failed to read tracks directory: {}", e);
                println!("[SYNC]  {}", error_msg);
                errors.push(error_msg);
            }
        }
    } else {
        println!("[SYNC]  Tracks directory does not exist");
    }

    // Sync album covers
    println!("[SYNC] Scanning album covers...");

    if albums_dir.exists() {
        match fs::read_dir(&albums_dir) {
            Ok(entries) => {
                for entry in entries {
                    if let Ok(entry) = entry {
                        let path = entry.path();

                        // Check if it's a file with image extension
                        if path.is_file() {
                            if let Some(extension) = path.extension() {
                                let ext_str = extension.to_string_lossy().to_lowercase();
                                if ext_str == "jpg"
                                    || ext_str == "jpeg"
                                    || ext_str == "png"
                                    || ext_str == "webp"
                                {
                                    // Extract album ID from filename
                                    if let Some(stem) = path.file_stem() {
                                        if let Ok(album_id) = stem.to_string_lossy().parse::<i64>()
                                        {
                                            let path_str = path.to_string_lossy().to_string();

                                            println!(
                                                "[SYNC] Album {}: Found cover at {}",
                                                album_id, path_str
                                            );

                                            // Update database
                                            match conn.execute(
                                                "UPDATE albums SET art_path = ?1 WHERE id = ?2",
                                                rusqlite::params![&path_str, album_id],
                                            ) {
                                                Ok(updated) => {
                                                    if updated > 0 {
                                                        println!("[SYNC]    Updated database");
                                                        albums_synced += 1;
                                                    } else {
                                                        println!("[SYNC]    Album {} not found in database", album_id);
                                                    }
                                                }
                                                Err(e) => {
                                                    let error_msg = format!(
                                                        "Failed to update album {}: {}",
                                                        album_id, e
                                                    );
                                                    println!("[SYNC]    {}", error_msg);
                                                    errors.push(error_msg);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let error_msg = format!("Failed to read albums directory: {}", e);
                println!("[SYNC]  {}", error_msg);
                errors.push(error_msg);
            }
        }
    } else {
        println!("[SYNC]  Albums directory does not exist");
    }

    let elapsed = start.elapsed();
    println!("[SYNC] SYNC COMPLETE");
    println!("[SYNC]   Tracks synced: {}", tracks_synced);
    println!("[SYNC]   Albums synced: {}", albums_synced);
    println!("[SYNC]   Errors: {}", errors.len());
    println!("[SYNC]   Duration: {:?}", elapsed);

    Ok(MigrationProgress {
        total: tracks_synced + albums_synced,
        processed: tracks_synced + albums_synced,
        tracks_migrated: tracks_synced,
        albums_migrated: albums_synced,
        errors,
    })
}
