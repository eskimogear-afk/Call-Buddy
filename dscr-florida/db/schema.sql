-- DSCR Florida Lead Machine — Supabase schema
-- Run this once in the Supabase SQL editor for your project.
--
-- Writes happen ONLY from the server (/api/lead) using the service-role key,
-- which bypasses RLS. We still enable RLS so the table is locked down to the
-- public anon key (no anonymous reads or inserts from the browser).

create extension if not exists "pgcrypto";

create table if not exists public.mortgage_leads (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  -- contact
  name              text not null,
  phone             text not null,
  email             text,

  -- property / deal
  property_address  text,
  city              text,
  loan_purpose      text,        -- purchase | refi_rate_term | refi_cash_out | brrrr
  property_type     text,        -- single_family | condo | 2_4_unit | short_term_rental | other
  estimated_value   numeric,
  estimated_rent    numeric,
  dscr_ratio        numeric,

  -- attribution
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,

  -- pipeline
  notes             text,
  status            text not null default 'new'  -- new | contacted | qualified | closed | dead
);

create index if not exists mortgage_leads_created_at_idx
  on public.mortgage_leads (created_at desc);

create index if not exists mortgage_leads_status_idx
  on public.mortgage_leads (status);

-- Lock the table down. The service-role key used by /api/lead bypasses RLS,
-- so no policies are needed for the server to write. With RLS enabled and no
-- policies granted to anon/authenticated, the public anon key can do nothing.
alter table public.mortgage_leads enable row level security;
