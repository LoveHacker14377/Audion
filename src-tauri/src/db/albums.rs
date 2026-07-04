// Albums and Artists query helpers
use rusqlite::{params, Connection, OptionalExtension, Result};
use std::time::Instant;

use super::models::{Album, Artist, Track};

/// Get album art path
pub fn get_album_art_path(conn: &Connection, album_id: i64) -> Result<Option<String>> {
    conn.query_row(
        "SELECT art_path FROM albums WHERE id = ?1",
        [album_id],
        |row| row.get(0),
    )
    .optional()
}

/// Get all albums WITH art data (slow, for migration only)
pub fn get_all_albums(conn: &Connection) -> Result<Vec<Album>> {
    let query_start = Instant::now();

    let mut stmt = conn
        .prepare("SELECT id, name, artist, art_data, art_path FROM albums ORDER BY artist, name")?;

    let albums = stmt
        .query_map([], |row| {
            Ok(Album {
                id: row.get(0)?,
                name: row.get(1)?,
                artist: row.get(2)?,
                art_data: row.get(3)?,
                art_path: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    let total_time = query_start.elapsed();
    println!(
        "[DB] get_all_albums: Fetched {} albums in {:?}",
        albums.len(),
        total_time
    );

    Ok(albums)
}

/// Get all albums WITHOUT art data (fast)
pub fn get_all_albums_lightweight(conn: &Connection) -> Result<Vec<Album>> {
    let query_start = Instant::now();

    let mut stmt = conn.prepare("SELECT id, name, artist FROM albums ORDER BY artist, name")?;

    let albums = stmt
        .query_map([], |row| {
            Ok(Album {
                id: row.get(0)?,
                name: row.get(1)?,
                artist: row.get(2)?,
                art_data: None,
                art_path: None,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    let total_time = query_start.elapsed();
    println!(
        "[DB] get_all_albums_lightweight: Fetched {} albums in {:?}",
        albums.len(),
        total_time
    );

    Ok(albums)
}

/// Get all albums WITH paths only (for on-demand loading)
pub fn get_all_albums_with_paths(conn: &Connection) -> Result<Vec<Album>> {
    let query_start = Instant::now();

    let mut stmt =
        conn.prepare("SELECT id, name, artist, art_path FROM albums ORDER BY artist, name")?;

    let albums = stmt
        .query_map([], |row| {
            Ok(Album {
                id: row.get(0)?,
                name: row.get(1)?,
                artist: row.get(2)?,
                art_data: None,
                art_path: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    let total_time = query_start.elapsed();
    println!(
        "[DB] get_all_albums_with_paths: Fetched {} albums in {:?}",
        albums.len(),
        total_time
    );

    Ok(albums)
}

/// Get paginated albums
pub fn get_albums_paginated(conn: &Connection, limit: i32, offset: i32) -> Result<Vec<Album>> {
    let query_start = Instant::now();

    let mut stmt = conn.prepare(
        "SELECT id, name, artist, art_path FROM albums 
         ORDER BY artist, name
         LIMIT ?1 OFFSET ?2",
    )?;

    let albums = stmt
        .query_map(params![limit, offset], |row| {
            Ok(Album {
                id: row.get(0)?,
                name: row.get(1)?,
                artist: row.get(2)?,
                art_data: None,
                art_path: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    let total_time = query_start.elapsed();
    println!(
        "[DB] get_albums_paginated: Fetched {} albums (limit: {}, offset: {}) in {:?}",
        albums.len(),
        limit,
        offset,
        total_time
    );

    Ok(albums)
}

pub fn get_all_artists(conn: &Connection) -> Result<Vec<Artist>> {
    let query_start = Instant::now();

    let mut stmt = conn.prepare(
        "SELECT artist, COUNT(*) as track_count, COUNT(DISTINCT album) as album_count 
         FROM tracks 
         WHERE artist IS NOT NULL 
         GROUP BY artist 
         ORDER BY artist",
    )?;

    let artists = stmt
        .query_map([], |row| {
            Ok(Artist {
                name: row.get(0)?,
                track_count: row.get(1)?,
                album_count: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    let total_time = query_start.elapsed();
    println!(
        "[DB] get_all_artists: Fetched {} artists in {:?}",
        artists.len(),
        total_time
    );

    Ok(artists)
}

pub fn get_tracks_by_album(conn: &Connection, album_id: i64) -> Result<Vec<Track>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, title, artist, album, track_number, duration, album_id, format, bitrate, source_type, cover_url, external_id, local_src, track_cover, track_cover_path, disc_number, metadata_json, date_added 
         FROM tracks WHERE album_id = ?1 ORDER BY disc_number, track_number, title",
    )?;

    let tracks = stmt
        .query_map([album_id], |row| {
            Ok(Track {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                artist: row.get(3)?,
                album: row.get(4)?,
                track_number: row.get(5)?,
                duration: row.get(6)?,
                album_id: row.get(7)?,
                format: row.get(8)?,
                bitrate: row.get(9)?,
                source_type: row.get(10)?,
                cover_url: row.get(11)?,
                external_id: row.get(12)?,
                local_src: row.get(13)?,
                track_cover: row.get(14)?,
                track_cover_path: row.get(15)?,
                disc_number: row.get(16)?,
                metadata_json: row.get(17)?,
                date_added: row.get(18)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(tracks)
}

pub fn get_tracks_by_artist(conn: &Connection, artist: &str) -> Result<Vec<Track>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, title, artist, album, track_number, duration, album_id, format, bitrate, source_type, cover_url, external_id, local_src, track_cover, track_cover_path, disc_number, metadata_json, date_added 
         FROM tracks WHERE artist = ?1 ORDER BY album, disc_number, track_number, title",
    )?;

    let tracks = stmt
        .query_map([artist], |row| {
            Ok(Track {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                artist: row.get(3)?,
                album: row.get(4)?,
                track_number: row.get(5)?,
                duration: row.get(6)?,
                album_id: row.get(7)?,
                format: row.get(8)?,
                bitrate: row.get(9)?,
                source_type: row.get(10)?,
                cover_url: row.get(11)?,
                external_id: row.get(12)?,
                local_src: row.get(13)?,
                track_cover: row.get(14)?,
                track_cover_path: row.get(15)?,
                disc_number: row.get(16)?,
                metadata_json: row.get(17)?,
                date_added: row.get(18)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(tracks)
}

pub fn get_album_by_id(conn: &Connection, album_id: i64) -> Result<Option<Album>> {
    conn.query_row(
        "SELECT id, name, artist, art_data, art_path FROM albums WHERE id = ?1",
        [album_id],
        |row| {
            Ok(Album {
                id: row.get(0)?,
                name: row.get(1)?,
                artist: row.get(2)?,
                art_data: row.get(3)?,
                art_path: row.get(4)?,
            })
        },
    )
    .optional()
}

pub fn get_recently_added_albums(conn: &Connection, limit: i32) -> Result<Vec<Album>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.name, a.artist, a.art_data, a.art_path, MAX(t.date_added) as album_date_added
         FROM albums a
         INNER JOIN tracks t ON a.id = t.album_id
         GROUP BY a.id
         ORDER BY album_date_added DESC
         LIMIT ?1",
    )?;

    let albums = stmt
        .query_map(params![limit], |row| {
            Ok(Album {
                id: row.get(0)?,
                name: row.get(1)?,
                artist: row.get(2)?,
                art_data: row.get(3)?,
                art_path: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    Ok(albums)
}
