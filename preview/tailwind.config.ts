import type {Config} from 'tailwindcss';

// Tailwind 3.x object config (NOT v4 CSS-first). theme.extend mirrors spec §10.9.
const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        base: 'var(--bg-base)',
        surface: 'var(--bg-surface)',
        elevated: 'var(--bg-elevated)',
        accent: {1: '#6366f1', 2: '#8b5cf6', 3: '#a78bfa'},
        ok: 'var(--green)',
        warn: 'var(--amber)',
        bad: 'var(--red)',
        ink: {
          DEFAULT: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
        },
      },
      backgroundImage: {
        'grad-main': 'linear-gradient(135deg, #6366f1, #8b5cf6)',
      },
      backdropBlur: {glass: '20px'},
      backdropSaturate: {glass: '180%'},
      fontFamily: {
        ui: ['var(--font-ui)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      animation: {
        'ring-pulse': 'ring-pulse 1.5s ease-in-out infinite',
        shimmer: 'shimmer 1.6s linear infinite',
        'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
      },
      keyframes: {
        'ring-pulse': {
          '0%,100%': {boxShadow: '0 0 0 0 rgba(99,102,241,0.4)'},
          '50%': {boxShadow: '0 0 0 6px rgba(99,102,241,0)'},
        },
        shimmer: {
          '0%': {backgroundPosition: '-400px 0'},
          '100%': {backgroundPosition: '400px 0'},
        },
        'pulse-dot': {
          '0%,100%': {opacity: '1', transform: 'scale(1)'},
          '50%': {opacity: '0.4', transform: 'scale(0.7)'},
        },
      },
    },
  },
  plugins: [],
};

export default config;
