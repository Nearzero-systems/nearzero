export const authMutedText = "text-[#a3a3a3]";
export const authControlClass =
	"w-full rounded-md border border-[#e5e7eb] bg-[#f7f7f8] px-3 py-1 text-sm text-[#111827] placeholder:text-[#9aa3b2] outline-none transition-colors focus:border-[#d1d5db]";
export const authBtnClass =
	"inline-flex w-full items-center justify-center gap-2 rounded-md border border-[#e5e7eb] bg-[#f7f7f8] px-2 py-1 text-xs font-normal text-[#111827] transition-colors duration-200 hover:bg-white disabled:cursor-not-allowed disabled:opacity-70";
export const authResendBtnClass =
	"inline-flex w-auto min-w-fit items-center justify-center gap-2 rounded-md border border-[#e5e7eb] bg-white px-2 py-1 text-xs font-normal text-[#6b7280] transition-colors duration-200 hover:bg-[#f7f7f8] hover:text-[#111827] disabled:cursor-not-allowed disabled:opacity-70";

export const authBtnSpinnerClass = "h-3.5 w-3.5 shrink-0 animate-spin";

export function authErrorMessage(data: unknown, fallback: string) {
	if (typeof data === "object" && data) {
		const o = data as Record<string, unknown>;
		if (typeof o.message === "string" && o.message) return o.message;
		const err = o.error;
		if (typeof err === "object" && err && typeof (err as { message?: string }).message === "string") {
			return (err as { message: string }).message;
		}
	}
	return fallback;
}
