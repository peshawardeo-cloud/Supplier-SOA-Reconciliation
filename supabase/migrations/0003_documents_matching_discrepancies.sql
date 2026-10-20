-- =====================================================================
-- Migration 0003: documents (PO, delivery notes, invoices, payments), allocations,
-- reconciliation results, discrepancies and refund claims.
-- Requires 0001 and 0002 to have been run first.
-- Run once in: Supabase dashboard -> SQL Editor -> New query -> Run
-- =====================================================================

-- ---------- Import types now include payments ----------
alter table public.import_batches drop constraint import_batches_import_type_check;
alter table public.import_batches add constraint import_batches_import_type_check
  check (import_type in ('soa', 'po', 'dn', 'invoice', 'payment'));
alter table public.import_mapping_templates drop constraint import_mapping_templates_import_type_check;
alter table public.import_mapping_templates add constraint import_mapping_templates_import_type_check
  check (import_type in ('soa', 'po', 'dn', 'invoice', 'payment'));

-- ---------- Types ----------
create type public.invoice_doc_type as enum ('invoice', 'credit_note');
create type public.match_origin     as enum ('exact', 'suggested', 'manual');
create type public.match_state      as enum ('pending', 'confirmed', 'rejected', 'superseded');
create type public.discrepancy_status as enum
  ('open', 'under_review', 'waiting_supplier', 'waiting_finance', 'resolved', 'closed');
create type public.refund_status as enum
  ('draft', 'submitted', 'acknowledged', 'partially_received', 'received', 'rejected');
create type public.refund_type as enum
  ('overpayment', 'duplicate_payment', 'credit_note_pending', 'excess_charge', 'other');

-- ---------- Short permission helpers ----------
create or replace function public.is_editor() returns boolean
language sql stable as $$ select public.has_role(array['admin', 'accountant']::public.user_role[]) $$;
create or replace function public.is_reader() returns boolean
language sql stable as $$ select public.has_role(array['admin', 'accountant', 'viewer']::public.user_role[]) $$;
revoke all on function public.is_editor() from public, anon;
revoke all on function public.is_reader() from public, anon;
grant execute on function public.is_editor() to authenticated;
grant execute on function public.is_reader() to authenticated;

-- Names (not emails) of active users, so people can be assigned and shown on discrepancies.
create or replace function public.user_directory()
returns table (id uuid, full_name text, role public.user_role)
language sql stable security definer set search_path = public as $$
  select p.id, coalesce(p.full_name, split_part(p.email, '@', 1)), p.role
  from public.profiles p
  where p.is_active and public.is_reader()
  order by 2
$$;
revoke all on function public.user_directory() from public, anon;
grant execute on function public.user_directory() to authenticated;

-- =====================================================================
-- Documents. Imported documents are never edited; only deleted_at may change (controlled revert).
-- =====================================================================

create table public.po_headers (
  id             uuid primary key default gen_random_uuid(),
  supplier_id    uuid not null references public.suppliers (id) on delete restrict,
  batch_id       uuid not null references public.import_batches (id) on delete restrict,
  po_number      text not null,
  po_number_norm text not null,
  po_date        date not null,
  project_ref    text,
  currency       text,
  net_amount     numeric(18,2),
  vat_amount     numeric(18,2),
  gross_amount   numeric(18,2),
  source_row     integer not null,
  raw            jsonb not null,
  deleted_at     timestamptz,
  created_by     uuid default auth.uid() references auth.users (id),
  created_at     timestamptz not null default now()
);
create unique index po_headers_unique on public.po_headers (supplier_id, po_number_norm) where deleted_at is null;
create index po_headers_supplier_idx on public.po_headers (supplier_id, po_date desc) where deleted_at is null;

create table public.po_lines (
  id             uuid primary key default gen_random_uuid(),
  po_id          uuid not null references public.po_headers (id) on delete restrict,
  line_no        integer not null,
  item_code      text,
  item_code_norm text,
  description    text,
  uom            text,
  qty            numeric(18,3) not null check (qty > 0),
  unit_price     numeric(18,4),
  net_amount     numeric(18,2),
  vat_amount     numeric(18,2),
  gross_amount   numeric(18,2),
  source_row     integer not null,
  raw            jsonb not null,
  constraint po_lines_unique unique (po_id, line_no)
);

create table public.dn_headers (
  id             uuid primary key default gen_random_uuid(),
  supplier_id    uuid not null references public.suppliers (id) on delete restrict,
  batch_id       uuid not null references public.import_batches (id) on delete restrict,
  dn_number      text not null,
  dn_number_norm text not null,
  dn_date        date not null,
  po_refs        text[] not null default '{}',
  project_ref    text,
  received_by    text,
  source_row     integer not null,
  raw            jsonb not null,
  deleted_at     timestamptz,
  created_by     uuid default auth.uid() references auth.users (id),
  created_at     timestamptz not null default now()
);
create unique index dn_headers_unique on public.dn_headers (supplier_id, dn_number_norm) where deleted_at is null;
create index dn_headers_supplier_idx on public.dn_headers (supplier_id, dn_date desc) where deleted_at is null;

create table public.dn_lines (
  id             uuid primary key default gen_random_uuid(),
  dn_id          uuid not null references public.dn_headers (id) on delete restrict,
  line_no        integer not null,
  item_code      text,
  item_code_norm text,
  description    text,
  uom            text,
  qty_delivered  numeric(18,3) not null check (qty_delivered > 0),
  source_row     integer not null,
  raw            jsonb not null,
  constraint dn_lines_unique unique (dn_id, line_no)
);

