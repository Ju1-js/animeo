const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const dbDir = path.join(__dirname, "..", "db");
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, "id-cache.db");
console.log(`[SQLite] Initializing database at: ${dbPath}`);
const db = new sqlite3.Database(dbPath);

const validSources = ["thetvdb", "themoviedb", "kitsu", "imdb"];

db.serialize(() => {
  db.run(`PRAGMA journal_mode = WAL;`);
  db.run(
    `CREATE TABLE IF NOT EXISTS ids (
    anilist INTEGER PRIMARY KEY NOT NULL,
    kitsu INTEGER UNIQUE,
    imdb TEXT UNIQUE, -- IMDB IDs are strings like tt123456
    thetvdb INTEGER UNIQUE,
    themoviedb INTEGER UNIQUE
  )`,
    (err) => {
      if (err) console.error("[SQLite] Error creating 'ids' table:", err);
      else console.log("[SQLite] 'ids' table checked/created successfully.");
    }
  );
  // Add indices for faster lookups
  db.run(`CREATE INDEX IF NOT EXISTS idx_kitsu ON ids(kitsu)`, (err) => {
    if (err) console.error("[SQLite] Error creating kitsu index:", err);
  });
  db.run(`CREATE INDEX IF NOT EXISTS idx_imdb ON ids(imdb)`, (err) => {
    if (err) console.error("[SQLite] Error creating imdb index:", err);
  });
  db.run(`CREATE INDEX IF NOT EXISTS idx_thetvdb ON ids(thetvdb)`, (err) => {
    if (err) console.error("[SQLite] Error creating thetvdb index:", err);
  });
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_themoviedb ON ids(themoviedb)`,
    (err) => {
      if (err) console.error("[SQLite] Error creating themoviedb index:", err);
    }
  );
});

// Get Anilist ID based on an external source ID
async function getFromDatabase(id, source) {
  const validSources = ["kitsu", "imdb", "thetvdb", "themoviedb"];
  if (!validSources.includes(source)) {
    console.error(
      `[SQLite] Invalid source provided to getFromDatabase: ${source}`
    );
    return Promise.reject(new Error("Invalid source column"));
  }
  const sql = `SELECT anilist FROM ids WHERE ${source} = ?`;
  // console.log(`[SQLite Query] ${sql} [${id}]`);
  return new Promise((resolve, reject) => {
    db.get(sql, [id], (err, row) => {
      if (err) {
        console.error(
          `[SQLite Error] Failed getFromDatabase (${source}=${id}):`,
          err.message
        );
        reject(err);
      } else {
        resolve(row ? row.anilist : null);
      }
    });
  });
}

// Cache mapping from external ID to Anilist ID
async function cacheToDatabase(anilistId, externalId, source) {
  const validSources = ["kitsu", "imdb", "thetvdb", "themoviedb"];
  if (!validSources.includes(source)) {
    console.error(
      `[SQLite] Invalid source provided to cacheToDatabase: ${source}`
    );
    return Promise.reject(new Error("Invalid source column"));
  }
  // Use INSERT OR IGNORE for the primary key (anilist), then UPDATE the specific source column
  // This handles cases where the anilist ID exists but the mapping for this source wasn't set yet.
  const sql = `
        INSERT INTO ids (anilist, ${source}) VALUES (?, ?)
        ON CONFLICT(anilist) DO UPDATE SET ${source} = excluded.${source}
        WHERE ${source} IS NULL OR ${source} != excluded.${source};
    `;
  // console.log(`[SQLite Query] ${sql} [${anilistId}, ${externalId}]`);
  return new Promise((resolve, reject) => {
    db.run(sql, [anilistId, externalId], function (err) {
      // Use function() to access this.changes
      if (err) {
        // Handle UNIQUE constraint errors gracefully (e.g., trying to map a different anilistId to an already mapped externalId)
        if (err.message.includes("UNIQUE constraint failed")) {
          console.warn(
            `[SQLite] UNIQUE constraint failed for ${source}:${externalId}. It might already be mapped to a different Anilist ID. Anilist ID ${anilistId} was not inserted/updated for this source.`
          );
          resolve(); // Resolve successfully, as this isn't a critical failure for the operation's goal
        } else {
          console.error(
            `[SQLite Error] Failed cacheToDatabase (${source}=${externalId} -> anilist=${anilistId}):`,
            err.message
          );
          reject(err);
        }
      } else {
        // if (this.changes > 0) console.log(`[SQLite] Cached ${source}:${externalId} -> anilist:${anilistId}`);
        resolve();
      }
    });
  });
}

// Get external ID (tvdb, tmdb) based on Anilist ID
async function getExternalIdFromDb(anilistId, targetSource) {
  if (!validSources.includes(targetSource)) {
    console.error(
      `[SQLite] Invalid targetSource provided to getExternalIdFromDb: ${targetSource}`
    );
    return Promise.reject(new Error("Invalid target source column"));
  }
  const sql = `SELECT ${targetSource} FROM ids WHERE anilist = ?`;
  // console.log(`[SQLite Query] ${sql} [${anilistId}]`);
  return new Promise((resolve, reject) => {
    db.get(sql, [anilistId], (err, row) => {
      if (err) {
        console.error(
          `[SQLite Error] Failed getExternalIdFromDb (anilist=${anilistId} -> ${targetSource}):`,
          err.message
        );
        reject(err);
      } else {
        resolve(row ? row[targetSource] : null);
      }
    });
  });
}

// Cache mapping from Anilist ID to external ID (tvdb, tmdb)
async function cacheExternalIdToDb(anilistId, externalId, targetSource) {
  if (!validSources.includes(targetSource)) {
    console.error(
      `[SQLite] Invalid targetSource provided to cacheExternalIdToDb: ${targetSource}`
    );
    return Promise.reject(new Error("Invalid target source column"));
  }

  // Ensure the anilist ID row exists, then update the target source column
  const sql = `
        INSERT INTO ids (anilist, ${targetSource}) VALUES (?, ?)
        ON CONFLICT(anilist) DO UPDATE SET ${targetSource} = excluded.${targetSource}
        WHERE ${targetSource} IS NULL OR ${targetSource} != excluded.${targetSource};
     `;
  // console.log(`[SQLite Query] ${sql} [${anilistId}, ${externalId}]`);
  return new Promise((resolve, reject) => {
    db.run(sql, [anilistId, externalId], function (err) {
      // Use function() to access this.changes
      if (err) {
        // Handle UNIQUE constraint errors (e.g., the external ID already exists mapped to a different anilist ID)
        if (err.message.includes("UNIQUE constraint failed")) {
          console.warn(
            `[SQLite] UNIQUE constraint failed for ${targetSource}:${externalId}. It might already be mapped to a different Anilist ID. Anilist ID ${anilistId} was not updated with this external ID.`
          );
          resolve();
        } else {
          console.error(
            `[SQLite Error] Failed cacheExternalIdToDb (anilist=${anilistId} -> ${targetSource}=${externalId}):`,
            err.message
          );
          reject(err);
        }
      } else {
        // if (this.changes > 0) console.log(`[SQLite] Cached anilist:${anilistId} -> ${targetSource}:${externalId}`);
        resolve();
      }
    });
  });
}

// Graceful shutdown
let shuttingDown = false;
function closeDb() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[SQLite] Closing database connection...");
  db.close((err) => {
    if (err) {
      console.error("[SQLite] Error closing database:", err.message);
      process.exit(1);
    } else {
      console.log("[SQLite] Database connection closed.");
      process.exit(0);
    }
  });
}

process.on("SIGINT", closeDb);
process.on("SIGTERM", closeDb);

module.exports = {
  getFromDatabase,
  cacheToDatabase,
  getExternalIdFromDb,
  cacheExternalIdToDb,
};
