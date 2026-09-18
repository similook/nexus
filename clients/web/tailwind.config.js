/** @type {import('tailwindcss').Config} */

/**
 * Theme lifted verbatim from the Stitch mockup's inline `tailwind.config` block.
 *
 * Values are copied exactly — the mockup is the design source of truth, and a hex that drifts
 * by one digit produces a UI that looks "slightly off" in a way nobody can pin down. If a
 * colour needs to change, change it here and regenerate the mockup, not the other way round.
 */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          orange: '#FF6B00',
          'orange-glow': '#FF8A33',
          'orange-dark': '#CC5500',
          navy: '#070D18',
          surface: '#0E1726',
          'surface-card': '#141F36',
          'surface-card-hover': '#1B2947',
          border: '#1E2D4A',
          muted: '#7E8CA0',
          accent: '#38BDF8',
        },
      },
      fontFamily: {
        // Self-hosted via @fontsource (see index.css), not the Google Fonts CDN the mockup
        // used. A packaged app must render correctly offline and on first launch, and a
        // webfont request at startup is both a blocking paint and a radio wakeup.
        sans: ['"Plus Jakarta Sans"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        'glow-orange':
          '0 0 45px -5px rgba(255, 107, 0, 0.55), 0 0 20px -2px rgba(255, 107, 0, 0.4)',
        'glow-orange-sm': '0 0 20px -3px rgba(255, 107, 0, 0.4)',
      },
      keyframes: {
        // The mockup declared this in a raw <style> block; as a real Tailwind keyframe it
        // gets the `animate-pulse-ring` utility generated for us.
        'pulse-ring': {
          '0%': { transform: 'scale(0.95)', opacity: '0.8' },
          '50%': { transform: 'scale(1.15)', opacity: '0.2' },
          '100%': { transform: 'scale(0.95)', opacity: '0.8' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        // The connecting-state ring. 4s rather than Tailwind's built-in 1s `animate-spin`,
        // which on a 13rem circle reads as frantic instead of "working".
        'spin-slow': 'spin 4s linear infinite',
      },
    },
  },
  plugins: [],
};
