import { BACKEND_URL } from "@/lib/branding";
import {
	isPublicRegistrationStatus,
	type PublicRegistrationStatus,
} from "@/lib/registration-status";

export async function fetchRegistrationStatusServer(): Promise<PublicRegistrationStatus | null> {
	try {
		const backend = BACKEND_URL.replace(/\/$/, "");
		const response = await fetch(`${backend}/api/auth/registration-status`, {
			method: "GET",
			headers: { accept: "application/json" },
			cache: "no-store",
		});
		if (!response.ok) return null;
		const value = (await response.json().catch(() => null)) as unknown;
		return isPublicRegistrationStatus(value) ? value : null;
	} catch {
		return null;
	}
}
