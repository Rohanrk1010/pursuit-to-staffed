/**
 * workforce-mcp  —  MCP-3 for the "Pursuit to Staffed" demo
 *
 * Tools exposed to the orchestrator:
 *   check_availability     -> reads cust_Availability, ranks consultants by skills fit + availability
 *   staff_team             -> upserts cust_Assignment rows, reduces availability
 *   get_consultant_profile -> User + availability row
 *
 * Backend: real SuccessFactors tenant, OData v2 (/odata/v2), two custom MDF objects:
 *   cust_Availability : externalCode(=userId), cust_role, cust_skills ("S/4 Finance:98;BTP CAP:95;Data Eng:92"),
 *                       cust_startDate, cust_endDate, cust_availablePct
 *   cust_Assignment   : externalCode(=engagementId-userId), cust_userId, cust_engagementId,
 *                       cust_startDate, cust_endDate, cust_utilizationPct
 *   (field names are configurable below — match them to what you create in Configure Object Definitions)
 *
 * Auth: OAuth 2.0 SAML bearer (Manage OAuth2 Client Applications -> client_id + X.509 private key),
 *       or SFSF_AUTH_MODE=basic if the tenant still allows basic auth for the API user.
 *
 * Run : npm i @modelcontextprotocol/sdk express zod && npx tsx --env-file=.env workforce-mcp.ts
 * Test: npx @modelcontextprotocol/inspector -> Streamable HTTP, http://localhost:8083/mcp,
 *       header  Authorization: Bearer <MCP_TOKEN>
 */
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------------------------------------------------------------------
// Config (environment only)
// ---------------------------------------------------------------------------
const env = (key: string, fallback?: string): string => {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${key}`);
  return v;
};

const SFSF = {
  apiHost: env("SFSF_API_HOST"),                       // https://api<dc>.successfactors.com  (your data center)
  companyId: env("SFSF_COMPANY_ID"),
  authMode: env("SFSF_AUTH_MODE", "oauth"),            // "oauth" (SAML bearer) or "basic"
  apiUser: env("SFSF_API_USER"),                       // API user id (oauth) or user (basic)
  password: process.env.SFSF_PASSWORD ?? "",           // basic only
  clientId: process.env.SFSF_CLIENT_ID ?? "",          // oauth only: from Manage OAuth2 Client Applications
  privateKey: process.env.SFSF_PRIVATE_KEY ?? "",      // oauth only: PEM body without header/footer lines
  availabilityEntity: env("SFSF_AVAILABILITY_ENTITY", "cust_Availability"),
  assignmentEntity: env("SFSF_ASSIGNMENT_ENTITY", "cust_Assignment"),
};
const MCP_TOKEN = env("MCP_TOKEN");
const PORT = Number(process.env.PORT ?? 8083);

// Field names of the two MDF objects — TODO: match to your object definitions
const F = {
  role: "cust_role",
  skills: "cust_skills",
  start: "cust_startDate",
  end: "cust_endDate",
  availablePct: "cust_availablePct",
  userId: "cust_userId",
  engagementId: "cust_engagementId",
  utilizationPct: "cust_utilizationPct",
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
let token: { value: string; expiresAt: number } | null = null;

async function authHeader(): Promise<string> {
  if (SFSF.authMode === "basic") {
    return "Basic " + Buffer.from(`${SFSF.apiUser}@${SFSF.companyId}:${SFSF.password}`).toString("base64");
  }
  if (token && Date.now() < token.expiresAt) return `Bearer ${token.value}`;

  // 1) Ask the SuccessFactors IdP endpoint for a SAML assertion for the API user
  const idp = await fetch(`${SFSF.apiHost}/oauth/idp`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SFSF.clientId,
      user_id: SFSF.apiUser,
      token_url: `${SFSF.apiHost}/oauth/token`,
      private_key: SFSF.privateKey,
    }),
  });
  if (!idp.ok) throw new Error(`SFSF /oauth/idp failed: HTTP ${idp.status} ${(await idp.text()).slice(0, 300)}`);
  const assertion = await idp.text();

  // 2) Exchange the assertion for an access token
  const tk = await fetch(`${SFSF.apiHost}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      company_id: SFSF.companyId,
      client_id: SFSF.clientId,
      grant_type: "urn:ietf:params:oauth:grant-type:saml2-bearer",
      assertion,
    }),
  });
  if (!tk.ok) throw new Error(`SFSF /oauth/token failed: HTTP ${tk.status} ${(await tk.text()).slice(0, 300)}`);
  const j = (await tk.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000 };
  return `Bearer ${token.value}`;
}

// ---------------------------------------------------------------------------
// Thin OData v2 client
// ---------------------------------------------------------------------------
async function odata(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${SFSF.apiHost}/odata/v2${path}`, {
    method,
    headers: {
      Authorization: await authHeader(),
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`SFSF ${method} ${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return r.json();
}

// SF OData v2 dates: write "/Date(ms)/", read the same back
const toSfDate = (isoDate: string) => `/Date(${Date.parse(`${isoDate}T00:00:00Z`)})/`;
const fromSfDate = (v?: string): string | null => {
  const m = v && /\/Date\((-?\d+)\)\//.exec(v);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : v ?? null;
};
const filterDate = (isoDate: string) => `datetime'${isoDate}T00:00:00'`;

// "S/4 Finance:98;BTP CAP:95;Data Eng:92" -> { "s/4 finance": 98, ... }
const parseSkills = (s: string): Record<string, number> =>
  Object.fromEntries(
    String(s ?? "")
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.lastIndexOf(":");
        return [p.slice(0, i).trim().toLowerCase(), Number(p.slice(i + 1)) || 0];
      }),
  );

