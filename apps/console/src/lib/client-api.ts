import superjson from "superjson";

type TrpcBatchItem = {
	result?: { data: unknown };
	error?: unknown;
};

function serializeBatchInputsDict(inputs: unknown[]): string {
	const d: Record<number, unknown> = {};
	for (let i = 0; i < inputs.length; i++) {
		d[i] = superjson.serialize(inputs[i]);
	}
	return JSON.stringify(d);
}

function trpcErrorMessage(raw: unknown): string {
	if (raw && typeof raw === "object") {
		const o = raw as Record<string, unknown>;
		if (typeof o.message === "string") return o.message;
		if (o.json && typeof o.json === "object") {
			const json = o.json as Record<string, unknown>;
			if (typeof json.message === "string") return json.message;
		}
		try {
			const d = superjson.deserialize(
				raw as Parameters<typeof superjson.deserialize>[0],
			) as { message?: string };
			if (d && typeof d.message === "string") return d.message;
		} catch {
			// fall through
		}
	}
	return "tRPC error";
}

function parseTrpcResultData<T>(data: unknown): T {
	if (data && typeof data === "object") {
		const wrapped = data as { json?: unknown; meta?: unknown };
		if ("json" in wrapped) {
			if (
				wrapped.meta &&
				typeof wrapped.meta === "object" &&
				Object.keys(wrapped.meta as object).length > 0
			) {
				return superjson.deserialize(
					wrapped as Parameters<typeof superjson.deserialize>[0],
				) as T;
			}
			return wrapped.json as T;
		}
	}
	return superjson.deserialize(
		data as Parameters<typeof superjson.deserialize>[0],
	) as T;
}

function parseTrpcBatchFirst<T>(text: string): T {
	const raw = JSON.parse(text) as TrpcBatchItem | TrpcBatchItem[];
	const first = Array.isArray(raw) ? raw[0] : raw;
	if (!first) throw new Error("Empty tRPC batch response");
	if (first.error) {
		throw new Error(trpcErrorMessage(first.error));
	}
	if (!first.result?.data) throw new Error("No result in tRPC response");
	return parseTrpcResultData<T>(first.result.data);
}

export async function trpcQuery<T>(
	procedure: string,
	input?: unknown,
): Promise<T> {
	const inputStr = serializeBatchInputsDict([input]);
	const url = `/api/trpc/${procedure}?batch=1&input=${encodeURIComponent(inputStr)}`;
	const res = await fetch(url, {
		method: "GET",
		headers: { accept: "application/json" },
		credentials: "include",
	});
	const text = await res.text();
	if (!text.trim()) {
		throw new Error(`tRPC query failed: ${procedure}`);
	}
	try {
		return parseTrpcBatchFirst<T>(text);
	} catch (err) {
		if (!res.ok) {
			throw new Error(
				err instanceof Error && err.message !== "tRPC error"
					? err.message
					: `tRPC query failed: ${procedure}`,
			);
		}
		throw err;
	}
}

export async function trpcMutate<T>(
	procedure: string,
	input?: unknown,
): Promise<T> {
	const res = await fetch(`/api/trpc/${procedure}?batch=1`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
		},
		credentials: "include",
		body: serializeBatchInputsDict([input]),
	});
	const text = await res.text();
	if (!text.trim()) {
		throw new Error(`tRPC mutation failed: ${procedure}`);
	}
	try {
		return parseTrpcBatchFirst<T>(text);
	} catch (err) {
		if (!res.ok) {
			// Proxy/upstream failures return a structured JSON error body rather
			// than a tRPC envelope. Surface a readable message instead of the raw
			// payload (or an opaque "Failed to fetch").
			const proxyMessage = proxyErrorMessage(text);
			if (proxyMessage) {
				throw new Error(proxyMessage);
			}
			throw new Error(
				err instanceof Error && err.message !== "tRPC error"
					? err.message
					: text || `tRPC mutation failed: ${procedure}`,
			);
		}
		throw err;
	}
}

function proxyErrorMessage(text: string): string | null {
	try {
		const parsed = JSON.parse(text) as { error?: string; detail?: string };
		if (parsed && (parsed.detail || parsed.error)) {
			return parsed.detail
				? `${parsed.error ?? "Request failed"}: ${parsed.detail}`
				: (parsed.error as string);
		}
	} catch {
		// Not JSON — caller falls back to generic handling.
	}
	return null;
}

function parseTrpcSingle<T>(text: string): T {
	const body = JSON.parse(text) as {
		result?: { data: unknown };
		error?: unknown;
	};
	if (body.error) {
		throw new Error(trpcErrorMessage(body.error));
	}
	if (!body.result?.data) throw new Error("No result in tRPC response");
	return parseTrpcResultData<T>(body.result.data);
}

export async function trpcFormMutate<T>(
	procedure: string,
	formData: FormData,
): Promise<T> {
	const res = await fetch(`/api/trpc/${procedure}`, {
		method: "POST",
		credentials: "include",
		body: formData,
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(text || `tRPC form mutation failed: ${procedure}`);
	}
	return parseTrpcSingle<T>(text);
}

/** @deprecated Use trpcMutate */
export const trpcMutation = trpcMutate;
