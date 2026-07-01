import type { ApiRequest, ApiResponse } from "@/server/types/api";

export default async function handler(
	req: ApiRequest,
	res: ApiResponse,
) {
	if (req.method === "POST") {
		const xGitHubEvent = req.headers["x-github-event"];

		if (xGitHubEvent === "ping") {
			res.redirect(307, "/dashboard/settings/git-providers");
		} else {
			res.redirect(307, "/dashboard/settings/git-providers");
		}
	} else {
		res.setHeader("Allow", ["POST"]);
		res.status(405).end(`Method ${req.method} not allowed`);
	}
}
