import type { ApiRequest, ApiResponse } from "@/server/types/api";

export default async function handler(
	_req: ApiRequest,
	res: ApiResponse,
) {
	return res.status(200).json({ ok: true });
}
