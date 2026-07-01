function showAvatarFallback(image: HTMLImageElement) {
	image.hidden = true;
	const fallback = image.nextElementSibling;
	if (
		fallback instanceof HTMLElement &&
		fallback.dataset.avatarFallback !== undefined
	) {
		fallback.hidden = false;
	}
}

export function bindAvatarFallbacks(root: ParentNode = document) {
	root.querySelectorAll("[data-avatar-image]").forEach((image) => {
		if (!(image instanceof HTMLImageElement)) return;
		if (image.dataset.avatarBound !== "1") {
			image.dataset.avatarBound = "1";
			image.addEventListener("error", () => showAvatarFallback(image));
		}
		if (image.complete && image.naturalWidth === 0) {
			showAvatarFallback(image);
		}
	});
}
