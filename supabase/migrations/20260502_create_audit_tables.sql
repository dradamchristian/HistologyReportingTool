-- Audit schema for Histology Reporting Tool
-- Purpose: store structured, dashboard-ready cancer resection audit data
-- Note: specimen number is NEVER stored; store only specimen_hash from server-side HMAC.

create schema if not exists audit;

create extension if not exists pgcrypto;

create table if not exists audit.case_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  report_generated_at timestamptz not null default now(),

  -- Core identity / governance fields
  specimen_hash text not null check (length(trim(specimen_hash)) > 0),
  consultant_name text not null check (length(trim(consultant_name)) > 0),
  dataset_id text not null check (length(trim(dataset_id)) > 0),

  -- Canonical tumour fields
  tumour_site text,
  tumour_type text,
  differentiation text,

  -- Stage fields (normalized as text to accommodate dataset-specific TNM variants)
  pt_stage text,
  pn_stage text,
  pm_stage text,

  -- Nodal burden
  nodes_examined integer check (nodes_examined is null or nodes_examined >= 0),
  nodes_positive integer check (nodes_positive is null or nodes_positive >= 0),

  -- Margin / CRM fields
  crm_involved boolean,
  crm_distance_mm numeric(8,3) check (crm_distance_mm is null or crm_distance_mm >= 0),
  margin_longitudinal_involved boolean,
  margin_distal_involved boolean,

  -- Invasion fields
  lvi_present boolean,
  pni_present boolean,
  emvi_present boolean,

  -- Treatment / misc
  neoadjuvant_given boolean,
  tumour_block text,

  -- Optional: keep rendered report text for audit traceability (policy-dependent)
  report_text text,

  -- Raw extracted payload captured at save time for remapping / backfill
  raw_extracted_json jsonb not null default '{}'::jsonb,

  -- Simple quality checks
  constraint case_audit_nodes_consistency_chk
    check (
      nodes_positive is null
      or nodes_examined is null
      or nodes_positive <= nodes_examined
    )
);

create index if not exists case_audit_created_at_idx
  on audit.case_audit (created_at desc);

create index if not exists case_audit_report_generated_at_idx
  on audit.case_audit (report_generated_at desc);

create index if not exists case_audit_dataset_id_idx
  on audit.case_audit (dataset_id);

create index if not exists case_audit_consultant_name_idx
  on audit.case_audit (consultant_name);

create index if not exists case_audit_specimen_hash_idx
  on audit.case_audit (specimen_hash);

create index if not exists case_audit_crm_involved_idx
  on audit.case_audit (crm_involved);

create index if not exists case_audit_nodes_positive_idx
  on audit.case_audit (nodes_positive);

create index if not exists case_audit_raw_extracted_gin_idx
  on audit.case_audit using gin (raw_extracted_json);

-- Edit history for manual corrections on admin page.
create table if not exists audit.case_audit_edits (
  id bigserial primary key,
  case_audit_id uuid not null references audit.case_audit(id) on delete cascade,
  edited_at timestamptz not null default now(),
  edited_by text not null,
  edit_reason text,
  before_json jsonb not null,
  after_json jsonb not null
);

create index if not exists case_audit_edits_case_id_idx
  on audit.case_audit_edits (case_audit_id, edited_at desc);

-- Optional view: most recent edit timestamp per case.
create or replace view audit.case_audit_with_last_edit as
select
  c.*,
  e.last_edited_at
from audit.case_audit c
left join (
  select case_audit_id, max(edited_at) as last_edited_at
  from audit.case_audit_edits
  group by case_audit_id
) e on e.case_audit_id = c.id;
