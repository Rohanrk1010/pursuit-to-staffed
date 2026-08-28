/**
 * propose.ts — the staffing-proposal agent (A2). DRAFTS ONLY, never writes to any system.
 *
 * Run as a test:  npx tsx --env-file=.env propose.ts
 * Expected: a team of 4, rationale, and a tradeoff flag about T. Lindqvist (60% available).
 *
 * .env: LLM_PROVIDER=azure, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT
 *       (later a company endpoint is a swap of these values, nothing else changes)
 */
import { z } from "zod";

// ---------- what the orchestrator gives us ----------
export type Opportunity = {
  opportunityId: string;
  name: string;
  accountName: string;
  amount: number;
  requiredSkills: string[];
  startDate: string;
  teamSize: number;
};

export type Consultant = {
  userId: string;
  name: string | null;
  role: string;
  skillsFit: number;
  availablePct: number;
  skills: string[];
};

// ---------- what the agent must return (validated) ----------
export const ProposalSchema = z.object({
  team: z
    .array(
      z.object({
        userId: z.string(),
        name: z.string(),
        role: z.string(),
        skillsFit: z.number(),
        availablePct: z.number(),
        allocationPct: z.number().min(1).max(100),
        reason: z.string(),
      }),
    )
    .min(1),
  rationale: z.string(),
  tradeoffFlags: z.array(z.string()),
});
export type Proposal = z.infer<typeof ProposalSchema>;

// ---------- the LLM call ----------
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};

// token usage of the last LLM call(s) in this process — read by the orchestrator for the trace
export const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
// rough cost estimate (USD per 1M tokens); override with LLM_PRICE_IN / LLM_PRICE_OUT in .env
const PRICE_IN = Number(process.env.LLM_PRICE_IN ?? 0.15);
const PRICE_OUT = Number(process.env.LLM_PRICE_OUT ?? 0.6);
export const estimatedCostUsd = () => Math.round(((usage.promptTokens * PRICE_IN + usage.completionTokens * PRICE_OUT) / 1e6) * 10000) / 10000;

async function chat(messages: { role: "system" | "user"; content: string }[]): Promise<string> {
  const endpoint = env("AZURE_OPENAI_ENDPOINT").replace(/\/$/, "");
  const deployment = env("AZURE_OPENAI_DEPLOYMENT");
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-10-21`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": env("AZURE_OPENAI_KEY") },
    body: JSON.stringify({ messages, temperature: 0.2, response_format: { type: "json_object" } }),
  });
  if (!r.ok) throw new Error(`LLM call failed: HTTP ${r.status} ${(await r.text()).slice(0, 500)}`);
  const data = await r.json();
  usage.promptTokens += Number(data.usage?.prompt_tokens ?? 0);
  usage.completionTokens += Number(data.usage?.completion_tokens ?? 0);
  usage.calls += 1;
  return data.choices?.[0]?.message?.content ?? "";
}

const SYSTEM = `You are a staffing assistant for a consulting firm. You DRAFT a team proposal; a human manager decides.
Return ONLY a JSON object with this exact shape:
{"team":[{"userId":"...","name":"...","role":"...","skillsFit":0,"availablePct":0,"allocationPct":0,"reason":"..."}],
 "rationale":"...","tradeoffFlags":["..."]}
Rules: pick exactly teamSize people. Prefer high skillsFit AND high availability. If the best-fit person is under 80% available,
do not pick them by default; name them in tradeoffFlags with their availability and who you picked instead. allocationPct is
the percentage of their time you propose (never above availablePct). Keep reasons to one sentence each.`;

export async function reviseTeam(
  opportunity: Opportunity,
  consultants: Consultant[],
  previous: Proposal,
  instruction: string,
): Promise<Proposal> {
  const sys = `You are a staffing assistant. You proposed a team; the manager now asks for a change, in plain English.
Apply the manager's instruction even if it conflicts with the default rules (the human decides) — but record any
resulting concern honestly in tradeoffFlags (e.g. availability below 80%). Keep the team size at ${opportunity.teamSize}
unless the instruction says otherwise. Only use consultants from the provided list. Respond with JSON only, same schema as before:
{"team":[{"userId","name","role","skillsFit","availablePct","allocationPct","reason"}],"rationale","tradeoffFlags":[]}`;
  const user = JSON.stringify({ opportunity, consultants, previousProposal: previous, managerInstruction: instruction });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await chat([
      { role: "system", content: sys },
      { role: "user", content: user },
    ]);
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
      const parsed = ProposalSchema.parse(JSON.parse(cleaned));
      return parsed;
    } catch (e) {
      if (attempt === 2) throw new Error(`Revised proposal invalid after retry: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw new Error("unreachable");
}

export async function proposeTeam(opportunity: Opportunity, consultants: Consultant[]): Promise<Proposal> {
  const user = `Opportunity: ${JSON.stringify(opportunity)}\nConsultants: ${JSON.stringify(consultants)}`;
  let raw = await chat([{ role: "system", content: SYSTEM }, { role: "user", content: user }]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = ProposalSchema.parse(JSON.parse(raw.replace(/```json|```/g, "").trim()));
      if (parsed.team.length !== opportunity.teamSize) throw new Error(`expected ${opportunity.teamSize} people`);
      return parsed;
    } catch (e) {
      if (attempt === 1) throw new Error(`Proposal invalid after retry: ${e instanceof Error ? e.message : e}\n${raw}`);
      raw = await chat([
        { role: "system", content: SYSTEM },
        { role: "user", content: `${user}\nYour previous answer was invalid (${e instanceof Error ? e.message : e}). Return valid JSON only.` },
      ]);
    }
  }
  throw new Error("unreachable");
}

// ---------- test run with the demo data (replace with live SuccessFactors output in the orchestrator) ----------
async function main() {
  const opportunity: Opportunity = {
    opportunityId: "TEST",
    name: "Project Falcon",
    accountName: "GlobalCo Financial",
    amount: 2400000,
    requiredSkills: ["S/4 Finance", "BTP CAP", "Data Eng"],
    startDate: "2026-09-01",
    teamSize: 4,
  };
  const consultants: Consultant[] = [
    { userId: "103417", name: "A. Mehta", role: "ENG_MANAGER", skillsFit: 95, availablePct: 100, skills: ["S/4 Finance", "BTP CAP", "Data Eng"] },
    { userId: "103418", name: "R. Silva", role: "SR_CONSULTANT", skillsFit: 92, availablePct: 100, skills: ["S/4 Finance", "BTP CAP", "Data Eng"] },
    { userId: "103419", name: "J. Okafor", role: "SR_CONSULTANT", skillsFit: 88, availablePct: 80, skills: ["S/4 Finance", "BTP CAP", "Data Eng"] },
    { userId: "103420", name: "T. Lindqvist", role: "ARCHITECT", skillsFit: 97, availablePct: 60, skills: ["S/4 Finance", "BTP CAP", "Data Eng"] },
    { userId: "103421", name: "P. Nair", role: "ANALYST", skillsFit: 84, availablePct: 100, skills: ["S/4 Finance", "BTP CAP", "Data Eng"] },
  ];
  const proposal = await proposeTeam(opportunity, consultants);
  console.log(JSON.stringify(proposal, null, 2));
  console.log(`tokens: ${usage.promptTokens} in / ${usage.completionTokens} out · est. cost $${estimatedCostUsd()}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
