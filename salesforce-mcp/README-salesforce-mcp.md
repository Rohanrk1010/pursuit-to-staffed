# salesforce-mcp (MCP-1) — Pursuit to Staffed demo

## What it is
A small Node app that publishes three tools and runs them when the orchestrator calls. Thin wrapper over the
Salesforce REST API; no AI inside; the only place the Salesforce credentials live.
The Platform Event subscription (CometD) is **not** here — Rohan's orchestrator subscribes directly.

## The three tools (the contract the orchestrator builds against)

| Tool | Input | Does | Returns |
|---|---|---|---|
| `get_opportunity` | opportunityId | SOQL read incl. Account.Name, Required_Skills__c, Start_Date__c, Team_Size__c | id, name, accountName, amount, currency, closeDate, stage, requiredSkills[], startDate, teamSize, staffingStatus |
| `update_opportunity_status` | opportunityId, status | PATCH `Staffing_Status__c` (configurable) | opportunityId, field, status, updatedAt |
| `post_chatter_update` | opportunityId, text | POST Chatter feed item on the Opportunity | feedItemId, url, postedAt |

Errors come back as `{ "error": "..." }` with `isError: true`.

## Salesforce setup this expects
1. Developer Edition org, custom fields on Opportunity: `Required_Skills__c` (multi-select picklist),
   `Start_Date__c` (date), `Team_Size__c` (number), `Staffing_Status__c` (picklist or text)
2. External Client App (or Connected App) with OAuth enabled and **"Use digital signatures"** holding our
   certificate.crt (JWT bearer flow), integration user `BTPIntegration@globalco.sf` pre-authorized, with API access,
   read/edit on Opportunity, Chatter enabled. Client Credentials flow also supported (`SF_AUTH_MODE=client_credentials`).
3. The same app / integration user is used for the Platform Event subscription
   (needs *Read* on the event; channel `/event/Opportunity_Won__e` as named by Shashank)

## Key pair for the JWT flow (Rohan generates, sends certificate.crt to Shashank, keeps private.key)
```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout private.key -out certificate.crt -days 365 -subj "/CN=pursuit-to-staffed"
```

## Run
```bash
mkdir salesforce-mcp && cd salesforce-mcp && npm init -y
npm i @modelcontextprotocol/sdk express zod
npm i -D tsx typescript @types/express @types/node
cp ../salesforce-mcp.ts . && cp .env.example .env
npx tsx --env-file=.env salesforce-mcp.ts
```

`.env.example`
```
SF_LOGIN_URL=https://<mydomain>.my.salesforce.com
SF_CLIENT_ID=                 # Consumer Key from Shashank
SF_AUTH_MODE=jwt              # jwt (certificate) or client_credentials
SF_USERNAME=BTPIntegration@globalco.sf
SF_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"   # contents of private.key, never committed
SF_CLIENT_SECRET=             # client_credentials mode only
SF_MULTI_CURRENCY=false
SF_API_VERSION=v62.0
SF_STATUS_FIELD=Staffing_Status__c
MCP_TOKEN=change-me
PORT=8081
```

## Test without the orchestrator
`npx @modelcontextprotocol/inspector` → Streamable HTTP, `http://localhost:8081/mcp`,
header `Authorization: Bearer <MCP_TOKEN>`. Run `get_opportunity` with the Project Falcon Id.

## Definition of done (milestone one for MCP-1)
`get_opportunity` returns Project Falcon with the three custom fields; `post_chatter_update` shows on the record.
Then hand Rohan the URL + token.

## Salesforce setup (dev org: orgfarm-27dfc46293-dev-ed)
 
External Client App
- JWT Bearer Flow enabled; certificate.crt from salesforce-mcp/ uploaded
- Consumer Key stored in .env as SF_CLIENT_ID
- Policies: pre-authorized profile "Minimum Access - API Only Integrations"
  and permission set "BTP Integration Permissions"
 
Integration user: BTPIntegration@globalco.sf
- User License: Salesforce Integration
- Profile: Minimum Access - API Only Integrations
- Permission Set License: Salesforce API Integration (required, see note below)
- Permission sets assigned: BTP Integration Permissions, BTP standard objects
 
Permission set "BTP standard objects" (License = Salesforce API Integration)
- Opportunity: Read and Edit; all fields Read; Staffing_Status__c Edit
- Account: Read
 
Custom fields on Opportunity
- Required_Skills__c, Start_Date__c, Team_Size__c
- Staffing_Status__c (Text field, not a picklist; any value is accepted,
  so the orchestrator must control which statuses it writes)
 
Important note
- For a user on the Salesforce Integration license, standard-object permissions
  apply only when granted through a permission set created with
  License = "Salesforce API Integration". Granted through any other permission
  set, they save without error but have no effect, and queries fail with
  "sObject type 'Opportunity' is not supported".
- After any permission change, restart salesforce-mcp.ts so it logs in again.
 
MCP server
- Endpoint: http://localhost:8081/mcp (Streamable HTTP)
- Header: Authorization: Bearer <MCP_TOKEN> (capital B required)
- Health check: http://localhost:8081/health
 
Test record: Express Logistics Portable Truck Generators (006aj00000bS4MuAAK)
Verified on 26 Aug 2026: get_opportunity, update_opportunity_status, post_chatter_update
 