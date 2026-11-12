import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createS3AssetStore } from "@pandocs/core/s3-asset-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CREDENTIALS = { AWS_ACCESS_KEY_ID: "test-key", AWS_SECRET_ACCESS_KEY: "test-secret" };

describe("storing files through the S3 API", () => {
  describe("what it asks of the service", () => {
    const requests: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];
    let endpoint = "";
    const objects = new Map<string, Buffer>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk as Buffer));
      request.on("end", () => {
        requests.push({ method: request.method!, url: request.url!, headers: request.headers });
        const key = request.url!.split("?")[0]!;
        if (request.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200, { etag: '"x"' }).end();
          return;
        }
        const object = objects.get(key);
        if (!object) {
          response.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
          return;
        }
        response.writeHead(200, { "content-type": "image/png", "content-length": object.length }).end(object);
      });
    });
    const saved = { ...process.env };

    beforeAll(async () => {
      Object.assign(process.env, CREDENTIALS);
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      process.env = saved;
      await new Promise(done => server.close(done));
    });

    it("sends no checksums, which some S3-compatible services refuse", async () => {
      const store = createS3AssetStore({
        bucket: "files",
        region: "us-east-1",
        prefix: "pandocs/",
        endpoint,
        forcePathStyle: true
      });
      await store.put("spaces/a/b", new Uint8Array([1, 2, 3]), "image/png");
      const put = requests.at(-1)!;
      expect(put.method).toBe("PUT");
      expect(put.url.split("?")[0]).toBe("/files/pandocs/spaces/a/b");
      const sent = Object.keys(put.headers);
      expect(
        sent.filter(
          name =>
            name.startsWith("x-amz-checksum") || name === "x-amz-sdk-checksum-algorithm" || name === "x-amz-trailer"
        )
      ).toEqual([]);
      expect(put.headers["content-encoding"]).toBeUndefined();

      const read = await store.get("spaces/a/b");
      expect(read?.bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(requests.at(-1)!.headers["x-amz-checksum-mode"]).toBeUndefined();
      store.destroy();
    });

    it("answers nothing for what is not there", async () => {
      const store = createS3AssetStore({
        bucket: "files",
        region: "us-east-1",
        prefix: "pandocs",
        endpoint,
        forcePathStyle: true
      });
      expect(await store.get("spaces/a/missing")).toBeNull();
      store.destroy();
    });

    it("keeps one prefix however it was written", async () => {
      const store = createS3AssetStore({
        bucket: "files",
        region: "us-east-1",
        prefix: "pandocs///",
        endpoint,
        forcePathStyle: true
      });
      await store.put("k", new Uint8Array([1]), "image/png");
      expect(requests.at(-1)!.url.split("?")[0]).toBe("/files/pandocs/k");
      store.destroy();
    });
  });

  // A real service, when given one: PANDOCS_TEST_S3_ENDPOINT, with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.
  describe.skipIf(!process.env.PANDOCS_TEST_S3_ENDPOINT)("against a real service", () => {
    const endpoint = process.env.PANDOCS_TEST_S3_ENDPOINT!;
    const bucket = `pandocs-test-${Date.now()}`;
    const options = {
      bucket,
      region: process.env.PANDOCS_TEST_S3_REGION ?? "us-east-1",
      prefix: "pandocs/",
      endpoint,
      forcePathStyle: true
    };

    beforeAll(async () => {
      const client = new S3Client({ region: options.region, endpoint, forcePathStyle: true });
      // It may have only just started.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
          break;
        } catch (error) {
          if (attempt >= 30) throw error;
          await new Promise(done => setTimeout(done, 1000));
        }
      }
      client.destroy();
    }, 60_000);

    it("keeps what it was given, whole", async () => {
      const store = createS3AssetStore(options);
      const bytes = new Uint8Array(5 * 1024 * 1024);
      for (let at = 0; at < bytes.length; at += 4096) bytes[at] = at % 251;
      await store.put("spaces/one/large", bytes, "application/pdf");
      const read = await store.get("spaces/one/large");
      expect(read?.contentType).toBe("application/pdf");
      expect(Buffer.compare(read!.bytes, bytes)).toBe(0);
      expect(await store.get("spaces/one/missing")).toBeNull();
      store.destroy();
    }, 60_000);
  });
});
