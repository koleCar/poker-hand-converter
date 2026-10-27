import { permanentRedirect } from "next/navigation";
import { paths } from "../../lib/routes";

/** `/f` is not a page of its own: the all-boards feed is `/`. */
export default function ForumIndex() {
  permanentRedirect(paths.home());
}
