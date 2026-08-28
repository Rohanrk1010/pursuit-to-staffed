/**
 * run.ts — the Pursuit-to-Staffed orchestrator. One file, six steps.
 *
 * v2 (Fri 28 Aug): approver name recorded (from approval.ts v2), "done" confirmation posted back to Teams,
 * before/after snapshot in the trace, and a live business view at http://localhost:3001/live
 *
 *   1 TRIGGER      Salesforce Opportunity_Won__e event  -> get_opportunity        (salesforce-mcp)
 *   2 ENGAGEMENT   create_engagement                                              (sap-engagement-mcp)
 *   3 INTEL        check_availability -> proposeTeam (Azure OpenAI, drafts only)  (workforce-mcp + propose.ts)
 *   4 HUMAN GATE   Adaptive Card in Teams, wait for Approve / Reject              (approval.ts)
 *   5 FAN-OUT      staff_team + confirm_staffing + update_opportunity_status + post_chatter_update, in parallel
 *   6 GOVERNANCE   trace written to runs/<runId>.json, viewable at http://localhost:3001/trace/<runId>
 *                  (+ Langfuse if LANGFUSE_* keys are set — otherwise silently skipped)
 *
 * Start the three MCP servers first (each in its own terminal), then:
 *   listen for the real event:   npx tsx --env-file=.env run.ts
 *   or run once on a record:     npx tsx --env-file=.env run.ts --opportunity 006XXXXXXXXXXXXXXX
 *
 * .env (orchestrator): SF_* (same as subscribe.ts), AZURE_OPENAI_*, TEAMS_WEBHOOK_URL, MCP_TOKEN,
 *   optional: MCP_SALESFORCE_URL (default http://localhost:8081/mcp), MCP_SAP_URL (…:8082/mcp),
 *             MCP_WORKFORCE_URL (…:8083/mcp), TRACE_PORT (3001), APPROVER_NAME, LANGFUSE_PUBLIC_KEY,
 *             LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
 */
