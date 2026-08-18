# TE-NDT QCMS — Personnel Compliance

Certification and compliance records for NDT (non-destructive testing) inspection personnel.
Three roles:

- **Staff** manage their own profile and upload the certificates their audits require.
- **Supervisors** see and upload for the staff assigned to them, and nobody else.
- **Managers** decide who is onboarded, who holds which role and region, which NDT method/level
  qualifications are on record, and whether an audit passes.

React and Vite on the front. Supabase for auth, Postgres, storage and two Edge Functions. No
application server: the static bundle talks to Supabase directly.

Live project: `cvnmspdyvdmwoqkkeics` (Supabase, `eu-west-3`). Repo:
`github.com/alluciousm-dotcom/TE-NDT-QCMS`. Hosted on GitHub Pages, deployed on every push to
`main` by `.github/workflows/deploy-pages.yml`.

---

## The one architectural rule

**Clients never write to a table.** Row level security grants `select` only. Every state change
goes through a `security definer` function in `supabase/migrations/0002_audit.sql`, and each of
those functions writes its audit row in the same transaction as the change it describes. If the
change commits, the audit entry commits. There is no path where one happens without the other.

The OpenAI key lives only in the `ai-review` Edge Function's environment. Nothing prefixed
`VITE_` is secret: it is compiled into the JavaScript that ships to every browser.

---

## Signing in: SAP number, not email

Nobody has a work email in this system — identity is the SAP number already printed on their
badge and payslip. Supabase Auth only speaks email/password, so each account gets a synthetic,
unreachable one: `{sapNo}@te-ndt-qcms.internal` (`src/lib/auth.js`). The password is the SAP
number itself.

Supabase enforces a 6-character password minimum, and several SAP numbers are only 4 digits, so
whatever's typed into the password field — at sign-in, at self-service password change, and at
account provisioning — is zero-padded on the left to 6 characters
(`"6428" → "006428"`) before it reaches Supabase. This is invisible to the person: they only ever
type their own SAP number. It's also harmless for a real chosen password, since `padStart` is a
no-op on anything already 6+ characters, which every self-chosen password already has to be.

