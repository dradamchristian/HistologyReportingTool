create table if not exists audit.report_generation_audit (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  model text,
  duration_ms integer,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  estimated_cost_usd numeric(12,6),
  template_key text,
  dataset_id text,
  success boolean not null default true,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists report_generation_audit_created_at_idx on audit.report_generation_audit (created_at desc);
create index if not exists report_generation_audit_model_idx on audit.report_generation_audit (model);
create index if not exists report_generation_audit_template_key_idx on audit.report_generation_audit (template_key);
create index if not exists report_generation_audit_success_idx on audit.report_generation_audit (success);
