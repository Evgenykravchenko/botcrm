import assert from "node:assert/strict";
import test from "node:test";
import { exportContacts, parseContactImport } from "./contact-transfer.js";

test("contact CSV transfer preserves quoted fields, tags and attributes", () => {
  const source = [{ displayName: 'Иван "Тест"', phone: "+7999", email: "i@example.test", city: "Омск", tags: ["VIP", "горячий"], marketingStatus: "GRANTED", attributes: { lead_score: 91 } }];
  const csv = exportContacts("csv", source);
  const parsed = parseContactImport("csv", csv);
  assert.equal(parsed[0].displayName, source[0].displayName);
  assert.deepEqual(parsed[0].tags, ["VIP", "горячий"]);
  assert.deepEqual(parsed[0].attributes, { lead_score: 91 });
});

test("contact JSON import accepts an array and validates names", () => {
  assert.equal(parseContactImport("json", JSON.stringify([{ name: "Анна", tags: "новый" }]))[0].displayName, "Анна");
  assert.throws(() => parseContactImport("json", "{}"), /array/);
});
