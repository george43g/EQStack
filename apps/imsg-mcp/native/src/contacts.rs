//! Contact resolution — reads the macOS AddressBook SQLite database(s) to
//! resolve phone numbers and emails to display names.
//!
//! Contacts can live in more than one Address Book: the local card store plus
//! one iCloud (or other account) source per `Sources/<uuid>/AddressBook-v22.abcddb`.
//! We load the main DB AND every source so a contact is resolvable wherever the
//! user keeps it — mirroring the TypeScript `ContactsDB`/`getContactsDbPaths`.

use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::path::Path;

const SOURCE_DB_NAME: &str = "AddressBook-v22.abcddb";

pub struct ContactsDb {
    handles: HashMap<String, String>, // phone/email → display name
}

impl ContactsDb {
    /// Open the main AddressBook plus every iCloud source under `sources_dir`
    /// and build a merged handle→name lookup map. Missing/unreadable databases
    /// are skipped (graceful degradation) rather than failing the whole load.
    pub fn open(main_path: &str, sources_dir: Option<&str>) -> Self {
        let mut handles = HashMap::new();
        Self::load_db(&mut handles, main_path);

        if let Some(dir) = sources_dir {
            for path in Self::discover_source_dbs(dir) {
                Self::load_db(&mut handles, &path);
            }
        }

        ContactsDb { handles }
    }

    /// Enumerate `<sources_dir>/<uuid>/AddressBook-v22.abcddb` for every source.
    fn discover_source_dbs(sources_dir: &str) -> Vec<String> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(sources_dir) else {
            return out;
        };
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let candidate = entry.path().join(SOURCE_DB_NAME);
                if candidate.exists() {
                    if let Some(s) = candidate.to_str() {
                        out.push(s.to_string());
                    }
                }
            }
        }
        out
    }

    /// Load one Address Book DB into the shared handle map. Best-effort: any
    /// open/query error leaves the map untouched.
    fn load_db(handles: &mut HashMap<String, String>, path: &str) {
        if !Path::new(path).exists() {
            return;
        }
        let Ok(conn) = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) else {
            return;
        };

        let query = "SELECT
                COALESCE(ZABCDFIRSTNAME, '') || ' ' || COALESCE(ZABCDLASTNAME, '') as full_name,
                mv.ZVALUE as handle
            FROM ZABCDRECORD r
            JOIN ZABCDPHONENUMBER mv ON mv.ZOWNER = r.Z_PK
            WHERE mv.ZVALUE IS NOT NULL AND mv.ZVALUE != ''
            UNION ALL
            SELECT
                COALESCE(ZABCDFIRSTNAME, '') || ' ' || COALESCE(ZABCDLASTNAME, '') as full_name,
                mv.ZVALUE as handle
            FROM ZABCDRECORD r
            JOIN ZABCDEMAILADDRESS mv ON mv.ZOWNER = r.Z_PK
            WHERE mv.ZVALUE IS NOT NULL AND mv.ZVALUE != ''";

        let Ok(mut stmt) = conn.prepare(query) else {
            return;
        };
        let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) else {
            return;
        };

        for row in rows.flatten() {
            let (name, handle) = row;
            let name = name.trim().to_string();
            if !name.is_empty() && name != " " {
                let normalized = normalize_handle(&handle);
                handles.insert(normalized, name.clone());
                handles.insert(handle, name);
            }
        }
    }

    /// Look up a display name for a handle (phone number or email).
    /// Returns None if no match found.
    pub fn lookup_handle(&self, handle: &str) -> Option<String> {
        if let Some(name) = self.handles.get(handle) {
            return Some(name.clone());
        }
        let normalized = normalize_handle(handle);
        self.handles.get(&normalized).cloned()
    }

    /// Batch resolve multiple handles.
    pub fn resolve_batch(&self, handles: &[String]) -> HashMap<String, String> {
        let mut result = HashMap::new();
        for handle in handles {
            if let Some(name) = self.lookup_handle(handle) {
                result.insert(handle.clone(), name);
            }
        }
        result
    }
}

/// Normalize a phone handle by stripping non-digit characters.
fn normalize_handle(handle: &str) -> String {
    if handle.contains('@') {
        return handle.to_lowercase();
    }
    handle.chars().filter(|c| c.is_ascii_digit() || *c == '+').collect()
}

