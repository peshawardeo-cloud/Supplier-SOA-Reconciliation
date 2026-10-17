-- =====================================================================
-- Migration 0002: Suppliers, reconciliation periods, SOA import
-- Requires 0001 to have been run first.
-- Run once in: Supabase dashboard -> SQL Editor -> New query -> Run
-- =====================================================================

-- ---------- Types ----------
create type public.period_status as enum
  ('draft', 'in_progress', 'under_review', 'completed', 'locked');

create type public.soa_entry_type as enum
  ('invoice', 'credit_note', 'debit_note', 'payment', 'opening_balance', 'adjustment', 'other');

create type public.import_status as enum
  ('uploaded', 'needs_mapping', 'staged', 'committed', 'failed', 'reverted');

-- ---------- Suppliers ----------
create table public.suppliers (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null,
  name                text not null,
  vat_number          text,
  cr_number           text,
  account_ref         text,            -- OUR account/customer number at this supplier (printed on their statements)
  contact_name        text,
  email               text,
  phone               text,
  address             text,
  currency            text not null default 'SAR',
  payment_terms_days  integer,
  notes               text,
  is_active           boolean not null default true,
  deleted_at          timestamptz,
  created_by          uuid default auth.uid() references auth.users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint suppliers_code_nonblank check (length(trim(code)) > 0),
  constraint suppliers_name_nonblank check (length(trim(name)) > 0),
  constraint suppliers_currency_fmt  check (currency ~ '^[A-Z]{3}$'),
  constraint suppliers_terms_range   check (payment_terms_days is null or payment_terms_days between 0 and 365)
);

create unique index suppliers_code_unique on public.suppliers (lower(code)) where deleted_at is null;
create index suppliers_name_idx on public.suppliers (lower(name));

create table public.supplier_aliases (
  id          uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  alias_name  text not null,
  created_at  timestamptz not null default now(),
  constraint alias_nonblank check (length(trim(alias_name)) > 0)
);
create unique index supplier_aliases_unique on public.supplier_aliases (supplier_id, lower(alias_name));

