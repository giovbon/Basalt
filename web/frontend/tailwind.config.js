/**
 * Tailwind build config: compiles only the utility classes actually used by
 * the app into a static CSS file (replaces the 408 KB Play CDN script, which
 * used to compile styles in the browser at runtime).
 *
 * Rebuild with ./build-tailwind.sh whenever classes change in index.html or
 * the JS sources. app.js is deliberately not scanned: it is generated from
 * src/, and minifier output changes would otherwise churn tailwind.css even
 * when no class was added or removed.
 */
module.exports = {
  content: [
    './index.html',
    './src/**/*.js',
    './editor-markdown-continue.js',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
