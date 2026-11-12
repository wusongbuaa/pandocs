// Run against a stand-in for a server, so that all this shows is that the package as installed does what it says.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPandocsClient } from "@pandocs/client";

const seen: string[] = [];
const server = createServer((request, response) => {
  seen.push(`${request.method} ${request.url} ${request.headers.authorization}`);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ version: 1, data: [{ slug: "handbook", name: "Handbook" }] }));
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const client = createPandocsClient({ server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "pd_try" });
const spaces = await client.spaces();
server.close();
if (spaces[0]?.slug !== "handbook" || !seen[0]?.includes("Bearer pd_try")) throw new Error(`the client did not work: ${JSON.stringify({ spaces, seen })}`);
console.log("@pandocs/client works");
// Importing it on a server, as a page rendered there does, must not fail for want of a browser.
await import("@pandocs/embed");
await import("@pandocs/embed/react");
console.log("@pandocs/embed can be imported where there is no browser");
