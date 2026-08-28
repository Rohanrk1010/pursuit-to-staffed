/**
 * reset.ts — put the SuccessFactors demo data back between runs.
 *
 *   npx tsx --env-file=../workforce-mcp/.env reset.ts          -> reset
 *   npx tsx --env-file=../workforce-mcp/.env reset.ts --check  -> only show current values
 *
 * Uses the same credentials as workforce-mcp (SFSF_API_HOST, SFSF_COMPANY_ID, SFSF_API_USER, SFSF_PASSWORD).
 * Restores cust_availability by consultant (matched on cust_skillsFit) and deletes every cust_ConsultantAssignment row.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // corporate TLS intercept, same as the connector

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
const ASSIGN = env("SFSF_ASSIGNMENT_ENTITY", "cust_ConsultantAssignment");
const F_FIT = process.env.SFSF_FIELD_SKILLSFIT ?? "cust_skillsFit";
const F_AVAIL = process.env.SFSF_FIELD_AVAILABILITY ?? "cust_availability";
const F_CONSULTANT = process.env.SFSF_FIELD_CONSULTANT ?? "cust_consultant";

// demo data sheet: skills fit -> availability
const TARGET_BY_FIT: Record<string, number> = { "95": 100, "92": 100, "88": 80, "97": 60, "84": 100, "94": 100, "91": 100, "89": 100, "86": 40, "82": 100, "78": 60 };

const login = USER.includes("@") ? USER : `${USER}@${COMPANY}`;
const auth = "Basic " + Buffer.from(`${login}:${PASS}`).toString("base64");

async function odata(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${HOST}/odata/v2${path}`, {
    method,
    headers: { Authorization: auth, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check");

  // 1. availability
  const av = await odata("GET", `/${AVAIL}?$format=json`);
  const rows: any[] = av.d?.results ?? [];
  console.log(`\n${AVAIL}: ${rows.length} rows`);
  for (const r of rows) {
    const fit = String(r[F_FIT] ?? "");
    const target = TARGET_BY_FIT[fit];
    const current = String(r[F_AVAIL] ?? "");
    const line = `  ${String(r[F_CONSULTANT] ?? r.externalCode).padEnd(10)} fit ${fit.padEnd(3)} availability ${current.padEnd(4)}`;
    if (checkOnly || target === undefined) {
      console.log(line + (target === undefined ? "  (no target for this fit — left as is)" : ""));
      continue;
    }
    if (current === String(target)) {
      console.log(line + "  ok");
      continue;
    }
    await odata("POST", "/upsert", { __metadata: { uri: AVAIL }, externalCode: r.externalCode, [F_AVAIL]: String(target) });
    console.log(line + `  -> ${target}`);
  }

  // 2. assignments
  const as = await odata("GET", `/${ASSIGN}?$format=json`);
  const arows: any[] = as.d?.results ?? [];
  console.log(`\n${ASSIGN}: ${arows.length} rows`);
  if (!checkOnly) {
    for (const r of arows) {
      const key = String(r.externalCode);
      try {
        await odata("DELETE", `/${ASSIGN}(externalCode='${encodeURIComponent(key)}')`);
        console.log(`  deleted ${key}`);
      } catch (e1) {
        try {
          await odata("DELETE", `/${ASSIGN}('${encodeURIComponent(key)}')`);
          console.log(`  deleted ${key}`);
        } catch (e2) {
          console.log(`  could not delete ${key}: ${e2 instanceof Error ? e2.message : e2}`);
        }
      }
    }
  }
  console.log(checkOnly ? "\ncheck done" : "\nreset done — SuccessFactors is back to the demo data sheet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
