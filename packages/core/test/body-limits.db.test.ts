import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();

/** A body that names no length, as a chunked upload does not: the cap has to bite on the bytes as they arrive. */
const endlessBytes = (chunk: number) => {
  let given = 0;
  return {
    pulled: () => given,
    stream: () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          given += 1;
          controller.enqueue(new Uint8Array(chunk).fill(65));
        }
      })
  };
};

describe("how much of a request body is read", () => {
  let h: ReturnType<typeof createHarness>;
  let space = "";
  let made = 0;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
  });
  afterAll(() => h.close());

  beforeEach(async () => {
    made += 1;
    const response = await h.call(USERS.admin, "POST", "spaces", {
      slug: `limits-${made}`,
      name: "限长",
      defaultRole: "editor"
    });
    space = response.data.slug as string;
  });

  it("stops reading an upload that names no length at the file limit", async () => {
    const source = endlessBytes(10 * 1024 * 1024);
    const response = await h.call(USERS.admin, "POST", `spaces/${space}/assets?filename=a.bin`, source.stream());
    expect(response.status).toBe(422);
    expect(response.error.code).toBe("ASSET_TOO_LARGE");
    // Refused while it was still arriving, not after all of it had been read into memory.
    expect(source.pulled()).toBeLessThan(20);
  });

  it("stops reading a JSON body that names no length at its limit", async () => {
    const source = endlessBytes(1024 * 1024);
    const response = await h.call(USERS.editor, "POST", `spaces/${space}/documents`, source.stream());
    expect(response.status).toBe(422);
    expect(response.error.code).toBe("BODY_TOO_LARGE");
    expect(source.pulled()).toBeLessThan(20);
  });

  it("takes an upload that names its length, as a browser does", async () => {
    const response = await h.call(
      USERS.admin,
      "POST",
      `spaces/${space}/assets?filename=a.txt`,
      new Uint8Array(1024).fill(66)
    );
    expect(response.status).toBe(201);
  });

  it("answers that a body is not JSON, rather than that the server is at fault", async () => {
    const response = await h.call(
      USERS.editor,
      "POST",
      `spaces/${space}/imports`,
      new Uint8Array(Buffer.from("not json")),
      {
        "content-type": "text/markdown"
      }
    );
    expect(response.status).toBe(422);
    expect(response.error.code).toBe("BODY_INVALID");
  });
});
