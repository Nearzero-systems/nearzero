/**
 * Owner account management for self-hosted installs. The `nearzero` helper on
 * the host runs this inside the platform container:
 *
 *   node dist/owner.mjs status           prints the owner email; exit 3 if none
 *   node dist/owner.mjs create           stdin: email, then password, one per line
 *   node dist/owner.mjs reset-password   stdin: email, then password, one per line
 *
 * Credentials come over stdin so they never appear in process arguments or the
 * container environment.
 */
import {
	createInstanceOwner,
	findInstanceOwner,
	InstanceOwnerError,
	resetAccountPassword,
} from "@nearzero/server/services/instance-owner";

const EXIT_INVALID_INPUT = 2;
const EXIT_NO_OWNER = 3;
const EXIT_OWNER_EXISTS = 3;
const EXIT_NOT_FOUND = 4;

async function readCredentials() {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
		if (Buffer.concat(chunks).length > 4096) break;
	}
	const [email = "", password = ""] = Buffer.concat(chunks)
		.toString("utf8")
		.split("\n");
	return { email: email.trim(), password: password.replace(/\r$/, "") };
}

async function run(command: string | undefined) {
	switch (command) {
		case "status": {
			const owner = await findInstanceOwner();
			if (!owner) return EXIT_NO_OWNER;
			console.log(owner.email);
			return 0;
		}
		case "create": {
			const owner = await createInstanceOwner(await readCredentials());
			console.log(owner.email);
			return 0;
		}
		case "reset-password": {
			const account = await resetAccountPassword(await readCredentials());
			console.log(account.email);
			return 0;
		}
		default:
			console.error("usage: owner.mjs {status|create|reset-password}");
			return EXIT_INVALID_INPUT;
	}
}

try {
	process.exit(await run(process.argv[2]));
} catch (error) {
	if (error instanceof InstanceOwnerError) {
		console.error(error.message);
		process.exit(
			error.code === "OWNER_EXISTS"
				? EXIT_OWNER_EXISTS
				: error.code === "NOT_FOUND"
					? EXIT_NOT_FOUND
					: EXIT_INVALID_INPUT,
		);
	}
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
