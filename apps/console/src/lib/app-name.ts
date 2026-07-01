export const APP_NAME_REGEX = /^[a-z](?!.*--)([a-z0-9-]*[a-z0-9])?$/;
export const APP_NAME_MESSAGE =
	"App name supports lowercase letters, numbers, '-' and must start with a letter, end with a letter or number, and cannot contain consecutive '-'";

export function isValidAppName(value: string): boolean {
	return APP_NAME_REGEX.test(value);
}