-- ---------- Reconciliation periods ----------
create table public.reconciliation_periods (
  id                        uuid primary key default gen_random_uuid(),
  supplier_id               uuid not null references public.suppliers (id) on delete restrict,
  period_start              date not null,
  period_end                date not null,
  statement_date            date,
  status                    public.period_status not null default 'draft',
  reported_opening_balance  numeric(18,2),   -- supplier-reported figures, kept apart from our calculations
  reported_closing_balance  numeric(18,2),
  notes                     text,
  completed_by              uuid references auth.users (id),
  completed_at              timestamptz,
  created_by                uuid default auth.uid() references auth.users (id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint period_dates_ok check (period_end >= period_start),
  constraint period_unique unique (supplier_id, period_start, period_end)
);
create index periods_supplier_idx on public.reconciliation_periods (supplier_id, period_end desc);

-- Locking rules: only admins lock/unlock; a locked period cannot be edited.
create or replace function public.period_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'locked' then
    if not public.has_role(array['admin']::public.user_role[]) then
      raise exception 'This period is locked. Only an administrator can unlock it.';
    end if;
    if new.status = 'locked' then
      raise exception 'Unlock the period before editing it.';
    end if;
  end if;
  if new.status = 'locked' and old.status <> 'locked'
     and not public.has_role(array['admin']::public.user_role[]) then
    raise exception 'Only an administrator can lock a period.';
  end if;
  if new.status = 'completed' and old.status <> 'completed' then
    new.completed_by := auth.uid();
    new.completed_at := now();
  end if;
  return new;
end;
$$;

create trigger periods_guard
  before update on public.reconciliation_periods
  for each row execute function public.period_guard();

-- ---------- Import tracking ----------
create table public.import_batches (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     uuid not null references public.suppliers (id) on delete restrict,
  period_id       uuid references public.reconciliation_periods (id) on delete restrict,
  import_type     text not null check (import_type in ('soa', 'po', 'dn', 'invoice')),
  file_name       text not null,
  file_kind       text not null check (file_kind in ('pdf', 'xlsx', 'csv')),
  storage_path    text not null,
  file_hash       text not null,            -- SHA-256 of the file, blocks uploading the same file twice
  sheet_name      text,
  column_mapping  jsonb,
  status          public.import_status not null default 'uploaded',
  total_rows      integer not null default 0,
  valid_rows      integer not null default 0,
  error_rows      integer not null default 0,
  duplicate_rows  integer not null default 0,
  imported_rows   integer not null default 0,
  control         jsonb,                    -- figures printed on the statement + our comparison
  error_message   text,
  created_by      uuid default auth.uid() references auth.users (id),
  created_at      timestamptz not null default now(),
  committed_by    uuid references auth.users (id),
  committed_at    timestamptz,
  reverted_by     uuid references auth.users (id),
  reverted_at     timestamptz,
  revert_reason   text
);

-- The same file cannot be imported twice for a supplier (failed or reverted batches may be retried).
create unique index import_batches_file_once
  on public.import_batches (supplier_id, import_type, file_hash)
  where status not in ('failed', 'reverted');
create index import_batches_period_idx on public.import_batches (period_id, created_at desc);

create table public.import_staging_rows (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references public.import_batches (id) on delete restrict,
  row_number      integer not null,
  raw             jsonb not null,           -- exactly what was in the file
  mapped          jsonb not null,           -- what the system understood
  status          text not null check (status in ('valid', 'error', 'duplicate')),
  issues          jsonb not null default '[]'::jsonb,
  duplicate_of    uuid,
  user_decision   text check (user_decision in ('import', 'skip')),
  decision_note   text,
  constraint staging_row_unique unique (batch_id, row_number)
);
create index staging_batch_status_idx on public.import_staging_rows (batch_id, status);

-- ---------- Imported SOA entries ----------
create table public.soa_entries (
  id                        uuid primary key default gen_random_uuid(),
  supplier_id               uuid not null references public.suppliers (id) on delete restrict,
  period_id                 uuid not null references public.reconciliation_periods (id) on delete restrict,
  batch_id                  uuid not null references public.import_batches (id) on delete restrict,
  source_row                integer not null,
  entry_type                public.soa_entry_type not null,
  doc_number                text not null,
  doc_number_norm           text not null,
  doc_date                  date not null,
  due_date                  date,
  account_ref               text,
  delivery_ref              text,
  po_ref                    text,
  description               text,
  debit                     numeric(18,2) not null default 0,   -- increases what we owe
  credit                    numeric(18,2) not null default 0,   -- reduces what we owe
  reported_running_balance  numeric(18,2),
  currency                  text,
  raw                       jsonb not null,
  row_fingerprint           text not null,
  force_imported            boolean not null default false,
  deleted_at                timestamptz,
  created_by                uuid default auth.uid() references auth.users (id),
  created_at                timestamptz not null default now(),
  constraint soa_amounts_nonneg check (debit >= 0 and credit >= 0)
);

-- One entry per document per type in a period (unless a user knowingly forced a duplicate in).
create unique index soa_entries_no_dupes
  on public.soa_entries (period_id, entry_type, doc_number_norm)
  where deleted_at is null and not force_imported;
create index soa_entries_supplier_doc_idx on public.soa_entries (supplier_id, doc_number_norm);
create index soa_entries_period_idx on public.soa_entries (period_id) where deleted_at is null;
create index soa_entries_fingerprint_idx on public.soa_entries (row_fingerprint);

-- Imported financial data is never edited. Only deleted_at may change (done by a controlled revert).
create or replace function public.soa_entries_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'deleted_at') is distinct from (to_jsonb(old) - 'deleted_at') then
      raise exception 'Imported statement entries cannot be edited.';
    end if;
    return new;
  end if;

  if not exists (
    select 1 from public.reconciliation_periods p
    where p.id = new.period_id and p.status in ('draft', 'in_progress')
  ) then
    raise exception 'This reconciliation period is not open for imports.';
  end if;
  return new;
end;
$$;

create trigger soa_entries_guard_trg
  before insert or update on public.soa_entries
  for each row execute function public.soa_entries_guard();

-- ---------- updated_at + audit triggers ----------
create trigger suppliers_set_updated_at before update on public.suppliers
  for each row execute function public.set_updated_at();
create trigger periods_set_updated_at before update on public.reconciliation_periods
  for each row execute function public.set_updated_at();

create trigger suppliers_audit after insert or update or delete on public.suppliers
  for each row execute function public.audit_row();
create trigger periods_audit after insert or update or delete on public.reconciliation_periods
  for each row execute function public.audit_row();
create trigger import_batches_audit after insert or update or delete on public.import_batches
  for each row execute function public.audit_row();
create trigger soa_entries_audit after insert or update or delete on public.soa_entries
  for each row execute function public.audit_row();

-- ---------- Atomic commit: either every accepted row is imported, or none ----------
create or replace function public.commit_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  b public.import_batches%rowtype;
  inserted_count integer;
  skipped_dupes integer;