const skillsFit = (skills: Record<string, number>, required: string[]) =>
  required.length === 0
    ? 0
    : Math.round(required.reduce((sum, k) => sum + (skills[k.toLowerCase()] ?? 0), 0) / required.length);

// MDF upsert: POST /upsert with __metadata.uri = entity name, key + fields in the body
const upsert = (entity: string, row: Record<string, unknown>) =>
  odata("POST", "/upsert", { __metadata: { uri: entity }, ...row });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }],
});

// ---------------------------------------------------------------------------
// MCP server: the three tools
// ---------------------------------------------------------------------------
function buildServer(): McpServer {
  const server = new McpServer({ name: "workforce-mcp", version: "0.1.0" });

  server.registerTool(
    "check_availability",
    {
      title: "Check availability",
      description:
        "Return consultants available in the date range, ranked by skills fit against the required skills. " +
        "Read-only — no writes happen here.",
      inputSchema: {
        requiredSkills: z.array(z.string()).min(1).describe('e.g. ["S/4 Finance","BTP CAP","Data Eng"]'),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      },
    },
    async ({ requiredSkills, startDate, endDate }) => {
      try {
        const filter = `${F.start} le ${filterDate(startDate)} and ${F.end} ge ${filterDate(endDate)}`;
        const res = await odata(
          "GET",
          `/${SFSF.availabilityEntity}?$filter=${encodeURIComponent(filter)}&$format=json`,
        );
        const rows: any[] = res.d?.results ?? [];
        const ranked = rows
          .map((r) => {
            const skills = parseSkills(r[F.skills]);
            return {
              userId: r.externalCode,
              role: r[F.role],
              skillsFit: skillsFit(skills, requiredSkills),
              availablePct: Number(r[F.availablePct] ?? 0),
              skills,
              availableFrom: fromSfDate(r[F.start]),
              availableTo: fromSfDate(r[F.end]),
              flags: Number(r[F.availablePct] ?? 0) < 80 ? ["partial_availability"] : [],
            };
          })
          .sort((a, b) => b.skillsFit - a.skillsFit || b.availablePct - a.availablePct);
        return ok({ requiredSkills, startDate, endDate, consultants: ranked });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "staff_team",
    {
      title: "Staff team",
      description:
        "Create the assignments for the approved team and reduce their availability. " +
        "Called by the orchestrator in the fan-out step, only after human approval in Slack.",
      inputSchema: {
        engagementId: z.string().describe("e.g. ENG-2026-0147"),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        team: z.array(
          z.object({
            userId: z.string(),
            role: z.string(),
            allocationPct: z.number().min(1).max(100).default(100),
          }),
        ).min(1),
        approvedBy: z.string().describe("Slack user who approved"),
      },
    },
    async ({ engagementId, startDate, endDate, team, approvedBy }) => {
      try {
        const created: Array<{ userId: string; assignmentId: string; utilizationPct: number }> = [];
        for (const m of team) {
          const assignmentId = `${engagementId}-${m.userId}`;
          await upsert(SFSF.assignmentEntity, {
            externalCode: assignmentId,
            [F.userId]: m.userId,
            [F.engagementId]: engagementId,
            [F.start]: toSfDate(startDate),
            [F.end]: toSfDate(endDate),
            [F.utilizationPct]: m.allocationPct,
          });
          // reduce availability for the same period
          const cur = await odata("GET", `/${SFSF.availabilityEntity}('${encodeURIComponent(m.userId)}')?$format=json`);
          const remaining = Math.max(0, Number(cur.d?.[F.availablePct] ?? 0) - m.allocationPct);
          await upsert(SFSF.availabilityEntity, { externalCode: m.userId, [F.availablePct]: remaining });
          created.push({ userId: m.userId, assignmentId, utilizationPct: m.allocationPct });
        }
        return ok({
          engagementId,
          assignmentsCreated: created.length,
          assignments: created,
          approvedBy,
          staffedAt: new Date().toISOString(),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_consultant_profile",
    {
      title: "Get consultant profile",
      description: "Read one consultant: user record plus role, skills and current availability.",
      inputSchema: { userId: z.string().describe("e.g. tlindqvist") },
    },
    async ({ userId }) => {
      try {
        const id = encodeURIComponent(userId);
        const [u, a] = await Promise.all([
          odata("GET", `/User('${id}')?$select=userId,firstName,lastName,title,email&$format=json`),
          odata("GET", `/${SFSF.availabilityEntity}('${id}')?$format=json`),
        ]);
        return ok({
          userId,
          name: `${u.d?.firstName ?? ""} ${u.d?.lastName ?? ""}`.trim(),
          title: u.d?.title ?? null,
          email: u.d?.email ?? null,
          role: a.d?.[F.role] ?? null,
          skills: parseSkills(a.d?.[F.skills]),
          availablePct: Number(a.d?.[F.availablePct] ?? 0),
          availableFrom: fromSfDate(a.d?.[F.start]),
          availableTo: fromSfDate(a.d?.[F.end]),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport — stateless: fresh server + transport per request
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    await authHeader();
    res.json({ ok: true, service: "workforce-mcp" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/mcp", async (req: Request, res: Response) => {
  if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => console.log(`workforce-mcp listening on :${PORT}`));