/// Public function exposed via N-API.
pub fn resolve_handles(
    contacts_main_path: &str,
    contacts_sources_dir: Option<&str>,
    handles: &[String],
) -> napi::Result<HashMap<String, String>> {
    let db = ContactsDb::open(contacts_main_path, contacts_sources_dir);
    Ok(db.resolve_batch(handles))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn test_normalize_handle_phone() {
        assert_eq!(normalize_handle("+1 (555) 555-0100"), "+15555550100");
        assert_eq!(normalize_handle("+1-555-555-0142"), "+15555550142");
    }

    #[test]
    fn test_normalize_handle_email() {
        assert_eq!(normalize_handle("USER@EXAMPLE.com"), "user@example.com");
    }

    #[test]
    fn test_open_missing_path_returns_empty() {
        let db = ContactsDb::open("/nonexistent/path/AddressBook.abcddb", None);
        assert!(db.lookup_handle("anything").is_none());
    }

    #[test]
    fn test_resolve_batch_empty_db() {
        let db = ContactsDb::open("/nonexistent/path/AddressBook.abcddb", None);
        let handles = vec!["+1234567890".to_string(), "user@example.com".to_string()];
        let result = db.resolve_batch(&handles);
        assert!(result.is_empty());
    }

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Build a minimal Address Book SQLite DB with one card carrying an optional
    /// phone and email. Returns the file path.
    fn make_address_book(dir: &Path, first: &str, last: &str, phone: Option<&str>, email: Option<&str>) -> String {
        let path = dir.join(SOURCE_DB_NAME);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZABCDFIRSTNAME TEXT, ZABCDLASTNAME TEXT);
             CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZVALUE TEXT, ZOWNER INTEGER);
             CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZVALUE TEXT, ZOWNER INTEGER);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ZABCDRECORD (Z_PK, ZABCDFIRSTNAME, ZABCDLASTNAME) VALUES (1, ?1, ?2)",
            rusqlite::params![first, last],
        )
        .unwrap();
        if let Some(p) = phone {
            conn.execute(
                "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZVALUE, ZOWNER) VALUES (1, ?1, 1)",
                rusqlite::params![p],
            )
            .unwrap();
        }
        if let Some(e) = email {
            conn.execute(
                "INSERT INTO ZABCDEMAILADDRESS (Z_PK, ZVALUE, ZOWNER) VALUES (1, ?1, 1)",
                rusqlite::params![e],
            )
            .unwrap();
        }
        path.to_str().unwrap().to_string()
    }

    fn unique_tmp() -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("imsg-rust-contacts-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_loads_main_db() {
        let dir = unique_tmp();
        let main = make_address_book(&dir, "Alex", "Local", Some("+15550000088"), None);
        let db = ContactsDb::open(&main, None);
        assert_eq!(db.lookup_handle("+15550000088").as_deref(), Some("Alex Local"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_merges_handles_from_icloud_sources() {
        // Main store under <root>/AddressBook-v22.abcddb (phone only).
        let root = unique_tmp();
        let main = make_address_book(&root, "Split", "Person", Some("+15550000099"), None);

        // iCloud source under <root>/Sources/<uuid>/AddressBook-v22.abcddb (email).
        let sources = root.join("Sources");
        let source_uuid = sources.join("ABCD-1234");
        std::fs::create_dir_all(&source_uuid).unwrap();
        make_address_book(&source_uuid, "Split", "Person", None, Some("split@example.com"));

        let db = ContactsDb::open(&main, Some(sources.to_str().unwrap()));
        // Both the main phone AND the iCloud-source email must resolve.
        assert_eq!(db.lookup_handle("+15550000099").as_deref(), Some("Split Person"));
        assert_eq!(db.lookup_handle("split@example.com").as_deref(), Some("Split Person"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_missing_sources_dir_is_graceful() {
        let dir = unique_tmp();
        let main = make_address_book(&dir, "Only", "Main", Some("+15550000111"), None);
        let db = ContactsDb::open(&main, Some("/nonexistent/Sources"));
        assert_eq!(db.lookup_handle("+15550000111").as_deref(), Some("Only Main"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
