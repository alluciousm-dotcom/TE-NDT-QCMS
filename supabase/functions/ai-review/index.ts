// Supabase Edge Function: ai-review
//
// Reviews one uploaded document and records the result in ai_review_log.
// The OpenAI key lives here and only here. It is never exposed to the browser.
//
// Deploy:
//   supabase functions deploy ai-review
//   supabase secrets set OPENAI_API_KEY=sk-...
//
// The prompt template is versioned. Bump PROMPT_VERSION whenever the wording
// changes, so past verdicts stay attributable to the prompt that produced them.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PROMPT_VERSION = "1.0.0";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
const IN_PER_MTOK = Number(Deno.env.get("OPENAI_INPUT_PER_MTOK") ?? "0.15");
const OUT_PER_MTOK = Number(Deno.env.get("OPENAI_OUTPUT_PER_MTOK") ?? "0.60");

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You review compliance documents for a non-destructive testing contractor.
You do not make the compliance decision. A human manager does. Your job is to surface what they
should look at.

Return strict JSON matching the schema. Rules:
- Report only what is visibly present in the document. Never infer a date that is not printed.
- If the document is unreadable, the wrong type, or missing a required field, say so as a finding.
- verdict is "pass" only when every requirement in the checklist is visibly satisfied.
- verdict is "needs_review" when the document is plausible but something is ambiguous or unreadable.
- verdict is "fail" when the document is clearly the wrong type, expired, or altered.
- confidence is your own calibration between 0 and 1. Be honest about low confidence.
- id_number and position are read only from identity documents and employment
  letters. Leave both null on any other document type, and never guess.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "findings", "extracted"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "needs_review"] },
    confidence: { type: "number" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "field", "detail"],
        properties: {
          severity: { type: "string", enum: ["info", "warning", "blocker"] },
          field: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    extracted: {
      type: "object",
      additionalProperties: false,
      required: ["holder_name", "issued_on", "expires_on", "issuer", "id_number", "position"],
      properties: {
        holder_name: { type: ["string", "null"] },
        issued_on: { type: ["string", "null"] },
        expires_on: { type: ["string", "null"] },
        issuer: { type: ["string", "null"] },
        // Only present on identity and employment documents (ID-copy,
        // Employ-Pr). Null everywhere else. Read from the document, never
        // written back to the profile automatically — a manager copies it
        // across after reviewing the document themselves.
        id_number: { type: ["string", "null"] },
        position: { type: ["string", "null"] },
      },
    },
  },
};

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const started = Date.now();
  const authHeader = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Caller-scoped client: row level security decides what this person may see.
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  // Service client: writes the review log and the audit row.
  const asService = createClient(url, serviceKey);

  let documentId = "";
  let requestId = crypto.randomUUID();
  let subjectId = "";
  let documentHash = "";
  let promptHash = "";

  try {
    const body = await req.json();
    documentId = body.document_id;
    requestId = body.request_id ?? requestId;
    if (!documentId) throw new Error("document_id is required");

    const { data: user } = await asCaller.auth.getUser();
    if (!user?.user) throw new Error("not authenticated");

    // RLS on this select is the authorisation check. If the caller may not read
    // the document, they may not have it reviewed either.
    const { data: doc, error: docErr } = await asCaller
      .from("documents")
      .select("id, subject_id, storage_path, file_name, mime_type, file_hash, document_types(code, name, review_prompt)")
      .eq("id", documentId)
      .single();
    if (docErr || !doc) throw new Error("document not found or not visible to you");

    subjectId = doc.subject_id;
    documentHash = doc.file_hash;

    const { data: file, error: fileErr } = await asService.storage
      .from("compliance-docs")
      .download(doc.storage_path);
    if (fileErr || !file) throw new Error("stored file could not be read");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const b64 = toBase64(bytes);
    const isPdf = (doc.mime_type ?? "").includes("pdf");

    const checklist = doc.document_types?.review_prompt ?? "Confirm the document is legible and current.";
    const userPrompt =
      `Document type: ${doc.document_types?.name} (${doc.document_types?.code})\n` +
      `Checklist for this type: ${checklist}\n` +
      `Today's date: ${new Date().toISOString().slice(0, 10)}`;

    promptHash = await sha256Hex(SYSTEM_PROMPT + "\n" + userPrompt);

    const content: unknown[] = [{ type: "input_text", text: userPrompt }];
    if (isPdf) {
      content.push({
        type: "input_file",
        filename: doc.file_name,
        file_data: `data:application/pdf;base64,${b64}`,
      });
    } else {
      content.push({
        type: "input_image",
        image_url: `data:${doc.mime_type ?? "image/jpeg"};base64,${b64}`,
      });
    }

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: SYSTEM_PROMPT,
        input: [{ role: "user", content }],
        text: {
          format: { type: "json_schema", name: "document_review", strict: true, schema: SCHEMA },
        },
      }),
    });

    if (!res.ok) throw new Error(`model call failed: ${res.status} ${await res.text()}`);
    const payload = await res.json();

    const text =
      payload.output_text ??
      payload.output?.[0]?.content?.find((c: { type: string }) => c.type === "output_text")?.text;
    const review = JSON.parse(text);

    const inTok = payload.usage?.input_tokens ?? 0;
    const outTok = payload.usage?.output_tokens ?? 0;
    const cost = (inTok / 1e6) * IN_PER_MTOK + (outTok / 1e6) * OUT_PER_MTOK;

    await asService.from("ai_review_log").insert({
      document_id: documentId,
      subject_id: subjectId,
      request_id: requestId,
      model: MODEL,
      prompt_version: PROMPT_VERSION,
      prompt_hash: promptHash,
      document_hash: documentHash,
      verdict: review.verdict,
      findings: review.findings,
      confidence: review.confidence,
      extracted: review.extracted,
      prompt_tokens: inTok,
      completion_tokens: outTok,
      cost_usd: Number(cost.toFixed(6)),
      latency_ms: Date.now() - started,
    });

    await asService.from("documents").update({ ai_verdict: review.verdict }).eq("id", documentId);

    await asService.from("audit_log").insert({
      actor_id: user.user.id,
      actor_role: "system",
      action: "ai_review.completed",
      entity_type: "document",
      entity_id: documentId,
      subject_id: subjectId,
      outcome: "success",
      after_state: { verdict: review.verdict, model: MODEL, prompt_version: PROMPT_VERSION },
      request_id: requestId,
    });

    return new Response(JSON.stringify(review), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    // A failed review is still a logged review. Silent failures are how backlogs hide.
    if (documentId && subjectId) {
      await asService.from("ai_review_log").insert({
        document_id: documentId,
        subject_id: subjectId,
        request_id: requestId,
        model: MODEL,
        prompt_version: PROMPT_VERSION,
        prompt_hash: promptHash || "n/a",
        document_hash: documentHash || "n/a",
        verdict: "error",
        findings: [{ severity: "blocker", field: "system", detail: String(err) }],
        latency_ms: Date.now() - started,
      });
    }
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