import { createSign } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import Faye from "faye";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { proposeTeam, usage as llmUsage, estimatedCostUsd, type Opportunity, type Consultant, type Proposal } from "./propose";
import { requestApproval, postTeamsMessage, type ApprovalResult } from "./approval";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${k}`);
  return v;
};
const MCP = {
  salesforce: { url: env("MCP_SALESFORCE_URL", "http://localhost:8081/mcp"), token: process.env.MCP_SALESFORCE_TOKEN ?? env("MCP_TOKEN") },
  sap: { url: env("MCP_SAP_URL", "http://localhost:8082/mcp"), token: process.env.MCP_SAP_TOKEN ?? env("MCP_TOKEN") },
  workforce: { url: env("MCP_WORKFORCE_URL", "http://localhost:8083/mcp"), token: process.env.MCP_WORKFORCE_TOKEN ?? env("MCP_TOKEN") },
};
const TRACE_PORT = Number(process.env.TRACE_PORT ?? 3001);
const APPROVER_FALLBACK = process.env.APPROVER_NAME ?? "Staffing Manager (Teams)";
const RUNS_DIR = path.join(process.cwd(), "runs");

// ---------------------------------------------------------------------------
// trace / run state (step 6 lives here, updated after every step)
// ---------------------------------------------------------------------------
type Step = { n: number; name: string; status: "running" | "ok" | "failed" | "skipped"; startedAt: string; ms?: number; input?: unknown; output?: unknown; error?: string };
type Snapshot = { opportunity: string; engagement: string; availability: Record<string, number>; assignments?: string };
type Run = { runId: string; startedAt: string; finishedAt?: string; status: "running" | "approved" | "rejected" | "failed" | "partial"; opportunityId?: string; opportunityName?: string; engagementId?: string; decidedBy?: string; decidedAt?: string; steps: Step[]; before?: Snapshot; after?: Snapshot; summary?: Record<string, unknown> };

const runs = new Map<string, Run>();
const save = (run: Run) => {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(path.join(RUNS_DIR, `${run.runId}.json`), JSON.stringify(run, null, 2));
};

// optional Langfuse — only if keys exist; never blocks the demo
let langfuse: any = null;
if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Langfuse } = require("langfuse");
    langfuse = new Langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY, baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com" });
    console.log("langfuse: enabled");
  } catch {
    console.log("langfuse: package not installed, skipping (npm i langfuse to enable)");
  }
}

async function step<T>(run: Run, trace: any, n: number, name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  const s: Step = { n, name, status: "running", startedAt: new Date().toISOString(), input };
  run.steps.push(s);
  save(run);
  const t0 = Date.now();
  const span = trace?.span?.({ name, input });
  console.log(`\n[${n}] ${name} …`);
  try {
    const out = await fn();
    s.status = "ok";
    s.ms = Date.now() - t0;
    s.output = out;
    span?.end?.({ output: out });
    console.log(`[${n}] ${name} ✓ ${s.ms} ms`);
    save(run);
    return out;
  } catch (e) {
    s.status = "failed";
    s.ms = Date.now() - t0;
    s.error = e instanceof Error ? e.message : String(e);
    span?.end?.({ level: "ERROR", statusMessage: s.error });
    console.log(`[${n}] ${name} ✗ ${s.error}`);
    save(run);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// MCP client: one short-lived connection per call (servers are stateless)
// ---------------------------------------------------------------------------
async function callTool(server: { url: string; token: string }, name: string, args: Record<string, unknown>): Promise<any> {
  const client = new Client({ name: "orchestrator", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } });
  await client.connect(transport);
  try {
    const res: any = await client.callTool({ name, arguments: args });
    const text = (res.content as any[])?.find((c) => c.type === "text")?.text ?? "{}";
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (res.isError || data?.error) throw new Error(`${name} failed: ${data?.error ?? text}`);
    return data;
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, "0");
const newRunId = () => {
  const d = new Date();
  return `RUN${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
// S/4 project IDs: letters/digits only, max 24 -> ENG20260827153245
const newEngagementId = (runId: string) => `ENG${runId.slice(3)}`;
// end date = start + 6 months - 1 day  (2026-09-01 -> 2027-02-28)
const plusSixMonths = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 6);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
// find the Opportunity Id (006…) anywhere in the event payload, whatever the field is called
const opportunityIdFromEvent = (payload: any): string | null => {
  const entries = Object.entries(payload ?? {});
  // 1) any value that looks like an Opportunity Id (006 + 12 or 15 chars)
  for (const [, v] of entries) if (typeof v === "string" && /^006[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/.test(v.trim())) return v.trim();
  // 2) else a key that names the id explicitly (OpportunityId__c, Opportunity_Id__c, …) — never the name
  for (const [k, v] of entries) if (/opportunity.*id/i.test(k) && typeof v === "string" && v.trim()) return v.trim();
  return null;
};

// ---------------------------------------------------------------------------
// the flow
// ---------------------------------------------------------------------------
export async function runFlow(opportunityId: string, eventPayload?: unknown): Promise<Run> {
  const run: Run = { runId: newRunId(), startedAt: new Date().toISOString(), status: "running", opportunityId, steps: [] };
  runs.set(run.runId, run);
  save(run);
  const trace = langfuse?.trace?.({ name: "pursuit-to-staffed", id: run.runId, input: { opportunityId } });
  const t0 = Date.now();
  console.log(`\n================  ${run.runId}  ================`);
  console.log(`trace: http://localhost:${TRACE_PORT}/trace/${run.runId}`);

  try {
    // 1 — trigger: read the won opportunity (source of truth is Salesforce, not the event)
    const opp = await step(run, trace, 1, "trigger.get_opportunity", { opportunityId, eventPayload }, async () => {
      const o = await callTool(MCP.salesforce, "get_opportunity", { opportunityId });
      return o;
    });
    const opportunity: Opportunity = {
      opportunityId: opp.opportunityId,
      name: opp.name,
      accountName: opp.accountName ?? "",
      amount: Number(opp.amount ?? 0),
      requiredSkills: opp.requiredSkills ?? [],
      startDate: opp.startDate,
      teamSize: Number(opp.teamSize ?? 4),
    };
    const endDate = plusSixMonths(opportunity.startDate);
    run.opportunityName = opportunity.name;

    // 2 — engagement in S/4
    const engagementId = newEngagementId(run.runId);
    run.engagementId = engagementId;
    const engagement = await step(run, trace, 2, "engagement.create_engagement", { engagementId }, () =>
      callTool(MCP.sap, "create_engagement", {
        engagementId,
        description: `${opportunity.name} - ${opportunity.accountName}`.slice(0, 40),
        clientName: opportunity.accountName,
        value: opportunity.amount,
        currency: opp.currency ?? "USD",
        startDate: opportunity.startDate,
        endDate,
        wbsElement: `${engagementId}.001`,
        sourceOpportunityId: opportunity.opportunityId,
      }),
    );

    // 3 — staffing intel: availability from SuccessFactors, proposal from the AI (draft only)
    const availability = await step(run, trace, 3, "intel.check_availability", { requiredSkills: opportunity.requiredSkills, startDate: opportunity.startDate, endDate }, () =>
      callTool(MCP.workforce, "check_availability", { requiredSkills: opportunity.requiredSkills, startDate: opportunity.startDate, endDate }),
    );
    const consultants: Consultant[] = (availability.consultants ?? []).map((c: any) => ({
      userId: String(c.userId),
      name: c.name ?? null,
      role: c.role ?? "",
      skillsFit: Number(c.skillsFit ?? 0),
      availablePct: Number(c.availablePct ?? 0),
      skills: c.skills ?? [],
    }));
    if (consultants.length === 0) throw new Error("no consultants returned by check_availability — has the SuccessFactors data been reset?");
    run.before = {
      opportunity: `${opp.stage ?? "?"} · staffing status ${opp.staffingStatus ?? "empty"}`,
      engagement: "none",
      availability: Object.fromEntries(consultants.map((c) => [c.name ?? c.userId, c.availablePct])),
      assignments: "none for this engagement",
    };
    save(run);

    const tokensBefore = { in: llmUsage.promptTokens, out: llmUsage.completionTokens };
    const proposal: Proposal = await step(run, trace, 3, "intel.propose_team (AI draft)", { consultants: consultants.length }, async () => {
      const p = await proposeTeam(opportunity, consultants);
      return { ...p, tokens: { in: llmUsage.promptTokens - tokensBefore.in, out: llmUsage.completionTokens - tokensBefore.out } };
    });

    // 4 — human gate in Teams
    const approval: ApprovalResult = await step(run, trace, 4, "human.approval (Teams)", { team: proposal.team.map((m) => m.name) }, () =>
      requestApproval(run.runId, opportunity, proposal),
    );
    const decision = approval.decision;
    const decidedAt = approval.at;
    const APPROVER = approval.by || APPROVER_FALLBACK;
    run.decidedBy = APPROVER;
    run.decidedAt = decidedAt;
    save(run);

    if (decision !== "approve") {
      run.status = "rejected";
      run.steps.push({ n: 5, name: "fanout", status: "skipped", startedAt: decidedAt });
      console.log("\nrejected by the human — no writes made.");
    } else {
      // 5 — fan-out, all four write-backs in parallel, only after approval
      const team = proposal.team;
      const names = team.map((m) => m.name).join(", ");
      const results = await Promise.allSettled([
        step(run, trace, 5, "fanout.staff_team (SuccessFactors)", { engagementId }, () =>
          callTool(MCP.workforce, "staff_team", {
            engagementId,
            startDate: opportunity.startDate,
            endDate,
            team: team.map((m) => ({ userId: m.userId, role: m.role, allocationPct: m.allocationPct })),
            approvedBy: APPROVER,
          }),
        ),
        step(run, trace, 5, "fanout.confirm_staffing (S/4)", { engagementId }, () =>
          callTool(MCP.sap, "confirm_staffing", {
            engagementId,
            team: team.map((m) => ({ personId: m.userId, name: m.name, role: m.role })),
            confirmedBy: APPROVER,
            confirmedAt: decidedAt,
          }),
        ),
        step(run, trace, 5, "fanout.update_opportunity_status (Salesforce)", { opportunityId }, () =>
          callTool(MCP.salesforce, "update_opportunity_status", { opportunityId, status: "Staffed" }),
        ),
        step(run, trace, 5, "fanout.post_chatter_update (Salesforce)", { opportunityId }, () =>
          callTool(MCP.salesforce, "post_chatter_update", {
            opportunityId,
            text: `Staffing confirmed — team of ${team.length} (${names}). Engagement ${engagementId}, start ${opportunity.startDate}. Approved by ${APPROVER} via Teams.`,
          }),
        ),
      ]);
      const failed = results.filter((r) => r.status === "rejected").length;
      run.status = failed ? "partial" : "approved";

      // after snapshot: read the systems again (real values, not assumed)
      try {
        const [oppAfter, availAfter] = await Promise.all([
          callTool(MCP.salesforce, "get_opportunity", { opportunityId }),
          callTool(MCP.workforce, "check_availability", { requiredSkills: opportunity.requiredSkills, startDate: opportunity.startDate, endDate }),
        ]);
        const staffed = results[0].status === "fulfilled" ? (results[0].value as any)?.assignmentsCreated ?? team.length : 0;
        run.after = {
          opportunity: `${oppAfter.stage ?? "?"} · staffing status ${oppAfter.staffingStatus ?? "empty"} · Chatter posted`,
          engagement: `${engagementId} · ${results[1].status === "fulfilled" ? "STAFFED" : "status update failed"}`,
          availability: Object.fromEntries((availAfter.consultants ?? []).map((c: any) => [c.name ?? c.userId, Number(c.availablePct ?? 0)])),
          assignments: `${staffed} rows in SuccessFactors for ${engagementId}`,
        };
      } catch (e) {
        console.log("after-snapshot skipped:", e instanceof Error ? e.message : e);
      }

      // confirmation back into the Teams channel
      const secs = Math.round((Date.now() - t0) / 10) / 100;
      await postTeamsMessage(
        failed
          ? `⚠️ Completed with ${failed} failed write-back(s) — see the trace for details.`
          : `🎉 Done in ${secs}s. ${team.length} assignments written in SuccessFactors · project ${engagementId} marked STAFFED in S/4 · Salesforce opportunity set to Staffed with a Chatter post. Approved by ${APPROVER}.`,
        `${opportunity.name} · run ${run.runId}`,
      ).catch((e) => console.log("could not post done message to Teams:", e instanceof Error ? e.message : e));
    }

    // 6 — governance
    run.finishedAt = new Date().toISOString();
    run.summary = {
      opportunity: `${opportunity.name} (${opportunity.opportunityId})`,
      engagement: engagementId,
      fioriUrl: engagement.fioriUrl,
      consultantsConsidered: consultants.length,
      teamProposed: proposal.team.map((m) => `${m.name} ${m.allocationPct}%`),
      tradeoffFlags: proposal.tradeoffFlags,
      decision,
      decidedBy: run.decidedBy,
      decidedAt: run.decidedAt,
      llmTokens: { in: llmUsage.promptTokens - tokensBefore.in, out: llmUsage.completionTokens - tokensBefore.out },
      llmCostUsd: estimatedCostUsd(),
      totalSeconds: Math.round((Date.now() - t0) / 10) / 100,
    };
    trace?.update?.({ output: run.summary });
    await langfuse?.flushAsync?.();
    save(run);
    console.log(`\n================  ${run.status.toUpperCase()} in ${run.summary.totalSeconds}s  ================`);
    console.log(JSON.stringify(run.summary, null, 2));
    console.log(`trace: http://localhost:${TRACE_PORT}/trace/${run.runId}`);
    return run;
  } catch (e) {
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
    save(run);
    await langfuse?.flushAsync?.();
    console.error(`\nRUN FAILED: ${e instanceof Error ? e.message : e}`);
    return run;
  }
}

// ---------------------------------------------------------------------------
// trace viewer — http://localhost:3001/trace/<runId>  and  /runs
// ---------------------------------------------------------------------------
function beforeAfter(run: Run): string {
  if (!run.before) return "";
  const esc2 = (s: unknown) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const names = Array.from(new Set([...Object.keys(run.before.availability), ...Object.keys(run.after?.availability ?? {})]));
  const rows = names.map((n) => `<tr><td>${esc2(n)}</td><td>${run.before!.availability[n] ?? ""}%</td><td>${run.after ? `${run.after.availability[n] ?? ""}%` : "—"}</td></tr>`).join("");
  return `<h2>before / after</h2><table><tr><th></th><th>before</th><th>after</th></tr>
<tr><td>Salesforce opportunity</td><td>${esc2(run.before.opportunity)}</td><td>${esc2(run.after?.opportunity ?? "—")}</td></tr>
<tr><td>S/4 engagement</td><td>${esc2(run.before.engagement)}</td><td>${esc2(run.after?.engagement ?? "—")}</td></tr>
<tr><td>SuccessFactors assignments</td><td>${esc2(run.before.assignments ?? "")}</td><td>${esc2(run.after?.assignments ?? "—")}</td></tr>
<tr><th>consultant availability</th><th></th><th></th></tr>${rows}</table>`;
}

const LIVE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Pursuit to Staffed — live</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
header{padding:20px 32px;font-size:22px;font-weight:600;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between}
#steps{display:grid;grid-template-columns:repeat(6,1fr);gap:16px;padding:24px 32px}
.step{background:#1e293b;border-radius:12px;padding:20px;min-height:120px;border:2px solid #334155;transition:all .3s}
.step .n{font-size:13px;color:#94a3b8}.step .t{font-size:18px;font-weight:600;margin:6px 0}.step .s{font-size:14px;color:#94a3b8}
.pending{opacity:.5}.running{border-color:#f59e0b;box-shadow:0 0 0 4px rgba(245,158,11,.25)}.running .s{color:#f59e0b}
.ok{border-color:#22c55e}.ok .s{color:#22c55e}.failed{border-color:#ef4444}.failed .s{color:#ef4444}.skipped{border-color:#64748b}
#detail{padding:0 32px 32px;display:grid;grid-template-columns:1fr 1fr;gap:24px}
.card{background:#1e293b;border-radius:12px;padding:20px}.card h3{margin:0 0 12px;font-size:15px;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;font-size:15px}td,th{padding:6px 4px;text-align:left;border-bottom:1px solid #334155}
.big{font-size:32px;font-weight:700}.muted{color:#94a3b8;font-size:14px}
</style></head><body>
<header><span>Pursuit to Staffed — live</span><span id="hdr" class="muted">waiting for a run…</span></header>
<div id="steps"></div>
<div id="detail"></div>
<script>
const PH=[[1,"Trigger","Salesforce"],[2,"Engagement","SAP S/4HANA"],[3,"Staffing intel","SuccessFactors + Azure OpenAI"],[4,"Human gate","Microsoft Teams"],[5,"Fan-out","SuccessFactors · S/4 · Salesforce"],[6,"Governance","Trace"]];
const DOING={1:"reading the won opportunity from Salesforce…",2:"creating the project in S/4…",3:"checking availability in SuccessFactors, AI drafting the team…",4:"waiting for the manager's decision in Teams…",5:"writing to SuccessFactors, S/4 and Salesforce…",6:"finalizing the audit trace…"};
const DONE={1:"opportunity read from Salesforce",2:"project created in S/4",3:"AI proposal drafted from SuccessFactors data",4:"decision received in Teams",5:"all three systems updated",6:"trace recorded"};
const need={1:1,2:1,3:2,4:1,5:4,6:0};
function phase(run,n){
  if(n===6){ if(!run.finishedAt) return run.steps.length?"running":"pending"; return run.status==="failed"?"failed":"ok"; }
  const st=run.steps.filter(s=>s.n===n);
  if(st.some(s=>s.status==="failed")) return "failed";
  if(st.some(s=>s.status==="skipped")) return "skipped";
  if(st.some(s=>s.status==="running")) return "running";
  if(st.length>=need[n]&&st.every(s=>s.status==="ok")) return "ok";
  return st.length?"running":"pending";
}
function ms(run,n){const st=run.steps.filter(s=>s.n===n&&s.ms);return st.length?Math.max(...st.map(s=>s.ms))+" ms":"";}
function render(run){
  if(!run){document.getElementById("hdr").textContent="waiting for a run…";return;}
  document.getElementById("hdr").textContent=(run.opportunityName||run.opportunityId||"")+" · "+run.runId+" · "+run.status.toUpperCase();
  document.getElementById("steps").innerHTML=PH.map(([n,t,sys])=>{const p=phase(run,n);const label=p==="running"?DOING[n]:p==="ok"?DONE[n]+" · "+ms(run,n):p==="failed"?"failed":p==="skipped"?"skipped":"waiting";return '<div class="step '+p+'"><div class="n">STEP '+n+' · '+sys+'</div><div class="t">'+t+'</div><div class="s">'+label+'</div></div>';}).join("");
  const prop=run.steps.find(s=>s.name&&s.name.indexOf("propose_team")>-1&&s.output);
  let left="";
  if(prop){const o=prop.output;left='<div class="card"><h3>AI proposal (draft)</h3><table>'+(o.team||[]).map(m=>'<tr><td>'+m.name+'</td><td>'+m.role+'</td><td>fit '+m.skillsFit+'</td><td>'+m.allocationPct+'%</td></tr>').join("")+'</table><p>'+(o.rationale||"")+'</p>'+(o.tradeoffFlags||[]).map(f=>'<p>⚠️ '+f+'</p>').join("")+'</div>';}
  else left='<div class="card"><h3>AI proposal (draft)</h3><p class="muted">not yet</p></div>';
  let right='<div class="card"><h3>Decision & result</h3>';
  if(run.decidedBy) right+='<p class="big">'+(run.status==="rejected"?"❌ Rejected":"✅ Approved")+'</p><p>by '+run.decidedBy+'<br><span class="muted">'+run.decidedAt+'</span></p>';
  else right+='<p class="muted">waiting for the human decision</p>';
  if(run.after){const b=run.before||{},a=run.after;right+='<table><tr><th></th><th>before</th><th>after</th></tr><tr><td>Salesforce</td><td>'+(b.opportunity||"")+'</td><td>'+a.opportunity+'</td></tr><tr><td>S/4</td><td>'+(b.engagement||"")+'</td><td>'+a.engagement+'</td></tr><tr><td>SuccessFactors</td><td>'+(b.assignments||"")+'</td><td>'+a.assignments+'</td></tr>'+Object.keys(a.availability||{}).map(k=>'<tr><td>'+k+'</td><td>'+((b.availability||{})[k]??"")+'%</td><td>'+a.availability[k]+'%</td></tr>').join("")+'</table>';}
  if(run.summary&&run.summary.totalSeconds) right+='<p class="big">'+run.summary.totalSeconds+' s</p><p class="muted">end to end · tokens '+JSON.stringify(run.summary.llmTokens||{})+' · est. $'+run.summary.llmCostUsd+'</p>';
  right+='</div>';
  document.getElementById("detail").innerHTML=left+right;
}
async function tick(){try{const r=await fetch("/latest.json",{cache:"no-store"});render(await r.json());}catch(e){}}
tick();setInterval(tick,1000);
</script></body></html>`;

function startTraceServer() {
  const esc = (s: unknown) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const page = (title: string, body: string) =>
    `<html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#222}h1{font-size:20px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top;font-size:14px}.ok{color:#1a7f37}.failed{color:#b42318}.running{color:#b54708}.skipped{color:#666}pre{white-space:pre-wrap;font-size:12px;background:#f6f8fa;padding:8px;margin:0}</style></head><body>${body}</body></html>`;
  http
    .createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${TRACE_PORT}`);
      const m = url.pathname.match(/^\/trace\/([A-Za-z0-9-]+)(\.json)?$/);
      if (m) {
        let run = runs.get(m[1]);
        const f = path.join(RUNS_DIR, `${m[1]}.json`);
        if (!run && existsSync(f)) run = JSON.parse(readFileSync(f, "utf8"));
        if (!run) {
          res.writeHead(404);
          return res.end("no such run");
        }
        if (m[2]) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(run, null, 2));
        }
        const rows = run.steps
          .map(
            (s) =>
              `<tr><td>${s.n}</td><td>${esc(s.name)}</td><td class="${s.status}">${s.status}</td><td>${s.ms ?? ""}</td><td><pre>${esc(JSON.stringify(s.output ?? s.error ?? s.input ?? "", null, 1)).slice(0, 1500)}</pre></td></tr>`,
          )
          .join("");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(
          page(
            run.runId,
            `<h1>Pursuit to Staffed — ${esc(run.runId)} <span class="${run.status}">${esc(run.status)}</span></h1><p>started ${esc(run.startedAt)} · finished ${esc(run.finishedAt ?? "—")} · opportunity ${esc(run.opportunityId ?? "")} · engagement ${esc(run.engagementId ?? "")}</p><table><tr><th>#</th><th>step</th><th>status</th><th>ms</th><th>detail</th></tr>${rows}</table>${beforeAfter(run)}${run.summary ? `<h2>summary</h2><pre>${esc(JSON.stringify(run.summary, null, 2))}</pre>` : ""}<p><a href="/trace/${esc(run.runId)}.json">json</a> · <a href="/runs">all runs</a> · <a href="/live">live view</a></p>`,
          ),
        );
      }
      if (url.pathname === "/latest.json") {
        const files = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort().reverse() : [];
        const latestId = [...runs.keys()].sort().reverse()[0] ?? files[0]?.replace(".json", "");
        const run = latestId ? runs.get(latestId) ?? JSON.parse(readFileSync(path.join(RUNS_DIR, `${latestId}.json`), "utf8")) : null;
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify(run));
      }
      if (url.pathname === "/live") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(LIVE_PAGE);
      }
      if (url.pathname === "/runs" || url.pathname === "/") {
        const files = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort().reverse() : [];
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page("runs", `<h1>runs</h1><ul>${files.map((f) => `<li><a href="/trace/${f.replace(".json", "")}">${f.replace(".json", "")}</a></li>`).join("")}</ul>`));
      }
      res.writeHead(404);
      res.end("not found");
    })
    .listen(TRACE_PORT, () => console.log(`trace viewer: http://localhost:${TRACE_PORT}/runs`));
}

