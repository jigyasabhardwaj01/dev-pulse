-- A checkpoint must describe a CONTIGUOUS fetched range, otherwise "committed_through" could claim data before the first run's window.
-- covered_from .. committed_through is the range that has been fetched completely and stored. Additive; no existing row changes.
-- Recovery: alter table source_checkpoints drop column if exists covered_from;
alter table source_checkpoints add column if not exists covered_from timestamptz;
