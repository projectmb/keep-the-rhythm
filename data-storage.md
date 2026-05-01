# Data Storage & Retrieval

The plugin keeps track of daily writing activity in two layers so that stats can survive restarts while remaining performant.

1. **Dexie (IndexedDB) / Runtime cache**
   - On load `src/db/db.ts` initializes a `KTRDatabase-<vault name>` Dexie instance keyed by vault.
   - The `dailyActivity` table stores one `DailyActivity` row for each `<date, file>` pair and holds the chronological `changes` array (5-minute buckets) plus the word/char counts from when the file was first opened that day.
   - `handleEditorChange()` (from `src/core/events.ts`) updates the current `DailyActivity` entry whenever the user types, flushing to Dexie after a short debounce.
   - Various UI components (`Heatmap`, slots, entries) read from Dexie via helpers in `src/db/queries.ts` and `src/utils/utils.ts` so the displayed stats always mirror the latest local activity.

2. **Plugin-level JSON (`data.json`)**
   - `KeepTheRhythm.saveDataToJSON()` repeatedly dumps the entire Dexie contents into `this.data.stats.dailyActivity` and calls Obsidian’s `saveData()` (the built-in plugin storage) to persist `data.json` inside `.obsidian/plugins/keep-the-rhythm/`.
   - `onload()` clears Dexie, then reloads `data.json` via `loadData()` before repopulating it (`initializeDataFromJSON()`). This keeps the disk file as the source of truth for restarts.
   - `onExternalSettingsChange()` reloads `data.json` after Obsidian Sync brings in updates, merges entries by `[date + filePath]`, writes into Dexie again, and emits `REFRESH_EVERYTHING` so the UI and JSON stay in sync.

3. **Backups**
   - A daily backup of the plugin data is written under `.keep-the-rhythm/backup-<YYYY-MM-DD>-<schema>.json`. The folder is automatically created and rotated (`cleanOlderBackups()` removes files older than two weeks).
   - Backups run before any schema change so you can restore earlier states if syncing or migrations cause issues.

In short, Dexie is the working copy, every save copies Dexie → `data.json`, and Obsidian Sync/backup hooks keep that file in sync across devices.
