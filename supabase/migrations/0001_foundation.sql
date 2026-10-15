-- =====================================================================
-- Migration 0001: Foundation
-- Roles, user profiles, application settings, audit log, security rules.
-- Run once in: Supabase dashboard -> SQL Editor -> New query -> Run
-- =====================================================================

-- ---------- Roles ----------
create type public.user_role as enum ('admin', 'accountant', 'viewer');

-- ---------- Generic helpers ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- Profiles (one row per login) ----------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete restrict,
  email       text,
  full_name   text,
  role        public.user_role not null default 'viewer',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- The first person ever created becomes the admin. Everyone after that
-- starts as an active viewer, and an admin then sets their real role.
-- (Public sign-up must be switched OFF in Supabase so only admins can add users.)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  first_user boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    case when first_user then 'admin'::public.user_role else 'viewer'::public.user_role end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Safety: never allow the last active admin to be demoted or deactivated.
create or replace function public.prevent_last_admin_loss()
returns trigger
language plpgsql
as $$
begin
  if old.role = 'admin' and old.is_active
     and (new.role <> 'admin' or not new.is_active) then
    if not exists (
      select 1 from public.profiles
      where id <> old.id and role = 'admin' and is_active
    ) then
      raise exception 'Cannot remove the last active administrator';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_keep_one_admin
  before update on public.profiles
  for each row execute function public.prevent_last_admin_loss();

-- ---------- Permission helper functions (used by security policies) ----------
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

create or replace function public.has_role(allowed public.user_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = any (allowed), false)
$$;

revoke all on function public.current_user_role() from public, anon;
revoke all on function public.has_role(public.user_role[]) from public, anon;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.has_role(public.user_role[]) to authenticated;

-- ---------- Application settings (exactly one row) ----------
create table public.app_settings (
  id                    boolean primary key default true,
  vat_rate              numeric(5,4)  not null default 0.15,
  amount_tolerance_abs  numeric(18,2) not null default 0.05,
  amount_tolerance_pct  numeric(7,4)  not null default 0,
  qty_tolerance         numeric(18,3) not null default 0,
  date_window_days      integer       not null default 7,
  rounding_mode         text          not null default 'half_up',
  default_currency      text          not null default 'SAR',
  doc_number_rules      jsonb         not null default
    '{"ignore_separators": true, "strip_leading_zeros": false, "strip_prefixes": []}'::jsonb,
  updated_at            timestamptz   not null default now(),
  updated_by            uuid references auth.users (id),
  constraint app_settings_singleton check (id = true),
  constraint vat_rate_range      check (vat_rate between 0 and 1),
  constraint tol_abs_nonneg      check (amount_tolerance_abs >= 0),
  constraint tol_pct_range       check (amount_tolerance_pct between 0 and 1),
  constraint qty_tol_nonneg      check (qty_tolerance >= 0),
  constraint date_window_range   check (date_window_days between 0 and 365),
  constraint rounding_mode_valid check (rounding_mode in ('half_up'))
);

insert into public.app_settings (id) values (true);

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------- Audit log (append-only) ----------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  table_name  text        not null,
  record_id   text        not null,
  action      text        not null,
  old_data    jsonb,
  new_data    jsonb,
  user_id     uuid,
  at          timestamptz not null default now()
);

create index audit_log_table_record_idx on public.audit_log (table_name, record_id);
create index audit_log_at_idx on public.audit_log (at desc);

create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rec jsonb;
begin
  rec := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  insert into public.audit_log (table_name, record_id, action, old_data, new_data, user_id)
  values (
    tg_table_name,
    coalesce(rec ->> 'id', 'n/a'),
    tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    auth.uid()
  );
  return null;
end;
$$;

create trigger profiles_audit
  after insert or update or delete on public.profiles
  for each row execute function public.audit_row();

create trigger app_settings_audit
  after insert or update or delete on public.app_settings
  for each row execute function public.audit_row();

-- ---------- Row Level Security: everything denied unless a policy allows it ----------
alter table public.profiles     enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_log    enable row level security;

-- profiles: you can read your own row; admins can read and change all rows.
create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.has_role(array['admin']::public.user_role[]));

create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (public.has_role(array['admin']::public.user_role[]))
  with check (public.has_role(array['admin']::public.user_role[]));
-- No INSERT policy (profiles are created by the trigger) and no DELETE policy.

-- app_settings: any active user may read; only admins may change.
create policy settings_select_active on public.app_settings
  for select to authenticated
  using (public.has_role(array['admin','accountant','viewer']::public.user_role[]));

create policy settings_update_admin on public.app_settings
  for update to authenticated
  using (public.has_role(array['admin']::public.user_role[]))
  with check (public.has_role(array['admin']::public.user_role[]));

-- audit_log: admins may read. Nobody can write directly (only the trigger does).
create policy audit_select_admin on public.audit_log
  for select to authenticated
  using (public.has_role(array['admin']::public.user_role[]));

-- ---------- Table privileges (defence in depth, on top of RLS) ----------
revoke all on public.profiles, public.app_settings, public.audit_log from anon, authenticated;

grant select, update on public.profiles     to authenticated;
grant select, update on public.app_settings to authenticated;
grant select         on public.audit_log    to authenticated;
