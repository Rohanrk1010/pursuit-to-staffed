/**
 * salesforce-mcp  —  MCP-1 for the "Pursuit to Staffed" demo
 *
 * Tools exposed to the orchestrator:
 *   get_opportunity            -> SOQL read of the Opportunity (+ custom fields)
 *   update_opportunity_status  -> PATCH Opportunity (Staffing_Status__c or another field)
 *   post_chatter_update        -> Chatter feed item on the Opportunity
 *
 * Auth: JWT bearer flow with a certificate (External Client App / Connected App, "use digital signatures"),
 *       or OAuth 2.0 Client Credentials — set SF_AUTH_MODE=jwt (default) or client_credentials.
 * The Platform Event subscription (CometD) lives in the orchestrator, not here.
 *
 * Run : npm i @modelcontextprotocol/sdk express zod && npx tsx --env-file=.env salesforce-mcp.ts
 * Test: npx @modelcontextprotocol/inspector -> Streamable HTTP, http://localhost:8081/mcp,
 *       header  Authorization: Bearer <MCP_TOKEN>
 */
import { createSign } from "node:crypto";
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

const SF = {
  loginUrl: env("SF_LOGIN_URL"),                 // https://<mydomain>.my.salesforce.com
  clientId: env("SF_CLIENT_ID"),                 // Consumer Key of the External Client App / Connected App
  clientSecret: process.env.SF_CLIENT_SECRET ?? "",   // client_credentials mode only
  authMode: env("SF_AUTH_MODE", "jwt"),          // "jwt" (certificate, Shashank's setup) or "client_credentials"
  username: process.env.SF_USERNAME ?? "",       // jwt: integration user, e.g. BTPIntegration@globalco.sf
  privateKey: (process.env.SF_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"), // jwt: contents of private.key (PEM)
  apiVersion: env("SF_API_VERSION", "v62.0"),    // any current version works
  statusField: env("SF_STATUS_FIELD", "Staffing_Status__c"), // TODO: confirm API name of the custom field
};
const MCP_TOKEN = env("MCP_TOKEN");
const PORT = Number(process.env.PORT ?? 8081);

// ---------------------------------------------------------------------------
// Auth + thin REST client
// ---------------------------------------------------------------------------
let session: { accessToken: string; instanceUrl: string; expiresAt: number } | null = null;

// JWT bearer flow: sign { iss: consumer key, sub: integration user, aud: login URL, exp } with private.key (RS256)
function jwtAssertion(): string {
  if (!SF.username || !SF.privateKey) throw new Error("SF_USERNAME and SF_PRIVATE_KEY are required for SF_AUTH_MODE=jwt");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256" })}.${b64({ iss: SF.clientId, sub: SF.username, aud: SF.loginUrl, exp: now + 180 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(SF.privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

async function login() {
  if (session && Date.now() < session.expiresAt) return session;
  const body =
    SF.authMode === "jwt"
      ? new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwtAssertion() })
      : new URLSearchParams({ grant_type: "client_credentials", client_id: SF.clientId, client_secret: SF.clientSecret });
  const r = await fetch(`${SF.loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Salesforce login failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { access_token: string; instance_url: string };
  session = { accessToken: j.access_token, instanceUrl: j.instance_url, expiresAt: Date.now() + 50 * 60 * 1000 };
  return session;
}

async function sf(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, retry = true): Promise<any> {
  const s = await login();
  const r = await fetch(`${s.instanceUrl}/services/data/${SF.apiVersion}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${s.accessToken}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401 && retry) {
    session = null;
    return sf(method, path, body, false);
  }
  if (!r.ok) throw new Error(`Salesforce ${method} ${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
  if (r.status === 204) return null;
  return r.json();
}

const soql = (q: string) => sf("GET", `/query?q=${encodeURIComponent(q)}`);

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }],
});

// ---------------------------------------------------------------------------
// MCP server: the three tools
// ---------------------------------------------------------------------------
function buildServer(): McpServer {
  const server = new McpServer({ name: "salesforce-mcp", version: "0.1.0" });

  server.registerTool(
    "get_opportunity",
    {
      title: "Get opportunity",
      description:
        "Read the won Opportunity with account, amount, close date and the custom staffing fields " +
        "(Required Skills, Start Date, Team Size).",
      inputSchema: { opportunityId: z.string().describe("Salesforce Opportunity Id, e.g. 006...") },
    },
    async ({ opportunityId }) => {
      try {
        // TODO: confirm custom field API names (Required_Skills__c, Start_Date__c, Team_Size__c)
        // CurrencyIsoCode only exists in multi-currency orgs; set SF_MULTI_CURRENCY=true to query it
        const currencyField = process.env.SF_MULTI_CURRENCY === "true" ? "CurrencyIsoCode, " : "";
        const q =
          `SELECT Id, Name, Amount, ${currencyField}CloseDate, StageName, Account.Name, ` +
          `Required_Skills__c, Start_Date__c, Team_Size__c, ${SF.statusField} ` +
          `FROM Opportunity WHERE Id = '${opportunityId.replace(/'/g, "")}'`;
        const res = await soql(q);
        const o = res.records?.[0];
        if (!o) throw new Error(`Opportunity ${opportunityId} not found`);
        return ok({
          opportunityId: o.Id,
          name: o.Name,
          accountName: o.Account?.Name ?? null,
          amount: o.Amount,
          currency: o.CurrencyIsoCode ?? "USD",
          closeDate: o.CloseDate,
          stage: o.StageName,
          requiredSkills: String(o.Required_Skills__c ?? "").split(";").map((s: string) => s.trim()).filter(Boolean),
          startDate: o.Start_Date__c,
          teamSize: o.Team_Size__c,
          staffingStatus: o[SF.statusField] ?? null,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_opportunity_status",
    {
      title: "Update opportunity status",
      description: "Write the staffing status back to the Opportunity after the human approval (fan-out step).",
      inputSchema: {
        opportunityId: z.string(),
        status: z.string().describe("e.g. Staffed"),
      },
    },
    async ({ opportunityId, status }) => {
      try {
        await sf("PATCH", `/sobjects/Opportunity/${encodeURIComponent(opportunityId)}`, { [SF.statusField]: status });
        return ok({ opportunityId, field: SF.statusField, status, updatedAt: new Date().toISOString() });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "post_chatter_update",
    {
      title: "Post Chatter update",
      description: "Post a Chatter feed item on the Opportunity, e.g. 'Staffing confirmed — team of 4, start Sep 1.'",
      inputSchema: {
        opportunityId: z.string(),
        text: z.string().max(2000),
      },
    },
    async ({ opportunityId, text }) => {
      try {
        const item = await sf("POST", "/chatter/feed-elements", {
          feedElementType: "FeedItem",
          subjectId: opportunityId,
          body: { messageSegments: [{ type: "Text", text }] },
        });
        const s = await login();
        return ok({
          feedItemId: item.id,
          opportunityId,
          text,
          url: `${s.instanceUrl}/${opportunityId}`,
          postedAt: new Date().toISOString(),
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
    await login();
    res.json({ ok: true, service: "salesforce-mcp" });
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

app.listen(PORT, () => console.log(`salesforce-mcp listening on :${PORT}`));
