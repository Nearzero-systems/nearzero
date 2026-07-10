export const AUTH_GRID_CLASS_NAME =
	"grid min-h-[100dvh] w-[100dvw] grid-cols-[8%_84%_8%] grid-rows-[10dvh_14dvh_8dvh_minmax(9.5rem,17dvh)_minmax(9rem,15dvh)_minmax(7rem,12dvh)_1fr] gap-[1px] bg-[#eceef3] sm:grid-cols-[12%_76%_12%] md:grid-cols-[24%_52%_24%] lg:grid-cols-[26%_48%_26%] xl:grid-cols-[37%_26%_37%] 2xl:grid-cols-[37%_26%_37%]";

export const AUTH_GRID_EXPAND_FORM_CLASS_NAME =
	"grid min-h-[100dvh] w-[100dvw] grid-cols-[8%_84%_8%] grid-rows-[10dvh_14dvh_8dvh_minmax(14rem,30dvh)_0px_minmax(7rem,12dvh)_1fr] gap-[1px] bg-[#eceef3] sm:grid-cols-[12%_76%_12%] md:grid-cols-[24%_52%_24%] lg:grid-cols-[26%_48%_26%] xl:grid-cols-[37%_26%_37%] 2xl:grid-cols-[37%_26%_37%]";

export const AUTH_TILE_BASE_CLASS = "rounded-md bg-white";

const TILE_PLACEMENT = [
	"row-start-1 col-start-1",
	"row-start-1 col-start-2",
	"row-start-1 col-start-3",
	"row-start-2 col-start-1",
	"row-start-2 col-start-2",
	"row-start-2 col-start-3",
	"row-start-3 col-start-1",
	"row-start-3 col-start-2",
	"row-start-3 col-start-3",
	"row-start-4 col-start-1",
	"row-start-4 col-start-2",
	"row-start-4 col-start-3",
	"row-start-5 col-start-1",
	"row-start-5 col-start-2",
	"row-start-5 col-start-3",
	"row-start-6 col-start-1",
	"row-start-6 col-start-2",
	"row-start-6 col-start-3",
	"row-start-7 col-start-1",
	"row-start-7 col-start-2",
	"row-start-7 col-start-3",
] as const;

export function loginTileClassName(
	index: number,
	hasContent: boolean,
	expandFormTile = false,
): string {
	const classes = [
		TILE_PLACEMENT[index] ?? "",
		hasContent ? "p-4" : "",
	];

	if (expandFormTile) {
		if (index === 10) {
			classes.push("row-span-2 min-h-0");
		}
		if (index === 12 || index === 14) {
			classes.push("min-h-0 overflow-hidden p-0");
		}
		if (index === 13) {
			classes.push("hidden");
		}
	}

	return classes.filter(Boolean).join(" ");
}
