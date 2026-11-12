#!/usr/bin/env node
// Load test against a running server: `node scripts/bench.mjs http://localhost:8080 pd_xxx [pages]`.
// It creates a space of its own. Absolute numbers depend on the machine; compare runs on the same one.
const [origin = "http://127.0.0.1:8080", token, pagesArg = "2000"] = process.argv.slice(2);
if (!token) throw new Error("usage: bench.mjs <origin> <admin token> [pages]");
const PAGES = Number(pagesArg);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const space = `bench-${Date.now().toString(36)}`;

const call = async (method, path, body) => {
  const response = await fetch(`${origin}/api/v1/${path}`, {
    method,
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload.error)}`);
  return payload.data;
};

const paragraph =
  "收银台每天打烊前要结班，清点现金，金额和班结单对不上的时候写清原因。书架上的书要书脊朝外，高度对齐，读者才看得清。";
const page = (index, size) => {
  const parts = [`## 第 ${index} 节\n`, `独有词语甲${index}乙。\n`];
  while (parts.join("\n").length < size) parts.push(`${paragraph}\n`, `- ${paragraph}\n`);
  return parts.join("\n");
};

async function pool(count, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < count) await work(next++);
    })
  );
}

async function run(label, { concurrency, seconds = 6, request }) {
  const latencies = [];
  const end = performance.now() + seconds * 1000;
  let errors = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, worker) => {
      for (let at = 0; performance.now() < end; at += 1) {
        const started = performance.now();
        const response = await request(worker, at).catch(() => null);
        if (response) await response.arrayBuffer();
        if (response?.ok) latencies.push(performance.now() - started);
        else errors += 1;
      }
    })
  );
  latencies.sort((a, b) => a - b);
  const at = share => (latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * share))] ?? 0).toFixed(1);
  console.log(
    `${label.padEnd(44)} ${(latencies.length / seconds).toFixed(0).padStart(7)} rps  p50 ${at(0.5).padStart(8)} ms  p99 ${at(0.99).padStart(8)} ms${errors ? `  errors ${errors}` : ""}`
  );
}

const get = path => fetch(`${origin}/api/v1/${path}`, { headers });

await call("POST", "spaces", { slug: space, name: "压测", defaultRole: "viewer" });
const started = performance.now();
const ids = [];
await pool(PAGES, async index => {
  const { document } = await call("POST", `spaces/${space}/documents`, {
    title: `页面 ${index}`,
    slug: `p${index}`,
    markdown: page(index, 4000)
  });
  ids.push(document.id);
});
console.log(`created ${PAGES} pages in ${((performance.now() - started) / 1000).toFixed(1)}s`);
const { document: big } = await call("POST", `spaces/${space}/documents`, {
  title: "长页面",
  slug: "big",
  markdown: page(0, 500_000)
});

const anyId = at => ids[at % ids.length];
await run("read a 4 KB page, 16 clients", {
  concurrency: 16,
  request: (worker, at) => get(`documents/${anyId(worker * 97 + at)}`)
});
await run("read a 500 KB page, 4 clients", { concurrency: 4, request: () => get(`documents/${big.id}`) });
await Promise.all([
  run("small reads next to 2 readers of 500 KB", {
    concurrency: 16,
    request: (worker, at) => get(`documents/${anyId(worker * 97 + at)}`)
  }),
  run("  (those 2 readers)", { concurrency: 2, request: () => get(`documents/${big.id}`) })
]);
await run("save a 4 KB page, 8 clients", {
  concurrency: 8,
  request: (() => {
    const revisions = new Map();
    return async worker => {
      const id = ids[worker];
      const no = revisions.get(id) ?? 1;
      const response = await fetch(`${origin}/api/v1/documents/${id}/content`, {
        method: "PUT",
        headers: { ...headers, "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ markdown: `${page(worker, 4000)}\n版本 ${no}\n`, expectedRevision: no })
      });
      if (response.ok) revisions.set(id, no + 1);
      return response;
    };
  })()
});
await run("search a rare phrase, 4 clients", {
  concurrency: 4,
  request: (_, at) => get(`search?q=${encodeURIComponent(`独有词语甲${at % PAGES}乙`)}`)
});
await run("search a common phrase, 4 clients", {
  concurrency: 4,
  request: () => get(`search?q=${encodeURIComponent("书脊朝外")}`)
});
await run("first screen data, 2 clients", { concurrency: 2, request: () => get("bootstrap") });
const index = await get("static/search_index.zh.abc123.json");
const indexBody = await index.text();
console.log(`browser search index: ${(indexBody.length / 1048576).toFixed(1)} MB`);
const boot = await (await get("bootstrap")).text();
console.log(`first screen data: ${(boot.length / 1048576).toFixed(2)} MB`);
