'use client';

import type {ScriptPrefs} from '@/lib/studio';
import {SELECT_FIELDS, SCRIPT_TYPE_OPTIONS, getField, setField} from '@/lib/scriptPrefs';
import {cn} from '@/lib/cn';

// Shared presentational form for the channel-voice preferences. Used by the global
// settings page and the per-video override panel. Every group is single-select with
// a toggle-off (click the active chip to clear) so "unset" is always reachable —
// an unset field emits no prompt line and keeps generation byte-identical.

function Chip({active, onClick, children}: {active: boolean; onClick: () => void; children: React.ReactNode}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-[12px] py-[6px] font-ui text-[12px] font-semibold transition-all duration-200',
        active
          ? 'border-[rgba(94,92,230,0.4)] bg-[var(--tint-soft,rgba(94,92,230,0.12))] text-[var(--accent-1)]'
          : 'border-transparent bg-white/[0.12] text-ink-secondary hover:bg-white/[0.2]',
      )}
    >
      {children}
    </button>
  );
}

function Group({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <div>
      <p className="mb-2 font-ui text-[12px] font-semibold text-ink-secondary">{label}</p>
      <div className="flex flex-wrap gap-[7px]">{children}</div>
    </div>
  );
}

export function StylePrefsForm({
  value,
  onChange,
}: {
  value: ScriptPrefs;
  onChange: (next: ScriptPrefs) => void;
}) {
  const toggleSelect = (path: string, v: string) =>
    onChange(setField(value, path, getField(value, path) === v ? '' : v));

  const toggleScriptType = (v: string) => {
    const has = value.script_types.includes(v);
    onChange({
      ...value,
      script_types: has ? value.script_types.filter((x) => x !== v) : [...value.script_types, v],
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {SELECT_FIELDS.map((f) => (
        <Group key={f.path} label={f.label}>
          {f.options.map((o) => (
            <Chip key={o.value} active={getField(value, f.path) === o.value} onClick={() => toggleSelect(f.path, o.value)}>
              {o.label}
            </Chip>
          ))}
        </Group>
      ))}

      <Group label="Rhetorical questions">
        <Chip
          active={value.style.use_questions === true}
          onClick={() => onChange({...value, style: {...value.style, use_questions: value.style.use_questions === true ? null : true}})}
        >
          Use them
        </Chip>
        <Chip
          active={value.style.use_questions === false}
          onClick={() => onChange({...value, style: {...value.style, use_questions: value.style.use_questions === false ? null : false}})}
        >
          Avoid them
        </Chip>
      </Group>

      <Group label="Format leanings">
        {SCRIPT_TYPE_OPTIONS.map((o) => (
          <Chip key={o.value} active={value.script_types.includes(o.value)} onClick={() => toggleScriptType(o.value)}>
            {o.label}
          </Chip>
        ))}
      </Group>

      <div>
        <p className="mb-2 font-ui text-[12px] font-semibold text-ink-secondary">Audience interests</p>
        <input
          value={value.audience.interests.join(', ')}
          onChange={(e) =>
            onChange({
              ...value,
              audience: {
                ...value.audience,
                interests: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              },
            })
          }
          placeholder="productivity, technology…"
          className="w-full rounded-[var(--radius-md)] border border-transparent bg-white/[0.03] px-3 py-2 font-ui text-[13px] text-ink outline-none transition-all placeholder:text-ink-muted focus:border-[var(--glass-border-active)] focus:bg-white/[0.05]"
        />
      </div>

      <div>
        <p className="mb-2 font-ui text-[12px] font-semibold text-ink-secondary">Channel niche</p>
        <input
          value={value.channel_niche}
          onChange={(e) => onChange({...value, channel_niche: e.target.value})}
          placeholder="ocean science facts…"
          className="w-full rounded-[var(--radius-md)] border border-transparent bg-white/[0.03] px-3 py-2 font-ui text-[13px] text-ink outline-none transition-all placeholder:text-ink-muted focus:border-[var(--glass-border-active)] focus:bg-white/[0.05]"
        />
      </div>
    </div>
  );
}
