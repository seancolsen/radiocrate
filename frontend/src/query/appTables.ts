// The tables the app keeps its own records in — saved queries and playlists,
// the explorer's folders, presets, contextual queries — which live in a schema
// of their own, `app` (migration 0018), apart from the music in `main`. Named
// as the app names tables (`qualifiedTableName`): what a DML operation is
// built from (`dmlTable`), and what Querydown follows the `#` with.

export const APP_TABLES = {
  contextualQuery: "/app/contextual_query",
  playlist: "/app/playlist",
  playlistTrack: "/app/playlist_track",
  source: "/app/source",
} as const;
