import type { NavContext } from "@/components/dashboard/navMenu";
import { createServerTrpcClient } from "@/lib/server-api";

export type BootstrapSettingsPageResult =
	| { ok: true }
	| { ok: false; reason: "load-failed" | "forbidden" };

export async function bootstrapSettingsDashboardPage(
	request: Request,
	options: {
		gate: (ctx: NavContext) => boolean;
		prefetch?: (api: any) => Promise<void>;
	},
): Promise<BootstrapSettingsPageResult> {
	const api = createServerTrpcClient(request) as any;
	let ctx: NavContext;
	try {
		const [member, perm, wl] = await Promise.all([
			api.user.get.query(),
			api.user.getPermissions.query(),
			api.whitelabeling.get.query().catch(() => null),
		]);
		ctx = {
			auth:
				member && typeof member === "object"
					? { role: (member as { role?: string | null }).role ?? null }
					: null,
			permissions: (perm ?? null) as NavContext["permissions"],
			whitelabeling:
				wl && typeof wl === "object"
					? {
							docsUrl: (wl as { docsUrl?: string | null }).docsUrl ?? null,
							supportUrl: (wl as { supportUrl?: string | null }).supportUrl ?? null,
						}
					:	null,
		};
	} catch {
		return { ok: false, reason: "load-failed" };
	}

	if (!options.gate(ctx)) return { ok: false, reason: "forbidden" };

	if (options.prefetch) {
		try {
			await options.prefetch(api);
		} catch {
			/* panel refetches client-side */
		}
	}

	return { ok: true };
}
