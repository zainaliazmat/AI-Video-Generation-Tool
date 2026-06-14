'use client';

import {Player, type PlayerRef} from '@remotion/player';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Video} from '@remotion-src/Video';
import type {Spec} from '@remotion-src/schema';
import {clampRelative, formatSceneClock} from '@/lib/sceneTime';

/**
 * ScenePlayer — plays a single scene span on the full spec, looping within it.
 *
 * Span binding (@remotion/player v4.0.472):
 *   The Player is fed the FULL composition duration so scenes render at their
 *   absolute frame addresses (the Video composition reads frame numbers directly
 *   — trimming durationInFrames would shift all content to frame 0 and render the
 *   wrong scene). inFrame/outFrame pin playback to the scene; `loop` loops it.
 *     - durationInFrames={spec.meta.durationInFrames}  ← FULL composition
 *     - inFrame={startFrame}, outFrame={startFrame + durationInFrames - 1}
 *     - initialFrame={startFrame}
 *
 * Controls: native controls would read the WHOLE video's length (e.g. 0:42) with
 * the rest of the bar greyed — confusing for a 5.8s scene. So when `controls`,
 * native controls are off and we render a custom bar bound to the scene span via
 * a PlayerRef: play/pause + scene-relative time (0 → scene length) + a scrubber
 * scoped to [0, dur-1] + mute + fullscreen. The looping mechanism is STILL
 * inFrame/outFrame — the ref drives the readout/scrub, not the loop.
 */
export function ScenePlayer({
  spec,
  startFrame,
  durationInFrames,
  controls = false,
}: {
  spec: Spec;
  startFrame: number;
  durationInFrames: number;
  controls?: boolean;
}) {
  const {fps, width, height, durationInFrames: totalFrames} = spec.meta;

  // inFrame/outFrame are INCLUSIVE in the Player API.
  const outFrame = startFrame + durationInFrames - 1;

  // Stable identity so the Player doesn't remount/reset on parent re-renders.
  const inputProps = useMemo(() => ({spec}), [spec]);

  const playerRef = useRef<PlayerRef>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [relFrame, setRelFrame] = useState(0);

  // Mirror the player's playback into the custom bar (scene-relative).
  useEffect(() => {
    if (!controls) return;
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (e: {detail: {frame: number}}) =>
      setRelFrame(clampRelative(e.detail.frame, startFrame, durationInFrames));
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    setRelFrame(clampRelative(player.getCurrentFrame(), startFrame, durationInFrames));
    setPlaying(player.isPlaying());
    setMuted(player.isMuted());
    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
    };
  }, [controls, startFrame, durationInFrames]);

  const onScrub = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const rel = Number(e.target.value);
      setRelFrame(rel);
      playerRef.current?.seekTo(startFrame + rel);
    },
    [startFrame],
  );

  const toggleMute = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.isMuted()) {
      player.unmute();
      setMuted(false);
    } else {
      player.mute();
      setMuted(true);
    }
  }, []);

  const player = (
    <Player
      ref={playerRef}
      component={Video}
      inputProps={inputProps}
      // Full composition duration — required for absolute frame addressing.
      durationInFrames={totalFrames}
      fps={fps}
      compositionWidth={width}
      compositionHeight={height}
      // Span constraints: Player will only play [startFrame, outFrame] inclusive.
      inFrame={startFrame}
      outFrame={outFrame}
      // Open at the scene start (not frame 0).
      initialFrame={startFrame}
      loop
      style={{width: '100%', display: 'block'}}
      controls={false}
      clickToPlay={controls}
      spaceKeyToPlayOrPause={controls}
    />
  );

  if (!controls) return player;

  const maxRel = Math.max(durationInFrames - 1, 0);

  return (
    <div>
      {player}
      {/* Custom scene-scoped control bar — reads scene-relative time, not 0:42. */}
      <div className="flex items-center gap-2.5 border-t border-white/10 bg-[#0b0b0f] px-2.5 py-2">
        <IconButton
          onClick={() => playerRef.current?.toggle()}
          label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <span className="min-w-[72px] font-mono text-[11px] tabular-nums text-ink-secondary">
          {formatSceneClock(relFrame, fps)} / {formatSceneClock(durationInFrames, fps)}
        </span>
        <input
          type="range"
          min={0}
          max={maxRel}
          value={relFrame}
          onChange={onScrub}
          aria-label="Seek within scene"
          className="h-1.5 flex-1 cursor-pointer accent-accent-1"
        />
        <IconButton onClick={toggleMute} label={muted ? 'Unmute' : 'Mute'}>
          {muted ? <MutedIcon /> : <VolumeIcon />}
        </IconButton>
        <IconButton onClick={() => playerRef.current?.requestFullscreen()} label="Fullscreen">
          <FullscreenIcon />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-ink-secondary transition hover:bg-white/[0.1] hover:text-ink"
    >
      {children}
    </button>
  );
}

// ─── inline icons (match the codebase's stroke-svg style) ─────────────────────
const svg = 'h-[15px] w-[15px]';
const PlayIcon = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8 5v14l11-7z" />
  </svg>
);
const PauseIcon = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
  </svg>
);
const VolumeIcon = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
  </svg>
);
const MutedIcon = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="m23 9-6 6M17 9l6 6" />
  </svg>
);
const FullscreenIcon = () => (
  <svg className={svg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3" />
  </svg>
);
