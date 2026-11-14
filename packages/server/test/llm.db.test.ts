import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Principal } from "@pandocs/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { migrate } from "../src/app.js";
import { readConfig, type LlmConfig } from "../src/config.js";
import { createLlmPort } from "../src/llm.js";

const postgres = usePostgresFixture();

const person: Principal = {
  id: "user-1",
  kind: "user",
  displayName: "读者",
  groups: [],
  isAdmin: false,
  scopes: ["read", "write"],
  channel: "web"
};

const read = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, any>;
};

describe("model calls", () => {
  let pool: pg.Pool;
  const seen: { path: string; headers: IncomingMessage["headers"]; body: Record<string, any> }[] = [];
  let baseUrl = "";
  let status = 200;
  let streamed: { type: string; body: string }[] | null = null;
  const server = createServer((request, response) => {
    void read(request).then(body => {
      seen.push({ path: request.url!, headers: request.headers, body });
      if (body.stream && streamed) {
        const script = streamed.shift()!;
        response.writeHead(status, { "content-type": script.type });
        response.end(script.body);
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      if (status !== 200) {
        response.end(
          JSON.stringify({ type: "error", error: { type: "api_error", message: "the upstream's own words" } })
        );
        return;
      }
      response.end(
        JSON.stringify(
          request.url!.endsWith("/v1/messages")
            ? {
                id: "msg",
                type: "message",
                role: "assistant",
                model: body.model,
                stop_reason: body.messages[0].content.includes("REFUSE") ? "refusal" : "end_turn",
                content: [{ type: "text", text: "  来自 Claude  " }],
                usage: { input_tokens: 11, output_tokens: 7 }
              }
            : { choices: [{ message: { content: "来自兼容接口" } }], usage: { prompt_tokens: 3, completion_tokens: 5 } }
        )
      );
    });
  });

  const config = (overrides: Partial<LlmConfig>): LlmConfig => ({
    protocol: "openai",
    baseUrl: `${baseUrl}/v1`,
    apiKey: "secret-key",
    model: "test-model",
    headers: {},
    hourlyLimit: 100,
    visitorHourlyLimit: 100,
    ...overrides
  });

  beforeAll(async () => {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    pool = new pg.Pool({ connectionString: postgres.getConnectionString(), max: 2 });
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.end();
    await new Promise(done => server.close(done));
  });

  it("speaks the OpenAI-compatible protocol, and records usage per person", async () => {
    const llm = createLlmPort(config({}), pool);
    const text = await llm.assist({ action: "rewrite", content: "选中的文字", context: "周围的文字", actor: person });
    expect(text).toBe("来自兼容接口");
    const call = seen.at(-1)!;
    expect(call.path).toBe("/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer secret-key");
    expect(call.body.model).toBe("test-model");
    expect(call.body.messages[1].content).toContain("<text>\n选中的文字\n</text>");
    const { rows } = await pool.query(
      `SELECT user_id, purpose, input_tokens, output_tokens FROM pandocs.llm_usage ORDER BY id DESC LIMIT 1`
    );
    expect(rows[0]).toEqual({ user_id: "user-1", purpose: "rewrite", input_tokens: 3, output_tokens: 5 });
  });

  it("speaks the Anthropic protocol through its SDK", async () => {
    const llm = createLlmPort(config({ protocol: "anthropic", baseUrl }), pool);
    const text = await llm.complete({ purpose: "thread_summary", prompt: "讨论内容", actor: person });
    expect(text).toBe("来自 Claude");
    const call = seen.at(-1)!;
    expect(call.path).toBe("/v1/messages");
    // The SDK sends the key as a Bearer token since 1.0; the API takes either form.
    expect(call.headers.authorization).toBe("Bearer secret-key");
    expect(call.headers["anthropic-version"]).toBeTruthy();
    expect(call.body.system).toContain("Summarize this discussion");
    expect(call.body.max_tokens).toBeGreaterThan(0);
  });

  it("sends a gateway's own headers, over either protocol, and lets them stand in for the key's", async () => {
    const headers = { "x-portkey-provider": "anthropic", Authorization: "Bearer gateway-key" };
    await createLlmPort(config({ headers }), pool).assist({
      action: "rewrite",
      content: "文字",
      context: "",
      actor: person
    });
    let call = seen.at(-1)!;
    expect(call.headers["x-portkey-provider"]).toBe("anthropic");
    expect(call.headers.authorization).toBe("Bearer gateway-key");
    expect(call.headers["content-type"]).toBe("application/json");

    await createLlmPort(
      config({ protocol: "anthropic", baseUrl, headers: { "x-gateway-route": "docs" } }),
      pool
    ).complete({ purpose: "thread_summary", prompt: "讨论内容", actor: person });
    call = seen.at(-1)!;
    expect(call.headers["x-gateway-route"]).toBe("docs");
    expect(call.headers.authorization).toBe("Bearer secret-key");
  });

  it("reads the headers to send as a JSON object, and refuses anything else", () => {
    const env = {
      DATABASE_URL: "postgres://x",
      PANDOCS_URL: "http://x.test",
      PANDOCS_LLM_API_KEY: "key",
      PANDOCS_LLM_MODEL: "model"
    };
    expect(readConfig(env).llm?.headers).toEqual({});
    expect(
      readConfig({ ...env, PANDOCS_LLM_HEADERS: '{"x-portkey-config":"{\\"retry\\":{\\"attempts\\":3}}"}' }).llm
        ?.headers
    ).toEqual({ "x-portkey-config": '{"retry":{"attempts":3}}' });
    for (const wrong of [
      "x-route: docs",
      "[]",
      '{"x-route":3}',
      '{"bad name":"x"}',
      '{"x-route":"a\\r\\nInjected: yes"}'
    ]) {
      expect(() => readConfig({ ...env, PANDOCS_LLM_HEADERS: wrong }), wrong).toThrow(
        "PANDOCS_LLM_HEADERS must be a JSON object"
      );
    }
  });

  it("says so when the model declines", async () => {
    const llm = createLlmPort(config({ protocol: "anthropic", baseUrl }), pool);
    await expect(llm.complete({ purpose: "thread_summary", prompt: "REFUSE", actor: person })).rejects.toMatchObject({
      code: "LLM_REFUSED"
    });
  });

  it("does not pass the upstream's error text on", async () => {
    status = 500;
    try {
      const llm = createLlmPort(config({}), pool);
      await expect(llm.complete({ purpose: "thread_summary", prompt: "x", actor: person })).rejects.toMatchObject({
        code: "LLM_FAILED",
        message: "The model is temporarily unavailable"
      });
    } finally {
      status = 200;
    }
  });

  it("keeps a person to the hourly limit, across replicas", async () => {
    await pool.query(`DELETE FROM pandocs.llm_usage`);
    const limited = config({ hourlyLimit: 2 });
    const [first, second] = [createLlmPort(limited, pool), createLlmPort(limited, pool)];
    await first.complete({ purpose: "thread_summary", prompt: "一", actor: person });
    await second.complete({ purpose: "thread_summary", prompt: "二", actor: person });
    await expect(first.complete({ purpose: "thread_summary", prompt: "三", actor: person })).rejects.toMatchObject({
      code: "LLM_HOURLY_LIMIT"
    });
    await expect(
      second.complete({ purpose: "thread_summary", prompt: "三", actor: { ...person, id: "user-2" } })
    ).resolves.toBeTruthy();
  });

  it("leaves agents to bring their own models", async () => {
    const llm = createLlmPort(config({}), pool);
    const agent: Principal = { ...person, id: "agent:1", kind: "agent", onBehalfOf: { id: "user-1", groups: [] } };
    await expect(llm.complete({ purpose: "thread_summary", prompt: "x", actor: agent })).rejects.toMatchObject({
      code: "LLM_USER_REQUIRED"
    });
  });

  describe("a conversation", () => {
    const signal = new AbortController().signal;
    const start = {
      purpose: "ask" as const,
      actor: person,
      system: "Answer from the tools.",
      history: [{ role: "user" as const, text: "How long?" }],
      tools: [
        {
          name: "search_pages",
          description: "Search.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
      ],
      signal
    };
    const sse = (events: readonly object[]) =>
      events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const usage = { input_tokens: 10, output_tokens: 2 };
    const message = {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "m",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage
    };
    const anthropicAnswer = (text: string) => ({
      type: "text/event-stream",
      body: sse([
        { type: "message_start", message },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        ...text.split(" ").map((word, at) => ({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: `${at ? " " : ""}${word}` }
        })),
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: "message_stop" }
      ])
    });
    const anthropicToolCall = {
      type: "text/event-stream",
      body: sse([
        { type: "message_start", message },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should search." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "search_pages", input: {} }
        },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"seven"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: "message_stop" }
      ])
    };
    const openAiStream = (chunks: readonly object[]) => ({
      type: "text/event-stream",
      body: `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
    });

    afterAll(() => {
      streamed = null;
    });

    it("streams text and tool calls over the Anthropic protocol, sending back everything the next turn needs", async () => {
      await pool.query(`DELETE FROM pandocs.llm_usage`);
      streamed = [anthropicToolCall, anthropicAnswer("Within seven days.")];
      const conversation = await createLlmPort(config({ protocol: "anthropic", baseUrl }), pool).conversation!(start);
      const first = await conversation.turn({ allowTools: true, onText: () => undefined });
      expect(first.calls).toEqual([{ id: "toolu_1", name: "search_pages", input: { query: "seven" } }]);
      const request = seen.at(-1)!;
      expect(request.path).toBe("/v1/messages");
      expect(request.body.stream).toBe(true);
      expect(request.body.system).toBe("Answer from the tools.");
      expect(request.body.tools[0]).toMatchObject({ name: "search_pages", input_schema: { required: ["query"] } });
      expect(request.body.tool_choice).toEqual({ type: "auto" });

      conversation.answerCalls([{ id: "toolu_1", content: "Nothing found.", failed: true }]);
      const pieces: string[] = [];
      const second = await conversation.turn({ allowTools: false, onText: delta => pieces.push(delta) });
      expect(second).toMatchObject({ text: "Within seven days.", calls: [] });
      expect(pieces.join("")).toBe("Within seven days.");
      const next = seen.at(-1)!.body;
      expect(next.tool_choice).toEqual({ type: "none" });
      // Thinking goes back unchanged, or the model cannot carry on from it.
      expect(next.messages[1].content[0]).toMatchObject({
        type: "thinking",
        thinking: "I should search.",
        signature: "sig-1"
      });
      expect(next.messages[1].content[1]).toMatchObject({ type: "tool_use", id: "toolu_1" });
      expect(next.messages[2].content).toEqual([
        { type: "tool_result", tool_use_id: "toolu_1", content: "Nothing found.", is_error: true }
      ]);

      await conversation.finish();
      const { rows } = await pool.query(`SELECT user_id, purpose, input_tokens, output_tokens FROM pandocs.llm_usage`);
      // One use, whatever it took.
      expect(rows).toEqual([{ user_id: "user-1", purpose: "ask", input_tokens: 20, output_tokens: 7 }]);
    });

    it("does not act on a tool call cut off by the length limit", async () => {
      streamed = [
        {
          type: "text/event-stream",
          body: sse([
            { type: "message_start", message },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "toolu_2", name: "search_pages", input: {} }
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"query":"se' }
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "max_tokens", stop_sequence: null },
              usage: { output_tokens: 4 }
            },
            { type: "message_stop" }
          ])
        }
      ];
      const conversation = await createLlmPort(config({ protocol: "anthropic", baseUrl }), pool).conversation!(start);
      expect((await conversation.turn({ allowTools: true, onText: () => undefined })).calls).toEqual([]);
    });

    it("says so when the model declines, over the Anthropic protocol", async () => {
      streamed = [
        {
          type: "text/event-stream",
          body: sse([
            { type: "message_start", message },
            {
              type: "message_delta",
              delta: { stop_reason: "refusal", stop_sequence: null },
              usage: { output_tokens: 0 }
            },
            { type: "message_stop" }
          ])
        }
      ];
      const conversation = await createLlmPort(config({ protocol: "anthropic", baseUrl }), pool).conversation!(start);
      await expect(conversation.turn({ allowTools: true, onText: () => undefined })).rejects.toMatchObject({
        code: "LLM_REFUSED"
      });
    });

    it("streams text and tool calls over the OpenAI-compatible protocol, however they are split", async () => {
      streamed = [
        openAiStream([
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search_", arguments: "" } }] } }
            ]
          },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "pages", arguments: '{"query":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"seven"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
        ]),
        openAiStream([
          { choices: [{ delta: { content: "Within " } }] },
          {
            choices: [{ delta: { content: "seven days." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 3 }
          }
        ])
      ];
      const conversation = await createLlmPort(config({}), pool).conversation!(start);
      const first = await conversation.turn({ allowTools: true, onText: () => undefined });
      expect(first.calls).toEqual([{ id: "call_1", name: "search_pages", input: { query: "seven" } }]);
      const request = seen.at(-1)!;
      expect(request.path).toBe("/v1/chat/completions");
      expect(request.body).toMatchObject({
        stream: true,
        tool_choice: "auto",
        messages: [
          { role: "system", content: "Answer from the tools." },
          { role: "user", content: "How long?" }
        ]
      });
      expect(request.body.tools[0]).toMatchObject({ type: "function", function: { name: "search_pages" } });
      conversation.answerCalls([{ id: "call_1", content: "Seven days." }]);
      const pieces: string[] = [];
      expect(await conversation.turn({ allowTools: false, onText: delta => pieces.push(delta) })).toMatchObject({
        text: "Within seven days.",
        calls: []
      });
      expect(pieces).toEqual(["Within ", "seven days."]);
      const next = seen.at(-1)!.body;
      expect(next.tool_choice).toBe("none");
      expect(next.messages[2].tool_calls).toEqual([
        { id: "call_1", type: "function", function: { name: "search_pages", arguments: '{"query":"seven"}' } }
      ]);
      expect(next.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Seven days." });
    });

    it("hands the tools arguments it could not read as just that", async () => {
      streamed = [
        openAiStream([
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "call_2", function: { name: "search_pages", arguments: "{not json" } }]
                },
                finish_reason: "tool_calls"
              }
            ]
          }
        ])
      ];
      const conversation = await createLlmPort(config({}), pool).conversation!(start);
      expect((await conversation.turn({ allowTools: true, onText: () => undefined })).calls).toEqual([
        { id: "call_2", name: "search_pages", input: undefined }
      ]);
    });

    it("works with a service that answers all at once, whatever was asked for", async () => {
      streamed = [
        {
          type: "application/json",
          body: JSON.stringify({
            choices: [
              {
                message: {
                  content: "All at once.",
                  tool_calls: [{ id: "call_3", function: { name: "search_pages", arguments: '{"query":"x"}' } }]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        }
      ];
      const pieces: string[] = [];
      const conversation = await createLlmPort(config({}), pool).conversation!(start);
      const turn = await conversation.turn({ allowTools: true, onText: delta => pieces.push(delta) });
      expect(pieces).toEqual(["All at once."]);
      expect(turn.calls).toEqual([{ id: "call_3", name: "search_pages", input: { query: "x" } }]);
    });

    it("does not pass the upstream's error text on, in either protocol", async () => {
      status = 500;
      streamed = [
        { type: "application/json", body: "{}" },
        { type: "application/json", body: "{}" },
        { type: "application/json", body: "{}" },
        { type: "application/json", body: "{}" }
      ];
      try {
        const compatible = await createLlmPort(config({}), pool).conversation!(start);
        await expect(compatible.turn({ allowTools: true, onText: () => undefined })).rejects.toMatchObject({
          code: "LLM_FAILED",
          message: "The model is temporarily unavailable"
        });
      } finally {
        status = 200;
      }
    });

    it("keeps to the hourly limit before anything starts, with one limit for everyone with no login", async () => {
      await pool.query(`DELETE FROM pandocs.llm_usage`);
      const limited = createLlmPort(config({ hourlyLimit: 1, visitorHourlyLimit: 2 }), pool);
      await (await limited.conversation!(start)).finish();
      await expect(limited.conversation!(start)).rejects.toMatchObject({ code: "LLM_HOURLY_LIMIT" });
      const visitor = { ...start, actor: { ...person, id: "anonymous", anonymous: true } };
      await (await limited.conversation!(visitor)).finish();
      await (await limited.conversation!(visitor)).finish();
      await expect(limited.conversation!(visitor)).rejects.toMatchObject({ code: "LLM_HOURLY_LIMIT" });
      const agent: Principal = { ...person, id: "agent:1", kind: "agent", onBehalfOf: { id: "user-1", groups: [] } };
      await expect(limited.conversation!({ ...start, actor: agent })).rejects.toMatchObject({
        code: "LLM_USER_REQUIRED"
      });
    });
  });
});
