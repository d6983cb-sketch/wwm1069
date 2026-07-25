import type { Config } from 'tailwindcss';
const config: Config = { content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'], theme: { extend: { colors: { ink: '#0c1514', jade: '#9eb8a6', gold: '#d5b77c' }, fontFamily: { sans: ['var(--font-sans)'], serif: ['var(--font-serif)'] } } }, plugins: [] };
export default config;
