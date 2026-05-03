create schema if not exists audit;

create table if not exists audit.generation_usage (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  dataset text,
  requested_mode text not null,
  actual_model text not null,
  duration_ms integer,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  estimated_cost_usd numeric(12,6),
  success boolean not null default true,
  error_message text,
  deploy_context text
);

create index if not exists generation_usage_created_at_idx on audit.generation_usage (created_at desc);
create index if not exists generation_usage_model_idx on audit.generation_usage (actual_model);
