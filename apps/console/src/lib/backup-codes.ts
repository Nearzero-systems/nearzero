/**
 * The backup codes as Download saves them and Copy copies them (spec 04 4.6, 31a G1-12): a
 * heading, the two notes, the account and the date they were made, then the codes numbered.
 */

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `nearzero-2fa-backup-codes-<YYYYMMDD>.txt`, by the person's own date. */
export function backupCodesFileName(at: Date): string {
  return `nearzero-2fa-backup-codes-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}.txt`;
}

export function backupCodesText(email: string, codes: readonly string[], at: Date): string {
  return [
    "Nearzero - BACKUP VERIFICATION CODES",
    "",
    "Each code can be used only once.",
    "Do not share these codes with anyone.",
    "",
    `Username: ${email}`,
    `Generated on: ${at.toLocaleString("en-US")}`,
    "",
    ...codes.map((code, index) => `${index + 1}. ${code}`),
    "",
  ].join("\n");
}

export const BACKUP_CODES_COPIED = "Backup codes copied to clipboard";