create table public.invoices (
  id                  uuid primary key default gen_random_uuid(),
  supplier_id         uuid not null references public.suppliers (id) on delete restrict,
  batch_id            uuid not null references public.import_batches (id) on delete restrict,
  doc_type            public.invoice_doc_type not null default 'invoice',
  invoice_number      text not null,
  invoice_number_norm text not null,
  invoice_date        date not null,
  due_date            date,
  po_refs             text[] not null default '{}',
  dn_refs             text[] not null default '{}',
  currency            text,
  net_amount          numeric(18,2) not null,
  vat_amount          numeric(18,2) not null,
  gross_amount        numeric(18,2) not null,
  vat_calculated      boolean not null default false,   -- true when VAT was calculated by us, not read from the file
  printed_gross       numeric(18,2),                    -- total printed on the document itself (PDF invoices)
  source_row          integer not null,
  raw                 jsonb not null,
  deleted_at          timestamptz,
  created_by          uuid default auth.uid() references auth.users (id),
  created_at          timestamptz not null default now(),
  constraint invoices_amounts_sane check (gross_amount >= 0 and net_amount >= 0 and vat_amount >= 0
                                          and abs(net_amount + vat_amount - gross_amount) <= 1.00)
);
create unique index invoices_unique on public.invoices (supplier_id, doc_type, invoice_number_norm) where deleted_at is null;
create index invoices_supplier_idx on public.invoices (supplier_id, invoice_date desc) where deleted_at is null;

create table public.invoice_lines (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null references public.invoices (id) on delete restrict,
  line_no        integer not null,
  item_code      text,
  item_code_norm text,
  description    text,
  uom            text,
  qty            numeric(18,3),
  unit_price     numeric(18,4),
  net_amount     numeric(18,2) not null,
  vat_amount     numeric(18,2) not null,
  gross_amount   numeric(18,2) not null,
  source_row     integer not null,
  raw            jsonb not null,
  constraint invoice_lines_unique unique (invoice_id, line_no)
);

create table public.payments (
  id               uuid primary key default gen_random_uuid(),
  supplier_id      uuid not null references public.suppliers (id) on delete restrict,
  batch_id         uuid references public.import_batches (id) on delete restrict,   -- null for payments typed in by hand
  payment_ref      text not null,
  payment_ref_norm text not null,
  payment_date     date not null,
  amount           numeric(18,2) not null check (amount > 0),
  method           text,
  bank_ref         text,
  bank_ref_norm    text,
  notes            text,
  currency         text,
  source           text not null default 'import' check (source in ('import', 'manual')),
  source_row       integer,
  raw              jsonb not null default '{}'::jsonb,
  deleted_at       timestamptz,
  created_by       uuid default auth.uid() references auth.users (id),
  created_at       timestamptz not null default now()
);
create unique index payments_unique on public.payments (supplier_id, payment_ref_norm, payment_date, amount) where deleted_at is null;
create index payments_supplier_idx on public.payments (supplier_id, payment_date desc) where deleted_at is null;

-- Documents may only be soft-deleted; lines are never edited.
create or replace function public.doc_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) - 'deleted_at') is distinct from (to_jsonb(old) - 'deleted_at') then
    raise exception 'Imported documents cannot be edited.';
  end if;
  return new;
end $$;

create or replace function public.lines_guard() returns trigger language plpgsql as $$
begin
  raise exception 'Imported document lines cannot be edited.';
end $$;

create trigger po_headers_guard before update on public.po_headers for each row execute function public.doc_guard();
create trigger dn_headers_guard before update on public.dn_headers for each row execute function public.doc_guard();
create trigger invoices_guard   before update on public.invoices   for each row execute function public.doc_guard();
create trigger payments_guard   before update on public.payments   for each row execute function public.doc_guard();
create trigger po_lines_guard      before update on public.po_lines      for each row execute function public.lines_guard();
create trigger dn_lines_guard      before update on public.dn_lines      for each row execute function public.lines_guard();
create trigger invoice_lines_guard before update on public.invoice_lines for each row execute function public.lines_guard();

-- =====================================================================
-- Payment and credit-note allocations (never edited; voided with a reason)
-- =====================================================================

create table public.payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references public.payments (id) on delete restrict,
  invoice_id  uuid not null references public.invoices (id) on delete restrict,
  amount      numeric(18,2) not null check (amount > 0),
  note        text,
  created_by  uuid default auth.uid() references auth.users (id),
  created_at  timestamptz not null default now(),
  voided_at   timestamptz,
  voided_by   uuid references auth.users (id),
  void_reason text
);
create unique index payment_alloc_once on public.payment_allocations (payment_id, invoice_id) where voided_at is null;
create index payment_alloc_invoice_idx on public.payment_allocations (invoice_id) where voided_at is null;

create table public.credit_allocations (
  id             uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references public.invoices (id) on delete restrict,
  invoice_id     uuid not null references public.invoices (id) on delete restrict,
  amount         numeric(18,2) not null check (amount > 0),
  note           text,
  created_by     uuid default auth.uid() references auth.users (id),
  created_at     timestamptz not null default now(),
  voided_at      timestamptz,
  voided_by      uuid references auth.users (id),
  void_reason    text,
  constraint credit_alloc_different check (credit_note_id <> invoice_id)
);
create unique index credit_alloc_once on public.credit_allocations (credit_note_id, invoice_id) where voided_at is null;
create index credit_alloc_invoice_idx on public.credit_allocations (invoice_id) where voided_at is null;

-- Amount of an invoice already settled by payments and credit notes (voided rows ignored).
create or replace function public.invoice_applied(p_invoice_id uuid, p_ignore uuid default null)
returns numeric language sql stable set search_path = public as $$
  select coalesce((select sum(amount) from public.payment_allocations
                    where invoice_id = p_invoice_id and voided_at is null and id is distinct from p_ignore), 0)
       + coalesce((select sum(amount) from public.credit_allocations
                    where invoice_id = p_invoice_id and voided_at is null and id is distinct from p_ignore), 0)
$$;

create or replace function public.allocation_caps() returns trigger language plpgsql security definer set search_path = public as $$
declare
  inv   public.invoices%rowtype;
  src_amount numeric;
  used  numeric;
