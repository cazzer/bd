// `language` → CodeMirror grammar (code-view, design.md decision 4). The
// repository loader stamps a file with one of a fixed set of language
// names (packages/core/src/git-repo.ts, LANGUAGE_BY_EXTENSION); this map
// turns each into a lazy `import()` of its grammar package, so a view with
// no TypeScript file never downloads the TypeScript grammar and a grammar
// is fetched once per session (the module system caches it). An unmapped
// or absent language answers `null`, which the pane draws as plain text
// with line numbers (code-view/spec.md, "Unknown language").
//
// Every name the loader can write is mapped today, so PLAIN_LANGUAGES is
// empty; it exists so that a loader language deliberately left without a
// grammar is listed here rather than silently falling through — the test
// next door reads the loader's map and fails on a name in neither list.
//
// `shell` and `toml` have no Lezer grammar; they come from
// `@codemirror/legacy-modes`' stream parsers, wrapped by `StreamLanguage`
// into the same `LanguageSupport` shape. `typescript` and `javascript`
// share one package with flags: `jsx` for both (`.tsx`/`.jsx` carry the
// same language name as `.ts`/`.js`), `typescript` for the former.

import { LanguageSupport, StreamLanguage } from "@codemirror/language";

type GrammarLoader = () => Promise<LanguageSupport>;

/** Loader language names that deliberately have no grammar and are shown as plain text. Empty today. */
export const PLAIN_LANGUAGES: readonly string[] = [];

const GRAMMARS: Readonly<Record<string, GrammarLoader>> = {
  typescript: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  json: async () => (await import("@codemirror/lang-json")).json(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  go: async () => (await import("@codemirror/lang-go")).go(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  shell: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell)),
  toml: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml)),
};

/** The language names a grammar exists for. */
export const GRAMMAR_LANGUAGES: readonly string[] = Object.keys(GRAMMARS);

/** True when `language` names a grammar this module can load. */
export function hasGrammar(language: string | null): boolean {
  return language !== null && Object.hasOwn(GRAMMARS, language);
}

/** The grammar for `language`, loaded on first use; `null` for an absent or unmapped language (plain text). */
export async function loadLanguage(language: string | null): Promise<LanguageSupport | null> {
  if (language === null || !Object.hasOwn(GRAMMARS, language)) {
    return null;
  }
  const load = GRAMMARS[language];
  return load === undefined ? null : load();
}