// ---------------------------------------------------------------------------
// Salesforce event subscription (same login as subscribe.ts)
// ---------------------------------------------------------------------------
async function sfLogin() {
  const loginUrl = env("SF_LOGIN_URL");
  const privateKey = process.env.SF_PRIVATE_KEY_PATH ? readFileSync(process.env.SF_PRIVATE_KEY_PATH, "utf8") : (process.env.SF_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256" })}.${b64({ iss: env("SF_CLIENT_ID"), sub: env("SF_USERNAME"), aud: loginUrl, exp: now + 180 })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  const r = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!r.ok) throw new Error(`Salesforce login failed ${r.status}: ${await r.text()}`);
  return (await r.json()) as { access_token: string; instance_url: string };
}

async function listenForEvents() {
  const { access_token, instance_url } = await sfLogin();
  const apiVersion = (process.env.SF_API_VERSION ?? "v62.0").replace("v", "");
  const channel = "/event/Opportunity_Won__e";
  const client = new Faye.Client(`${instance_url}/cometd/${apiVersion}`, { timeout: 110 });
  client.disable("websocket");
  client.setHeader("Authorization", `OAuth ${access_token}`);
  client.addExtension({
    outgoing: (msg: any, cb: (m: any) => void) => {
      if (msg.channel === "/meta/subscribe") msg.ext = { replay: { [channel]: -1 } };
      cb(msg);
    },
  });
  let busy = false;
  const sub = client.subscribe(channel, async (message: any) => {
    const payload = message.payload ?? message;
    const id = opportunityIdFromEvent(payload);
    console.log("\nEVENT RECEIVED", JSON.stringify(payload));
    if (!id) return console.log("no opportunity id in the event payload — ignored");
    if (busy) return console.log("a run is already in progress — ignored");
    busy = true;
    try {
      await runFlow(id, payload);
    } finally {
      busy = false;
    }
  });
  sub.then(
    () => console.log(`subscribed OK to ${channel} — flip an opportunity to Closed Won to start a run`),
    (err: any) => {
      console.log("SUBSCRIBE FAILED:", JSON.stringify(err));
      process.exit(1);
    },
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  startTraceServer();
  const i = process.argv.indexOf("--opportunity");
  if (i > -1 && process.argv[i + 1]) {
    const run = await runFlow(process.argv[i + 1]);
    console.log("\n(direct run finished — trace viewer stays up; Ctrl+C to exit)");
    if (run.status === "failed") process.exitCode = 1;
    return;
  }
  await listenForEvents();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
