import { LanguageSupport } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { GRAMMAR_LANGUAGES, PLAIN_LANGUAGES, hasGrammar, loadLanguage } from "./codeLanguage.js";

/**
 * The loader's language map, read from its own module at run time. A
 * computed specifier keeps `packages/core/src/git-repo.ts` (which imports
 * `@breakdown/db` and Node built-ins) out of the app's type program —
 * apps/web/src is typechecked with the DOM lib and no Node types, and
 * server/dto.ts explains why the client never imports the core barrel —
 * while vitest, running in Node, resolves and loads the file as it is.
 */
async function loaderLanguages(): Promise<string[]> {
  const specifier = new URL("../../../../packages/core/src/git-repo.ts", import.meta.url).href;
  const loader = (await import(/* @vite-ignore */ specifier)) as { LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> };
  return [...new Set(loader.LANGUAGE_BY_EXTENSION.values())];
}

describe("codeLanguage", () => {
  it("every language the loader can write is either mapped to a grammar or deliberately listed as plain", async () => {
    const languages = await loaderLanguages();
    expect(languages.length).toBeGreaterThan(0);
    const unaccounted = languages.filter((language) => !GRAMMAR_LANGUAGES.includes(language) && !PLAIN_LANGUAGES.includes(language));
    expect(unaccounted).toEqual([]);
    const both = languages.filter((language) => GRAMMAR_LANGUAGES.includes(language) && PLAIN_LANGUAGES.includes(language));
    expect(both).toEqual([]);
  });

  it("every mapped language loads a LanguageSupport", async () => {
    for (const language of GRAMMAR_LANGUAGES) {
      const support = await loadLanguage(language);
      expect(support, language).toBeInstanceOf(LanguageSupport);
      expect(hasGrammar(language)).toBe(true);
    }
  });

  it("typescript and javascript are different dialects of the one package", async () => {
    const [ts, js] = await Promise.all([loadLanguage("typescript"), loadLanguage("javascript")]);
    expect(ts?.language).toBeDefined();
    expect(ts?.language).not.toBe(js?.language);
  });

  it("an absent or unmapped language is plain text", async () => {
    expect(await loadLanguage(null)).toBeNull();
    expect(await loadLanguage("cobol")).toBeNull();
    expect(await loadLanguage("")).toBeNull();
    expect(await loadLanguage("constructor")).toBeNull();
    expect(hasGrammar(null)).toBe(false);
    expect(hasGrammar("toString")).toBe(false);
  });
});
