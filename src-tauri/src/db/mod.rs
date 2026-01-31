// Database module for SQLite operations
pub mod queries;
pub mod schema;

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Database {
    pub conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn new(app_dir: &PathBuf) -> Result<Self, rusqlite::Error> {
        let db_path = app_dir.join("rlist.db");
        let conn = Connection::open(&db_path)?;

        // Enable WAL mode for better concurrency and resilience to corruption
        // Use execute_batch because these PRAGMAs return results which execute() doesn't like
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;

        // Run an integrity check on startup
        match conn.query_row("PRAGMA integrity_check;", [], |row| row.get::<_, String>(0)) {
            Ok(status) if status != "ok" => {
                eprintln!("[DB] Warning: Database integrity check failed: {}", status);
            }
            Err(e) => {
                eprintln!("[DB] Warning: Could not run integrity check: {}", e);
            }
            _ => {} // Everything is fine ("ok")
        }

        // Initialize schema
        schema::init_schema(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}
