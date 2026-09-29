import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";

/**
 * TEST-ONLY SMTP sink. Accepts mail from the application's real SMTP adapter (nodemailer)
 * during E2E tests and exposes received messages over HTTP (GET /messages) so Playwright
 * workers can read verification and reset links. Never used by production code.
 */

export interface SinkMessage {
  readonly to: string[];
  readonly raw: string;
}

export interface SmtpSink {
  readonly messages: SinkMessage[];
  close(): Promise<void>;
}

function handleConnection(socket: Socket, messages: SinkMessage[]) {
  let buffer = "";
  let inData = false;
  let data = "";
  let recipients: string[] = [];
  socket.write("220 isela-test-sink ESMTP\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        data += buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        messages.push({ to: recipients, raw: data });
        inData = false;
        data = "";
        recipients = [];
        socket.write("250 OK queued\r\n");
        continue;
      }
      const lineEnd = buffer.indexOf("\r\n");
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      const command = line.slice(0, 4).toUpperCase();
      if (command === "EHLO") socket.write("250-isela-test-sink\r\n250 8BITMIME\r\n");
      else if (command === "HELO") socket.write("250 isela-test-sink\r\n");
      else if (command === "MAIL") socket.write("250 OK\r\n");
      else if (command === "RCPT") {
        const match = /<([^>]+)>/.exec(line);
        if (match?.[1] !== undefined) recipients.push(match[1].toLowerCase());
        socket.write("250 OK\r\n");
      } else if (command === "DATA") {
        inData = true;
        socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      } else if (command === "QUIT") {
        socket.end("221 Bye\r\n");
        return;
      } else socket.write("250 OK\r\n");
    }
  });
}

export async function startSmtpSink(smtpPort: number, httpPort: number): Promise<SmtpSink> {
  const messages: SinkMessage[] = [];
  const smtp: Server = createServer((socket) => {
    handleConnection(socket, messages);
  });
  const http: HttpServer = createHttpServer((request, response) => {
    if (request.url === "/messages") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(messages));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => smtp.listen(smtpPort, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => http.listen(httpPort, "127.0.0.1", resolve));
  return {
    messages,
    close: async () => {
      await new Promise<void>((resolve) =>
        smtp.close(() => {
          resolve();
        }),
      );
      await new Promise<void>((resolve) =>
        http.close(() => {
          resolve();
        }),
      );
    },
  };
}

/** Decodes quoted-printable soft line breaks and =XX escapes in a raw message. */
export function decodeQuotedPrintable(raw: string): string {
  return raw
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Latest link for a recipient whose URL contains the given fragment. */
export function findLink(
  messages: readonly SinkMessage[],
  to: string,
  fragment: string,
): string | null {
  for (const message of [...messages].reverse()) {
    if (!message.to.includes(to.toLowerCase())) continue;
    const body = decodeQuotedPrintable(message.raw);
    // Static pattern + substring filter: no input is ever compiled into a regular expression.
    const link = (body.match(/https?:\/\/[^\s"<>]+/g) ?? []).find((url) => url.includes(fragment));
    if (link !== undefined) return link;
  }
  return null;
}