A person can change their own password from **Account** (re-verified against the current one
first, so an unlocked unattended browser can't be used to take over the account) and upload their
own avatar. A manager can reset anyone's password back to their SAP number from **People**.

---

## Provisioning people

New accounts are created through the `admin-people` Edge Function (**People → Add a person**),
never through Supabase's normal sign-up flow — a synthetic email can't receive a confirmation
link, so the function creates the account via the Auth admin API with `email_confirm: true` and
the chosen role/region/discipline stamped into `user_metadata`. `handle_new_user()`
(`0001_schema.sql`) reads that metadata and seeds the `profiles` row in the same trigger, so the
account is fully usable the moment it's created.

Bootstrapping the very first manager account (before any manager exists to use **Add a person**)
was done once, by hand, the same way the original DKMS-NDT README documented: create the auth
user, then a one-off SQL `update profiles set role = 'manager'`. Every subsequent role change goes
through `set_user_role` and is logged.

---

## NDT method qualifications

A person can hold **more than one level of the same method at once** — PT Level 1 and PT Level 2
both on file are two independent, coexisting facts, not one overwriting the other.
`staff_ndt_qualifications` keys on `(subject_id, method, level)`, not `(subject_id, method)`.
Levels run 1–4 (standard ASNT/ISO schemes stop at 3; widened to 4 on request pending confirmation
whether a 4th level is actually needed).

The **Q-Cert** document type is `per_method` (`document_types.per_method`): every upload asks
which method *and* level it covers. Uploading a new PT Level 2 certificate only ever supersedes an
existing PT Level 2 — a Level 1 certificate on file is untouched. **Approving** a per-method
document automatically writes the matching row into `staff_ndt_qualifications` in the same
transaction (`decide_document`), so the certificate and the recorded qualification can't silently
drift apart. A manager can also grant or revoke any specific `(method, level)` directly from a
person's record, independent of any document — useful for correcting history, or for a
qualification that predates this feature (see "known gotchas" below).

The compliance view expands a per-method type into one tracked row per method+level the person
actually holds a qualification or a document for, so "Qualification certificate (PT · Level 1)"
and "(PT · Level 2)" show as independently tracked requirements, each with its own status.

---

## Documents

`documents.status`: `pending → approved | rejected`, plus two terminal states outside that
lifecycle: `superseded` (a newer submission for the same type/method/level replaced it) and
`deleted` (a manager or the assigned supervisor retracted a mistaken upload — wrong file, wrong
person, duplicate, test upload). **Deletion never erases anything**: the row and the stored file
stay, audited like every other action, but the document drops out of the person's active record
and compliance status the same way a superseded one does. Only `pending` or `rejected` documents
can be deleted — an approved certificate is live compliance evidence and can only be superseded by
a fresh submission, never deleted out from under someone.

A document can be marked `never_expires` at upload time (with a manager-facing checkbox) for
certificate types that carry no expiry, rather than forcing a fake date into `expires_on`.

---

## Data model

| Table | What it holds |
|---|---|
| `profiles` | One row per person. SAP number, region, role, supervisor discipline (QA/OPS), ID number, position, avatar, employment dates. |
| `depots` | The 8 regions (BFN, KZNDBN, KZNSD, GMX, KDS, WCSRX, UTH, WCSLD). |
| `staff_assignments` | Supervisor → staff, for the "supervises the people assigned to them" rule. |
| `staff_ndt_qualifications` | `(subject_id, method, level)` — see above. |
| `document_types` | The 7 certificate types (Q-Cert, Exam-R, Class-Tr, Log-B, ID-copy, Eye-test, Employ-Pr), each with `requires_expiry`, `manager_only` (Log-B only), `per_method` (Q-Cert only). |
| `documents` | One row per upload/version. `method`/`level` when `per_method`; `never_expires`; full decision trail. |
| `compliance_audits` | Formal pass/fail audits a manager opens and decides on a person. |
| `audit_log` | Hash-chained, append-only. See "What gets logged". |
| `ai_review_log` | Every AI review call, including failures. |

`compliance_matrix` is the view every list/dashboard reads: one row per person per mandatory
requirement (expanding per-method types into their held method+level combinations), with the
current state of its most recent non-superseded, non-deleted submission — `missing`, `pending`,
`expiring`, `expired`, `rejected`, or `valid`.

---

## Edge Functions

**`admin-people`** — the only place accounts are created or passwords are reset. Both need
`auth.admin`, which needs the service role key, which the browser never sees. A manager calls it
with their own session; it checks their role itself and writes its own audit row.

**`ai-review`** — reviews one uploaded document against the document type's `review_prompt` and
records a verdict, findings, and extracted fields (holder name, dates, ID number, position where
relevant) in `ai_review_log`. Advisory only — "this is a reading aid, the compliance decision
stays with the manager" is both the UI copy and the actual authorization model; nothing the model
returns writes to `documents` or `staff_ndt_qualifications`.

Neither function needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` set
manually — Supabase injects those automatically.

---

## Frontend pages

- **Dashboard** (manager landing page, `/`) — KPIs, a labelled donut for certificate status, expiry
  forecast, personnel-by-region and personnel-by-role donuts (real per-region/per-role colour from
  a colourblind-validated 8-hue categorical palette — see `src/components/ui.jsx`), qualified
  personnel by method (bars, not a donut — someone can hold several methods at once, so those
  counts aren't mutually-exclusive slices of one whole). A region filter (dropdown, or click a
  donut segment) scopes every panel and the export below it.
- **Compliance** (`/roster` for managers, `/` for staff/supervisors) — the person-by-person status
  list, filterable by not-cleared / expiring / awaiting review.
- **People** (manager only) — add a person, change role, reset a password, assign supervisors.
- A person's own record — certificate status, documents, NDT qualifications; a manager or
  supervisor additionally gets personnel-detail editing, qualification granting, document
  approve/reject/delete, and an inline document preview (see below).
- **Audit trail** — the append-only log, filterable by person.
- **Account** — change name/password/avatar.

### Document preview

Documents render inline (an expandable panel under each document row) rather than opening in a
new tab. That's a deliberate fix, not a style choice: `window.open()` called after an `await` is
silently blocked by most browsers since it no longer counts as a direct result of the click.
Images render as `<img>`; PDFs render via `pdf.js` onto a canvas (with zoom and page navigation)
rather than an `<iframe>`, because handing a PDF to the *browser's own* viewer has the same
silent-download problem — confirmed happening even with clean response headers, since it's a
browser/OS setting question, not something a server header can override. `pdf.js` needs its own
font-substitution data to render text using non-embedded fonts (most of the body text on a typical
scanned certificate); that data is copied into `public/pdfjs/` at build time since Vite can't
import a whole directory as a URL, and both `standardFontDataUrl` and `cMapUrl` are wired into the
renderer — without them, `pdf.js` silently drops that text instead of falling back, which reads as
"half the certificate is missing" rather than an error.

### Exports

The dashboard's Download control (one format dropdown, one button) respects the active region
filter. Four formats, all built client-side in `src/lib/export.js`:

- **CSV / Excel** — one row per person, full detail: SAP no, name, region, role, NDT
  qualifications, the status of each of the 6 fixed document types, and an outstanding-items
  summary. Excel uses `xlsx` (SheetJS) — installed from **SheetJS's own CDN
  (`cdn.sheetjs.com`), not the npm registry**, because the npm-published build carries unpatched
  high-severity CVEs (prototype pollution, ReDoS) that SheetJS fixed but never re-published to
  npm.
- **PDF / Word report** — a trimmed 7-column table (a 13-column table is unreadable on a printed
  page) plus a title, region/date subtitle, and the same summary KPIs shown on the dashboard.
  PDF via `jspdf` + `jspdf-autotable`; Word via `docx`. **`jsPDF`'s default font mangles
  non-ASCII characters** (em dashes, smart quotes, the "·" separator used elsewhere in the app)
  into a replacement-character glyph instead of erroring, which matters here because every
  placeholder name is literally `Pending — SAP XXXX`. `downloadPdf` sanitizes to ASCII
  equivalents before anything reaches the PDF; Word and CSV/Excel don't need this, they handle
  Unicode natively.

All three new libraries (`xlsx`, `jspdf`+`jspdf-autotable`, `docx`) are dynamically imported, so
none of them cost anything on a dashboard visit that never clicks Download.

---

## Setup

### 1. Supabase

Create a project, then run the three migrations in order — `0001_schema.sql`, `0002_audit.sql`,
`0003_rls.sql` — via `supabase db push` if the CLI is linked, or paste them into the SQL editor.
If you don't have the CLI available, a plain `pg` (node-postgres) script against the **session
pooler** connection string works fine and is what was actually used to deploy this project (direct
`db.<ref>.supabase.co:5432` connections are IPv6-only, which fails outright on an IPv4-only
network — use the session pooler host from **Connect → Session pooler** instead).

Make yourself a manager (see "Provisioning people" above for why this one step is manual).

### 2. Edge Functions

Deploy `admin-people` and `ai-review` (dashboard **Edge Functions → Deploy** paste-in, or
`supabase functions deploy <name>` if the CLI is linked), then set secrets:

```bash
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set OPENAI_MODEL=gpt-4o-mini
supabase secrets set ALLOWED_ORIGIN=https://your-deployed-url
```

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

### GitHub Pages (current)

`.github/workflows/deploy-pages.yml` builds and publishes on every push to `main`. Set
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as repository **variables** (Settings → Secrets
and variables → Actions → Variables), not secrets, since they end up in the bundle anyway.
**Pages source must be set to "GitHub Actions"** in Settings → Pages — GitHub's own Pages setup
wizard defaults to adding its own Jekyll workflow otherwise, which will race against and override
this one, serving raw unbuilt source instead of the built app.

The app uses `HashRouter` so deep links work on Pages without server rewrites. The workflow also
copies `index.html` to `404.html` as a fallback.

Once you have the Pages URL, add it to Supabase under **Authentication → URL Configuration →
Redirect URLs** — sign-in breaks silently if you skip that step.

### Vercel (alternative)

Import the repository, set the same two env vars, and deploy. `vercel.json` sets the build output
and security headers.

---

## What gets logged

Two separate systems, deliberately.

**Audit trail** (`audit_log`). Business record. Written inside the transaction, append only,
enforced by a trigger that raises on update and delete. Each row is sealed with a SHA-256 hash of
its own content plus the previous row's hash, so altering history breaks the chain from that point
on. `verify_audit_chain()` walks it and returns the first broken id, and the Audit trail page
exposes that as a button. Schedule it nightly with `pg_cron` and alert on a non-null result.
**Never cleared, even during development** — the entries from this system's own build-and-test
phase (16–18 Aug 2026) were deliberately kept rather than wiped when the test *data* (documents,
qualifications) was cleared for go-live, specifically because clearing the audit trail itself
would mean bypassing the append-only trigger that's the whole point of the table.

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
form validation and the expiry states in `compliance_matrix`. Set `per_method = true` only if the
certificate is method-specific like Q-Cert (Exam-R and Class-Tr are plausibly also per-method in
reality — a person likely sits a separate exam per method — but that hasn't been confirmed, so
they're still generic single-slot types). New types appear in the validity strip automatically,
ordered by `sort_order`.

---

## Known gotchas (Postgres/Supabase-specific — read before your next migration)

- **`CREATE OR REPLACE FUNCTION` does not replace a function whose parameter list changed** — it
  silently creates a second overload alongside the old one. This bit `record_upload` twice in this
  project's history (once when `never_expires` was added, once when `method` was added), leaving
  ambiguous-overload errors waiting to happen on the next call. If you add or remove a parameter,
  `drop function` the old signature explicitly first.
- **`pgcrypto` lives in the `extensions` schema on Supabase, not `public`.** Any
  `security definer` function that calls `digest()` (or another pgcrypto function) needs
  `set search_path = public, extensions`, not just `public` — otherwise it fails with `function
  digest(text, unknown) does not exist`, and since `audit_log_seal()` is called inside every
  audited write, this quietly breaks *every* write in the app, not just the one that surfaces it.
- **`ALTER TYPE ... ADD VALUE` cannot be used in the same transaction as code that references the
  new value.** Adding an enum value (e.g. `doc_status` gaining `'deleted'`) needs its own
  standalone, auto-committed statement before any view or function in the same migration run can
  compare against it.
- **Direct Postgres connections (`db.<ref>.supabase.co:5432`) are IPv6-only.** They fail with
  `ENOTFOUND`/timeout on an IPv4-only network with no useful error pointing at why. Use the
  session pooler connection string instead for anything run from a network without IPv6 egress.

---

## Known gaps

- No training register, exam register, or SNT-TC-1A written-practice tracking as first-class,
  structured data — only document uploads (Class-Tr, Exam-R) stand in for them today.
- No capacity planning / equipment utilisation tracking — nothing about equipment exists in the
  schema at all.
- No findings/corrective-action register or exceptions/risk register — `compliance_audits` has one
  free-text `notes` field per audit, not a list of discrete, individually-tracked findings.
- The hash chain reads the last row on each insert, so concurrent writes serialise. Fine at this
  volume. If write rates climb, chain per subject or batch-seal hourly with a Merkle root.
- No email notifications yet. Expiry reminders want a `pg_cron` job reading `compliance_matrix`
  where `days_remaining` is between 0 and 30.
- No audit export beyond the CSV/Excel/PDF/Word compliance exports — a signed, single-person,
  date-ranged record for an external auditor is still a manual job.
- Signed storage URLs last up to 3 minutes for inline viewing (originally 60 seconds; extended
  once, for readability, not for download) and are never logged. Keep it that way: a signed URL
  in a log line is a live credential.
- Deleting a document via `delete_document` removes it from the app's view but does not delete
  the underlying file from storage — there's no delete policy on `storage.objects` for
  `compliance-docs` by design (documents are never truly erased), so old bytes for genuinely
  deleted rows sit inert and unreachable in the bucket rather than being purged.