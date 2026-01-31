use std::path::{Path, PathBuf};

/// Helper function to validate paths and prevent directory traversal
pub fn resolve_path(base_dir: &Path, unsafe_path: &str) -> Result<PathBuf, String> {
    // Join the base directory with the unsafe path
    let full_path = base_dir.join(unsafe_path);

    // Resolve all '..' and symbolic links to get the absolute canonical path
    // Note: canonicalize returns an error if the path does not exist.
    // We want to handle paths that might not exist yet (e.g., for downloads).

    // For existing paths, we can use canonicalize
    if full_path.exists() {
        let canonical = full_path
            .canonicalize()
            .map_err(|e| format!("Invalid path: {}", e))?;

        // Ensure the canonical path starts with the base_dir
        // We also need to canonicalize base_dir to be sure
        let canonical_base = base_dir
            .canonicalize()
            .map_err(|e| format!("Invalid base directory: {}", e))?;

        if !canonical.starts_with(&canonical_base) {
            return Err("Path traversal detected".to_string());
        }
        Ok(canonical)
    } else {
        // For paths that don't exist yet, we check the components
        // A simple check is to ensure no ".." components after joining
        // or to use a library like `path-clean` or manually normalize.

        let mut normalized = PathBuf::new();
        for component in full_path.components() {
            match component {
                std::path::Component::Prefix(p) => normalized.push(p.as_os_str()),
                std::path::Component::RootDir => {
                    normalized.push(std::path::MAIN_SEPARATOR.to_string())
                }
                std::path::Component::ParentDir => {
                    if !normalized.pop() {
                        return Err("Path traversal detected (out of bounds)".to_string());
                    }
                }
                std::path::Component::Normal(c) => normalized.push(c),
                std::path::Component::CurDir => {}
            }
        }

        // Final check against base_dir
        // This is tricky without canonicalization, but we can check if it stays within
        // the string representation if we know base_dir is already safe.
        if !normalized.starts_with(base_dir) {
            return Err("Path traversal detected".to_string());
        }

        Ok(normalized)
    }
}
