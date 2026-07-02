interface Env {
	INSTALL_BUCKET: R2Bucket;
}

const allowedInstallPath = /^\/(?:install\.sh|releases\/[^/]+\/install\.sh)$/;

function objectKeyFromPath(pathname: string) {
	return pathname.replace(/^\/+/, "");
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);

		if (!allowedInstallPath.test(url.pathname)) {
			return new Response("Not found\n", { status: 404 });
		}

		const object = await env.INSTALL_BUCKET.get(objectKeyFromPath(url.pathname));
		if (!object) {
			return new Response("Installer not found\n", { status: 404 });
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set("etag", object.httpEtag);
		headers.set("content-type", headers.get("content-type") ?? "text/x-shellscript; charset=utf-8");
		headers.set("x-content-type-options", "nosniff");

		return new Response(object.body, {
			headers,
			status: 200,
		});
	},
};
