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

        // Initialize schema
        schema::init_schema(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}
