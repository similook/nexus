/**
 * The eight font faces, imported by the shell.
 *
 * They live here rather than in @nexus/shared's stylesheet because a bare package specifier in
 * CSS resolves against the build root, so a shared stylesheet cannot import from node_modules
 * that belong to whichever shell is compiling it. Vite resolves these from TypeScript against
 * this package, which works.
 *
 * Keep this list identical to clients/web/src/index.css. Latin subsets only, and only the
 * weights the design uses — the unscoped entry points pull four more subsets and roughly
 * quadruple the font payload.
 */
import '@fontsource/plus-jakarta-sans/latin-400.css';
import '@fontsource/plus-jakarta-sans/latin-500.css';
import '@fontsource/plus-jakarta-sans/latin-600.css';
import '@fontsource/plus-jakarta-sans/latin-700.css';
import '@fontsource/plus-jakarta-sans/latin-800.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
