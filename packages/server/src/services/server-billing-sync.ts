/** Cloud billing sync hook used by hosted deployments. No-op in Community mode. */
export async function updateServersBasedOnQuantity(
	_userId: string,
	_newServersQuantity: number,
) {
	return;
}
