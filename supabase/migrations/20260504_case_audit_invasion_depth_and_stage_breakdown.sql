alter table audit.case_audit
  add column if not exists venous_invasion_level text,
  add column if not exists lymphatic_invasion_level text,
  add column if not exists perineural_invasion_level text;
