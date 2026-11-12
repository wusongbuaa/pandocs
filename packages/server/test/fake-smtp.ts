import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export interface SentMail {
  readonly to: string;
  readonly subject: string;
  /** With quoted-printable undone, which is how long lines such as addresses arrive. */
  readonly body: string;
}

const decoded = (raw: string) => Buffer.from(raw.replace(/=\n/gu, "").replace(/=([0-9A-F]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1").toString("utf8");

/** Enough of SMTP for nodemailer to deliver to, so mail is tested the way it goes out. */
export async function startFakeSmtp() {
  const inbox: SentMail[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let reading = false;
    let to = "";
    let content = "";
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", chunk => {
      buffer += String(chunk);
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (reading) {
          if (line === ".") {
            reading = false;
            const message = decoded(content);
            inbox.push({ to, subject: /^Subject: (.*)$/mu.exec(message)?.[1] ?? "", body: message });
            content = "";
            socket.write("250 ok\r\n");
          } else {
            content += `${line}\n`;
          }
          continue;
        }
        const word = line.slice(0, 4).toUpperCase();
        if (word === "RCPT") to = /<(.+)>/u.exec(line)?.[1] ?? "";
        if (word === "DATA") {
          reading = true;
          socket.write("354 go ahead\r\n");
        } else if (word === "QUIT") {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return {
    inbox,
    env: { PANDOCS_SMTP_HOST: "127.0.0.1", PANDOCS_SMTP_PORT: String((server.address() as AddressInfo).port), PANDOCS_SMTP_SECURE: "false", PANDOCS_SMTP_FROM: "docs@example.test" },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(done => server.close(done));
    }
  };
}
