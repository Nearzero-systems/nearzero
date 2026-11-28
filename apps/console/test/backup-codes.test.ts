import { describe, expect, test } from "bun:test";
import { backupCodesFileName, backupCodesText } from "../src/lib/backup-codes.ts";

describe("the backup codes file and copied text (31a G1-12)", () => {
  test("named with the date, holding the account, the date, both notes and the numbered codes", () => {
    const at = new Date(2026, 10, 28, 9, 5);
    expect(backupCodesFileName(at)).toBe("nearzero-2fa-backup-codes-20261128.txt");
    const codes = Array.from({ length: 10 }, (_, n) => `abcd${n}-efgh${n}`);
    const text = backupCodesText("olivia@example.com", codes, at);
    const lines = text.split("\n");
    expect(lines.slice(0, 7)).toEqual([
      "Nearzero - BACKUP VERIFICATION CODES",
      "",
      "Each code can be used only once.",
      "Do not share these codes with anyone.",
      "",
      "Username: olivia@example.com",
      `Generated on: ${at.toLocaleString("en-US")}`,
    ]);
    expect(lines).toContain("1. abcd0-efgh0");
    expect(lines).toContain("10. abcd9-efgh9");
  });
});
