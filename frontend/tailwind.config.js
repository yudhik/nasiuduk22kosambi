/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          cream: '#FFFBF0',
          'cream-deep': '#FFF2CC',
          amber: '#F5A623',
          'amber-soft': '#FDE6B0',
          orange: '#EC6F07',
          'orange-dark': '#CF5C00',
          brown: '#541A03',
          'brown-dark': '#3D1302',
        },
      },
    },
  },
  plugins: [],
};
