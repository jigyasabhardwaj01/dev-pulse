-- Security hardening flagged by Supabase's linter (function_search_path_mutable).
-- Pins the search_path of the delivered-report trigger function so it can never resolve names through a caller-controlled path.
-- ADDITIVE and re-runnable: no table, column, row or constraint is touched, and the function body is unchanged.
-- Apply after migrations_004_report_integrity.sql.
alter function public.briefs_protect_delivered() set search_path = public, pg_temp;
