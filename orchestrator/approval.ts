/**
 * approval.ts — human-in-the-loop step (A3). Posts the proposal to Teams and waits for Approve / Reject.
 *
 * v2 (Fri 28 Aug):
 *   - the Approve / Reject link opens a small page that asks for the approver's name, then confirms
 *   - the decision (name + time) is returned to the orchestrator and recorded in the trace
 *   - a confirmation message is posted back into the same Teams channel after the click
 *   - postTeamsMessage() is exported so the orchestrator can post "done" after the write-backs
 *
 * Test run:  npx tsx --env-file=.env approval.ts
 *   -> a card appears in the Teams channel; click Approve; enter a name; the terminal prints "DECISION: approve by <name>".
 *
 * .env: TEAMS_WEBHOOK_URL (required)
 *       PUBLIC_URL (optional, default http://localhost:3000 — the machine where the button is clicked
 *                   must reach this; use a tunnel URL if someone else's laptop will click)
 *       APPROVAL_PORT (optional, default 3000)
 *       APPROVER_NAME (optional, pre-filled name on the confirmation page)
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
const defaultApprover = process.env.APPROVER_NAME ?? "";
// APPROVERS="Shivani:4321,Rohan:1234" — when set, only these names with the right PIN can decide
const APPROVERS: Record<string, string> = Object.fromEntries(
  (process.env.APPROVERS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.lastIndexOf(":");
      return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()];
    }),
);
const approverCheckEnabled = Object.keys(APPROVERS).length > 0;
export type AuthAttempt = { by: string; at: string; outcome: "verified" | "denied" };
const authLog: AuthAttempt[] = [];
export const authAttempts = () => [...authLog];

export type Decision = "approve" | "reject" | "modify";
export type ApprovalResult = { decision: Decision; by: string; at: string; instruction?: string };

// ---------- tiny server that receives the button clicks ----------
type Pending = { resolve: (r: ApprovalResult) => void; title: string };
const waiters = new Map<string, Pending>();
let server: http.Server | null = null;

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const page = (body: string) =>
  `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Staffing approval</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 20px;color:#222}h2{margin:0 0 8px}p{color:#555}input{font-size:16px;padding:10px;width:100%;box-sizing:border-box;margin:12px 0}button{font-size:16px;padding:10px 18px;border:0;border-radius:6px;color:#fff;cursor:pointer}.ok{background:#1a7f37}.no{background:#b42318}.mid{background:#9a6700}</style></head><body>${body}</body></html>`;

function ensureServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", publicUrl);
    const runId = url.searchParams.get("runId") ?? "";
    const decision = url.searchParams.get("decision") as Decision | null;
    const valid = (decision === "approve" || decision === "reject" || decision === "modify") && waiters.has(runId);

    // step 1: the button link — ask who is deciding
    if (url.pathname === "/decision") {
      if (!valid) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page(`<h2>Nothing to decide</h2><p>This run has already been decided, or it doesn't exist.</p>`));
      }
      const title = waiters.get(runId)!.title;
      const heading = decision === "approve" ? "Approve" : decision === "reject" ? "Reject" : "Modify";
      const btn = decision === "approve" ? `<button class="ok" type="submit">✅ Confirm approval</button>`
        : decision === "reject" ? `<button class="no" type="submit">❌ Confirm rejection</button>`
        : `<button class="mid" type="submit">✏️ Send change to the AI</button>`;
      const extra = decision === "modify"
        ? `<textarea name="instruction" placeholder="Describe the change in plain English, e.g. include T. Lindqvist even at 60%" required rows="3" style="font-size:16px;padding:10px;width:100%;box-sizing:border-box;margin:12px 0"></textarea>`
        : "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        page(
          `<h2>${heading} staffing — ${esc(title)}</h2><p>Run ${esc(runId)}. Your name will be recorded with this decision.</p>` +
            `<form method="GET" action="/decision/confirm"><input type="hidden" name="runId" value="${esc(runId)}"><input type="hidden" name="decision" value="${esc(decision)}">` +
            `<input name="by" placeholder="Your name" value="${esc(defaultApprover)}" required autofocus>` +
            (approverCheckEnabled ? `<input name="pin" type="password" placeholder="Approver PIN" required>` : "") +
            extra + btn + `</form>`,
        ),
      );
    }

    // step 2: the confirmation — record and release the orchestrator
    if (url.pathname === "/decision/confirm") {
      const by = (url.searchParams.get("by") ?? "").trim() || "Unnamed approver";
      const pin = (url.searchParams.get("pin") ?? "").trim();
      const instruction = (url.searchParams.get("instruction") ?? "").trim();
      if (approverCheckEnabled && valid) {
        const expected = APPROVERS[by.toLowerCase()];
        if (!expected || expected !== pin) {
          authLog.push({ by, at: new Date().toISOString(), outcome: "denied" });
          console.log(`approval DENIED for "${by}" (unknown name or wrong PIN)`);
          res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(page(`<h2>⛔ Not authorized</h2><p><b>${esc(by)}</b> is not an authorized approver for staffing decisions (or the PIN is wrong). Nothing was changed; the attempt has been recorded.</p>`));
        }
        authLog.push({ by, at: new Date().toISOString(), outcome: "verified" });
      }
      if (!valid || (decision === "modify" && !instruction)) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page(`<h2>Nothing to decide</h2><p>This run has already been decided, it doesn't exist, or the change text was empty.</p>`));
      }
      const pending = waiters.get(runId)!;
      waiters.delete(runId);
      const at = new Date().toISOString();
      pending.resolve({ decision: decision!, by: approverCheckEnabled ? `${by} (verified)` : by, at, ...(decision === "modify" ? { instruction } : {}) });
      const head = decision === "approve" ? "✅ Approved" : decision === "reject" ? "❌ Rejected" : "✏️ Change sent to the AI";
      const tail = decision === "modify" ? `<p>"${esc(instruction)}"</p><p>A revised proposal will appear in the Teams channel shortly.</p>` : `<p>Recorded. You can close this tab — the confirmation is also posted in the Teams channel.</p>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page(`<h2>${head}</h2><p>${esc(pending.title)} · by <b>${esc(by)}</b> · ${esc(at)}</p>${tail}`));
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("approval server up");
  });
  server.listen(port, () => console.log(`approval server listening on ${port} (public: ${publicUrl})`));
}

// ---------- Teams messages ----------
export async function postTeamsMessage(text: string, title?: string): Promise<void> {
  const body = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            ...(title ? [{ type: "TextBlock", weight: "Bolder", size: "Medium", text: title, wrap: true }] : []),
            { type: "TextBlock", text, wrap: true },
          ],
        },
      },
    ],
  };
  const r = await fetch(env("TEAMS_WEBHOOK_URL"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Teams post failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
}

// ---------- the proposal card ----------
function buildCard(runId: string, opp: Opportunity, p: Proposal, revised = false) {
  const rows = p.team.map((m) => ({
    type: "ColumnSet",
    columns: [
      { type: "Column", width: "stretch", items: [{ type: "TextBlock", text: `**${m.name}**`, wrap: true }] },
      { type: "Column", width: "auto", items: [{ type: "TextBlock", text: m.role, wrap: true }] },
      { type: "Column", width: "auto", items: [{ type: "TextBlock", text: `fit ${m.skillsFit}`, wrap: true }] },
      { type: "Column", width: "auto", items: [{ type: "TextBlock", text: `${m.allocationPct}%`, wrap: true }] },
    ],
  }));
  const flags = p.tradeoffFlags.length ? [{ type: "TextBlock", text: `⚠️ ${p.tradeoffFlags.join(" ")}`, wrap: true, color: "Attention" }] : [];
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
            { type: "TextBlock", size: "Large", weight: "Bolder", text: `${revised ? "REVISED staffing proposal" : "Staffing proposal"} — ${opp.name}` },
            { type: "TextBlock", text: `${opp.accountName} · USD ${opp.amount.toLocaleString("en-US")} · start ${opp.startDate} · team of ${opp.teamSize}`, wrap: true, isSubtle: true },
            { type: "TextBlock", text: `Required: ${opp.requiredSkills.join(", ")}`, wrap: true, isSubtle: true },
            ...rows,
            { type: "TextBlock", text: p.rationale, wrap: true },
            ...flags,
            { type: "TextBlock", text: `Run ${runId} · drafted by AI, decision is yours`, wrap: true, isSubtle: true, size: "Small" },
          ],
          actions: [
            { type: "Action.OpenUrl", title: "✅ Approve", url: `${publicUrl}/decision?runId=${runId}&decision=approve` },
            { type: "Action.OpenUrl", title: "✏️ Modify", url: `${publicUrl}/decision?runId=${runId}&decision=modify` },
            { type: "Action.OpenUrl", title: "❌ Reject", url: `${publicUrl}/decision?runId=${runId}&decision=reject` },
          ],
        },
      },
    ],
  };
}

// ---------- public function used by the orchestrator ----------
export async function requestApproval(runId: string, opp: Opportunity, proposal: Proposal, timeoutMs = 15 * 60 * 1000, revised = false): Promise<ApprovalResult> {
  ensureServer();
  const r = await fetch(env("TEAMS_WEBHOOK_URL"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildCard(runId, opp, proposal, revised)) });
  if (!r.ok) throw new Error(`Teams post failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  console.log("card posted to Teams — waiting for Approve / Reject …");
  const result = await new Promise<ApprovalResult>((resolve, reject) => {
    waiters.set(runId, { resolve, title: opp.name });
    setTimeout(() => {
      if (waiters.delete(runId)) reject(new Error("approval timed out"));
    }, timeoutMs);
  });
  // confirmation back into the same channel
  await postTeamsMessage(
    result.decision === "approve"
      ? `✅ Approved by **${result.by}** at ${result.at}. Staffing in progress — writing to SuccessFactors, S/4 and Salesforce…`
      : result.decision === "reject"
        ? `❌ Rejected by **${result.by}** at ${result.at}. No changes were made to any system.`
        : `✏️ Change requested by **${result.by}** at ${result.at}: "${result.instruction}". The AI is drafting a revised proposal…`,
    `${opp.name} · run ${runId}`,
  ).catch((e) => console.log("could not post confirmation to Teams:", e instanceof Error ? e.message : e));
  return result;
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
  const result = await requestApproval(runId, opp, proposal);
  console.log(`DECISION: ${result.decision} by ${result.by} at ${result.at}`);
  stopApprovalServer();
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
