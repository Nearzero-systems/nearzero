/** Precio legacy / Hobby: $4.50/mo primer servidor, $3.50 siguientes; anual $45.90 primero, $35.70 siguientes. */
export function calculatePrice(count: number, isAnnual = false) {
	if (isAnnual) {
		if (count <= 1) return 45.9;
		return 35.7 * count;
	}
	if (count <= 1) return 4.5;
	return count * 3.5;
}

/** Hobby: $4.50/mo per server; annual 20% off = $43.20/yr per server (4.5 * 12 * 0.8). */
export function calculatePriceHobby(count: number, isAnnual = false) {
	const perServerMonthly = 4.5;
	const perServerAnnual = 43.2;
	return isAnnual ? count * perServerAnnual : count * perServerMonthly;
}

/** Startup: 3 servers included ($15/mo); extra servers $4.50/mo each. Annual 20% off. */
export const STARTUP_SERVERS_INCLUDED = 3;

export function calculatePriceStartup(count: number, isAnnual = false) {
	const baseMonthly = 15;
	const extraMonthly = 4.5;
	const baseAnnual = 144;
	const extraAnnual = 43.2;
	if (count <= STARTUP_SERVERS_INCLUDED)
		return isAnnual ? baseAnnual : baseMonthly;
	return isAnnual
		? baseAnnual + (count - STARTUP_SERVERS_INCLUDED) * extraAnnual
		: baseMonthly + (count - STARTUP_SERVERS_INCLUDED) * extraMonthly;
}
