import assert from "node:assert/strict";
import test from "node:test";
import { renderCampaignTemplate } from "./campaign-template.js";

test("campaign template personalizes built-in contact fields", () => {
  assert.equal(renderCampaignTemplate("Здравствуйте, {{first_name}}!", { displayName: "Анна Иванова" }), "Здравствуйте, Анна!");
  assert.equal(renderCampaignTemplate("{{full_name}} · {{email}} · {{city}}", { displayName: "Анна Иванова", email: "anna@example.com", city: "Омск" }), "Анна Иванова · anna@example.com · Омск");
});

test("campaign template resolves custom attributes and fallbacks", () => {
  const contact = { displayName: "Анна", attributes: { lead_score: 95, profile: { plan: "pro" }, active: false } };
  assert.equal(renderCampaignTemplate("{{lead_score}} / {{attributes.profile.plan}} / {{active}}", contact), "95 / pro / false");
  assert.equal(renderCampaignTemplate("Здравствуйте, {{first_name|клиент}} из {{city|вашего города}}!", {}), "Здравствуйте, клиент из вашего города!");
});

test("campaign template handles malformed and adversarial input in linear passes", () => {
  assert.equal(renderCampaignTemplate("before {{ after", {}), "before {{ after");
  assert.equal(renderCampaignTemplate("{{}}", {}), "{{}}");
  assert.equal(renderCampaignTemplate("{{{{name}}", { displayName: "Anna" }), "{{{{name}}");
  assert.equal(renderCampaignTemplate(`{{missing|${" ".repeat(100_000)}fallback}}`, {}), "fallback");
});
