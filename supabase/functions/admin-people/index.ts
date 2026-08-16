// Supabase Edge Function: admin-people
//
// The only place accounts are created or passwords are reset. Both need
// auth.admin, which needs the service role key, which is never handed to the
// browser. A manager calls this function with their own session; it checks
// their role itself (RLS is not in play here, since the service client
// bypasses it) and writes its own audit row, the same way ai-review does.
//
// Deploy:
//   supabase functions deploy admin-people

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EMAIL_DOMAIN = "te-ndt-qcms.internal";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Supabase's default password policy requires at least 6 characters. Several
// SAP numbers are only 4 digits, so the login password is the SAP number
// zero-padded to 6 on the left. This happens on both ends (here, and in the
// browser at sign-in) and is invisible to the person typing their SAP
// number — they never see or type the padding.
function passwordFor(sapNo: string): string {
  return sapNo.padStart(6, "0");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const asService = createClient(url, serviceKey);

  try {
    const { data: caller } = await asCaller.auth.getUser();
    if (!caller?.user) throw new Error("not authenticated");

    const { data: callerProfile, error: profileErr } = await asCaller
      .from("profiles")
      .select("id, role")
      .eq("id", caller.user.id)
      .single();
    if (profileErr || !callerProfile) throw new Error("no profile for caller");
    if (callerProfile.role !== "manager") throw new Error("only a manager may manage people");

    const body = await req.json();
    const requestId = body.request_id ?? crypto.randomUUID();

    if (body.action === "provision") {
      const sapNo = String(body.sap_no ?? "").trim();
      const depotCode = String(body.depot_code ?? "").trim();
      const role = String(body.role ?? "").trim();
      const discipline = body.supervisor_discipline ?? null;
      const fullName = body.full_name?.trim() || null;

      if (!sapNo) throw new Error("SAP number is required");
      if (!depotCode) throw new Error("Region is required");
      if (!["staff", "supervisor", "manager"].includes(role)) throw new Error("invalid role");
      if (role === "supervisor" && !["QA", "OPS"].includes(discipline)) {
        throw new Error("a supervisor needs a discipline: QA or OPS");
      }

      const { data: existing } = await asService
        .from("profiles")
        .select("id")
        .eq("sap_no", sapNo)
        .maybeSingle();
      if (existing) throw new Error(`SAP number ${sapNo} already has an account`);

      const email = `${sapNo}@${EMAIL_DOMAIN}`;
      const { data: created, error: createErr } = await asService.auth.admin.createUser({
        email,
        password: passwordFor(sapNo),
        email_confirm: true,
        user_metadata: {
          full_name: fullName ?? `Pending — SAP ${sapNo}`,
          sap_no: sapNo,
          depot_code: depotCode,
          role,
          supervisor_discipline: role === "supervisor" ? discipline : null,
        },
      });
      if (createErr || !created.user) throw new Error(createErr?.message ?? "account creation failed");

      const { data: newProfile } = await asService
        .from("profiles")
        .select("*")
        .eq("id", created.user.id)
        .single();

      await asService.from("audit_log").insert({
        actor_id: caller.user.id,
        actor_role: "manager",
        action: "profile.provisioned",
        entity_type: "profile",
        entity_id: created.user.id,
        subject_id: created.user.id,
        outcome: "success",
        after_state: newProfile,
        request_id: requestId,
      });

      return jsonResponse({ profile: newProfile });
    }

    if (body.action === "reset_password") {
      const subjectId = body.subject_id;
      if (!subjectId) throw new Error("subject_id is required");

      const { data: subjectProfile } = await asService
        .from("profiles")
        .select("id, sap_no")
        .eq("id", subjectId)
        .single();
      if (!subjectProfile) throw new Error("person not found");

      // A manager may reset to a password of their choosing, or omit new_password
      // to reset it back to the person's own SAP number.
      const newPassword = body.new_password
        ? String(body.new_password)
        : passwordFor(subjectProfile.sap_no ?? "");
      if (newPassword.length < 6) throw new Error("password must be at least 6 characters");

      const { error: updateErr } = await asService.auth.admin.updateUserById(subjectId, {
        password: newPassword,
      });
      if (updateErr) throw new Error(updateErr.message);

      await asService.from("audit_log").insert({
        actor_id: caller.user.id,
        actor_role: "manager",
        action: "password.reset_by_manager",
        entity_type: "profile",
        entity_id: subjectId,
        subject_id: subjectId,
        outcome: "success",
        request_id: requestId,
      });

      return jsonResponse({ ok: true });
    }

    throw new Error("unknown action");
  } catch (err) {
    return jsonResponse({ error: String(err instanceof Error ? err.message : err) }, 400);
  }
});