begin
  if not public.has_role(array['admin', 'accountant']::public.user_role[]) then
    raise exception 'You do not have permission to commit imports.';
  end if;

  select * into b from public.import_batches where id = p_batch_id for update;
  if not found then raise exception 'Import not found.'; end if;
  if b.import_type <> 'soa' then raise exception 'Only SOA imports are supported in this version.'; end if;
  if b.status <> 'staged' then raise exception 'This import is not ready to commit (status: %).', b.status; end if;
  if b.period_id is null then raise exception 'This import has no reconciliation period.'; end if;

  insert into public.soa_entries (
    supplier_id, period_id, batch_id, source_row, entry_type, doc_number, doc_number_norm,
    doc_date, due_date, account_ref, delivery_ref, po_ref, description,
    debit, credit, currency, raw, row_fingerprint, force_imported
  )
  select
    b.supplier_id, b.period_id, b.id, s.row_number,
    (s.mapped ->> 'entry_type')::public.soa_entry_type,
    s.mapped ->> 'doc_number',
    s.mapped ->> 'doc_number_norm',
    (s.mapped ->> 'doc_date')::date,
    nullif(s.mapped ->> 'due_date', '')::date,
    nullif(s.mapped ->> 'account_ref', ''),
    nullif(s.mapped ->> 'delivery_ref', ''),
    nullif(s.mapped ->> 'po_ref', ''),
    nullif(s.mapped ->> 'description', ''),
    coalesce((s.mapped ->> 'debit')::numeric, 0),
    coalesce((s.mapped ->> 'credit')::numeric, 0),
    nullif(s.mapped ->> 'currency', ''),
    s.raw,
    s.mapped ->> 'row_fingerprint',
    (s.status = 'duplicate')
  from public.import_staging_rows s
  where s.batch_id = p_batch_id
    and (s.status = 'valid' or (s.status = 'duplicate' and s.user_decision = 'import'));
  get diagnostics inserted_count = row_count;

  select count(*) into skipped_dupes
  from public.import_staging_rows s
  where s.batch_id = p_batch_id and s.status = 'duplicate' and coalesce(s.user_decision, 'skip') <> 'import';

  update public.import_batches
     set status = 'committed', imported_rows = inserted_count,
         committed_at = now(), committed_by = auth.uid()
   where id = p_batch_id;

  return jsonb_build_object('imported', inserted_count, 'skipped_duplicates', skipped_dupes);
end;
$$;

