/**
* approval.ts — human-in-the-loop step (A3). Posts the proposal to Teams and waits for Approve / Reject.
*
* Test run:  npx tsx --env-file=.env approval.ts
*   -> a card appears in the Teams channel; click Approve; the terminal prints "DECISION: approve".
*
* .env: TEAMS_WEBHOOK_URL (required)
*       PUBLIC_URL (optional, default http://localhost:3000 — the machine where the button is clicked
*                   must reach this; use a tunnel URL if someone else's laptop will click)
*       APPROVAL_PORT (optional, default 3000)
*/
import http from "node:http";
import type { Proposal, Opportunity } from "./propose";
 
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};
const port = Number(process.env.APPROVAL_PORT ?? 3000);
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
 
// ---------- tiny server that receives the button clicks ----------
type Decision = "approve" | "reject";
const waiters = new Map<string, (d: Decision) => void>();
let server: http.Server | null = null;
 
function ensureServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", publicUrl);
    if (url.pathname === "/decision") {
      const runId = url.searchParams.get("runId") ?? "";
      const decision = url.searchParams.get("decision") as Decision | null;
      const resolve = waiters.get(runId);
      if (resolve && (decision === "approve" || decision === "reject")) {
        waiters.delete(runId);
        resolve(decision);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>${decision === "approve" ? "✅ Approved" : "❌ Rejected"}</h2><p>Run ${runId}. You can close this tab.</p></body></html>`);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Unknown or already-decided run");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("approval server up");
  });
  server.listen(port, () => console.log(`approval server listening on ${port} (public: ${publicUrl})`));
}
 
// ---------- the card ----------
function buildCard(runId: string, opp: Opportunity, p: Proposal) {
  const rows = p.team.map((m) => ({
    type: "ColumnSet",
    columns: [
      { type: "Column", width: "stretch", items: [{ type: "TextBlock", text: `**${m.name}**`, wrap: true }] },
      { type: "Column", width: "auto", items: [{ type: "TextBlock", text: m.role, wrap: true }] },
      { type: "Column", width: "auto", items: [{ type: "TextBlock", text: `fit ${m.skillsFit}`, wrap: true }] },
      { type: "Column", width: "auto", items: [{ type: "TextBlock", text: `${m.allocationPct}%`, wrap: true }] },
    ],
  }));
  const flags = p.tradeoffFlags.length
    ? [{ type: "TextBlock", text: `⚠️ ${p.tradeoffFlags.join(" ")}`, wrap: true, color: "Attention" }]
    : [];
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", size: "Large", weight: "Bolder", text: `Staffing proposal — ${opp.name}` },
            { type: "TextBlock", text: `${opp.accountName} · USD ${opp.amount.toLocaleString("en-US")} · start ${opp.startDate} · team of ${opp.teamSize}`, wrap: true, isSubtle: true },
            { type: "TextBlock", text: `Required: ${opp.requiredSkills.join(", ")}`, wrap: true, isSubtle: true },
            ...rows,
            { type: "TextBlock", text: p.rationale, wrap: true },
            ...flags,
            { type: "TextBlock", text: `Run ${runId} · drafted by AI, decision is yours`, wrap: true, isSubtle: true, size: "Small" },
          ],
          actions: [
            { type: "Action.OpenUrl", title: "✅ Approve", url: `${publicUrl}/decision?runId=${runId}&decision=approve` },
            { type: "Action.OpenUrl", title: "❌ Reject", url: `${publicUrl}/decision?runId=${runId}&decision=reject` },
          ],
        },
      },
    ],
  };
}
 
// ---------- public function used by the orchestrator ----------
export async function requestApproval(runId: string, opp: Opportunity, proposal: Proposal, timeoutMs = 15 * 60 * 1000): Promise<Decision> {
  ensureServer();
  const r = await fetch(env("TEAMS_WEBHOOK_URL"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildCard(runId, opp, proposal)),
  });
  if (!r.ok) throw new Error(`Teams post failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  console.log("card posted to Teams — waiting for Approve / Reject …");
  return new Promise<Decision>((resolve, reject) => {
    waiters.set(runId, resolve);
    setTimeout(() => {
      if (waiters.delete(runId)) reject(new Error("approval timed out"));
    }, timeoutMs);
  });
}
 
export function stopApprovalServer() {
  server?.close();
  server = null;
}
 
// ---------- test with demo data ----------
async function main() {
  const opp: Opportunity = {
    opportunityId: "TEST",
    name: "Project Falcon",
    accountName: "GlobalCo Financial",
    amount: 2400000,
    requiredSkills: ["S/4 Finance", "BTP CAP", "Data Eng"],
    startDate: "2026-09-01",
    teamSize: 4,
  };
  const proposal: Proposal = {
    team: [
      { userId: "103417", name: "A. Mehta", role: "ENG_MANAGER", skillsFit: 95, availablePct: 100, allocationPct: 100, reason: "Best-fit manager, fully available." },
      { userId: "103418", name: "R. Silva", role: "SR_CONSULTANT", skillsFit: 92, availablePct: 100, allocationPct: 100, reason: "Strong S/4 Finance fit." },
      { userId: "103419", name: "J. Okafor", role: "SR_CONSULTANT", skillsFit: 88, availablePct: 80, allocationPct: 80, reason: "Good fit, 80% available." },
      { userId: "103421", name: "P. Nair", role: "ANALYST", skillsFit: 84, availablePct: 100, allocationPct: 100, reason: "Data Eng coverage, fully available." },
    ],
    rationale: "Balanced fit and availability across the three required skills.",
    tradeoffFlags: ["T. Lindqvist has the highest fit (97) but is only 60% available; picked P. Nair instead."],
  };
  const runId = `TEST-${Date.now().toString().slice(-6)}`;
  const decision = await requestApproval(runId, opp, proposal);
  console.log("DECISION:", decision);
  stopApprovalServer();
  process.exit(0);
}
 
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
