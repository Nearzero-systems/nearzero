import { BACKEND_URL } from "@/lib/branding";
import {
	isPublicInstallSetupStatus,
	type PublicInstallSetupStatus,
} from "@/lib/install-setup";

export async function fetchInstallSetupStatusServer(
	request?: Request,
): Promise<PublicInstallSetupStatus | null> {
	try {
		const backend = BACKEND_URL.replace(/\/$/, "");
		const response = await fetch(`${backend}/api/install/setup-status`, {
			method: "GET",
			headers: {
				accept: "application/json",
				...(request?.headers.get("cookie")
					? { cookie: request.headers.get("cookie")! }
					: {}),
			},
			cache: "no-store",
		});
		if (!response.ok) return null;
		const value = (await response.json().catch(() => null)) as unknown;
		return isPublicInstallSetupStatus(value) ? value : null;
	} catch {
		return null;
	}
}
