// SAP-number sign in. A person's identifier is their SAP number; Supabase
// Auth only speaks email, so each account gets a synthetic, unreachable one.
export const EMAIL_DOMAIN = 'te-ndt-qcms.internal'

export const sapEmail = (sapNo) => `${sapNo.trim()}@${EMAIL_DOMAIN}`

// Supabase's password policy requires at least 6 characters. Several SAP
// numbers are only 4 digits, so whatever is typed into a password field is
// zero-padded on the left before it reaches Supabase. This is a no-op for
// anything already 6+ characters — true for every real password someone
// chooses for themselves, since Supabase enforces that minimum when a
// password is set — so it only ever changes the short, all-numeric default.
// A person only ever types their own SAP number; they never see the padding.
// Must match passwordFor() in supabase/functions/admin-people/index.ts.
export const normalizePassword = (value) => value.trim().padStart(6, '0')
