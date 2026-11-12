import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { pandocsRouteTable } from "../src/http/handler.js";

const spec = parse(readFileSync(join(import.meta.dirname, "../../../docs/api/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, { operationId?: string; parameters?: unknown[] }> & { "x-served-by"?: string }>;
  components: { schemas: { EditOp: { oneOf: { properties: { op: { const: string } } }[] } } };
};

const METHODS = ["get", "post", "put", "patch", "delete"];

/** `documents/:id` becomes `/documents/{id}`; the asset wildcard carries one named segment in the contract. */
const toOpenApi = (pattern: string) => `/${pattern.replace(/:([a-z]+)/gu, "{$1}").replace(/\*$/u, "{asset}")}`;

describe("Pandocs OpenAPI contract", () => {
  it("documents exactly the routes the handler serves", () => {
    const served = pandocsRouteTable.map(route => `${route.method} ${toOpenApi(route.pattern)}`).sort();
    const documented = Object.entries(spec.paths)
      .filter(([, operations]) => !operations["x-served-by"])
      .flatMap(([path, operations]) =>
        METHODS.filter(method => operations[method]).map(method => `${method.toUpperCase()} ${path}`)
      )
      .sort();
    expect(documented).toEqual(served);
  });

  it("names every operation once and requires an idempotency key on the writes that demand it", () => {
    const operations = Object.values(spec.paths).flatMap(item =>
      METHODS.flatMap(method => (item[method] ? [item[method]] : []))
    );
    const ids = operations.map(operation => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Boolean)).toBe(true);
    const key = { $ref: "#/components/parameters/IdempotencyKey" };
    expect(spec.paths["/documents/{id}/content"]!.put!.parameters).toContainEqual(key);
    expect(spec.paths["/documents/{id}/ops"]!.post!.parameters).toContainEqual(key);
    expect(spec.paths["/documents/{id}/rollback"]!.post!.parameters).toContainEqual(key);
    expect(spec.paths["/proposals/{id}/decide"]!.post!.parameters).toContainEqual(key);
  });

  it("lists the edit operations the schema accepts", () => {
    expect(spec.components.schemas.EditOp.oneOf.map(item => item.properties.op.const)).toEqual([
      "str_replace",
      "block_replace",
      "block_insert_after",
      "block_delete",
      "block_move_after"
    ]);
  });
});
