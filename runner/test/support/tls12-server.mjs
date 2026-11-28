// A TLS server limited to TLS 1.2, for link-tls.test.ts (C4-15): Bun's own TLS server can't be
// limited to 1.2, so this runs under Node. It holds the certificate the runner pins, prints its
// port, reports every application byte it reads, and asks to renegotiate when it reads any.
//
//   node tls12-server.mjs <certificate.pem> <key.pem>
import { readFileSync } from "node:fs";
import tls from "node:tls";

const [certificate, key] = process.argv.slice(2);
const server = tls.createServer(
  {
    cert: readFileSync(certificate),
    key: readFileSync(key),
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  },
  (socket) => {
    console.log(`handshake ${socket.getProtocol()}`);
    socket.on("error", () => {});
    socket.on("data", (data) => {
      console.log(`read ${data.length}`);
      socket.renegotiate({}, (error) => console.log(`renegotiated ${error ? "no" : "yes"}`));
    });
  },
);
server.on("tlsClientError", () => {});
server.listen(0, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
