import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));

/** An in-memory PostgreSQL with just enough of Supabase's auth/storage schemas to run our migrations. */
export async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema auth, public, storage to anon, authenticated;
    grant select on auth.users to authenticated;
  `);
  await db.exec(readFileSync(dir + "0001_foundation.sql", "utf8"));
  await db.exec(readFileSync(dir + "0002_suppliers_periods_soa_import.sql", "utf8"));
  return db;
}

export async function asUser<T>(db: PGlite, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub','${userId}',false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}
