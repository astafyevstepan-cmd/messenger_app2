const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "messenger.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL,
  to_user INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read INTEGER DEFAULT 0,
  FOREIGN KEY(from_user) REFERENCES users(id),
  FOREIGN KEY(to_user) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_user, to_user);
`);

module.exports = db;