begin
  select * into inv from public.invoices where id = new.invoice_id for update;
  if not found or inv.deleted_at is not null then raise exception 'The invoice was not found.'; end if;
  if inv.doc_type <> 'invoice' then raise exception 'Allocations can only be applied to invoices, not credit notes.'; end if;

  if tg_table_name = 'payment_allocations' then
    select amount into src_amount from public.payments where id = new.payment_id and deleted_at is null for update;
    if not found then raise exception 'The payment was not found.'; end if;
    select coalesce(sum(amount), 0) into used from public.payment_allocations
      where payment_id = new.payment_id and voided_at is null and id <> new.id;
    if used + new.amount > src_amount then
      raise exception 'This allocation exceeds the unallocated part of the payment (% available).', src_amount - used;
    end if;
  else
    declare cn public.invoices%rowtype;
    begin
      select * into cn from public.invoices where id = new.credit_note_id and deleted_at is null for update;
      if not found or cn.doc_type <> 'credit_note' then raise exception 'The credit note was not found.'; end if;
      src_amount := cn.gross_amount;
      select coalesce(sum(amount), 0) into used from public.credit_allocations
        where credit_note_id = new.credit_note_id and voided_at is null and id <> new.id;
      if used + new.amount > src_amount then
        raise exception 'This allocation exceeds the unused part of the credit note (% available).', src_amount - used;
      end if;
    end;
  end if;

  if public.invoice_applied(new.invoice_id, new.id) + new.amount > inv.gross_amount then
    raise exception 'This allocation exceeds the open amount of invoice % (% still open).',
      inv.invoice_number, inv.gross_amount - public.invoice_applied(new.invoice_id, new.id);
  end if;
  return new;
end $$;

create trigger payment_alloc_caps before insert on public.payment_allocations
  for each row execute function public.allocation_caps();
create trigger credit_alloc_caps before insert on public.credit_allocations
  for each row execute function public.allocation_caps();

-- Allocations can only be voided (with a reason). Nothing else may change.
create or replace function public.allocation_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) - 'voided_at' - 'voided_by' - 'void_reason') is distinct from
     (to_jsonb(old) - 'voided_at' - 'voided_by' - 'void_reason') then
    raise exception 'Allocations cannot be edited. Void it and create a new one.';
  end if;
  if old.voided_at is not null then raise exception 'This allocation is already voided.'; end if;
  if new.voided_at is not null then
    if coalesce(trim(new.void_reason), '') = '' then raise exception 'A reason is required to void an allocation.'; end if;
    new.voided_by := auth.uid();
  end if;
  return new;
end $$;
create trigger payment_alloc_guard before update on public.payment_allocations
  for each row execute function public.allocation_guard();
create trigger credit_alloc_guard before update on public.credit_allocations
  for each row execute function public.allocation_guard();

-- A payment that has allocations must have them voided before it can be removed.
create or replace function public.payment_delete_guard() returns trigger language plpgsql as $$
begin
  if new.deleted_at is not null and old.deleted_at is null and exists (
    select 1 from public.payment_allocations where payment_id = new.id and voided_at is null) then
    raise exception 'Void the allocations of this payment before removing it.';
  end if;
  return new;
end $$;
create trigger payments_delete_guard before update on public.payments
  for each row execute function public.payment_delete_guard();

-- Per-invoice and per-payment balances for a supplier (respects row security).
create or replace function public.invoice_balances(p_supplier_id uuid)
returns table (invoice_id uuid, doc_type public.invoice_doc_type, invoice_number text, invoice_date date,
               gross numeric, applied numeric, open_amount numeric)
language sql stable set search_path = public as $$
  select x.id, x.doc_type, x.invoice_number, x.invoice_date, x.gross_amount, x.applied, x.gross_amount - x.applied
  from (
    select i.id, i.doc_type, i.invoice_number, i.invoice_date, i.gross_amount,
      case when i.doc_type = 'invoice' then public.invoice_applied(i.id)
           else coalesce((select sum(ca.amount) from public.credit_allocations ca
                           where ca.credit_note_id = i.id and ca.voided_at is null), 0) end as applied
    from public.invoices i
    where i.supplier_id = p_supplier_id and i.deleted_at is null
  ) x
  order by x.invoice_date, x.invoice_number
$$;

create or replace function public.payment_balances(p_supplier_id uuid)
returns table (payment_id uuid, payment_ref text, payment_date date, amount numeric, allocated numeric, unallocated numeric)
language sql stable set search_path = public as $$
  select p.id, p.payment_ref, p.payment_date, p.amount,
         coalesce(a.s, 0), p.amount - coalesce(a.s, 0)
  from public.payments p
  left join lateral (select sum(pa.amount) s from public.payment_allocations pa
                      where pa.payment_id = p.id and pa.voided_at is null) a on true
  where p.supplier_id = p_supplier_id and p.deleted_at is null
  order by p.payment_date, p.payment_ref
$$;
revoke all on function public.invoice_balances(uuid) from public, anon;
revoke all on function public.payment_balances(uuid) from public, anon;
grant execute on function public.invoice_balances(uuid) to authenticated;
grant execute on function public.payment_balances(uuid) to authenticated;

-- =====================================================================
-- Reconciliation results
-- =====================================================================

create table public.reconciliation_runs (
  id                uuid primary key default gen_random_uuid(),
  period_id         uuid not null references public.reconciliation_periods (id) on delete restrict,
  run_number        integer not null,
  settings_snapshot jsonb not null,
  summary           jsonb not null,
  started_by        uuid default auth.uid() references auth.users (id),
  created_at        timestamptz not null default now(),
  constraint run_unique unique (period_id, run_number)
);

create table public.matches (
  id            uuid primary key default gen_random_uuid(),
  period_id     uuid not null references public.reconciliation_periods (id) on delete restrict,
  soa_entry_id  uuid not null references public.soa_entries (id) on delete restrict,
  invoice_id    uuid references public.invoices (id) on delete restrict,
  payment_id    uuid references public.payments (id) on delete restrict,
  origin        public.match_origin not null,
  state         public.match_state not null default 'pending',
  confidence    integer not null default 0 check (confidence between 0 and 100),
  evidence      jsonb not null default '[]'::jsonb,
  decided_by    uuid references auth.users (id),
  decided_at    timestamptz,
  reject_reason text,
  first_run_id  uuid references public.reconciliation_runs (id) on delete restrict,
  created_by    uuid default auth.uid() references auth.users (id),
  created_at    timestamptz not null default now(),
  constraint match_one_target check (((invoice_id is not null)::int + (payment_id is not null)::int) = 1)
);
-- A statement line, an invoice and a payment can each be confirmed against only one counterpart.
create unique index matches_soa_confirmed     on public.matches (soa_entry_id) where state = 'confirmed';
create unique index matches_invoice_confirmed on public.matches (period_id, invoice_id) where state = 'confirmed' and invoice_id is not null;
create unique index matches_payment_confirmed on public.matches (period_id, payment_id) where state = 'confirmed' and payment_id is not null;
create unique index matches_pair_once         on public.matches (soa_entry_id, coalesce(invoice_id, payment_id)) where state in ('pending', 'confirmed');
create index matches_period_idx on public.matches (period_id, state);

