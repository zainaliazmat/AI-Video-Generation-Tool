'use client';

import {useEffect, useState} from 'react';
import {useRouter} from 'next/navigation';
import {Eyebrow, Button} from '@/components/ui';
import {StylePrefsForm} from '@/components/StylePrefsForm';
import {studio, type ScriptPrefs} from '@/lib/studio';
import {EMPTY_PREFS} from '@/lib/scriptPrefs';

// Global channel-voice settings. Collected once (the skill's is_initialized → setup
// flow), reused on every generation, editable anytime. Saved fields are layered into
// the script prompt as soft style guides (grounding still wins).

export default function StyleSettings() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<ScriptPrefs>(EMPTY_PREFS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    studio.prefs
      .get()
      .then((r) => setPrefs({...EMPTY_PREFS, ...r.prefs, audience: {...EMPTY_PREFS.audience, ...r.prefs.audience}, style: {...EMPTY_PREFS.style, ...r.prefs.style}}))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load preferences'))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setSavedNote(null);
    setError(null);
    try {
      await studio.prefs.save(prefs);
      setSavedNote('Saved — this voice now applies to every new video.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="relative z-[1] mx-auto max-w-[720px] px-6 py-12 sm:py-16">
      <div>
        <Eyebrow>Channel voice</Eyebrow>
        <h1 className="mt-3 font-ui text-[clamp(24px,4vw,34px)] font-semibold leading-tight tracking-[-0.03em] text-ink">
          Your scriptwriting style
        </h1>
        <p className="mt-3 max-w-[52ch] font-ui text-[14px] leading-relaxed text-ink-secondary">
          Set your tone, audience, hook style, and personality once. Every new video's
          script follows this voice — while facts stay grounded in real sources. Leave
          anything blank to let the writer decide.
        </p>
      </div>

      {loading ? (
        <p className="mt-8 font-ui text-[13px] text-ink-muted">Loading…</p>
      ) : (
        <>
          <div className="glass mt-8 rounded-[var(--radius-xl)] p-5">
            <StylePrefsForm value={prefs} onChange={setPrefs} />
          </div>

          <div className="mt-5 flex items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save voice'}
            </Button>
            <button
              type="button"
              onClick={() => router.push('/')}
              className="font-ui text-[13px] font-semibold text-ink-secondary hover:text-ink"
            >
              Back to studio
            </button>
            {savedNote && <span className="font-ui text-[12px] text-[var(--accent-1)]">{savedNote}</span>}
            {error && <span className="font-ui text-[12px] text-[#ff5050]">{error}</span>}
          </div>
        </>
      )}
    </main>
  );
}
