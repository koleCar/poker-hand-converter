import type { LessonBlock } from "../../../lib/learn/lessons";
import { ConceptWidget } from "../ConceptWidget";
import { Formula } from "../Formula";
import { Checkpoint } from "./Checkpoint";
import { RichText } from "./RichText";
import styles from "./course.module.css";

/**
 * One block of a lesson or reference page's text: a paragraph, a list, a
 * concept widget, a "predict, then reveal" checkpoint, a formula or an honesty
 * banner. The text is rendered on the server; the widgets and checkpoints are
 * client islands fed this page's words.
 */
export function Block({ block, whereLabel }: { block: LessonBlock; whereLabel: string }) {
  if (typeof block === "string") {
    return (
      <p>
        <RichText text={block} />
      </p>
    );
  }
  if ("list" in block) {
    return (
      <ul className={styles.list}>
        {block.list.map((item) => (
          <li key={item}>
            <RichText text={item} />
          </li>
        ))}
      </ul>
    );
  }
  if ("widget" in block) {
    return (
      <figure className={styles.widget}>
        <ConceptWidget preset={block.widget} />
        {block.caption ? <figcaption className={styles.muted}>{block.caption}</figcaption> : null}
      </figure>
    );
  }
  if ("checkpoint" in block) {
    const c = block.checkpoint;
    return <Checkpoint question={c.question} options={c.options} answer={c.answer} explain={c.explain} reveal={c.reveal} />;
  }
  if ("formula" in block) return <Formula formula={block.formula} whereLabel={whereLabel} />;
  return (
    <p className={styles.banner} data-tone={block.note.tone}>
      {block.note.text}
    </p>
  );
}