create table public.doc_links (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references public.suppliers (id) on delete restrict,
  invoice_id    uuid not null references public.invoices (id) on delete restrict,
  po_id         uuid references public.po_headers (id) on delete restrict,
  dn_id         uuid references public.dn_headers (id) on delete restrict,
  origin        public.match_origin not null,
  state         public.match_state not null default 'pending',
  confidence    integer not null default 0 check (confidence between 0 and 100),
  evidence      jsonb not null default '[]'::jsonb,
  decided_by    uuid references auth.users (id),
  decided_at    timestamptz,
  reject_reason text,
  first_run_id  uuid references public.reconciliation_runs (id) on delete restrict,
  created_by    uuid default auth.uid() references auth.users (id),
  created_at    timestamptz not null default now(),
  constraint link_one_target check (((po_id is not null)::int + (dn_id is not null)::int) = 1)
);
create unique index doc_links_po_once on public.doc_links (invoice_id, po_id) where po_id is not null and state in ('pending', 'confirmed');
create unique index doc_links_dn_once on public.doc_links (invoice_id, dn_id) where dn_id is not null and state in ('pending', 'confirmed');
create index doc_links_supplier_idx on public.doc_links (supplier_id, state);

-- Decisions on matches and links: only the decision fields may change.
create or replace function public.decision_guard() returns trigger language plpgsql as $$
declare per_status public.period_status;
begin
  if (to_jsonb(new) - 'state' - 'decided_by' - 'decided_at' - 'reject_reason')
     is distinct from (to_jsonb(old) - 'state' - 'decided_by' - 'decided_at' - 'reject_reason') then
    raise exception 'Only the decision on a match can be changed.';
  end if;
  if new.state is distinct from old.state then
    if old.state in ('rejected', 'superseded') then raise exception 'This match was already rejected.'; end if;
    if new.state = 'rejected' and old.state = 'confirmed' and coalesce(trim(new.reject_reason), '') = '' then
      raise exception 'A reason is required to unmatch a confirmed match.';
    end if;
    if coalesce(current_setting('app.system_update', true), '') <> '1' then
      new.decided_by := auth.uid();
    end if;
    new.decided_at := now();
  end if;
  if tg_table_name = 'matches' then
    select status into per_status from public.reconciliation_periods where id = new.period_id;
    if per_status in ('completed', 'locked') then
      raise exception 'This period is % and its matches cannot be changed.', per_status;
    end if;
  end if;
  return new;
end $$;
create trigger matches_decision_guard before update on public.matches for each row execute function public.decision_guard();
create trigger doc_links_decision_guard before update on public.doc_links for each row execute function public.decision_guard();

create or replace function public.match_insert_guard() returns trigger language plpgsql as $$
declare per_status public.period_status;
begin
  select status into per_status from public.reconciliation_periods where id = new.period_id;
  if per_status in ('completed', 'locked') then
    raise exception 'This period is % and its matches cannot be changed.', per_status;
  end if;
  if new.origin = 'manual' then
    new.state := 'confirmed';
    new.confidence := 100;
    new.decided_by := auth.uid();
    new.decided_at := now();
  end if;
  return new;
end $$;
create trigger matches_insert_guard before insert on public.matches for each row execute function public.match_insert_guard();

-- =====================================================================
-- Discrepancies with history, and refund claims
-- =====================================================================

