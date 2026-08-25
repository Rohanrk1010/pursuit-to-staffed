# workforce-mcp (MCP-3) — Pursuit to Staffed demo

## What it is
A small Node app that publishes three tools and runs them when the orchestrator calls. Thin wrapper over the
SuccessFactors OData v2 API; no AI inside; the only place the SF API user lives.

## The three tools (the contract the orchestrator builds against)

| Tool | Input | Does | Returns |
|---|---|---|---|
| `check_availability` | requiredSkills[], startDate, endDate | GET `cust_Availability` for the period, computes skills fit, ranks | consultants[] with userId, role, skillsFit, availablePct, flags |
| `staff_team` | engagementId, startDate, endDate, team[{userId, role, allocationPct}], approvedBy | upserts `cust_Assignment` rows, reduces `cust_availablePct` | assignments[], staffedAt |
| `get_consultant_profile` | userId | GET User + availability row | name, title, role, skills, availablePct |

Errors come back as `{ "error": "..." }` with `isError: true`. `check_availability` never writes.

## SuccessFactors setup this expects
1. Real tenant, admin rights, API user with RBP permissions on User and the two MDF objects
2. Two MDF objects (Configure Object Definitions), OData API visibility = editable:
   - `cust_Availability`: externalCode = userId, `cust_role`, `cust_skills` (string, e.g. `S/4 Finance:98;BTP CAP:95;Data Eng:92`),
     `cust_startDate`, `cust_endDate`, `cust_availablePct`
   - `cust_Assignment`: externalCode = `<engagementId>-<userId>`, `cust_userId`, `cust_engagementId`,
     `cust_startDate`, `cust_endDate`, `cust_utilizationPct`
   Field names are configurable in the `F` map at the top of the code.
3. The five consultants as users (amehta, rsilva, jokafor, tlindqvist, pnair) with the rows from the demo data sheet
4. Auth: OAuth 2.0 SAML bearer — Manage OAuth2 Client Applications → register app, generate X.509 → client_id + private key.
   If the tenant still allows basic auth for the API user, set `SFSF_AUTH_MODE=basic` to move faster.

## Run
```bash
mkdir workforce-mcp && cd workforce-mcp && npm init -y
npm i @modelcontextprotocol/sdk express zod
npm i -D tsx typescript @types/express @types/node
cp ../workforce-mcp.ts . && cp .env.example .env
npx tsx --env-file=.env workforce-mcp.ts
```

`.env.example`
```
SFSF_API_HOST=https://api<dc>.successfactors.com
SFSF_COMPANY_ID=
SFSF_AUTH_MODE=oauth            # or basic
SFSF_API_USER=
SFSF_CLIENT_ID=                 # oauth
SFSF_PRIVATE_KEY=               # oauth: PEM body, single line
SFSF_PASSWORD=                  # basic
SFSF_AVAILABILITY_ENTITY=cust_Availability
SFSF_ASSIGNMENT_ENTITY=cust_Assignment
MCP_TOKEN=change-me
PORT=8083
```

## Test without the orchestrator
`npx @modelcontextprotocol/inspector` → Streamable HTTP, `http://localhost:8083/mcp`,
header `Authorization: Bearer <MCP_TOKEN>`. Run `check_availability` with the three skills and Sep 1 → Feb 28;
you should get the five consultants ranked Lindqvist 97, Mehta 95, Silva 92, Okafor 88, Nair 84, with Lindqvist flagged.

## Definition of done (milestone one for MCP-3)
`check_availability` returns the five consultants from the real tenant. Then `staff_team` creates four rows you can see
in Manage Data. Then hand Rohan the URL + token.

## Reset between runs
Delete the four `cust_Assignment` rows and set `cust_availablePct` back to 100/100/80/60/100.
