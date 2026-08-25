import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_ROUTE, ROLES_ROUTE } from "./auth.js";
import { AdminController, ApiController, AuthController, RealtimeController, SystemController } from "./app.js";

function metadata(key: string, target: object, method: string) {
  const handler = (target as Record<string, unknown>)[method];
  assert.equal(typeof handler, "function");
  return Reflect.getMetadata(key, handler as (...args: unknown[]) => unknown);
}

test("only operationally required endpoints are public", () => {
  assert.equal(metadata(PUBLIC_ROUTE, SystemController.prototype, "health"), true);
  assert.equal(metadata(PUBLIC_ROUTE, AuthController.prototype, "login"), true);
  assert.equal(metadata(PUBLIC_ROUTE, ApiController.prototype, "verifyWhatsApp"), true);
  assert.equal(metadata(PUBLIC_ROUTE, ApiController.prototype, "receiveWebhook"), true);

  assert.equal(metadata(PUBLIC_ROUTE, SystemController.prototype, "metrics"), undefined);
  assert.deepEqual(metadata(ROLES_ROUTE, SystemController.prototype, "metrics"), ["OWNER", "ADMIN", "SUPERVISOR", "SERVICE"]);
  assert.equal(metadata(PUBLIC_ROUTE, SystemController.prototype, "capabilities"), undefined);
  assert.equal(metadata(PUBLIC_ROUTE, AuthController.prototype, "me"), undefined);
});

test("RBAC metadata matches the product role matrix", () => {
  const humanRoles = ["OWNER", "ADMIN", "SUPERVISOR", "OPERATOR"];
  const supervisorRoles = ["OWNER", "ADMIN", "SUPERVISOR"];
  const adminRoles = ["OWNER", "ADMIN"];

  assert.deepEqual(Reflect.getMetadata(ROLES_ROUTE, AdminController), adminRoles);
  assert.deepEqual(metadata(ROLES_ROUTE, RealtimeController.prototype, "stream"), humanRoles);

  for (const method of ["listContacts", "createContact", "updateContact", "setContactTags", "contactActivity", "addContactNote", "addContactTask", "completeTask", "listConversations", "markConversationRead", "pipelines", "createDeal", "updateDeal", "listDeals", "moveDeal", "listSegments", "previewSegment", "listCampaigns", "listConnectors", "listAutomations", "automationRuns", "search", "analytics"]) {
    assert.deepEqual(metadata(ROLES_ROUTE, ApiController.prototype, method), humanRoles, `${method} must remain available to operators`);
  }
  for (const method of ["exportContacts", "importContacts", "mergeContacts", "createPipeline", "updatePipeline", "createStage", "updateStage", "deleteStage", "createSegment", "updateSegment", "deleteSegment", "previewCampaign", "createCampaign", "updateCampaign", "testCampaign", "pauseCampaign", "cancelCampaign", "listCampaignRecipients", "checkConnector", "createAutomation", "updateAutomation", "deleteAutomation", "testAutomation", "audit"]) {
    assert.deepEqual(metadata(ROLES_ROUTE, ApiController.prototype, method), supervisorRoles, `${method} must require supervisor access`);
  }
  for (const method of ["anonymizeContact", "createConnector", "updateConnector", "deleteConnector"]) {
    assert.deepEqual(metadata(ROLES_ROUTE, ApiController.prototype, method), adminRoles, `${method} must require administrator access`);
  }
  assert.deepEqual(metadata(ROLES_ROUTE, ApiController.prototype, "processAutomation"), ["SERVICE"]);
});