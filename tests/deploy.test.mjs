import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { funnelConfig, upstreamConfig } from "../infra/scripts/deploy.mjs";

test("staging a Funnel transport preserves live port and storage exactly", () => {
  const original = { TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } }, Web: { "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: "http://caddy:8080" } } }, "${TS_CERT_DOMAIN}:8443": { Handlers: { "/": { Proxy: "http://minio:9000" } } } }, AllowFunnel: { "${TS_CERT_DOMAIN}:443": true, "${TS_CERT_DOMAIN}:8443": true } };
  const staged = funnelConfig(original, "crm.example.ts.net", 10000);
  assert.deepEqual(staged.TCP[443], original.TCP[443]);
  assert.deepEqual(staged.Web["${TS_CERT_DOMAIN}:443"], original.Web["${TS_CERT_DOMAIN}:443"]);
  assert.deepEqual(staged.Web["${TS_CERT_DOMAIN}:8443"], original.Web["${TS_CERT_DOMAIN}:8443"]);
  assert.equal(staged.TCP[10000].HTTPS, true);
  const live = funnelConfig(original, "crm.example.ts.net", 443);
  assert.equal(live.Web["${TS_CERT_DOMAIN}:443"].Handlers["/"].Proxy, "http://botcrm-edge-1:8080");
  assert.deepEqual(live.TCP[8443], original.TCP[8443]);
  assert.deepEqual(live.Web["${TS_CERT_DOMAIN}:8443"], original.Web["${TS_CERT_DOMAIN}:8443"]);
  assert.deepEqual(original.TCP[443], { HTTPS: true });
});

test("committed Funnel config is the exact persistent live config", async () => {
  const source = await readFile(new URL("../infra/tailscale-serve/serve.json", import.meta.url), "utf8");
  assert.equal(JSON.stringify(funnelConfig(JSON.parse(source), "crm.example.ts.net", 443), null, 2) + "\n", source);
});

test("release upstreams replace forwarded addresses and reject config injection", () => {
  const text = upstreamConfig("botcrm-blue-api-release-1", "botcrm-blue-web-release-1");
  assert.match(text, /header_up X-Forwarded-For \{client_ip\}/);
  assert.match(text, /header_up -Forwarded/);
  assert.match(text, /header_up -X-Real-IP/);
  assert.throws(() => upstreamConfig("attacker.example {", "botcrm-web-1"));
  assert.throws(() => upstreamConfig("api", "botcrm-web-1"));
});
