// Run from packages/core, where the SDK is installed.
import { createRequire } from "node:module";

const { CreateBucketCommand, S3Client } = createRequire(`${process.cwd()}/package.json`)("@aws-sdk/client-s3");
const client = new S3Client({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:19000",
  forcePathStyle: true,
  credentials: { accessKeyId: "testkey12345", secretAccessKey: "testsecret1234567890" }
});
for (let attempt = 0; ; attempt += 1) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: "pandocs" }));
    break;
  } catch (error) {
    if (attempt > 60) throw error;
    await new Promise(done => setTimeout(done, 1000));
  }
}
client.destroy();
