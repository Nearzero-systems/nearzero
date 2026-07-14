import {
	checkDnsHealth,
	createDnsZone,
	deleteDnsRecord,
	deleteDnsZone,
	findDnsZoneById,
	getDnsZoneInstructions,
	listDnsRecords,
	listDnsZones,
	publishAllDnsZones,
	publishDnsZone,
	upsertDnsRecord,
} from "@nearzero/server/services/dns";
import { getManagedDnsReadiness } from "@nearzero/server/services/managed-domain-provision";
import { apiCreateDnsZone, apiUpsertDnsRecord } from "@nearzero/server/db/schema";
import { z } from "zod";
import { audit } from "../utils/audit";
import { createTRPCRouter, withPermission } from "../trpc";

const orgId = (ctx: { session: { activeOrganizationId: string } }) =>
	ctx.session.activeOrganizationId;

export const dnsRouter = createTRPCRouter({
	zones: createTRPCRouter({
		list: withPermission("dns", "read").query(async ({ ctx }) =>
			listDnsZones(orgId(ctx)),
		),

		one: withPermission("dns", "read")
			.input(z.object({ dnsZoneId: z.string().min(1) }))
			.query(async ({ ctx, input }) =>
				findDnsZoneById(input.dnsZoneId, orgId(ctx)),
			),

		create: withPermission("dns", "create")
			.input(apiCreateDnsZone)
			.mutation(async ({ ctx, input }) => {
				const zone = await createDnsZone(orgId(ctx), input);
				await audit(ctx, {
					action: "create",
					resourceType: "domain",
					resourceId: zone.dnsZoneId,
					resourceName: zone.name,
					metadata: { dnsZone: true },
				});
				return zone;
			}),

		delete: withPermission("dns", "delete")
			.input(z.object({ dnsZoneId: z.string().min(1) }))
			.mutation(async ({ ctx, input }) => {
				const zone = await deleteDnsZone(input.dnsZoneId, orgId(ctx));
				await audit(ctx, {
					action: "delete",
					resourceType: "domain",
					resourceId: zone.dnsZoneId,
					resourceName: zone.name,
					metadata: { dnsZone: true },
				});
				return zone;
			}),

		publish: withPermission("dns", "update")
			.input(z.object({ dnsZoneId: z.string().min(1) }))
			.mutation(async ({ ctx, input }) => {
				const zone = await publishDnsZone(input.dnsZoneId, orgId(ctx));
				await audit(ctx, {
					action: "update",
					resourceType: "domain",
					resourceId: zone.dnsZoneId,
					resourceName: zone.name,
					metadata: { dnsPublish: true },
				});
				return zone;
			}),

		publishAll: withPermission("dns", "update")
			.mutation(async ({ ctx }) => {
				const count = await publishAllDnsZones(orgId(ctx));
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "dns-publish-all",
					metadata: { count },
				});
				return { count };
			}),

		instructions: withPermission("dns", "read")
			.input(z.object({ dnsZoneId: z.string().min(1) }))
			.query(async ({ ctx, input }) => {
				const zone = await findDnsZoneById(input.dnsZoneId, orgId(ctx));
				return getDnsZoneInstructions(zone);
			}),
	}),

	records: createTRPCRouter({
		list: withPermission("dns", "read")
			.input(z.object({ dnsZoneId: z.string().min(1) }))
			.query(async ({ ctx, input }) =>
				listDnsRecords(input.dnsZoneId, orgId(ctx)),
			),

		upsert: withPermission("dns", "update")
			.input(apiUpsertDnsRecord)
			.mutation(async ({ ctx, input }) => {
				const record = await upsertDnsRecord(orgId(ctx), input);
				await audit(ctx, {
					action: "update",
					resourceType: "domain",
					resourceId: record.dnsRecordId,
					resourceName: `${record.name}.${input.dnsZoneId}`,
					metadata: { dnsRecord: true },
				});
				return record;
			}),

		delete: withPermission("dns", "delete")
			.input(z.object({ dnsRecordId: z.string().min(1) }))
			.mutation(async ({ ctx, input }) => {
				const record = await deleteDnsRecord(input.dnsRecordId, orgId(ctx));
				await audit(ctx, {
					action: "delete",
					resourceType: "domain",
					resourceId: record.dnsRecordId,
					resourceName: record.name,
					metadata: { dnsRecord: true },
				});
				return record;
			}),
	}),

	health: withPermission("dns", "read").query(async ({ ctx }) =>
		checkDnsHealth(orgId(ctx)),
	),

	readiness: withPermission("dns", "read").query(async ({ ctx }) =>
		getManagedDnsReadiness(orgId(ctx)),
	),
});