create table public.discrepancies (
  id               uuid primary key default gen_random_uuid(),
  supplier_id      uuid not null references public.suppliers (id) on delete restrict,
  period_id        uuid references public.reconciliation_periods (id) on delete restrict,
  type             text not null check (type ~ '^[a-z_]{3,40}$'),
  source           text not null default 'system' check (source in ('system', 'manual')),
  soa_entry_id     uuid references public.soa_entries (id) on delete restrict,
  invoice_id       uuid references public.invoices (id) on delete restrict,
  payment_id       uuid references public.payments (id) on delete restrict,
  po_id            uuid references public.po_headers (id) on delete restrict,
  dn_id            uuid references public.dn_headers (id) on delete restrict,
  ref_text         text,                      -- the document references to show, e.g. "INV 2020752RI / PO 200196"
  expected_amount  numeric(18,2),
  actual_amount    numeric(18,2),
  difference       numeric(18,2) generated always as (coalesce(actual_amount, 0) - coalesce(expected_amount, 0)) stored,
  explanation      text not null,
  calculation      jsonb,                     -- how the figures were worked out, step by step
  notes            text,
  assigned_to      uuid references public.profiles (id) on delete set null,
  status           public.discrepancy_status not null default 'open',
  resolution_note  text,
  resolved_at      timestamptz,
  resolved_by      uuid references auth.users (id),
  fingerprint      text not null,
  first_run_id     uuid references public.reconciliation_runs (id) on delete restrict,
  last_seen_run_id uuid references public.reconciliation_runs (id) on delete restrict,
  created_by       uuid default auth.uid() references auth.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index discrepancies_unique
  on public.discrepancies (coalesce(period_id, '00000000-0000-0000-0000-000000000000'::uuid), type, fingerprint);
create index discrepancies_supplier_idx on public.discrepancies (supplier_id, status);
create index discrepancies_period_idx on public.discrepancies (period_id, status);

create table public.discrepancy_history (
  id             bigint generated always as identity primary key,
  discrepancy_id uuid not null references public.discrepancies (id) on delete restrict,
  changed_by     uuid default auth.uid(),
  changed_at     timestamptz not null default now(),
  field          text not null,
  old_value      text,
  new_value      text,
  comment        text
);
create index discrepancy_history_idx on public.discrepancy_history (discrepancy_id, changed_at);

create or replace function public.discrepancy_guard() returns trigger language plpgsql as $$
declare sys boolean := coalesce(current_setting('app.system_update', true), '') = '1';
begin
  if not sys then
    if (old.supplier_id, old.period_id, old.type, old.source, old.fingerprint) is distinct from
       (new.supplier_id, new.period_id, new.type, new.source, new.fingerprint) then
      raise exception 'The type and references of a discrepancy cannot be changed.';
    end if;
    if old.source = 'system' and (
         (old.soa_entry_id, old.invoice_id, old.payment_id, old.po_id, old.dn_id, old.ref_text,
          old.expected_amount, old.actual_amount, old.explanation, old.calculation::text) is distinct from
         (new.soa_entry_id, new.invoice_id, new.payment_id, new.po_id, new.dn_id, new.ref_text,
          new.expected_amount, new.actual_amount, new.explanation, new.calculation::text)) then
      raise exception 'The details found by the reconciliation cannot be edited. Add a note instead.';
    end if;
  end if;

  if new.status in ('resolved', 'closed') then
    if old.status not in ('resolved', 'closed') then
      new.resolved_at := now();
      new.resolved_by := case when sys then null else auth.uid() end;
      if coalesce(trim(new.resolution_note), '') = '' then
        raise exception 'Add a resolution note before resolving or closing a discrepancy.';
      end if;
    end if;
  else
    new.resolved_at := null;
    new.resolved_by := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger discrepancies_guard before update on public.discrepancies for each row execute function public.discrepancy_guard();

create or replace function public.discrepancy_history_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare f text;
begin
  if tg_op = 'INSERT' then
    insert into public.discrepancy_history (discrepancy_id, changed_by, field, new_value, comment)
    values (new.id, auth.uid(), 'created', new.status::text,
            case when new.source = 'manual' then 'Created manually' else 'Detected by reconciliation run' end);
    return null;
  end if;
  foreach f in array array['status', 'assigned_to', 'notes', 'resolution_note', 'expected_amount', 'actual_amount', 'explanation'] loop
    if (to_jsonb(new) -> f) is distinct from (to_jsonb(old) -> f) then
      insert into public.discrepancy_history (discrepancy_id, changed_by, field, old_value, new_value, comment)
      values (new.id, auth.uid(), f, to_jsonb(old) ->> f, to_jsonb(new) ->> f,
              case when coalesce(current_setting('app.system_update', true), '') = '1' then 'Updated by reconciliation run' end);
    end if;
  end loop;
  return null;
end $$;
create trigger discrepancies_history after insert or update on public.discrepancies
  for each row execute function public.discrepancy_history_trg();

create table public.refund_claims (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     uuid not null references public.suppliers (id) on delete restrict,
  period_id       uuid references public.reconciliation_periods (id) on delete restrict,
  discrepancy_id  uuid references public.discrepancies (id) on delete restrict,
  claim_ref       text,
  claim_type      public.refund_type not null,
  amount_claimed  numeric(18,2) not null check (amount_claimed > 0),
  amount_received numeric(18,2) not null default 0 check (amount_received >= 0),
  status          public.refund_status not null default 'draft',
  submitted_at    date,
  notes           text,
  created_by      uuid default auth.uid() references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint refund_received_ok check (amount_received <= amount_claimed)
);
create unique index refund_claim_ref_unique on public.refund_claims (supplier_id, lower(claim_ref)) where claim_ref is not null;
create index refund_claims_supplier_idx on public.refund_claims (supplier_id, status);

-- =====================================================================
-- Commit and revert for document imports (one transaction each)
-- =====================================================================

create or replace function public.commit_document_batch(p_batch_id uuid)
returns jsonb language plpgsql set search_path = public as $$
declare
  b        public.import_batches%rowtype;
  d        record;
  new_id   uuid;
  n_docs   integer := 0;
  n_lines  integer := 0;
  n_skip   integer;
  bad      integer;
  k        integer;
begin
  if not public.is_editor() then raise exception 'You do not have permission to commit imports.'; end if;

  select * into b from public.import_batches where id = p_batch_id for update;
  if not found then raise exception 'Import not found.'; end if;
  if b.import_type not in ('po', 'dn', 'invoice', 'payment') then raise exception 'This is not a document import.'; end if;
  if b.status <> 'staged' then raise exception 'This import is not ready to commit (status: %).', b.status; end if;

  if b.import_type <> 'payment' then
    select count(*) into bad from (
      select 1 from public.import_staging_rows s where s.batch_id = p_batch_id
      group by s.mapped ->> 'doc_key'
      having bool_or(s.status = 'valid') and bool_or(s.status <> 'valid')
    ) x;
    if bad > 0 then raise exception 'A document has both accepted and rejected lines. Re-upload the file after fixing it.'; end if;
  end if;

  if b.import_type = 'payment' then
    insert into public.payments (supplier_id, batch_id, payment_ref, payment_ref_norm, payment_date, amount, method,
                                 bank_ref, bank_ref_norm, notes, currency, source, source_row, raw)
    select b.supplier_id, b.id, s.mapped ->> 'doc_number', s.mapped ->> 'doc_number_norm', (s.mapped ->> 'doc_date')::date,
           (s.mapped ->> 'gross')::numeric, nullif(s.mapped ->> 'method', ''), nullif(s.mapped ->> 'bank_ref', ''),
           nullif(s.mapped ->> 'bank_ref_norm', ''), nullif(s.mapped ->> 'description', ''), nullif(s.mapped ->> 'currency', ''),
           'import', s.row_number, s.raw
    from public.import_staging_rows s where s.batch_id = p_batch_id and s.status = 'valid';
    get diagnostics n_docs = row_count;
    n_lines := n_docs;

  else
    for d in
      select distinct on (s.mapped ->> 'doc_key') s.mapped ->> 'doc_key' as dkey, s.mapped as m, s.raw as r, s.row_number as rn
      from public.import_staging_rows s
      where s.batch_id = p_batch_id and s.status = 'valid'
      order by s.mapped ->> 'doc_key', s.row_number
    loop
      if b.import_type = 'po' then
        insert into public.po_headers (supplier_id, batch_id, po_number, po_number_norm, po_date, project_ref, currency,
                                       net_amount, vat_amount, gross_amount, source_row, raw)
        select b.supplier_id, b.id, d.m ->> 'doc_number', d.m ->> 'doc_number_norm', (d.m ->> 'doc_date')::date,
               max(nullif(s.mapped ->> 'project_ref', '')), max(nullif(s.mapped ->> 'currency', '')),
               sum((s.mapped ->> 'net')::numeric), sum((s.mapped ->> 'vat')::numeric), sum((s.mapped ->> 'gross')::numeric),
               d.rn, d.r
        from public.import_staging_rows s
        where s.batch_id = p_batch_id and s.status = 'valid' and s.mapped ->> 'doc_key' = d.dkey
        returning id into new_id;

        insert into public.po_lines (po_id, line_no, item_code, item_code_norm, description, uom, qty, unit_price,
                                     net_amount, vat_amount, gross_amount, source_row, raw)
        select new_id, row_number() over (order by s.row_number), nullif(s.mapped ->> 'item_code', ''),
               nullif(s.mapped ->> 'item_code_norm', ''), nullif(s.mapped ->> 'description', ''), nullif(s.mapped ->> 'uom', ''),
               (s.mapped ->> 'qty')::numeric, (s.mapped ->> 'unit_price')::numeric, (s.mapped ->> 'net')::numeric,
               (s.mapped ->> 'vat')::numeric, (s.mapped ->> 'gross')::numeric, s.row_number, s.raw
        from public.import_staging_rows s
        where s.batch_id = p_batch_id and s.status = 'valid' and s.mapped ->> 'doc_key' = d.dkey;

      elsif b.import_type = 'dn' then
        insert into public.dn_headers (supplier_id, batch_id, dn_number, dn_number_norm, dn_date, po_refs, project_ref,
                                       received_by, source_row, raw)
        select b.supplier_id, b.id, d.m ->> 'doc_number', d.m ->> 'doc_number_norm', (d.m ->> 'doc_date')::date,
               coalesce((select array_agg(distinct x) from public.import_staging_rows s2,
                          jsonb_array_elements_text(s2.mapped -> 'po_refs') x
                         where s2.batch_id = p_batch_id and s2.status = 'valid' and s2.mapped ->> 'doc_key' = d.dkey), '{}'),
               max(nullif(s.mapped ->> 'project_ref', '')), max(nullif(s.mapped ->> 'received_by', '')), d.rn, d.r
        from public.import_staging_rows s
        where s.batch_id = p_batch_id and s.status = 'valid' and s.mapped ->> 'doc_key' = d.dkey
        returning id into new_id;

        insert into public.dn_lines (dn_id, line_no, item_code, item_code_norm, description, uom, qty_delivered, source_row, raw)
        select new_id, row_number() over (order by s.row_number), nullif(s.mapped ->> 'item_code', ''),
               nullif(s.mapped ->> 'item_code_norm', ''), nullif(s.mapped ->> 'description', ''), nullif(s.mapped ->> 'uom', ''),
               (s.mapped ->> 'qty')::numeric, s.row_number, s.raw
        from public.import_staging_rows s
        where s.batch_id = p_batch_id and s.status = 'valid' and s.mapped ->> 'doc_key' = d.dkey;

      else -- invoice
        insert into public.invoices (supplier_id, batch_id, doc_type, invoice_number, invoice_number_norm, invoice_date, due_date,
                                     po_refs, dn_refs, currency, net_amount, vat_amount, gross_amount, vat_calculated,
                                     printed_gross, source_row, raw)
        select b.supplier_id, b.id, (d.m ->> 'doc_type')::public.invoice_doc_type, d.m ->> 'doc_number', d.m ->> 'doc_number_norm',
               (d.m ->> 'doc_date')::date, nullif(d.m ->> 'due_date', '')::date,
               coalesce((select array_agg(distinct x) from public.import_staging_rows s2,
                          jsonb_array_elements_text(s2.mapped -> 'po_refs') x
                         where s2.batch_id = p_batch_id and s2.status = 'valid' and s2.mapped ->> 'doc_key' = d.dkey), '{}'),
               coalesce((select array_agg(distinct x) from public.import_staging_rows s2,
                          jsonb_array_elements_text(s2.mapped -> 'dn_refs') x
                         where s2.batch_id = p_batch_id and s2.status = 'valid' and s2.mapped ->> 'doc_key' = d.dkey), '{}'),
               max(nullif(s.mapped ->> 'currency', '')),
               sum((s.mapped ->> 'net')::numeric), sum((s.mapped ->> 'vat')::numeric), sum((s.mapped ->> 'gross')::numeric),
               bool_or((s.mapped ->> 'vat_calculated')::boolean),
               nullif(d.m -> 'header' ->> 'gross', '')::numeric, d.rn, d.r
        from public.import_staging_rows s
        where s.batch_id = p_batch_id and s.status = 'valid' and s.mapped ->> 'doc_key' = d.dkey
        returning id into new_id;

        insert into public.invoice_lines (invoice_id, line_no, item_code, item_code_norm, description, uom, qty, unit_price,
                                          net_amount, vat_amount, gross_amount, source_row, raw)
        select new_id, row_number() over (order by s.row_number), nullif(s.mapped ->> 'item_code', ''),
               nullif(s.mapped ->> 'item_code_norm', ''), nullif(s.mapped ->> 'description', ''), nullif(s.mapped ->> 'uom', ''),
               nullif(s.mapped ->> 'qty', '')::numeric, nullif(s.mapped ->> 'unit_price', '')::numeric,
               (s.mapped ->> 'net')::numeric, (s.mapped ->> 'vat')::numeric, (s.mapped ->> 'gross')::numeric, s.row_number, s.raw
        from public.import_staging_rows s
        where s.batch_id = p_batch_id and s.status = 'valid' and s.mapped ->> 'doc_key' = d.dkey;
      end if;

      get diagnostics k = row_count;
      n_docs := n_docs + 1;
      n_lines := n_lines + k;
    end loop;
  end if;

  select count(*) into n_skip from public.import_staging_rows s where s.batch_id = p_batch_id and s.status <> 'valid';

  update public.import_batches
     set status = 'committed', imported_rows = n_lines, committed_at = now(), committed_by = auth.uid()
   where id = p_batch_id;

  return jsonb_build_object('documents', n_docs, 'lines', n_lines, 'skipped_rows', n_skip);
end $$;

create or replace function public.revert_document_batch(p_batch_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare b public.import_batches%rowtype;
begin
  if not public.has_role(array['admin']::public.user_role[]) then raise exception 'Only an administrator can revert an import.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required to revert an import.'; end if;

  select * into b from public.import_batches where id = p_batch_id for update;
  if not found then raise exception 'Import not found.'; end if;
  if b.import_type not in ('po', 'dn', 'invoice', 'payment') then raise exception 'This is not a document import.'; end if;
  if b.status <> 'committed' then raise exception 'Only a committed import can be reverted.'; end if;

  if b.import_type = 'invoice' and exists (
       select 1 from public.invoices i
       where i.batch_id = b.id and i.deleted_at is null and (
         exists (select 1 from public.payment_allocations a where a.invoice_id = i.id and a.voided_at is null) or
         exists (select 1 from public.credit_allocations a where (a.invoice_id = i.id or a.credit_note_id = i.id) and a.voided_at is null))) then
    raise exception 'Some invoices in this import have payments or credit notes allocated to them. Void those allocations first.';
  end if;
  if b.import_type = 'payment' and exists (
       select 1 from public.payments p join public.payment_allocations a on a.payment_id = p.id and a.voided_at is null
       where p.batch_id = b.id and p.deleted_at is null) then
    raise exception 'Some payments in this import are allocated to invoices. Void those allocations first.';
  end if;

  -- Matches and links that pointed at these documents are rejected (not deleted) so the history stays.
  if b.import_type = 'invoice' then
    update public.matches set state = 'rejected', reject_reason = 'The invoice import was reverted: ' || p_reason,
           decided_by = auth.uid(), decided_at = now()
     where state in ('pending', 'confirmed') and invoice_id in (select id from public.invoices where batch_id = b.id);
    update public.doc_links set state = 'rejected', reject_reason = 'The invoice import was reverted: ' || p_reason,
           decided_by = auth.uid(), decided_at = now()
     where state in ('pending', 'confirmed') and invoice_id in (select id from public.invoices where batch_id = b.id);
    update public.invoices set deleted_at = now() where batch_id = b.id and deleted_at is null;
  elsif b.import_type = 'po' then
    update public.doc_links set state = 'rejected', reject_reason = 'The PO import was reverted: ' || p_reason,
           decided_by = auth.uid(), decided_at = now()
     where state in ('pending', 'confirmed') and po_id in (select id from public.po_headers where batch_id = b.id);
    update public.po_headers set deleted_at = now() where batch_id = b.id and deleted_at is null;
  elsif b.import_type = 'dn' then
    update public.doc_links set state = 'rejected', reject_reason = 'The delivery note import was reverted: ' || p_reason,
           decided_by = auth.uid(), decided_at = now()
     where state in ('pending', 'confirmed') and dn_id in (select id from public.dn_headers where batch_id = b.id);
    update public.dn_headers set deleted_at = now() where batch_id = b.id and deleted_at is null;
  else
    update public.matches set state = 'rejected', reject_reason = 'The payment import was reverted: ' || p_reason,
           decided_by = auth.uid(), decided_at = now()
     where state in ('pending', 'confirmed') and payment_id in (select id from public.payments where batch_id = b.id);
    update public.payments set deleted_at = now() where batch_id = b.id and deleted_at is null;
  end if;

  update public.import_batches
     set status = 'reverted', reverted_at = now(), reverted_by = auth.uid(), revert_reason = p_reason
   where id = p_batch_id;
end $$;

-- =====================================================================
-- Save the result of a reconciliation run atomically
-- =====================================================================

create or replace function public.save_reconciliation_run(
  p_period_id uuid, p_settings jsonb, p_summary jsonb, p_matches jsonb, p_links jsonb, p_findings jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  per          public.reconciliation_periods%rowtype;
  run_id       uuid;
  run_no       integer;
  n_matches    integer := 0;
  n_links      integer := 0;
  n_new        integer := 0;
  n_seen       integer := 0;
  n_resolved   integer := 0;
begin
  if not public.is_editor() then raise exception 'You do not have permission to run a reconciliation.'; end if;

  select * into per from public.reconciliation_periods where id = p_period_id for update;
  if not found then raise exception 'Period not found.'; end if;
  if per.status in ('completed', 'locked') then
    raise exception 'This period is %. Re-open it before running the reconciliation again.', per.status;
  end if;

  perform set_config('app.system_update', '1', true);

  select coalesce(max(run_number), 0) + 1 into run_no from public.reconciliation_runs where period_id = p_period_id;
  insert into public.reconciliation_runs (period_id, run_number, settings_snapshot, summary)
  values (p_period_id, run_no, p_settings, p_summary) returning id into run_id;

  -- Earlier suggestions that were not proposed again are superseded (decisions are never touched).
  update public.matches mt set state = 'superseded'
   where mt.period_id = p_period_id and mt.state = 'pending'
     and not exists (select 1 from jsonb_to_recordset(p_matches) m(soa_entry_id uuid, invoice_id uuid, payment_id uuid)
                      where m.soa_entry_id = mt.soa_entry_id
                        and m.invoice_id is not distinct from mt.invoice_id
                        and m.payment_id is not distinct from mt.payment_id);

  insert into public.matches (period_id, soa_entry_id, invoice_id, payment_id, origin, state, confidence, evidence,
                              decided_by, decided_at, first_run_id)
  select p_period_id, m.soa_entry_id, m.invoice_id, m.payment_id, m.origin, m.state, m.confidence, coalesce(m.evidence, '[]'::jsonb),
         null, case when m.state = 'confirmed' then now() end, run_id
  from jsonb_to_recordset(p_matches) m(soa_entry_id uuid, invoice_id uuid, payment_id uuid, origin public.match_origin,
                                       state public.match_state, confidence integer, evidence jsonb)
  on conflict do nothing;
  get diagnostics n_matches = row_count;

  update public.doc_links l set state = 'superseded'
   where l.supplier_id = per.supplier_id and l.state = 'pending'
     and not exists (select 1 from jsonb_to_recordset(p_links) x(invoice_id uuid, po_id uuid, dn_id uuid)
                      where x.invoice_id = l.invoice_id
                        and x.po_id is not distinct from l.po_id and x.dn_id is not distinct from l.dn_id);

  insert into public.doc_links (supplier_id, invoice_id, po_id, dn_id, origin, state, confidence, evidence, decided_at, first_run_id)
  select per.supplier_id, x.invoice_id, x.po_id, x.dn_id, x.origin, x.state, x.confidence, coalesce(x.evidence, '[]'::jsonb),
         case when x.state = 'confirmed' then now() end, run_id
  from jsonb_to_recordset(p_links) x(invoice_id uuid, po_id uuid, dn_id uuid, origin public.match_origin,
                                     state public.match_state, confidence integer, evidence jsonb)
  on conflict do nothing;
  get diagnostics n_links = row_count;

  with f as (
    select * from jsonb_to_recordset(p_findings) x(
      type text, fingerprint text, soa_entry_id uuid, invoice_id uuid, payment_id uuid, po_id uuid, dn_id uuid,
      ref_text text, expected_amount numeric, actual_amount numeric, explanation text, calculation jsonb)
  ), up as (
    insert into public.discrepancies (supplier_id, period_id, type, source, soa_entry_id, invoice_id, payment_id, po_id, dn_id,
                                      ref_text, expected_amount, actual_amount, explanation, calculation, fingerprint,
                                      first_run_id, last_seen_run_id)
    select per.supplier_id, p_period_id, f.type, 'system', f.soa_entry_id, f.invoice_id, f.payment_id, f.po_id, f.dn_id,
           f.ref_text, f.expected_amount, f.actual_amount, f.explanation, f.calculation, f.fingerprint, run_id, run_id
    from f
    on conflict (coalesce(period_id, '00000000-0000-0000-0000-000000000000'::uuid), type, fingerprint)
    do update set last_seen_run_id = excluded.last_seen_run_id,
                  expected_amount  = excluded.expected_amount,
                  actual_amount    = excluded.actual_amount,
                  explanation      = excluded.explanation,
                  calculation      = excluded.calculation,
                  ref_text         = excluded.ref_text,
                  -- an item the system closed by itself comes back if a later run finds it again
                  status           = case when public.discrepancies.status = 'resolved'
                                           and public.discrepancies.resolution_note like 'Resolved automatically%'
                                          then 'open'::public.discrepancy_status else public.discrepancies.status end
      where public.discrepancies.source = 'system'
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted) into n_new, n_seen from up;

  -- Untouched open items that the run no longer finds are resolved automatically (with a history entry).
  update public.discrepancies
     set status = 'resolved',
         resolution_note = 'Resolved automatically: no longer found by reconciliation run #' || run_no
   where period_id = p_period_id and source = 'system' and status = 'open'
     and assigned_to is null and notes is null
     and last_seen_run_id is distinct from run_id;
  get diagnostics n_resolved = row_count;

  perform set_config('app.system_update', '', true);

  return jsonb_build_object('run_id', run_id, 'run_number', run_no, 'matches_added', n_matches, 'links_added', n_links,
                            'discrepancies_new', n_new, 'discrepancies_updated', n_seen, 'auto_resolved', n_resolved);
end $$;

revoke all on function public.commit_document_batch(uuid) from public, anon;
revoke all on function public.revert_document_batch(uuid, text) from public, anon;
revoke all on function public.save_reconciliation_run(uuid, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.commit_document_batch(uuid) to authenticated;
grant execute on function public.revert_document_batch(uuid, text) to authenticated;
grant execute on function public.save_reconciliation_run(uuid, jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;

-- =====================================================================
-- Audit, updated_at, row security, privileges
-- =====================================================================

create trigger refund_claims_set_updated_at before update on public.refund_claims
  for each row execute function public.set_updated_at();

do $$
declare t text;
begin
  -- audit trail on every financial table (line tables are covered by their header's import batch)
  foreach t in array array['po_headers', 'dn_headers', 'invoices', 'payments', 'payment_allocations', 'credit_allocations',
                           'matches', 'doc_links', 'discrepancies', 'refund_claims', 'reconciliation_runs'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_row()', t || '_audit', t);
  end loop;

  foreach t in array array['po_headers', 'po_lines', 'dn_headers', 'dn_lines', 'invoices', 'invoice_lines', 'payments',
                           'payment_allocations', 'credit_allocations', 'reconciliation_runs', 'matches', 'doc_links',
                           'discrepancies', 'discrepancy_history', 'refund_claims'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_reader())', t || '_read', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;

  -- add (admins and accountants)
  foreach t in array array['po_headers', 'po_lines', 'dn_headers', 'dn_lines', 'invoices', 'invoice_lines', 'payments',
                           'payment_allocations', 'credit_allocations', 'reconciliation_runs', 'matches', 'doc_links',
                           'discrepancies', 'refund_claims'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_editor())', t || '_ins', t);
    execute format('grant insert on public.%I to authenticated', t);
  end loop;

  -- change (admins and accountants); the guard triggers above limit what may change
  foreach t in array array['payment_allocations', 'credit_allocations', 'matches', 'doc_links', 'discrepancies', 'refund_claims'] loop
    execute format('create policy %I on public.%I for update to authenticated using (public.is_editor()) with check (public.is_editor())', t || '_upd', t);
    execute format('grant update on public.%I to authenticated', t);
  end loop;
end $$;

-- Removing a manually entered payment is an administrator action (soft delete only).
create policy payments_remove_admin on public.payments for update to authenticated
  using (public.has_role(array['admin']::public.user_role[]))
  with check (public.has_role(array['admin']::public.user_role[]));
grant update on public.payments to authenticated;

-- People may add comments to a discrepancy's history, nothing else.
create policy discrepancy_history_comment on public.discrepancy_history for insert to authenticated
  with check (public.is_editor() and field = 'comment');
grant insert on public.discrepancy_history to authenticated;
