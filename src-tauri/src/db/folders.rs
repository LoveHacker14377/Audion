// Music folder management and scanner cleanup helpers
use rusqlite::{Connection, Result};
use std::path::Path;

// Music folder operations
pub fn add_music_folder(conn: &Connection, path: &str) -> Result<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO music_folders (path, last_scanned) VALUES (?1, CURRENT_TIMESTAMP)",
        [path],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Returns true if the folder was registered, false if it was already covered.
pub fn register_music_folder(conn: &Connection, path: &str) -> Result<bool> {
    let existing = {
        let mut stmt = conn.prepare("SELECT path FROM music_folders")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut v = Vec::new();
        for r in rows { v.push(r?); }
        v
    };

    // If any existing folder is a parent
    if existing.iter().any(|f| Path::new(path).starts_with(Path::new(f))) {
        return Ok(false);
    }

    // Remove any existing folders that are subfolders of the new path
    for f in existing.iter().filter(|f| Path::new(f).starts_with(Path::new(path))) {
        conn.execute("DELETE FROM music_folders WHERE path = ?1", [f])?;
    }

    conn.execute(
        "INSERT OR IGNORE INTO music_folders (path, last_scanned) VALUES (?1, CURRENT_TIMESTAMP)",
        [path],
    )?;

    Ok(true)
}

pub fn get_music_folders(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM music_folders ORDER BY path")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    let mut folders = Vec::new();
    for folder in rows {
        folders.push(folder?);
    }
    Ok(folders)
}

pub fn remove_music_folder(conn: &Connection, path: &str) -> Result<()> {
    conn.execute("DELETE FROM music_folders WHERE path = ?1", [path])?;
    Ok(())
}

pub fn update_folder_last_scanned(conn: &Connection, path: &str) -> Result<()> {
    conn.execute(
        "UPDATE music_folders SET last_scanned = CURRENT_TIMESTAMP WHERE path = ?1",
        [path],
    )?;
    Ok(())
}

// Cleanup tracks that no longer exist on filesystem
pub fn cleanup_deleted_tracks(conn: &Connection, folder_paths: &[String]) -> Result<usize> {
    if folder_paths.is_empty() {
        return Ok(0);
    }

    // Build query with OR conditions for each folder
    let conditions: Vec<String> = folder_paths
        .iter()
        .enumerate()
        .map(|(i, _)| format!("path LIKE ?{}", i + 1))
        .collect();
    let query = format!(
        "SELECT id, path FROM tracks WHERE {}",
        conditions.join(" OR ")
    );

    let mut params = Vec::new();
    for folder in folder_paths {
        params.push(format!("{}%", folder));
    }

    let mut stmt = conn.prepare(&query)?;
    let track_rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut deleted_count = 0;
    for track_result in track_rows {
        let (id, path) = track_result?;
        if !std::path::Path::new(&path).exists() {
            // Track file doesn't exist, remove it
            conn.execute("DELETE FROM tracks WHERE id = ?1", [id])?;
            deleted_count += 1;
        }
    }

    Ok(deleted_count)
}

/// Cleanup albums that have no tracks associated with them
pub fn cleanup_empty_albums(conn: &Connection) -> Result<usize> {
    let deleted = conn.execute(
        "DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)",
        [],
    )?;
    Ok(deleted)
}
