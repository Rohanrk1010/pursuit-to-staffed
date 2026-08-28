/**
 * seed.ts — add six more consultants to cust_ConsultantAvailability so runs can pick different teams.
 *
 *   npx tsx --env-file=../workforce-mcp/.env seed.ts          -> add the six (skips ones already there)
 *   npx tsx --env-file=../workforce-mcp/.env seed.ts --check  -> only list current rows
 *
 * Uses the same credentials as workforce-mcp. cust_consultant only accepts existing SuccessFactors
 * user IDs, so the script maps six roles/fits onto real spare users from the tenant (their actual
 * names then display everywhere). Row keys are numeric (Edm.Int64), continuing from the highest.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${k}`);
  return v;
};
const HOST = env("SFSF_API_HOST").replace(/\/$/, "");
const COMPANY = env("SFSF_COMPANY_ID");
const USER = env("SFSF_API_USER");
const PASS = env("SFSF_PASSWORD");
const AVAIL = env("SFSF_AVAILABILITY_ENTITY", "cust_ConsultantAvailability");
const F = {
  consultant: process.env.SFSF_FIELD_CONSULTANT ?? "cust_consultant",
  role: "cust_role",
  skills: "cust_Skills",
  fit: process.env.SFSF_FIELD_SKILLSFIT ?? "cust_skillsFit",
  avail: process.env.SFSF_FIELD_AVAILABILITY ?? "cust_availability",
  start: "cust_AvailabilityStartDate",
  end: "cust_AvailabilityEndDate",
};

const login = USER.includes("@") ? USER : `${USER}@${COMPANY}`;
const auth = "Basic " + Buffer.from(`${login}:${PASS}`).toString("base64");

async function odata(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${HOST}/odata/v2${path}`, {
    method,
    headers: { Authorization: auth, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const toSfDate = (iso: string) => `/Date(${Date.parse(`${iso}T00:00:00Z`)})/`;
const START = "2026-09-01";
const END = "2027-02-28";

// six profiles to add — they get mapped onto real tenant users at runtime
// (cust_consultant only accepts existing SuccessFactors user IDs)
const PROFILES = [
  { role: "ARCHITECT",     fit: 94, avail: 100 },
  { role: "SR_CONSULTANT", fit: 91, avail: 100 },
  { role: "ENG_MANAGER",   fit: 89, avail: 100 },
  { role: "SR_CONSULTANT", fit: 86, avail: 40 },
  { role: "ANALYST",       fit: 82, avail: 100 },
  { role: "ANALYST",       fit: 78, avail: 60 },
];

async function main() {
  const checkOnly = process.argv.includes("--check");
  const res = await odata("GET", `/${AVAIL}?$format=json`);
  const rows: any[] = res.d?.results ?? [];
  console.log(`current rows: ${rows.length}`);
  for (const r of rows) console.log(`  ${String(r[F.consultant]).padEnd(12)} fit ${r[F.fit]}  avail ${r[F.avail]}`);
  if (checkOnly) return console.log("\ncheck done");

  const used = new Set(rows.map((r) => String(r[F.consultant])));

  // find real users in the tenant that are not yet consultants
  const ures = await odata("GET", `/User?$select=userId,firstName,lastName,status&$top=100&$format=json`);
  const users: any[] = ures.d?.results ?? [];
  const candidates = users
    .map((u) => ({ userId: String(u.userId), name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() }))
    .filter((u) => u.userId && !used.has(u.userId));
  console.log(`\nusers in tenant: ${users.length}, free to use as consultants: ${candidates.length}`);
  if (candidates.length === 0) {
    console.log("no spare users found — Arun Sri needs to point us atsix more user IDs, or create users.");
    return;
  }

  const recordResult = (resp: any) => {
    const d = Array.isArray(resp?.d) ? resp.d[0] : resp?.d;
    return { ok: String(d?.status ?? "").toUpperCase() === "OK", msg: String(d?.message ?? d?.status ?? "no message") };
  };
  let keyCounter = rows.map((r) => Number(r.externalCode)).filter((n) => Number.isFinite(n)).reduce((a, b) => Math.max(a, b), 0) + 1;

  const take = Math.min(PROFILES.length, candidates.length);
  for (let i = 0; i < take; i++) {
    const u = candidates[i];
    const p = PROFILES[i];
    const resp = await odata("POST", "/upsert", {
      __metadata: { uri: AVAIL },
      externalCode: String(keyCounter),
      [F.consultant]: u.userId,
      [F.role]: p.role,
      [F.skills]: "S/4 Finance, BTP CAP, Data Eng",
      [F.fit]: String(p.fit),
      [F.avail]: String(p.avail),
      [F.start]: toSfDate(START),
      [F.end]: toSfDate(END),
    });
    const r = recordResult(resp);
    if (r.ok) {
      console.log(`  added ${u.userId} ${u.name || "(no name)"} — ${p.role}, fit ${p.fit}, avail ${p.avail}`);
      keyCounter += 1;
    } else {
      console.log(`  ${u.userId} ${u.name}: -> ${r.msg}`);
    }
  }
  if (take < PROFILES.length) console.log(`only ${take} of ${PROFILES.length} added — not enough spare users`);

  const after = await odata("GET", `/${AVAIL}?$format=json`);
  console.log(`\nrows now: ${(after.d?.results ?? []).length}`);
  console.log("seed done — note the added user IDs and names for the data sheet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
