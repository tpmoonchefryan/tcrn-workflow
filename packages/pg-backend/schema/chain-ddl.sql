-- SPDX-License-Identifier: Apache-2.0
-- TCRN-CROSS-STORY-175 / ADR 0004 §2-§4 — the chain schema DDL.
--
-- One database `tcrn_governance`, five per-chain schemas (`chain_<partition>`),
-- one domain schema, one collaboration placeholder. The engine role
-- (`tcrn_engine`) is the ONLY role with chain-write; append-only is enforced by
-- triggers; the events table is structurally append-only.
--
-- This script is applied by the engine's schema-DDL verb (STORY-175.1) on the
-- VM's single instance bound to loopback. It is NOT applied by hand.

-- Roles (ADR §3). Idempotent creation.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tcrn_engine') then
    create role tcrn_engine;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tcrn_domain') then
    create role tcrn_domain;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tcrn_collab') then
    create role tcrn_collab;
  end if;
end
$$;

-- One database (created by the operator; loopback-only listen).
--   createdb tcrn_governance

-- The five chain schemas, the domain schema, and the collab placeholder.
create schema if not exists chain_aos;
create schema if not exists chain_cross;
create schema if not exists chain_ds;
create schema if not exists chain_tms;
create schema if not exists chain_joi;
create schema if not exists domain;
create schema if not exists collab;

-- Events table per chain (ADR §4): all nine EventRecord fields as columns,
-- canonical bytes stored verbatim, sequence-continuity enforced. The trigger is
-- a fail-closed first line only — the engine re-validates the whole chain on
-- read (validateEventChain), which is the authority. TG_TABLE_SCHEMA resolves
-- the owning chain schema so one function serves all five schemas.
create or replace function chain_append_only_trigger() returns trigger
language plpgsql as $$
declare
  head_sequence integer;
  head_event_hash text;
begin
  if tg_op = 'DELETE' then
    raise exception 'chain events are append-only';
  end if;
  if tg_op = 'UPDATE' then
    -- The engine rewrites the whole segment on each append (segment-replace
    -- semantics). A no-op UPDATE that re-presents an existing event with
    -- identical bytes is the idempotent re-insert the rewrite implies and is
    -- allowed; a genuine mutation of a committed row is refused.
    if old.sequence = new.sequence and old.id = new.id and old.stream_id = new.stream_id
       and old.schema_version = new.schema_version and old.occurred_at = new.occurred_at
       and old.prior_hash is not distinct from new.prior_hash
       and old.payload = new.payload and old.payload_hash = new.payload_hash
       and old.event_hash = new.event_hash then
      return new;
    end if;
    raise exception 'chain events are append-only';
  end if;
  execute format('select max(sequence), (select event_hash from %I.events order by sequence desc limit 1) from %I.events', tg_table_schema, tg_table_schema)
    into head_sequence, head_event_hash;
  -- The engine rewrites the whole segment on each append, re-presenting already
  -- committed events. A re-presented event (sequence already at or below the
  -- head) is a no-op the ON CONFLICT path absorbs — allow it and let the
  -- conflict branch confirm the bytes are identical. Only a sequence past the
  -- head must satisfy the continuity checks.
  if new.sequence <= coalesce(head_sequence, 0) then
    return new;
  end if;
  if new.sequence = 1 then
    if head_sequence is not null or new.prior_hash is not null then
      raise exception 'sequence 1 must be the first event with null prior_hash';
    end if;
  else
    if new.prior_hash is null then
      raise exception 'non-first event requires a prior_hash';
    end if;
    if head_sequence is null or new.sequence <> head_sequence + 1 then
      raise exception 'sequence is not contiguous';
    end if;
    if head_event_hash is null or new.prior_hash <> head_event_hash then
      raise exception 'prior_hash does not match the preceding head';
    end if;
  end if;
  return new;
end
$$;

-- Attach the trigger + append-only to every chain schema.
do $$
declare
  schema_name text;
begin
  foreach schema_name in array array['chain_aos','chain_cross','chain_ds','chain_tms','chain_joi']
  loop
    execute format(
      'create table if not exists %I.events (
        sequence       integer primary key,
        id             text not null unique,
        stream_id      text not null,
        schema_version text not null,
        occurred_at    text not null,
        prior_hash     text,
        payload        bytea not null,
        payload_hash   text not null,
        event_hash     text not null unique,
        check (sequence >= 1),
        check ((sequence = 1) = (prior_hash is null))
      )', schema_name);
    execute format(
      'create table if not exists %I.metadata (
        id    integer primary key default 1 check (id = 1),
        bytes bytea not null
      )', schema_name);
    execute format(
      'create table if not exists %I.views (
        name  text primary key,
        bytes bytea not null
      )', schema_name);
    -- STORY-177: the knowledge/artifact store data plane in PG. The marker
    -- (store.json) is a single row; records and bodies are keyed by id; the
    -- knowledge derived view is a single row. These mirror the file store's
    -- content so the two-store PG backend can round-trip byte-exactly.
    execute format(
      'create table if not exists %I.knowledge_marker (
        id    integer primary key default 1 check (id = 1),
        bytes bytea not null
      )', schema_name);
    execute format(
      'create table if not exists %I.knowledge_metadata (
        id    text primary key,
        bytes bytea not null
      )', schema_name);
    execute format(
      'create table if not exists %I.knowledge_bodies (
        id    text primary key,
        bytes bytea not null
      )', schema_name);
    execute format(
      'create table if not exists %I.knowledge_views (
        id    integer primary key default 1 check (id = 1),
        bytes bytea not null
      )', schema_name);
    execute format(
      'create table if not exists %I.artifact_marker (
        id    integer primary key default 1 check (id = 1),
        bytes bytea not null
      )', schema_name);
    execute format(
      'create table if not exists %I.artifact_records (
        id    text primary key,
        bytes bytea not null
      )', schema_name);
    execute format(
      'drop trigger if exists events_append_only on %I.events',
      schema_name);
    execute format(
      'create trigger events_append_only
       before insert or update or delete on %I.events
       for each row execute function chain_append_only_trigger()',
      schema_name);
    execute format('revoke truncate on %I.events from public', schema_name);
  end loop;
end
$$;

-- GRANT matrix (ADR §3): engine writes chains; domain owns domain; collab
-- reads chains only and uses collab schema. Everyone SELECTs chains.
do $$
declare
  schema_name text;
begin
  foreach schema_name in array array['chain_aos','chain_cross','chain_ds','chain_tms','chain_joi']
  loop
    execute format('grant usage on schema %I to tcrn_engine, tcrn_domain, tcrn_collab', schema_name);
    execute format('grant select on all tables in schema %I to tcrn_engine, tcrn_domain, tcrn_collab', schema_name);
    execute format('grant insert, update, delete on all tables in schema %I to tcrn_engine', schema_name);
    execute format('grant create on schema %I to tcrn_engine', schema_name);
  end loop;
  grant usage, create on schema domain to tcrn_domain;
  grant usage on schema collab to tcrn_collab;
end
$$;
