/**
 * The README.md inside the account export (Rail R6.5), in the reader's
 * language: the formats, then one line per entry of the database's data
 * inventory (`account_data_inventory`) saying whether and where it is in the
 * archive, and why not when it is not.
 */

import type { Dict } from "../i18n/types";
import type { ReadmeContext } from "./export";

export function buildReadme(t: Dict["yourData"]["readme"], context: ReadmeContext): string {
  const { manifest } = context;
  const lines: string[] = [];
  lines.push(`# ${t.title}`, "", t.generated(context.exportedAt, manifest.accountId), "", t.about, "");
  lines.push(`## ${t.formatsHeading}`, "");
  for (const item of t.formats) lines.push(`- ${item}`);
  lines.push("", `## ${t.filesHeading}`, "", t.filesIntro, "");

  const inventory = [...(manifest.inventory ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of inventory) {
    let where: string;
    if (entry.export === "file" && entry.file) {
      where = `${t.included}: \`${entry.file}\``;
    } else if (entry.export === "profile") {
      where = t.inProfile;
    } else {
      const reason = t.reasons[entry.export as keyof typeof t.reasons];
      where = reason ? `${t.notIncluded} (${reason})` : t.notIncluded;
    }
    lines.push(`- **${entry.name}** - ${where}. ${entry.note}`);
  }

  lines.push("", `## ${t.optionsHeading}`, "");
  lines.push(`- ${context.derived ? t.derivedOn : t.derivedOff}`);
  lines.push(`- ${context.originals ? t.originalsOn : t.originalsOff}`);
  lines.push(`- ${t.manifest}`);
  lines.push("", `## ${t.desktopHeading}`, "", t.desktop, "", t.contact, "");
  return lines.join("\n");
}
