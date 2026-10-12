-- JARVIS 2.0: record an owner decision atomically (supersede the current one, insert the new one, move the item's state, log the event).
-- ADDITIVE and re-runnable: one new function, nothing existing is altered. Apply after migrations_006/007.
-- Recovery: drop function if exists record_review_decision(uuid, text, text, text, jsonb, jsonb, boolean);
--
-- Callable only by the server's service-role key: execute is revoked from public, anon and authenticated.
create or replace function record_review_decision(
  p_item uuid, p_outcome text, p_by text, p_rationale text, p_evidence jsonb, p_votes jsonb, p_followup boolean
) returns bigint
language plpgsql
set search_path = public, pg_temp as $$
declare
  new_id bigint;
  new_state text;
begin
  if not exists (select 1 from review_items where id = p_item for update) then
    raise exception 'review item % not found', p_item using errcode = 'no_data_found';
  end if;
  update review_decisions set superseded_at = now() where item_id = p_item and superseded_at is null;
  insert into review_decisions (item_id, outcome, decided_by, rationale, evidence, vote_snapshot, followup)
  values (p_item, p_outcome, p_by, p_rationale, p_evidence, p_votes, coalesce(p_followup, false))
  returning id into new_id;
  new_state := p_outcome; -- outcomes and final states share their names
  update review_items set state = new_state, updated_at = now() where id = p_item;
  insert into review_events (item_id, actor, action, detail)
  values (p_item, p_by, 'decision_recorded', jsonb_build_object('decision_id', new_id, 'outcome', p_outcome, 'votes', p_votes));
  return new_id;
end $$;
revoke all on function record_review_decision(uuid, text, text, text, jsonb, jsonb, boolean) from public, anon, authenticated;
