// Uses the running site from outside the cluster, through its Service, the way people would.
const origin = "http://127.0.0.1:18080";
const [, , command, ...args] = process.argv;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const fail = message => {
  console.error(`FAILED: ${message}`);
  process.exit(1);
};

async function signIn() {
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "admin@example.test", password: "test-password-for-the-chart", next: "/" })
  });
  if (login.status !== 303) fail(`could not sign in: ${login.status}`);
  const cookie = login.headers
    .getSetCookie()
    .map(line => line.split(";")[0])
    .join("; ");
  const answer = await fetch(`${origin}/api/v1/account/tokens`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "chart test", scopes: ["read", "write"] })
  });
  return (await answer.json()).data.token;
}

const headers = token => ({ authorization: `Bearer ${token}` });
const call = async (token, method, path, body, extra = {}) => {
  const response = await fetch(`${origin}/api/v1/${path}`, {
    method,
    headers: { ...headers(token), ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, data: payload?.data, error: payload?.error };
};
const save = async (token, id, markdown) => {
  const { data } = await call(token, "GET", `documents/${id}`);
  return call(
    token,
    "PUT",
    `documents/${id}/content`,
    { markdown, expectedRevision: data.revision.no },
    { "idempotency-key": crypto.randomUUID() }
  );
};

const commands = {
  async token() {
    process.stdout.write(await signIn());
  },
  async setup(token) {
    const space = await call(token, "POST", "spaces", { slug: "handbook", name: "Handbook", defaultRole: "viewer" });
    if (space.status !== 201) fail(`could not create a space: ${JSON.stringify(space)}`);
    const upload = await fetch(`${origin}/api/v1/spaces/handbook/assets?filename=a.png`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "image/png" },
      body: PNG
    });
    const image = (await upload.json()).data;
    if (upload.status !== 201) fail("could not upload to object storage");
    const page = await call(token, "POST", "spaces/handbook/documents", {
      title: "Getting started",
      slug: "start",
      markdown: `# Getting started\n\n![Picture](${image.path})\n`
    });
    if (page.status !== 201) fail(`could not create a page: ${JSON.stringify(page)}`);
    // Every pod has to find the upload, wherever it landed.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const read = await fetch(`${origin}/api/v1/spaces/handbook/assets/${image.sha256}`, { headers: headers(token) });
      if (read.status !== 200 || Buffer.compare(Buffer.from(await read.arrayBuffer()), PNG) !== 0)
        fail(`attempt ${attempt} read the upload back wrong: ${read.status}`);
    }
    console.log(`page ${page.data.document.id}, upload reads back from every pod`);
    process.stdout.write("");
  },
  async convert(token) {
    const form = new FormData();
    form.set("file", new File(["name,team\nAda,Books\n"], "people.csv", { type: "text/csv" }));
    form.set("target", "{}");
    const started = await fetch(`${origin}/api/v1/spaces/handbook/imports`, {
      method: "POST",
      headers: headers(token),
      body: form
    });
    const { data: job } = await started.json();
    if (started.status !== 201) fail(`could not import: ${started.status}`);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const { data } = await call(token, "GET", `imports/${job.id}`);
      if (data.status === "succeeded") {
        if (!data.draftMarkdown.includes("| Ada | Books |")) fail(`converted wrongly: ${data.draftMarkdown}`);
        console.log("a separate worker pod converted a file");
        return;
      }
      if (data.status === "failed") fail(`conversion failed: ${data.errorMessage}`);
      await new Promise(done => setTimeout(done, 250));
    }
    fail("the conversion never finished");
  },
  async edit(token, path, text) {
    const { data } = await call(token, "GET", `spaces/handbook/resolve?path=${path}`);
    const saved = await save(token, data.id, text);
    if (saved.status !== 200) fail(`could not save: ${JSON.stringify(saved)}`);
  },
  /** Keeps reading and saving for as long as it is told, and counts what goes wrong. */
  async hammer(token, seconds) {
    const { data: page } = await call(token, "GET", "spaces/handbook/resolve?path=start");
    const until = Date.now() + Number(seconds) * 1000;
    const outcomes = new Map();
    const note = key => outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    const reader = async () => {
      while (Date.now() < until) {
        try {
          const response = await fetch(`${origin}/api/v1/documents/${page.id}`, { headers: headers(token) });
          await response.arrayBuffer();
          note(`read ${response.status}`);
        } catch (error) {
          note(`read ${error.cause?.code ?? error.message}`);
        }
      }
    };
    const writer = async () => {
      let round = 0;
      while (Date.now() < until) {
        try {
          round += 1;
          const saved = await save(token, page.id, `# Getting started\n\nRound ${round}.\n`);
          note(`save ${saved.status === 200 ? 200 : `${saved.error?.code} ${saved.status}`}`);
        } catch (error) {
          note(`save ${error.cause?.code ?? error.message}`);
        }
        await new Promise(done => setTimeout(done, 100));
      }
    };
    await Promise.all([reader(), reader(), reader(), reader(), writer()]);
    const summary = [...outcomes]
      .sort()
      .map(([key, count]) => `${key}: ${count}`)
      .join(", ");
    console.log(summary);
    const bad = [...outcomes.keys()].filter(key => !/ 200$/u.test(key));
    if (bad.length > 0) fail(`requests failed during the update: ${bad.join(", ")}`);
  }
};

if (!commands[command]) fail(`unknown command ${command}`);
await commands[command](...args);
