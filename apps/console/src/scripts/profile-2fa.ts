import copy from "copy-to-clipboard";
import QRCode from "qrcode";
import { authClient } from "@/lib/auth-client";
import { showToast } from "@/scripts/ui";

const USERNAME_PLACEHOLDER = "%username%";
const DATE_PLACEHOLDER = "%date%";
const BACKUP_CODES_PLACEHOLDER = "%backupCodes%";

const backupCodeTemplate = `Nearzero - BACKUP VERIFICATION CODES

Points to note
--------------
# Each code can be used only once.
# Do not share these codes with anyone.

Generated codes
---------------
Username: ${USERNAME_PLACEHOLDER}
Generated on: ${DATE_PLACEHOLDER}


${BACKUP_CODES_PLACEHOLDER}
`;

function formatBackupCodesText(codes: string[], email: string) {
	const backupCodesFormatted = codes
		.map((code, index) => ` ${index + 1}. ${code}`)
		.join("\n");
	const date = new Date();
	return backupCodeTemplate
		.replace(USERNAME_PLACEHOLDER, email || "unknown")
		.replace(DATE_PLACEHOLDER, date.toLocaleString())
		.replace(BACKUP_CODES_PLACEHOLDER, backupCodesFormatted);
}

function downloadBackupCodes(codes: string[], email: string) {
	if (!codes.length) {
		showToast("No backup codes to download.", "error");
		return;
	}
	const date = new Date();
	const filename = `nearzero-2fa-backup-codes-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}.txt`;
	const blob = new Blob([formatBackupCodesText(codes, email)], {
		type: "text/plain",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

function copyBackupCodes(codes: string[], email: string) {
	copy(formatBackupCodesText(codes, email));
	showToast("Backup codes copied to clipboard", "success");
}

function renderBackupCodesGrid(
	container: HTMLElement,
	codes: string[],
	email: string,
) {
	container.innerHTML = `
		<div class="w-full space-y-3 border rounded-lg p-4">
			<div class="flex items-center justify-between">
				<h4 class="font-medium">Backup Codes</h4>
				<div class="flex items-center gap-2">
					<button type="button" class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background hover:bg-accent" data-2fa-copy-codes aria-label="Copy backup codes">
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
					</button>
					<button type="button" class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background hover:bg-accent" data-2fa-dl-codes aria-label="Download backup codes">
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
					</button>
				</div>
			</div>
			<div class="grid grid-cols-2 gap-2">
				${codes.map((code) => `<code class="bg-muted p-2 rounded text-sm font-mono">${code}</code>`).join("")}
			</div>
			<p class="text-sm text-muted-foreground">
				Save these backup codes in a secure place. You can use them to access your account if you lose access to your authenticator device.
			</p>
		</div>
	`;
	container.querySelector("[data-2fa-copy-codes]")?.addEventListener("click", () =>
		copyBackupCodes(codes, email),
	);
	container.querySelector("[data-2fa-dl-codes]")?.addEventListener("click", () =>
		downloadBackupCodes(codes, email),
	);
}

export function bindProfile2FA(root: HTMLElement, userEmail: string) {
	if (root.dataset.twoFaBound === "1") return;
	root.dataset.twoFaBound = "1";

	const enableDlg = document.getElementById("nz-2fa-enable-dialog");
	const manageDlg = document.getElementById("nz-2fa-manage-dialog");
	const disableDlg = document.getElementById("nz-2fa-disable-dialog");

	if (
		!(enableDlg instanceof HTMLDialogElement) ||
		!(manageDlg instanceof HTMLDialogElement) ||
		!(disableDlg instanceof HTMLDialogElement)
	) {
		return;
	}

	// --- Enable 2FA ---
	let enableStep: "password" | "verify" = "password";
	let enableBackupCodes: string[] = [];
	let enableQrUrl = "";
	let enableSecret = "";

	const enablePasswordPanel = document.getElementById("nz-2fa-enable-password");
	const enableVerifyPanel = document.getElementById("nz-2fa-enable-verify");
	const enablePasswordForm = document.getElementById("nz-2fa-enable-password-form");
	const enableVerifyForm = document.getElementById("nz-2fa-enable-verify-form");
	const enablePasswordInput = document.getElementById("nz-2fa-enable-password-input");
	const enableIssuerInput = document.getElementById("nz-2fa-enable-issuer-input");
	const enableOtpInput = document.getElementById("nz-2fa-enable-otp");
	const enableQrImg = document.getElementById("nz-2fa-enable-qr");
	const enableSecretEl = document.getElementById("nz-2fa-enable-secret");
	const enableBackupContainer = document.getElementById("nz-2fa-enable-backup");
	const enableSubmit = document.getElementById("nz-2fa-enable-submit");

	const resetEnableDialog = () => {
		enableStep = "password";
		enableBackupCodes = [];
		enableQrUrl = "";
		enableSecret = "";
		enablePasswordPanel?.classList.remove("hidden");
		enableVerifyPanel?.classList.add("hidden");
		if (enablePasswordInput instanceof HTMLInputElement) enablePasswordInput.value = "";
		if (enableIssuerInput instanceof HTMLInputElement) enableIssuerInput.value = "";
		if (enableOtpInput instanceof HTMLInputElement) enableOtpInput.value = "";
		if (enableBackupContainer) enableBackupContainer.innerHTML = "";
	};

	document.getElementById("nz-2fa-enable-open")?.addEventListener("click", () => {
		resetEnableDialog();
		enableDlg.showModal();
	});

	enableDlg.querySelectorAll("[data-close-2fa-enable]").forEach((el) => {
		el.addEventListener("click", () => enableDlg.close());
	});

	enablePasswordForm?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!(enablePasswordInput instanceof HTMLInputElement)) return;
		if (enableSubmit instanceof HTMLButtonElement) {
			enableSubmit.disabled = true;
			enableSubmit.textContent = "Loading...";
		}
		try {
			const issuer =
				enableIssuerInput instanceof HTMLInputElement
					? enableIssuerInput.value
					: undefined;
			const { data: enableData, error } = await authClient.twoFactor.enable({
				password: enablePasswordInput.value,
				issuer: issuer || undefined,
			});
			if (!enableData) {
				throw new Error(error?.message || "Error enabling 2FA");
			}
			if (enableData.backupCodes) {
				enableBackupCodes = enableData.backupCodes;
			}
			if (!enableData.totpURI) {
				throw new Error("No TOTP URI received from server");
			}
			enableQrUrl = await QRCode.toDataURL(enableData.totpURI);
			enableSecret =
				enableData.totpURI.split("secret=")[1]?.split("&")[0] || "";
			if (enableQrImg instanceof HTMLImageElement) {
				enableQrImg.src = enableQrUrl;
				enableQrImg.classList.remove("hidden");
			}
			if (enableSecretEl) enableSecretEl.textContent = enableSecret;
			if (enableBackupContainer && enableBackupCodes.length) {
				renderBackupCodesGrid(enableBackupContainer, enableBackupCodes, userEmail);
			}
			enableStep = "verify";
			enablePasswordPanel?.classList.add("hidden");
			enableVerifyPanel?.classList.remove("hidden");
			showToast("Scan the QR code with your authenticator app", "success");
		} catch (err) {
			showToast(
				err instanceof Error ? err.message : "Error setting up 2FA",
				"error",
			);
		} finally {
			if (enableSubmit instanceof HTMLButtonElement) {
				enableSubmit.disabled = false;
				enableSubmit.textContent = "Continue";
			}
		}
	});

	enableVerifyForm?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!(enableOtpInput instanceof HTMLInputElement)) return;
		const verifyBtn = document.getElementById("nz-2fa-enable-verify-submit");
		if (verifyBtn instanceof HTMLButtonElement) {
			verifyBtn.disabled = true;
			verifyBtn.textContent = "Loading...";
		}
		try {
			const result = await authClient.twoFactor.verifyTotp({
				code: enableOtpInput.value,
			});
			if (result.error) {
				if (result.error.code === "INVALID_TWO_FACTOR_AUTHENTICATION") {
					showToast("Invalid verification code", "error");
					return;
				}
				throw result.error;
			}
			showToast("2FA configured successfully", "success");
			enableDlg.close();
			window.location.reload();
		} catch (err) {
			const msg =
				err instanceof Error && err.message === "Failed to fetch"
					? "Connection error. Please check your internet connection."
					: err instanceof Error
						? err.message
						: "Error verifying 2FA code";
			showToast(msg, "error");
		} finally {
			if (verifyBtn instanceof HTMLButtonElement) {
				verifyBtn.disabled = enableOtpInput.value.length !== 6;
				verifyBtn.textContent = "Enable 2FA";
			}
		}
	});

	enableOtpInput?.addEventListener("input", () => {
		const verifyBtn = document.getElementById("nz-2fa-enable-verify-submit");
		if (verifyBtn instanceof HTMLButtonElement && enableOtpInput instanceof HTMLInputElement) {
			verifyBtn.disabled = enableOtpInput.value.length !== 6;
		}
	});

	// --- Manage 2FA ---
	let manageStep: "password" | "actions" | "backup-codes" = "password";
	let managePassword = "";
	let manageBackupCodes: string[] = [];

	const managePasswordPanel = document.getElementById("nz-2fa-manage-password");
	const manageActionsPanel = document.getElementById("nz-2fa-manage-actions");
	const manageBackupPanel = document.getElementById("nz-2fa-manage-backup");
	const managePasswordForm = document.getElementById("nz-2fa-manage-password-form");
	const managePasswordInput = document.getElementById("nz-2fa-manage-password-input");

	const resetManageDialog = () => {
		manageStep = "password";
		managePassword = "";
		manageBackupCodes = [];
		managePasswordPanel?.classList.remove("hidden");
		manageActionsPanel?.classList.add("hidden");
		manageBackupPanel?.classList.add("hidden");
		if (managePasswordInput instanceof HTMLInputElement) managePasswordInput.value = "";
	};

	document.getElementById("nz-2fa-manage-open")?.addEventListener("click", () => {
		resetManageDialog();
		manageDlg.showModal();
	});

	manageDlg.querySelectorAll("[data-close-2fa-manage]").forEach((el) => {
		el.addEventListener("click", () => {
			if (manageStep === "backup-codes") {
				manageStep = "actions";
				manageBackupPanel?.classList.add("hidden");
				manageActionsPanel?.classList.remove("hidden");
			} else {
				manageDlg.close();
			}
		});
	});

	managePasswordForm?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!(managePasswordInput instanceof HTMLInputElement)) return;
		const btn = document.getElementById("nz-2fa-manage-password-submit");
		if (btn instanceof HTMLButtonElement) {
			btn.disabled = true;
			btn.textContent = "Loading...";
		}
		try {
			const result = await authClient.twoFactor.generateBackupCodes({
				password: managePasswordInput.value,
			});
			if (result.error) {
				showToast(result.error.message || "Incorrect password", "error");
				return;
			}
			managePassword = managePasswordInput.value;
			manageStep = "actions";
			managePasswordPanel?.classList.add("hidden");
			manageActionsPanel?.classList.remove("hidden");
		} catch {
			showToast("Incorrect password", "error");
		} finally {
			if (btn instanceof HTMLButtonElement) {
				btn.disabled = false;
				btn.textContent = "Continue";
			}
		}
	});

	document.getElementById("nz-2fa-regenerate")?.addEventListener("click", async () => {
		const btn = document.getElementById("nz-2fa-regenerate");
		if (btn instanceof HTMLButtonElement) {
			btn.disabled = true;
		}
		try {
			const result = await authClient.twoFactor.generateBackupCodes({
				password: managePassword,
			});
			if (result.error) {
				showToast(result.error.message || "Failed to regenerate", "error");
				return;
			}
			if (result.data?.backupCodes) {
				manageBackupCodes = result.data.backupCodes;
				const grid = document.getElementById("nz-2fa-manage-backup-grid");
				if (grid) {
					grid.innerHTML = manageBackupCodes
						.map(
							(code) =>
								`<code class="bg-background p-2 rounded text-sm font-mono text-center">${code}</code>`,
						)
						.join("");
				}
				manageStep = "backup-codes";
				manageActionsPanel?.classList.add("hidden");
				manageBackupPanel?.classList.remove("hidden");
				showToast("Backup codes regenerated successfully", "success");
			}
		} catch (err) {
			showToast(
				err instanceof Error ? err.message : "Failed to regenerate backup codes",
				"error",
			);
		} finally {
			if (btn instanceof HTMLButtonElement) btn.disabled = false;
		}
	});

	document.getElementById("nz-2fa-manage-copy")?.addEventListener("click", () =>
		copyBackupCodes(manageBackupCodes, userEmail),
	);
	document.getElementById("nz-2fa-manage-dl")?.addEventListener("click", () =>
		downloadBackupCodes(manageBackupCodes, userEmail),
	);

	document.getElementById("nz-2fa-disable-open")?.addEventListener("click", () => {
		disableDlg.showModal();
	});

	disableDlg.querySelectorAll("[data-close-2fa-disable]").forEach((el) => {
		el.addEventListener("click", () => disableDlg.close());
	});

	document.getElementById("nz-2fa-disable-confirm")?.addEventListener("click", async () => {
		const btn = document.getElementById("nz-2fa-disable-confirm");
		if (btn instanceof HTMLButtonElement) {
			btn.disabled = true;
			btn.textContent = "Disabling...";
		}
		try {
			const result = await authClient.twoFactor.disable({ password: managePassword });
			if (result.error) {
				showToast(result.error.message || "Failed to disable 2FA", "error");
				return;
			}
			showToast("2FA disabled successfully", "success");
			disableDlg.close();
			manageDlg.close();
			window.location.reload();
		} catch {
			showToast("Failed to disable 2FA. Please try again.", "error");
		} finally {
			if (btn instanceof HTMLButtonElement) {
				btn.disabled = false;
				btn.textContent = "Disable 2FA";
			}
		}
	});
}
