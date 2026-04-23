import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'game-dark': '#080c18',
        'game-blue': '#64b5f6',
        'game-red': '#ef5350',
        'game-gold': '#fde047',
        'game-ice': '#4a6a8a',
      },
    },
  },
  plugins: [],
};

export default config;
