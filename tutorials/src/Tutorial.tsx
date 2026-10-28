// One tutorial video: the title card, the steps, the outro.

import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';

import { Backdrop } from './components/Backdrop';
import { loadFonts } from './components/Fonts';
import { Outro } from './components/Outro';
import { RailMark } from './components/RailMark';
import { Stage, type TimedStep } from './components/Stage';
import { TitleCard } from './components/TitleCard';
import { loadManifest, type Manifest } from './manifest';
import { SCRIPTS, scriptOf } from './scripts';
import { FPS, OUTRO_SECONDS, TITLE_SECONDS, type Tutorial } from './scripts/types';
import { color, font, radius } from './theme';

loadFonts();

export interface TutorialProps extends Record<string, unknown> {
  slug: string;
  manifest: Manifest | null;
}

export function timeline(t: Tutorial): { steps: TimedStep[]; title: number; body: number; outro: number } {
  const title = Math.round(TITLE_SECONDS * FPS);
  let start = 0;
  let index = 0;
  const steps: TimedStep[] = [];
  for (const chapter of t.chapters) {
    for (const step of chapter.steps) {
      const frames = Math.round(Math.max(2.5, step.seconds) * FPS);
      steps.push({ ...step, chapter: chapter.title, index: ++index, start, frames });
      start += frames;
    }
  }
  return { steps, title, body: start, outro: Math.round(OUTRO_SECONDS * FPS) };
}

export function durationOf(t: Tutorial): number {
  const { title, body, outro } = timeline(t);
  return title + body + outro;
}

export async function metadata({ props }: { props: TutorialProps }) {
  const script = scriptOf(props.slug);
  return { props: { ...props, manifest: await loadManifest(script.captures ?? script.slug) } };
}

/** The tutorial's name, top left, for the first seconds of the steps only. */
function Corner({ title }: { title: string }) {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        opacity: interpolate(frame, [0, 10, 100, 115], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        position: 'absolute',
        top: 32,
        left: 40,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px 8px 12px',
        borderRadius: radius.pill,
        background: 'color-mix(in srgb, var(--surface-raised) 88%, transparent)',
        border: `1px solid ${color.border}`,
        fontFamily: font.sans,
        fontSize: 22,
        fontWeight: 650,
        color: color.text,
        boxShadow: 'var(--elevation-1)',
      }}
    >
      <RailMark size={30} />
      <span>{title}</span>
    </div>
  );
}

export function TutorialVideo({ slug, manifest }: TutorialProps) {
  const script = scriptOf(slug);
  const { steps, title, body, outro } = timeline(script);
  const number = String(SCRIPTS.findIndex((s) => s.slug === slug) + 1).padStart(2, '0');
  const next = script.next ? scriptOf(script.next).title : undefined;
  return (
    <AbsoluteFill style={{ background: color.bg }}>
      <Sequence durationInFrames={title} name="Title">
        <TitleCard title={script.title} subtitle={script.subtitle} where={script.where} index={number} />
      </Sequence>
      <Sequence from={title} durationInFrames={body} name="Steps">
        <Backdrop />
        <Stage slug={script.captures ?? slug} manifest={manifest} steps={steps} />
        <Corner title={script.title} />
      </Sequence>
      <Sequence from={title + body} durationInFrames={outro} name="Outro">
        <Outro title={script.title} recap={script.chapters.map((c) => c.title)} next={next} />
      </Sequence>
    </AbsoluteFill>
  );
}
