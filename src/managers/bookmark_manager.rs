//! Bookmark Manager for GitBrowser.
//!
//! Implements `BookmarkManagerTrait` — CRUD operations for bookmarks and folders,
//! backed by SQLite via `rusqlite`.

use rusqlite::{params, Connection};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::types::bookmark::Bookmark;
use crate::types::errors::BookmarkError;

/// Trait defining bookmark management operations.
pub trait BookmarkManagerTrait {
    fn add_bookmark(&mut self, url: &str, title: &str, folder_id: Option<&str>) -> Result<String, BookmarkError>;
    fn remove_bookmark(&mut self, id: &str) -> Result<(), BookmarkError>;
    fn update_bookmark(&mut self, id: &str, url: Option<&str>, title: Option<&str>) -> Result<(), BookmarkError>;
    fn move_bookmark(&mut self, id: &str, folder_id: Option<&str>) -> Result<(), BookmarkError>;
    fn search_bookmarks(&self, query: &str) -> Result<Vec<Bookmark>, BookmarkError>;
    fn list_bookmarks(&self, folder_id: Option<&str>) -> Result<Vec<Bookmark>, BookmarkError>;
    /// Paginated bookmark listing. Returns (bookmarks, total_count).
    fn list_bookmarks_paginated(&self, folder_id: Option<&str>, limit: i64, offset: i64) -> Result<(Vec<Bookmark>, i64), BookmarkError>;
    fn create_folder(&mut self, name: &str, parent_id: Option<&str>) -> Result<String, BookmarkError>;
    fn delete_folder(&mut self, id: &str) -> Result<(), BookmarkError>;
}

/// Bookmark manager backed by a SQLite connection.
pub struct BookmarkManager<'a> {
    conn: &'a Connection,
}

