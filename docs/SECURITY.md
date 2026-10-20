# Security notes

- **Authentication:** Supabase Auth, self-sign-up disabled. Only administrators can see/change user roles; the last active administrator cannot be removed.
- **Authorisation:** every table has Row Level Security. Roles: viewer (read and export), accountant (import, match, allocate, manage discrepancies and refunds), admin (also settings, users, revert imports, lock/unlock periods, remove manually typed payments). The app re-checks the role on the server for every action; the database enforces it even if the app is bypassed.
- **Server-side validation:** every form is validated on the server; amounts use exact decimal arithmetic; numbers and dates are parsed strictly.
- **Secrets:** only the public Supabase URL and anon key are used by the app. The `service_role` key is never used or needed. Do not put it in Vercel or GitHub.
- **Files:** uploaded to a private bucket under the supplier's folder, size-limited (20 MB), type-checked by content (not only the name). Files are hashed so the same file can never be imported twice.
- **Excel exports:** text beginning with = + - @ is neutralised so a malicious supplier file cannot run a formula in your Excel. Exports run with the signed-in user's permissions.
- **Integrity:** imported documents, statement lines and allocations cannot be edited (database triggers, even for administrators); allocation caps prevent counting a payment or credit note twice; all changes to financial tables go to an append-only audit log.
- **Headers:** frame-denial, no-sniff, strict transport security and a restrictive referrer policy are set on every response.
- **Known limits:** text-based PDFs only; the PDF reader knows the Saudi Vetonit layout, other suppliers use Excel/CSV or need a reader added; the audit log is readable by administrators in the Supabase table editor (no in-app screen yet).
