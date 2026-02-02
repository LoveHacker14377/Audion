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
use std::io::Read;
use sha2::{Sha256, Digest};

#[derive(Debug, Serialize, Deserialize)]
pub struct MigrationProgress {
    pub total: usize,
    pub processed: usize,
    pub tracks_migrated: usize,
    pub albums_migrated: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MergeCoverResult {
    pub covers_merged: usize,
    pub space_saved_bytes: u64,
    pub albums_processed: usize,
    pub errors: Vec<String>,
}

// Helper trait for cleaner error conversion
trait ToStringErr<T> {
    fn to_str_err(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> ToStringErr<T> for Result<T, E> {
    fn to_str_err(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

/// Migrate all existing base64 covers to files
#[tauri::command]
pub async fn migrate_covers_to_files(db: State<'_, Database>) -> Result<MigrationProgress, String> {
    println!("[MIGRATION] Starting cover migration...");
    let start = std::time::Instant::now();

    let mut tracks_migrated = 0;
    let mut albums_migrated = 0;
    let mut errors = Vec::new();

    // Fetch tracks and albums (with lock)
    let (tracks, albums) = {
        let conn = db.conn.lock().to_str_err()?;
        
        println!("[MIGRATION] Fetching tracks from database...");
        // Only get tracks that need migration
        let mut stmt = conn.prepare(
            "SELECT id, track_cover FROM tracks WHERE track_cover IS NOT NULL AND track_cover_path IS NULL"
        ).to_str_err()?;
        
        let tracks: Vec<(i64, String)> = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
            ))
        })
        .to_str_err()?
        .filter_map(|r| r.ok())
        .collect();
        
        println!("[MIGRATION] Found {} tracks to migrate", tracks.len());

        println!("[MIGRATION] Fetching albums from database...");
        let mut stmt = conn.prepare(
            "SELECT id, art_data FROM albums WHERE art_data IS NOT NULL AND art_path IS NULL"
        ).to_str_err()?;
        
        let albums: Vec<(i64, String)> = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
            ))
        })
        .to_str_err()?
        .filter_map(|r| r.ok())
        .collect();
        
        println!("[MIGRATION] Found {} albums to migrate", albums.len());
        
        (tracks, albums)
    }; // Lock released here

    let total = tracks.len() + albums.len();
    let mut processed = 0;

    println!("[MIGRATION] Starting track migration...");

    // Migrate track covers (no DB lock held during file I/O)
    for (track_id, cover_data) in tracks {
        println!("[MIGRATION] Track {}: Migrating...", track_id);
        
        match save_track_cover_from_base64(track_id, &cover_data) {
            Ok(path) => {
                println!("[MIGRATION]   Cover saved to: {}", path);

                // Update database with file path (acquire lock only for update)
                let result = {
                    let conn = db.conn.lock().to_str_err()?;
                    queries::update_track_cover_path(&conn, track_id, Some(&path))
                }; // Lock released immediately
                
                if let Err(e) = result {
                    let error_msg = format!("Failed to update track {} path: {}", track_id, e);
                    println!("[MIGRATION]   {}", error_msg);
                    errors.push(error_msg);
                } else {
                    tracks_migrated += 1;
                    println!("[MIGRATION]   Database updated successfully");
                }
            }
            Err(e) => {
                let error_msg = format!("Failed to save track {} cover: {}", track_id, e);
                println!("[MIGRATION]   {}", error_msg);
                errors.push(error_msg);
            }
        }
        processed += 1;
    }

    println!("[MIGRATION] Starting album migration...");

    // Migrate album art
    for (album_id, art_data) in albums {
        println!("[MIGRATION] Album {}: Migrating...", album_id);

        match save_album_art_from_base64(album_id, &art_data) {
            Ok(path) => {
                println!("[MIGRATION]   Art saved to: {}", path);

                // Update db with file path
                let result = {
                    let conn = db.conn.lock().to_str_err()?;
                    queries::update_album_art_path(&conn, album_id, Some(&path))
                };
                
                if let Err(e) = result {
                    let error_msg = format!("Failed to update album {} path: {}", album_id, e);
                    println!("[MIGRATION]   {}", error_msg);
                    errors.push(error_msg);
                } else {
                    albums_migrated += 1;
                    println!("[MIGRATION]   Database updated successfully");
                }
            }
            Err(e) => {
                let error_msg = format!("Failed to save album {} art: {}", album_id, e);
                println!("[MIGRATION]   {}", error_msg);
                errors.push(error_msg);
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
    let conn = db.conn.lock().to_str_err()?;
    get_track_cover_file_path(&conn, track_id).to_str_err()
}

/// Get batch cover paths for multiple tracks
#[tauri::command]
pub async fn get_batch_cover_paths(
    track_ids: Vec<i64>,
    db: State<'_, Database>,
) -> Result<HashMap<i64, String>, String> {
    let conn = db.conn.lock().to_str_err()?;
    queries::get_batch_cover_paths(&conn, &track_ids).to_str_err()
}

/// Get album art path
#[tauri::command]
pub async fn get_album_art_path(
    album_id: i64,
    db: State<'_, Database>,
) -> Result<Option<String>, String> {
    let conn = db.conn.lock().to_str_err()?;
    get_album_art_file_path(&conn, album_id).to_str_err()
}

/// Convert file path to asset URL for browser
#[tauri::command]
pub async fn get_cover_as_asset_url(file_path: String) -> Result<String, String> {
    Ok(file_path)
}

/// Preload covers - for the future
#[tauri::command]
pub async fn preload_covers(_track_ids: Vec<i64>, _db: State<'_, Database>) -> Result<(), String> {
    Ok(())
}

/// Clean up orphaned cover files
#[tauri::command]
pub async fn cleanup_orphaned_cover_files(db: State<'_, Database>) -> Result<usize, String> {
    let conn = db.conn.lock().to_str_err()?;
    cleanup_orphaned_covers(&conn).to_str_err()
}

/// Clear all base64 data after successful migration
/// imp : Only run this after verifying all covers have been migrated to files
#[tauri::command]
pub async fn clear_base64_covers(db: State<'_, Database>) -> Result<usize, String> {
    let conn = db.conn.lock().to_str_err()?;

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

    // Sync track covers - collect updates first
    println!("[SYNC] Scanning track covers...");
    let mut track_updates: Vec<(String, i64)> = Vec::new();

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
                                            println!("[SYNC] Track {}: Found cover at {}", track_id, path_str);
                                            track_updates.push((path_str, track_id));
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

    // Batch update tracks in a transaction
    if !track_updates.is_empty() {
        let mut conn = db.conn.lock().to_str_err()?;
        let tx = conn.transaction().to_str_err()?;
        
        for (path_str, track_id) in &track_updates {
            match tx.execute(
                "UPDATE tracks SET track_cover_path = ?1 WHERE id = ?2",
                rusqlite::params![path_str, track_id],
            ) {
                Ok(updated) => {
                    if updated > 0 {
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
        
        if let Err(e) = tx.commit() {
            errors.push(format!("Transaction commit failed: {}", e));
        }
    }

    // Sync album covers - collect updates first
    println!("[SYNC] Scanning album covers...");
    let mut album_updates: Vec<(String, i64)> = Vec::new();

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
                                            println!("[SYNC] Album {}: Found cover at {}", album_id, path_str);
                                            album_updates.push((path_str, album_id));
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

    // Batch update albums in a transaction
    if !album_updates.is_empty() {
        let mut conn = db.conn.lock().to_str_err()?;
        let tx = conn.transaction().to_str_err()?;
        
        for (path_str, album_id) in &album_updates {
            match tx.execute(
                "UPDATE albums SET art_path = ?1 WHERE id = ?2",
                rusqlite::params![path_str, album_id],
            ) {
                Ok(updated) => {
                    if updated > 0 {
                        albums_synced += 1;
                    } else {
                        println!("[SYNC]    Album {} not found in database", album_id);
                    }
                }
                Err(e) => {
                    let error_msg = format!("Failed to update album {}: {}", album_id, e);
                    println!("[SYNC]    {}", error_msg);
                    errors.push(error_msg);
                }
            }
        }
        
        if let Err(e) = tx.commit() {
            errors.push(format!("Transaction commit failed: {}", e));
        }
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

#[tauri::command]
pub async fn merge_duplicate_covers(db: State<'_, Database>) -> Result<MergeCoverResult, String> {
    println!("[MERGE] Starting cover merge...");
    let start = std::time::Instant::now();

    let mut covers_merged = 0;
    let mut space_saved_bytes = 0u64;
    let mut albums_processed = 0;
    let mut errors = Vec::new();
    
    // Get all albums (with lock)
    let albums = {
        let conn = db.conn.lock().to_str_err()?;
        
        println!("[MERGE] Fetching albums from database...");
        let mut stmt = conn
            .prepare("SELECT DISTINCT album, album_id FROM tracks WHERE album IS NOT NULL")
            .to_str_err()?;
        
        let albums: Vec<(String, Option<i64>)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                ))
            })
            .to_str_err()?
            .filter_map(|r| r.ok())
            .collect();
        
        println!("[MERGE] Found {} albums to process", albums.len());
        albums
    }; // Lock released here
    
    // Prepare statement outside the loop
    for (album_name, _album_id) in albums {
        albums_processed += 1;
        println!("[MERGE] Processing album: {}", album_name);
        
        // Get all tracks for this album with cover paths
        let tracks = {
            let conn = db.conn.lock().to_str_err()?;
            let mut track_stmt = conn
                .prepare("SELECT id, track_cover_path FROM tracks WHERE album = ? AND track_cover_path IS NOT NULL AND track_cover_path != ''")
                .to_str_err()?;
            
            let tracks: Vec<(i64, String)> = track_stmt
                .query_map([&album_name], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                    ))
                })
                .to_str_err()?
                .filter_map(|r| r.ok())
                .collect();
            
            tracks
        }; // Lock released
        
        // 1: Check if >=2 tracks
        if tracks.len() < 2 {
            println!("[MERGE]   Only {} track(s), skipping", tracks.len());
            continue;
        }
        
        println!("[MERGE]   Found {} tracks with covers", tracks.len());
        
        // 2: Group tracks by identical filepath first
        let mut filepath_to_tracks: HashMap<String, Vec<i64>> = HashMap::new();
        for (track_id, cover_path) in &tracks {
            filepath_to_tracks
                .entry(cover_path.clone())
                .or_insert_with(Vec::new)
                .push(*track_id);
        }
        
        // Get unique cover paths only
        let unique_covers: Vec<String> = filepath_to_tracks.keys().cloned().collect();
        
        if unique_covers.len() < 2 {
            println!("[MERGE]   All tracks already use the same cover file, skipping");
            continue;
        }
        
        println!("[MERGE]   Found {} unique cover files", unique_covers.len());
        
        // 3: Pre-filter by size BEFORE hashing
        println!("[MERGE]   Pre-filtering by file size...");
        
        // Group files by similar size (rounded to nearest KB)
        let mut size_groups: HashMap<u64, Vec<(String, u64)>> = HashMap::new();
        
        for cover_path in unique_covers {
            match fs::metadata(&cover_path) {
                Ok(metadata) => {
                    let size = metadata.len();
                    // Round to nearest KB for grouping (allows 1KB difference for minor metadat differences)
                    let size_key = size / 1024;
                    size_groups.entry(size_key).or_insert_with(Vec::new).push((cover_path, size));
                }
                Err(e) => {
                    errors.push(format!("Failed to get metadata for {}: {}", cover_path, e));
                }
            }
        }
        
        // 4: Hash only files within each size group
        println!("[MERGE]   Hashing files with similar sizes...");
        let mut cover_groups: HashMap<String, Vec<(String, u64)>> = HashMap::new();
        let mut files_hashed = 0;
        
        for (_size_key, size_group) in size_groups {
            // Only hash if there are 2+ files in this size group
            if size_group.len() < 2 {
                continue;
            }
            
            println!("[MERGE]     Size group has {} files, hashing...", size_group.len());
            
            for (cover_path, size) in size_group {
                match get_file_hash(&cover_path) {
                    Ok(hash) => {
                        files_hashed += 1;
                        cover_groups
                            .entry(hash)
                            .or_insert_with(Vec::new)
                            .push((cover_path, size));
                    }
                    Err(e) => {
                        errors.push(format!("Failed to hash {}: {}", cover_path, e));
                    }
                }
            }
        }
        
        println!("[MERGE]   Hashed {} files (skipped {} files with unique sizes)", 
                 files_hashed, 
                 filepath_to_tracks.len() - files_hashed);
        
        // 5: Merge duplicates
        for (hash, mut group) in cover_groups {
            if group.len() < 2 {
                continue; // No duplicates in this group
            }
            
            println!("[MERGE]   Found {} duplicate covers (hash: {}...)", group.len(), &hash[..8]);
            
            // Sort by path to get a consistent canonical cover
            group.sort_by(|a, b| a.0.cmp(&b.0));
            
            let canonical_cover = &group[0].0;
            println!("[MERGE]     Canonical cover: {}", canonical_cover);
            
            // Collect all updates first
            let mut updates: Vec<(i64, String)> = Vec::new();
            let mut files_to_delete: Vec<(String, u64)> = Vec::new();
            
            for (old_cover_path, file_size) in &group[1..] {
                // Get all track IDs that use this duplicate cover
                if let Some(track_ids) = filepath_to_tracks.get(old_cover_path) {
                    for track_id in track_ids {
                        updates.push((*track_id, canonical_cover.clone()));
                    }
                    files_to_delete.push((old_cover_path.clone(), *file_size));
                }
            }
            
            // Batch update in transaction
            if !updates.is_empty() {
                let mut conn = db.conn.lock().to_str_err()?;
                let tx = conn.transaction().to_str_err()?;
                
                for (track_id, canonical_path) in &updates {
                    if let Err(e) = tx.execute(
                        "UPDATE tracks SET track_cover_path = ?1 WHERE id = ?2",
                        rusqlite::params![canonical_path, track_id],
                    ) {
                        errors.push(format!("Failed to update track {}: {}", track_id, e));
                    }
                }
                
                if let Err(e) = tx.commit() {
                    errors.push(format!("Failed to commit transaction: {}", e));
                    continue;
                }
                
                println!("[MERGE]       Updated {} tracks to use canonical cover", updates.len());
            }
            
            // Delete duplicate files 
            for (old_cover_path, file_size) in files_to_delete {
                match fs::remove_file(&old_cover_path) {
                    Ok(_) => {
                        space_saved_bytes += file_size;
                        covers_merged += 1;
                        println!("[MERGE]       Deleted: {}", old_cover_path);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        // File already deleted, that's fine
                        println!("[MERGE]       Already deleted: {}", old_cover_path);
                    }
                    Err(e) => {
                        errors.push(format!("Failed to delete {}: {}", old_cover_path, e));
                    }
                }
            }
        }
    }
    
    let elapsed = start.elapsed();
    println!("[MERGE] MERGE COMPLETE");
    println!("[MERGE]   Albums processed: {}", albums_processed);
    println!("[MERGE]   Covers merged: {}", covers_merged);
    println!("[MERGE]   Space saved: {} bytes ({:.2} MB)", space_saved_bytes, space_saved_bytes as f64 / (1024.0 * 1024.0));
    println!("[MERGE]   Errors: {}", errors.len());
    println!("[MERGE]   Duration: {:?}", elapsed);
    
    if !errors.is_empty() {
        println!("[MERGE] Errors encountered:");
        for error in &errors {
            println!("[MERGE]   - {}", error);
        }
    }
    
    Ok(MergeCoverResult {
        covers_merged,
        space_saved_bytes,
        albums_processed,
        errors,
    })
}

// Helper function for hashing - returns only hash string
fn get_file_hash(path: &str) -> Result<String, String> {
    let path = std::path::Path::new(path);
    
    // Calculate hash
    let mut file = fs::File::open(path).to_str_err()?;
    let mut hasher = Sha256::new();
    
    // Read in 64KB chunks for efficiency
    let mut buffer = [0u8; 65536];
    loop {
        let bytes_read = file.read(&mut buffer).to_str_err()?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    
    let hash = format!("{:x}", hasher.finalize());
    Ok(hash)
}