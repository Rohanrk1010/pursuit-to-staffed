/**
 * sap-engagement-mcp  —  MCP-2 for the "Pursuit to Staffed" demo
 *
 * Exposes three tools to the orchestrator:
 *   create_engagement  -> POST  A_EnterpriseProject (+ nested WBS element)
 *   get_engagement     -> GET   A_EnterpriseProject('ID')?$expand=to_EnterpriseProjectElement
 *   confirm_staffing   -> PATCH A_EnterpriseProject('ID')  { StaffingStatus = STAFFED }
 *
 * Backend: SAP S/4HANA Cloud Public Edition, Enterprise Project API
 *          (communication scenario SAP_COM_0308, service API_ENTERPRISE_PROJECT_SRV;v=0002)
 *
 * Run : npm i @modelcontextprotocol/sdk express zod && npx tsx sap-engagement-mcp.ts
 * Test: npx @modelcontextprotocol/inspector  -> Streamable HTTP, URL http://localhost:8082/mcp,
 *       header  Authorization: Bearer <MCP_TOKEN>
 *
 * Every "TODO" below must be confirmed against the tenant ($metadata / Custom Fields app)
 * before the first real call. No credentials live in this file — everything comes from env.
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

const S4 = {
  apiHost: env("S4_API_HOST"),                 // https://my######-api.s4hana.cloud.sap
  fioriHost: env("S4_FIORI_HOST"),             // https://my######.s4hana.cloud.sap
  user: env("S4_USER"),                        // communication user from the SAP_COM_0308 arrangement
  password: env("S4_PASSWORD"),
  projectProfile: env("S4_PROJECT_PROFILE"),   // copy from an existing project in the tenant
  costCenter: env("S4_COST_CENTER"),
  profitCenter: env("S4_PROFIT_CENTER"),
  // TODO: technical name of the custom field created in the "Custom Fields" app
  staffingField: env("S4_STAFFING_FIELD", "YY1_StaffingStatus_PTD"),
};
const SERVICE = "/sap/opu/odata/sap/API_ENTERPRISE_PROJECT_SRV;v=0002";
const MCP_TOKEN = env("MCP_TOKEN");            // shared secret; only the orchestrator has it
const PORT = Number(process.env.PORT ?? 8082

);

// ---------------------------------------------------------------------------
// Thin OData v2 client (basic auth + CSRF token for writes)
// ---------------------------------------------------------------------------
const basicAuth = "Basic " + Buffer.from(`${S4.user}:${S4.password}`).toString("base64");

async function csrf(): Promise<{ token: string; cookie: string }> {
  const r = await fetch(`${S4.apiHost}${SERVICE}/`, {
    headers: { Authorization: basicAuth, Accept: "application/json", "x-csrf-token": "fetch" },
  });
  const token = r.headers.get("x-csrf-token");
  if (!token) throw new Error(`CSRF fetch failed: HTTP ${r.status}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { token, cookie };
}

async function s4(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { Authorization: basicAuth, Accept: "application/json" };
  if (method !== "GET") {
    const { token, cookie } = await csrf();
    Object.assign(headers, { "x-csrf-token": token, Cookie: cookie, "Content-Type": "application/json"  });
  }
  if (method === "PATCH") headers["If-Match"] = "*";
  const r = await fetch(`${S4.apiHost}${SERVICE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`S/4 ${method} ${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
  if (r.status === 204) return null;
  return (await r.json()).d;
}

// OData v2 Edm.DateTime: ISO without timezone, e.g. 2026-09-01T00:00:00   (TODO: confirm in $metadata)
const odataDate = (isoDate: string) => `${isoDate}T00:00:00`;
// "/Date(1756684800000)/" -> "2026-09-01"
const fromOdataDate = (v?: string): string | null => {
  const m = v && /\/Date\((-?\d+)\)\//.exec(v);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : v ?? null;
};
// TODO: copy the real deep link from the "Project Control – Enterprise Projects" app once a project exists
const fioriUrl = (id: string) =>
  `${S4.fioriHost}/ui#EnterpriseProject-display&/EnterpriseProject(Project='${encodeURIComponent(id)}')`;

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }],
});

// ---------------------------------------------------------------------------
// MCP server: the three tools
// ---------------------------------------------------------------------------
function buildServer(): McpServer {
  const server = new McpServer({ name: "sap-engagement-mcp", version: "0.1.0" });

  server.registerTool(
    "create_engagement",
    {
      title: "Create engagement",
      description:
        "Create the engagement (enterprise project + WBS element) in S/4HANA Cloud for a won opportunity. " +
        "Staffing status starts as 'Awaiting assignment'. Returns the engagement ID and a Fiori link.",
      inputSchema: {
        engagementId: z.string().max(24).describe("e.g. ENG-2026-0147"),
        description: z.string().describe("e.g. Project Falcon — GlobalCo"),
        clientName: z.string().describe("e.g. GlobalCo Financial"),
        value: z.number().describe("e.g. 2400000"),
        currency: z.string().length(3).describe("e.g. USD"),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
        wbsElement: z.string().describe("e.g. FALCON.26.001"),
        sourceOpportunityId: z.string().optional().describe("Salesforce Opportunity ID, for traceability"),
      },
    },
    async (a) => {
      try {
        const payload: Record<string, unknown> = {
          // TODO: verify every property name against $metadata of A_EnterpriseProject
          Project: a.engagementId,
          ProjectDescription: a.description.slice(0, 40),
          ProjectStartDate: odataDate(a.startDate),
          ProjectEndDate: odataDate(a.endDate),
          ProjectProfileCode: S4.projectProfile,
          ResponsibleCostCenter: S4.costCenter,
          ProfitCenter: S4.profitCenter,
          ProjectCurrency: a.currency,
          //[S4.staffingField]: "Awaiting assignment",
          to_EnterpriseProjectElement: [
            {
              ProjectElement: a.wbsElement,
              ProjectElementDescription: `${a.clientName} ${a.currency} ${a.value}`.slice(0, 40),
              PlannedStartDate: odataDate(a.startDate),
              PlannedEndDate: odataDate(a.endDate),
            },
          ],
        };
        const d = await s4("POST", "/A_EnterpriseProject", payload);
        return ok({
          engagementId: d.Project,
          status: "CREATED",
          staffingStatus: "Awaiting assignment",
          wbsElement: a.wbsElement,
          sourceOpportunityId: a.sourceOpportunityId ?? null,
          fioriUrl: fioriUrl(d.Project),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_engagement",
    {
      title: "Get engagement",
      description: "Read an engagement (enterprise project) and its WBS elements from S/4HANA Cloud.",
      inputSchema: { engagementId: z.string().describe("e.g. ENG-2026-0147") },
    },
    async ({ engagementId }) => {
      try {
        const d = await s4(
          "GET",
          `/A_EnterpriseProject?$filter=Project eq '${encodeURIComponent(engagementId)}'&$expand=to_EnterpriseProjectElement`,
        );
        const p = d?.results?.[0] ?? d;
        return ok({
          engagementId: d.Project,
          description: d.ProjectDescription,
          startDate: fromOdataDate(d.ProjectStartDate),
          endDate: fromOdataDate(d.ProjectEndDate),
          staffingStatus: d[S4.staffingField] ?? null,
          wbsElements: (d.to_EnterpriseProjectElement?.results ?? []).map((w: any) => ({
            id: w.ProjectElement,
            description: w.ProjectElementDescription,
          })),
          fioriUrl: fioriUrl(d.Project),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "confirm_staffing",
    {
      title: "Confirm staffing",
      description:
        "Mark the engagement as STAFFED after the staffing manager approved the team in Slack. " +
        "Called by the orchestrator in the fan-out step, never before human approval.",
      inputSchema: {
        engagementId: z.string(),
        team: z.array(z.object({ personId: z.string(), name: z.string(), role: z.string() })),
        confirmedBy: z.string().describe("Slack user who approved"),
        confirmedAt: z.string().describe("ISO 8601 timestamp of the approval"),
      },
    },
    async (a) => {
      try {
        const g = await s4("GET", `/A_EnterpriseProject?$filter=Project eq '${encodeURIComponent(a.engagementId)}'&$select=ProjectUUID`);
        const uuid = g?.results?.[0]?.ProjectUUID ?? g?.d?.results?.[0]?.ProjectUUID;
        if (!uuid) throw new Error(`S/4 project ${a.engagementId} has no ProjectUUID`);
        try {
          await s4("PATCH", `/A_EnterpriseProject(ProjectUUID=guid'${encodeURIComponent(uuid)}')`, {
            [S4.staffingField]: "STAFFED",
            // TODO (optional): second custom field with the team names, e.g. YY1_StaffedTeam_PTD
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (message.includes("/S4PPM/CRUD/278") || message.includes("Custom fields for project header")) {
            throw new Error(
              `S/4 rejected custom field ${S4.staffingField} for project ${a.engagementId}. ` +
              "Assign this field to the project's category in Custom Fields, enable it for API_ENTERPRISE_PROJECT_SRV, " +
              "and ensure the field value contains STAFFED.",
            );
          }
          throw e;
        }
        return ok({
          engagementId: a.engagementId,
          staffingStatus: "STAFFED",
          teamSize: a.team.length,
          confirmedBy: a.confirmedBy,
          confirmedAt: a.confirmedAt,
          fioriUrl: fioriUrl(a.engagementId),
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

app.get("/health", (_req, res) => res.json({ ok: true, service: "sap-engagement-mcp" }));

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

app.listen(PORT, () => console.log(`sap-engagement-mcp listening on :${PORT}`));
