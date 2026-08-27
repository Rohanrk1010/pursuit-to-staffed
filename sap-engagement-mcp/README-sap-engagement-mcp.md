# sap-engagement-mcp (MCP-2) — Pursuit to Staffed demo

## What it is
An MCP (Model Context Protocol) server is a small Node app that publishes a list of **tools**
(name + description + JSON input schema) and executes them when the orchestrator calls them.
It is a thin API wrapper: the orchestrator says `create_engagement {...}`, this server turns that
into an OData call to S/4HANA Cloud and returns JSON. No AI logic lives here, and only this server
holds the S/4 communication user.

## The three tools (this is the contract the orchestrator builds against)

| Tool | Input | Does in S/4 | Returns |
|---|---|---|---|
| `create_engagement` | engagementId, description, clientName, value, currency, startDate, endDate, wbsElement, sourceOpportunityId? | POST `A_EnterpriseProject` with nested WBS element; staffing status = Awaiting assignment | engagementId, status CREATED, staffingStatus, fioriUrl |
| `get_engagement` | engagementId | GET project + `$expand=to_EnterpriseProjectElement` | engagementId, description, dates, staffingStatus, wbsElements[], fioriUrl |
| `confirm_staffing` | engagementId, team[], confirmedBy, confirmedAt | PATCH staffing status = STAFFED | engagementId, staffingStatus STAFFED, teamSize, confirmedBy, fioriUrl |

Errors come back as `{ "error": "..." }` with `isError: true`; the orchestrator logs them to Langfuse.

## Run
```bash
mkdir sap-engagement-mcp && cd sap-engagement-mcp
npm init -y
npm i @modelcontextprotocol/sdk express zod
npm i -D tsx typescript @types/express @types/node
cp ../sap-engagement-mcp.ts .
cp .env.example .env   # fill in values, then:
npx tsx --env-file=.env sap-engagement-mcp.ts
```

`.env.example`
```
S4_API_HOST=https://my######-api.s4hana.cloud.sap
S4_FIORI_HOST=https://my######.s4hana.cloud.sap
S4_USER=MCP_DEMO
S4_PASSWORD=********
S4_PROJECT_PROFILE=      # from an existing project
S4_COST_CENTER=          # from an existing project
S4_PROFIT_CENTER=        # from an existing project
S4_STAFFING_FIELD=YY1_StaffingStatus_PTD   # from the Custom Fields app
MCP_TOKEN=change-me      # shared with the orchestrator only
PORT=8080
```

## Test without the orchestrator
```bash
npx @modelcontextprotocol/inspector
```
Transport: Streamable HTTP · URL: `http://localhost:8080/mcp` · Header: `Authorization: Bearer <MCP_TOKEN>`.
You should see the three tools listed; run `create_engagement` with the demo data and open the project in Fiori.

## Before the first real call (TODOs in the code)
1. Communication arrangement for **SAP_COM_0308** exists; API host + communication user in `.env`
2. Property names checked against `$metadata` of `A_EnterpriseProject` / `A_EnterpriseProjectElement`
3. Custom field "Staffing Status" created in the Custom Fields app, assigned to the project category used by `S4_PROJECT_PROFILE`, enabled for `API_ENTERPRISE_PROJECT_SRV` and the Fiori app; technical name in `S4_STAFFING_FIELD`. Its allowed values must include `STAFFED`.
4. Project ID format allows `ENG-2026-0147` (else adjust the demo data sheet)
5. Fiori deep link copied from the real app into `fioriUrl()`

## Definition of done (milestone one)
`create_engagement` called from MCP Inspector -> project visible in *Project Control – Enterprise Projects*.
After that, deploy to BTP Cloud Foundry (`cf push`, env vars as user-provided service) and hand the URL + token to the orchestrator owner.
