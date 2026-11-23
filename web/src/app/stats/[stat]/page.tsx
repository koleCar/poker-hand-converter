import { permanentRedirect } from "next/navigation";
import { paths } from "../../../lib/routes";

/**
 * Where a stat's drill-down was while Analytics stood in for Reports (0.13.0,
 * 2026-11-23). Analytics is a section of Analysis now, and `/stats` is
 * Reports again: an old link lands on the same drill-down there.
 */
export default async function OldStatDrillPage({ params }: { params: Promise<{ stat: string }> }) {
  const { stat } = await params;
  let id = stat;
  try {
    id = decodeURIComponent(stat);
  } catch {
    // Not percent-encoded as expected: pass it on as it came.
  }
  permanentRedirect(paths.analysisStat(id));
}
