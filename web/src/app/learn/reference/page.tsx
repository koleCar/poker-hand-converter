import { permanentRedirect } from "next/navigation";
import { paths } from "../../../lib/routes";

/** `/learn/reference` has no page of its own: the reference pages are listed on the course map (L1.1). */
export default function ReferenceIndex() {
  permanentRedirect(paths.learn());
}
