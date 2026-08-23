import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./core.js";
import { compileSegmentFilter, validateSegmentFilter } from "./segment.js";

test("segment compiler produces parameterized nested SQL", () => {
  const compiled = compileSegmentFilter({ operator: "AND", conditions: [
    { field: "channel", operator: "contains", value: "telegram" },
    { operator: "OR", conditions: [{ field: "attributes.lead_score", operator: "gte", value: 70 }, { field: "tag", operator: "equals", value: "vip" }] },
  ] }, ["workspace"]);
  assert.match(compiled.sql, /AND/); assert.match(compiled.sql, /OR/); assert.match(compiled.sql, /custom_fields/); assert.equal(compiled.params[0], "workspace"); assert.ok(compiled.params.includes(70)); assert.ok(compiled.params.includes("vip"));
});

test("segment validation rejects untrusted fields and oversized IN filters", () => {
  assert.throws(() => validateSegmentFilter({ operator: "AND", conditions: [{ field: "ct.id);drop table", operator: "equals", value: "x" }] }), (error: unknown) => error instanceof DomainError && error.code === "invalid_segment_field");
  assert.throws(() => validateSegmentFilter({ operator: "AND", conditions: [{ field: "city", operator: "in", value: Array.from({ length: 101 }, (_, index) => index) }] }), (error: unknown) => error instanceof DomainError && error.code === "invalid_segment_value");
});
