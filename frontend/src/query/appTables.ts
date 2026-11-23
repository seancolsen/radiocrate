// The tables the app keeps its own records in, apart from the music in `main`:
// saved queries and playlists, the explorer's folders and presets live in a
// schema of their own, `app` (migration 0018), and contextual queries with the
// rest of what customizes the user's tables, in `metadata` (migration 0019).
// Named as the app names tables (`qualifiedTableName`): what a DML operation is
// built from (`dmlTable`), and what Querydown follows the `#` with.

export const APP_TABLES = {
  contextualQuery: "/metadata/contextual_query",
  playlist: "/app/playlist",
  playlistTrack: "/app/playlist_track",
  source: "/app/source",
} as const;
