# TE_NDT_QCMS personnel compliance

Certification and compliance records for NDT inspection personnel. Three roles:

- **Staff** manage their own profile and upload the certificates their audits require.
- **Supervisors** see and upload for the staff assigned to them, and nobody else.
- **Managers** decide who is onboarded, who holds which role, and whether an audit passes.

React and Vite on the front, Supabase for auth, Postgres and storage, and one Supabase Edge
Function that runs AI assisted document review.

---

## The one architectural rule

There is no application server. A static bundle on Vercel or GitHub Pages talks straight to
Supabase, which means the browser is not trusted with anything.

**Clients never write to a table.** Row level security grants `select` only. Every state change
goes through a `security definer` function in `supabase/migrations/0002_audit.sql`, and each of
those functions writes its audit row in the same transaction as the change it describes. If the
change commits, the audit entry commits. There is no path where one happens without the other.

The OpenAI key lives in the Edge Function environment. Nothing prefixed `VITE_` is secret: it is
compiled into the JavaScript that ships to every browser.

---

## Setup

### 1. Supabase

Create a project, then run the migrations in order from the SQL editor or the CLI:

```bash
supabase link --project-ref your-project-ref
supabase db push
```

Or paste `0001_schema.sql`, `0002_audit.sql`, `0003_rls.sql` into the SQL editor in that order.

Make yourself a manager. Sign in through the app once so your profile row exists, then run:

```sql
update public.profiles set role = 'manager' where email = 'you@te-ndt-qcms.com';
```

This is the only role change that bypasses the audited path, because there is no manager yet to
authorise it. Every subsequent one goes through `set_user_role` and is logged.

### 2. Edge Function

```bash
supabase functions deploy ai-review
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set OPENAI_MODEL=gpt-4o-mini
supabase secrets set ALLOWED_ORIGIN=https://te-ndt-qcms.com
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

Check the model name and the Responses API request shape against current OpenAI documentation
before going live. Both move. `PROMPT_VERSION` in the function is stamped onto every review, so
when you change the prompt you can still tell which verdicts came from which version.

### 3. Local development

```bash
cp .env.example .env      # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

---

## Deploying

### Vercel (recommended for now)

Import the repository, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment
variables, and deploy. `vercel.json` sets the build output and security headers.

When `te-ndt-qcms.com` is ready, add it as a custom domain in Vercel, point the DNS there, and add
both the apex and the Vercel preview domain to Supabase under Authentication, URL configuration,
Redirect URLs. Sign in links break silently if you skip that step.

### GitHub Pages

`.github/workflows/deploy-pages.yml` builds and publishes on every push to `main`. Set
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as repository **variables**, not secrets, since
they end up in the bundle anyway and secrets are awkward to use in build steps.

The app uses `HashRouter` so deep links work on Pages without server rewrites. The workflow also
copies `index.html` to `404.html` as a fallback.

Pages cannot host the Edge Function, but it does not need to: the function runs on Supabase and
the browser calls it directly. Set `ALLOWED_ORIGIN` to your Pages URL while you are testing there.

---

## What gets logged

Two separate systems, deliberately.

**Audit trail** (`audit_log`). Business record. Written inside the transaction, append only,
enforced by a trigger that raises on update and delete. Each row is sealed with a SHA-256 hash of
its own content plus the previous row's hash, so altering history breaks the chain from that point
on. `verify_audit_chain()` walks it and returns the first broken id, and the Audit trail page
exposes that as a button. Schedule it nightly with `pg_cron` and alert on a non-null result.

Actions recorded: uploads, supersessions, approvals, rejections, audit open and decisions, role
grants, supervisor assignments, AI reviews, and views of another person's record.

**AI review log** (`ai_review_log`). Every call to the model, including failures. Records the exact
model string, prompt version, a hash of the rendered prompt, a hash of the reviewed file, the
verdict, findings, token counts, cost and latency. The `overridden` column is generated: it flags
where a manager disagreed with the model. Override rate by document type is the number that tells
you whether the prompt still matches reality.

Neither of these is your operational log. Application errors and latency belong in a log drain with
short retention, sampled, with the fields listed in the design document redacted before they leave
Supabase.

---

## Adding a certificate type

Insert a row into `document_types`. `review_prompt` is the per-type checklist handed to the model,
so write it as instructions to a careful human reviewer. `requires_expiry` drives both the upload
form validation and the expiry states in `compliance_matrix`. New types appear in the validity
strip automatically, ordered by `sort_order`.

---

## Known gaps

- The hash chain reads the last row on each insert, so concurrent writes serialise. Fine at this
  volume. If write rates climb, chain per subject or batch-seal hourly with a Merkle root.
- No email notifications yet. Expiry reminders want a `pg_cron` job reading `compliance_matrix`
  where `days_remaining` is between 0 and 30.
- No audit export. Auditors will ask for a signed record for one person over a date range, and you
  do not want to be writing that under deadline.
- Signed storage URLs last 60 seconds and are never logged. Keep it that way: a signed URL in a log
  line is a live credential.
