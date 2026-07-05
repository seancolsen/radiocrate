create schema settings;

-- User overrides for command keyboard shortcuts. A row is present only when the
-- user has changed a command's binding away from its built-in default:
--   chord = 'mod+shift+P'  -> the command is bound to that chord
--   chord = null           -> the command is explicitly unbound
--   (no row)               -> the command uses its built-in default
--
-- `command_id` is the stable snake_case command identifier (e.g.
-- 'tabs.close_active'). Unknown ids are ignored on load, so older/newer builds
-- can share a collection without losing settings.
create table settings.keybinding (
  command_id text primary key,
  chord text
);