impl<'a> BookmarkManager<'a> {
    /// Creates a new `BookmarkManager` using the provided database connection.
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Returns the current UNIX timestamp in seconds.
    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }

    /// Computes the next position value for a bookmark in the given folder.
    fn next_bookmark_position(&self, folder_id: Option<&str>) -> Result<i32, BookmarkError> {
        let pos: i32 = match folder_id {
            Some(fid) => self.conn.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM bookmarks WHERE folder_id = ?1",
                params![fid],
                |row| row.get(0),
            ),
            None => self.conn.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM bookmarks WHERE folder_id IS NULL",
                [],
                |row| row.get(0),
            ),
        }
        .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;
        Ok(pos)
    }

    /// Computes the next position value for a folder under the given parent.
    fn next_folder_position(&self, parent_id: Option<&str>) -> Result<i32, BookmarkError> {
        let pos: i32 = match parent_id {
            Some(pid) => self.conn.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM bookmark_folders WHERE parent_id = ?1",
                params![pid],
                |row| row.get(0),
            ),
            None => self.conn.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM bookmark_folders WHERE parent_id IS NULL",
                [],
                |row| row.get(0),
            ),
        }
        .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;
        Ok(pos)
    }

    /// Checks whether a folder with the given ID exists.
    fn folder_exists(&self, folder_id: &str) -> Result<bool, BookmarkError> {
        let count: i32 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM bookmark_folders WHERE id = ?1",
                params![folder_id],
                |row| row.get(0),
            )
            .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;
        Ok(count > 0)
    }

    /// Reads a single `Bookmark` row into a struct.
    fn row_to_bookmark(row: &rusqlite::Row) -> rusqlite::Result<Bookmark> {
        Ok(Bookmark {
            id: row.get(0)?,
            url: row.get(1)?,
            title: row.get(2)?,
            folder_id: row.get(3)?,
            position: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    }
}

impl<'a> BookmarkManagerTrait for BookmarkManager<'a> {
    /// Adds a new bookmark. Returns the generated bookmark ID.
    fn add_bookmark(
        &mut self,
        url: &str,
        title: &str,
        folder_id: Option<&str>,
    ) -> Result<String, BookmarkError> {
        // Validate folder exists if specified
        if let Some(fid) = folder_id {
            if !self.folder_exists(fid)? {
                return Err(BookmarkError::FolderNotFound(fid.to_string()));
            }
        }

        let id = Uuid::new_v4().to_string();
        let now = Self::now();
        let position = self.next_bookmark_position(folder_id)?;

        self.conn
            .execute(
                "INSERT INTO bookmarks (id, url, title, folder_id, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, url, title, folder_id, position, now, now],
            )
            .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        Ok(id)
    }

    /// Removes a bookmark by ID.
    fn remove_bookmark(&mut self, id: &str) -> Result<(), BookmarkError> {
        let affected = self
            .conn
            .execute("DELETE FROM bookmarks WHERE id = ?1", params![id])
            .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        if affected == 0 {
            return Err(BookmarkError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// Updates the url and/or title of an existing bookmark.
    fn update_bookmark(
        &mut self,
        id: &str,
        url: Option<&str>,
        title: Option<&str>,
    ) -> Result<(), BookmarkError> {
        let now = Self::now();

        // Build dynamic update — at least one field must be provided
        let affected = match (url, title) {
            (Some(u), Some(t)) => self.conn.execute(
                "UPDATE bookmarks SET url = ?1, title = ?2, updated_at = ?3 WHERE id = ?4",
                params![u, t, now, id],
            ),
            (Some(u), None) => self.conn.execute(
                "UPDATE bookmarks SET url = ?1, updated_at = ?2 WHERE id = ?3",
                params![u, now, id],
            ),
            (None, Some(t)) => self.conn.execute(
                "UPDATE bookmarks SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![t, now, id],
            ),
            (None, None) => {
                // Nothing to update — still verify the bookmark exists
                self.conn.execute(
                    "UPDATE bookmarks SET updated_at = ?1 WHERE id = ?2",
                    params![now, id],
                )
            }
        }
        .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        if affected == 0 {
            return Err(BookmarkError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// Moves a bookmark to a different folder (or to root if `folder_id` is `None`).
    fn move_bookmark(&mut self, id: &str, folder_id: Option<&str>) -> Result<(), BookmarkError> {
        if let Some(fid) = folder_id {
            if !self.folder_exists(fid)? {
                return Err(BookmarkError::FolderNotFound(fid.to_string()));
            }
        }

        let position = self.next_bookmark_position(folder_id)?;
        let now = Self::now();

        let affected = self
            .conn
            .execute(
                "UPDATE bookmarks SET folder_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
                params![folder_id, position, now, id],
            )
            .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        if affected == 0 {
            return Err(BookmarkError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// Searches bookmarks by title or URL using SQL LIKE.
    fn search_bookmarks(&self, query: &str) -> Result<Vec<Bookmark>, BookmarkError> {
        let pattern = format!("%{}%", query);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, url, title, folder_id, position, created_at, updated_at \
                 FROM bookmarks WHERE title LIKE ?1 OR url LIKE ?2 ORDER BY position",
            )
            .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        let rows = stmt
            .query_map(params![pattern, pattern], Self::row_to_bookmark)
            .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| BookmarkError::DatabaseError(e.to_string()))?);
        }
        Ok(results)
    }

    /// Lists bookmarks in a specific folder (or root if `folder_id` is `None`).
    fn list_bookmarks(&self, folder_id: Option<&str>) -> Result<Vec<Bookmark>, BookmarkError> {
        let mut stmt = match folder_id {
            Some(_) => self.conn.prepare(
                "SELECT id, url, title, folder_id, position, created_at, updated_at \
                 FROM bookmarks WHERE folder_id = ?1 ORDER BY position",
            ),
            None => self.conn.prepare(
                "SELECT id, url, title, folder_id, position, created_at, updated_at \
                 FROM bookmarks WHERE folder_id IS NULL ORDER BY position",
            ),
        }
        .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        let rows = match folder_id {
            Some(fid) => stmt.query_map(params![fid], Self::row_to_bookmark),
            None => stmt.query_map([], Self::row_to_bookmark),
        }
        .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| BookmarkError::DatabaseError(e.to_string()))?);
        }
        Ok(results)
    }

    /// Creates a new bookmark folder. Returns the generated folder ID.
    fn create_folder(
        &mut self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<String, BookmarkError> {
        if let Some(pid) = parent_id {
            if !self.folder_exists(pid)? {
                return Err(BookmarkError::FolderNotFound(pid.to_string()));
            }
        }

        let id = Uuid::new_v4().to_string();
        let position = self.next_folder_position(parent_id)?;

        self.conn
            .execute(
                "INSERT INTO bookmark_folders (id, name, parent_id, position) VALUES (?1, ?2, ?3, ?4)",
                params![id, name, parent_id, position],
            )
            .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        Ok(id)
    }

    /// Deletes a bookmark folder by ID.
    ///
    /// Bookmarks inside the folder will have their `folder_id` set to `NULL` (moved to root).
    fn delete_folder(&mut self, id: &str) -> Result<(), BookmarkError> {
        // Move contained bookmarks to root before deleting the folder
        self.conn
            .execute(
                "UPDATE bookmarks SET folder_id = NULL WHERE folder_id = ?1",
                params![id],
            )
            .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        // Move child folders to root
        self.conn
            .execute(
                "UPDATE bookmark_folders SET parent_id = NULL WHERE parent_id = ?1",
                params![id],
            )
            .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        let affected = self
            .conn
            .execute("DELETE FROM bookmark_folders WHERE id = ?1", params![id])
            .map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        if affected == 0 {
            return Err(BookmarkError::FolderNotFound(id.to_string()));
        }
        Ok(())
    }

    fn list_bookmarks_paginated(&self, folder_id: Option<&str>, limit: i64, offset: i64) -> Result<(Vec<Bookmark>, i64), BookmarkError> {
        let total: i64 = match folder_id {
            Some(fid) => self.conn.query_row(
                "SELECT COUNT(*) FROM bookmarks WHERE folder_id = ?1",
                params![fid],
                |row| row.get(0),
            ),
            None => self.conn.query_row(
                "SELECT COUNT(*) FROM bookmarks WHERE folder_id IS NULL",
                [],
                |row| row.get(0),
            ),
        }.map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        let mut stmt = match folder_id {
            Some(_) => self.conn.prepare(
                "SELECT id, url, title, folder_id, position, created_at, updated_at \
                 FROM bookmarks WHERE folder_id = ?1 ORDER BY position LIMIT ?2 OFFSET ?3",
            ),
            None => self.conn.prepare(
                "SELECT id, url, title, folder_id, position, created_at, updated_at \
                 FROM bookmarks WHERE folder_id IS NULL ORDER BY position LIMIT ?1 OFFSET ?2",
            ),
        }.map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        let rows = match folder_id {
            Some(fid) => stmt.query_map(params![fid, limit, offset], Self::row_to_bookmark),
            None => stmt.query_map(params![limit, offset], Self::row_to_bookmark),
        }.map_err(|e| BookmarkError::DatabaseError(e.to_string()))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| BookmarkError::DatabaseError(e.to_string()))?);
        }
        Ok((results, total))
    }
}
