import Link from "next/link";
import { isReferenceId } from "../../../lib/learn/course";
import { refLinks } from "../../../lib/learn/lessons/types";
import { paths } from "../../../lib/routes";

/**
 * A lesson's paragraph, list item or goal with its reference links
 * (`[[pot-odds|pot odds]]`, Learn L1.1): the first time a lesson uses a term
 * the course assumes, the term links to its reference page. No hooks, so a
 * server page and a client island can both render it.
 */
export function RichText({ text }: { text: string }) {
  const parts = refLinks(text);
  if (parts.length === 1 && !parts[0].ref) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        part.ref && isReferenceId(part.ref) ? (
          <Link key={index} href={paths.learnReference(part.ref)}>
            {part.text}
          </Link>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