-- ---------- Controlled revert (admin only, reason required, history kept) ----------
create or replace function public.revert_import_batch(p_batch_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.import_batches%rowtype;
  pstatus public.period_status;
begin
  if not public.has_role(array['admin']::public.user_role[]) then
    raise exception 'Only an administrator can revert an import.';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to revert an import.';
  end if;

  select * into b from public.import_batches where id = p_batch_id for update;
  if not found then raise exception 'Import not found.'; end if;
  if b.status <> 'committed' then raise exception 'Only a committed import can be reverted.'; end if;

  select status into pstatus from public.reconciliation_periods where id = b.period_id;
  if pstatus in ('completed', 'locked') then
    raise exception 'Re-open the period before reverting an import.';
  end if;

  update public.soa_entries set deleted_at = now() where batch_id = p_batch_id and deleted_at is null;
  update public.import_batches
     set status = 'reverted', reverted_at = now(), reverted_by = auth.uid(), revert_reason = p_reason
   where id = p_batch_id;
end;
$$;

revoke all on function public.commit_import_batch(uuid) from public, anon;
revoke all on function public.revert_import_batch(uuid, text) from public, anon;
grant execute on function public.commit_import_batch(uuid) to authenticated;
grant execute on function public.revert_import_batch(uuid, text) to authenticated;

-- ---------- Remembered column mappings (one per supplier and import type) ----------
create table public.import_mapping_templates (
  id          uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  import_type text not null check (import_type in ('soa', 'po', 'dn', 'invoice')),
  mapping     jsonb not null,
  created_by  uuid default auth.uid() references auth.users (id),
  updated_at  timestamptz not null default now(),
  constraint mapping_template_unique unique (supplier_id, import_type)
);
create trigger mapping_templates_set_updated_at before update on public.import_mapping_templates
  for each row execute function public.set_updated_at();

-- ---------- Totals of imported statement entries for one period (respects RLS) ----------
create or replace function public.soa_period_summary(p_period_id uuid)
returns table (entry_type public.soa_entry_type, entries bigint, debit numeric, credit numeric)
language sql
stable
set search_path = public
as $$
  select e.entry_type, count(*), coalesce(sum(e.debit), 0), coalesce(sum(e.credit), 0)
  from public.soa_entries e
  where e.period_id = p_period_id and e.deleted_at is null
  group by e.entry_type
  order by e.entry_type
$$;
revoke all on function public.soa_period_summary(uuid) from public, anon;
grant execute on function public.soa_period_summary(uuid) to authenticated;

-- ---------- Row Level Security ----------
alter table public.suppliers              enable row level security;
alter table public.supplier_aliases       enable row level security;
alter table public.reconciliation_periods enable row level security;
alter table public.import_batches         enable row level security;
alter table public.import_staging_rows    enable row level security;
alter table public.soa_entries            enable row level security;
alter table public.import_mapping_templates enable row level security;

-- Everyone active may read.
create policy suppliers_read   on public.suppliers              for select to authenticated using (public.has_role(array['admin','accountant','viewer']::public.user_role[]));
create policy aliases_read     on public.supplier_aliases       for select to authenticated using (public.has_role(array['admin','accountant','viewer']::public.user_role[]));
create policy periods_read     on public.reconciliation_periods for select to authenticated using (public.has_role(array['admin','accountant','viewer']::public.user_role[]));
create policy batches_read     on public.import_batches         for select to authenticated using (public.has_role(array['admin','accountant','viewer']::public.user_role[]));
create policy staging_read     on public.import_staging_rows    for select to authenticated using (public.has_role(array['admin','accountant','viewer']::public.user_role[]));
create policy soa_entries_read on public.soa_entries            for select to authenticated using (public.has_role(array['admin','accountant','viewer']::public.user_role[]));

create policy mapping_read on public.import_mapping_templates for select to authenticated using (public.has_role(array['admin','accountant','viewer']::public.user_role[]));

-- Admins and accountants may add and change (never delete).
create policy mapping_insert on public.import_mapping_templates for insert to authenticated with check (public.has_role(array['admin','accountant']::public.user_role[]));
create policy mapping_update on public.import_mapping_templates for update to authenticated using (public.has_role(array['admin','accountant']::public.user_role[])) with check (public.has_role(array['admin','accountant']::public.user_role[]));

create policy suppliers_insert on public.suppliers for insert to authenticated with check (public.has_role(array['admin','accountant']::public.user_role[]));
create policy suppliers_update on public.suppliers for update to authenticated using (public.has_role(array['admin','accountant']::public.user_role[])) with check (public.has_role(array['admin','accountant']::public.user_role[]));

create policy aliases_insert on public.supplier_aliases for insert to authenticated with check (public.has_role(array['admin','accountant']::public.user_role[]));

create policy periods_insert on public.reconciliation_periods for insert to authenticated with check (public.has_role(array['admin','accountant']::public.user_role[]));
create policy periods_update on public.reconciliation_periods for update to authenticated using (public.has_role(array['admin','accountant']::public.user_role[])) with check (public.has_role(array['admin','accountant']::public.user_role[]));

create policy batches_insert on public.import_batches for insert to authenticated with check (public.has_role(array['admin','accountant']::public.user_role[]));
create policy batches_update on public.import_batches for update to authenticated using (public.has_role(array['admin','accountant']::public.user_role[])) with check (public.has_role(array['admin','accountant']::public.user_role[]));

create policy staging_insert on public.import_staging_rows for insert to authenticated with check (public.has_role(array['admin','accountant']::public.user_role[]));
create policy staging_update on public.import_staging_rows for update to authenticated using (public.has_role(array['admin','accountant']::public.user_role[])) with check (public.has_role(array['admin','accountant']::public.user_role[]));

-- soa_entries: insert only (via the commit function). No update or delete policy exists.
create policy soa_entries_insert on public.soa_entries for insert to authenticated with check (public.has_role(array['admin','accountant']::public.user_role[]));

-- ---------- Table privileges ----------
revoke all on public.suppliers, public.supplier_aliases, public.reconciliation_periods,
              public.import_batches, public.import_staging_rows, public.soa_entries,
              public.import_mapping_templates
  from anon, authenticated;

grant select, insert, update on public.suppliers, public.reconciliation_periods,
                                public.import_batches, public.import_staging_rows,
                                public.import_mapping_templates to authenticated;
grant select, insert on public.supplier_aliases, public.soa_entries to authenticated;

-- ---------- Private storage for uploaded original files ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'imports', 'imports', false, 20971520,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'text/plain'
  ]
)
on conflict (id) do nothing;

create policy imports_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'imports' and public.has_role(array['admin','accountant']::public.user_role[]));

create policy imports_read on storage.objects
  for select to authenticated
  using (bucket_id = 'imports' and public.has_role(array['admin','accountant','viewer']::public.user_role[]));
-- No update or delete policies: original files are kept as evidence.
