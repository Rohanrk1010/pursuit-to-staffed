import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import Faye from "faye";
 
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Missing ${k}`); return v; };
const loginUrl = env("SF_LOGIN_URL");
const clientId = env("SF_CLIENT_ID");
const username = env("SF_USERNAME");
const privateKey = process.env.SF_PRIVATE_KEY_PATH
  ? readFileSync(process.env.SF_PRIVATE_KEY_PATH, "utf8")
  : (process.env.SF_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
const apiVersion = (process.env.SF_API_VERSION ?? "v62.0").replace("v", "");
const channel = "/event/Opportunity_Won__e";
 
async function login() {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256" })}.${b64({ iss: clientId, sub: username, aud: loginUrl, exp: now + 180 })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  const r = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!r.ok) throw new Error(`login failed ${r.status}: ${await r.text()}`);
  return (await r.json()) as { access_token: string; instance_url: string };
}
 
async function main() {
  const { access_token, instance_url } = await login();
  console.log("logged in to", instance_url);
 
  const client = new Faye.Client(`${instance_url}/cometd/${apiVersion}`, { timeout: 110 });
  client.disable("websocket");
  client.setHeader("Authorization", `OAuth ${access_token}`);
  client.addExtension({
    outgoing: (msg: any, cb: (m: any) => void) => {
      if (msg.channel === "/meta/subscribe") msg.ext = { replay: { [channel]: -1 } };
      cb(msg);
    },
  });
  client.on("transport:down", () => console.log("transport down"));
  client.on("transport:up", () => console.log("transport up"));
  const sub = client.subscribe(channel, (message: any) => {
    console.log("EVENT RECEIVED");
    console.log(JSON.stringify(message.payload ?? message, null, 2));
  });
  sub.then(
    () => console.log("subscribed OK to", channel, "- now flip Project Falcon to Closed Won"),
    (err: any) => { console.log("SUBSCRIBE FAILED:", JSON.stringify(err)); process.exit(1); },
  );
}
 
main().catch((e) => {
  console.error(e);
  process.exit(1);
});