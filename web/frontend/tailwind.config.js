/**
 * Tailwind build config: compiles only the utility classes actually used by
 * the app into a static CSS file (replaces the 408 KB Play CDN script, which
 * used to compile styles in the browser at runtime).
 *
 * Rebuild with ./build-tailwind.sh whenever classes change in index.html or
 * app.js. Keep content globs in sync with any new source file that embeds
 * class attributes.
 */
module.exports = {
  content: [
    './index.html',
    './app.js',
    './src/**/*.js',
    './editor-markdown-continue.js',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
