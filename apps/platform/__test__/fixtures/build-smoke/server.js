import http from "node:http";

const port = Number(process.env.PORT ?? 3000);

http
	.createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ status: "ok", builder: "nearzero" }));
	})
	.listen(port, "0.0.0.0");
