import { readFile, stat } from 'fs/promises';
import postcss from 'postcss';
import type { Resolver } from '../resolver/index.js';
import { createDefaultResolver } from '../resolver/index.js';
import { createDefaultTransformer, type Transformer } from '../transformer/index.js';
import { unique, uniqueBy } from '../util.js';
import {
  getOriginalLocationOfClassSelector,
  getOriginalLocationOfAtValue,
  generateLocalTokenNames,
  parseAtImport,
  type Location,
  collectNodes,
  parseAtValue,
} from './postcss.js';

export { collectNodes, type Location } from './postcss.js';

/**
 * Whether the specifier should be ignored.
 * For example, specifiers starting with `http://` or `https://` should be ignored.
 */
function isIgnoredSpecifier(specifier: string): boolean {
  return specifier.startsWith('http://') || specifier.startsWith('https://');
}

/** The exported token. */
export type Token = {
  /** The token name. */
  name: string;
  /** The name of the imported token. */
  importedName?: string;
  /** The original location of the token in the source file. */
  originalLocation: Location;
};

type CacheEntry = {
  mtime: number; // TODO: `--cache-strategy` option will allow you to switch between `content` and `metadata` modes.
  result: LoadResult;
};

/** The result of `Locator#load`. */
export type LoadResult = {
  /** The path of the file imported from the source file with `@import`. */
  dependencies: string[];
  /** The tokens exported by the source file. */
  tokens: Token[];
};

export type LocatorOptions = {
  /** The function to transform source code. */
  transformer?: Transformer | undefined;
  /** The function to resolve the path of the imported file. */
  resolver?: Resolver | undefined;
};

/** The resolver that throws an exception if resolving fails. */
export type StrictlyResolver = (...args: Parameters<Resolver>) => Promise<string>;

/** This class collects information on tokens exported from CSS Modules files. */
export class Locator {
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly transformer: Transformer | undefined;
  private readonly resolver: StrictlyResolver;
  private loading = false;

  constructor(options?: LocatorOptions) {
    this.transformer = options?.transformer ?? createDefaultTransformer();
    this.resolver = async (specifier, resolverOptions) => {
      const resolver = options?.resolver ?? createDefaultResolver();
      const resolved = await resolver(specifier, resolverOptions);
      if (resolved === false) throw new Error(`Could not resolve '${specifier}' in '${resolverOptions.request}'.`);
      return resolved;
    };
  }

  /** Returns `true` if the cache is outdated. */
  private async isCacheOutdated(filePath: string): Promise<boolean> {
    const entry = this.cache.get(filePath);
    if (!entry) return true;
    const mtime = (await stat(filePath)).mtime.getTime();
    if (entry.mtime !== mtime) return true;

    const { dependencies } = entry.result;
    for (const dependency of dependencies) {
      const entry = this.cache.get(dependency);
      if (!entry) return true;
      // eslint-disable-next-line no-await-in-loop
      const mtime = (await stat(dependency)).mtime.getTime();
      if (entry.mtime !== mtime) return true;
    }
    return false;
  }

  /**
   * Reads the source file and returns the code.
   * If transformer is specified, the code is transformed before returning.
   */
  private async readCSS(
    filePath: string,
  ): Promise<
    | { css: string; map: undefined; dependencies: string[] }
    | { css: string; map: string | object | undefined; dependencies: string[] }
  > {
    const css = await readFile(filePath, 'utf-8');
    if (!this.transformer) return { css, map: undefined, dependencies: [] };
    const result = await this.transformer(css, { from: filePath, resolver: this.resolver, isIgnoredSpecifier });
    if (result === false) return { css, map: undefined, dependencies: [] };
    return {
      css: result.css,
      map: result.map,
      dependencies: result.dependencies
        .map((dep) => {
          if (typeof dep === 'string') return dep;
          if (dep.protocol !== 'file:') throw new Error(`Unsupported protocol: ${dep.protocol}`);
          return dep.pathname;
        })
        .filter((dep) => {
          // less makes a remote module inline, so it may be included in dependencies.
          // However, the dependencies field of happy-css-modules is not yet designed to store http protocol URLs.
          // Therefore, we exclude them from the dependencies field for now.
          return !isIgnoredSpecifier(dep);
        }),
    };
  }

  /** Returns information about the tokens exported from the CSS Modules file. */
  async load(filePath: string): Promise<LoadResult> {
    if (this.loading) throw new Error('Cannot call `Locator#load` concurrently.');
    this.loading = true;
    const result = await this._load(filePath).finally(() => {
      this.loading = false;
    });
    return result;
  }

  private async _load(filePath: string): Promise<LoadResult> {
    if (!(await this.isCacheOutdated(filePath))) {
      const cacheEntry = this.cache.get(filePath)!;
      return cacheEntry.result;
    }

    const mtime = (await stat(filePath)).mtime.getTime();

    const { css, map, dependencies } = await this.readCSS(filePath);

    const ast = postcss.parse(css, { from: filePath, map: map ? { inline: false, prev: map } : { inline: false } });

    // Get the local tokens exported by the source file.
    // The tokens are fetched using `postcss-modules` plugin.
    const localTokenNames = await generateLocalTokenNames(ast);

    const tokens: Token[] = [];

    const { atImports, atValues, classSelectors } = collectNodes(ast);

    // Load imported sheets recursively.
    for (const atImport of atImports) {
      const importedSheetPath = parseAtImport(atImport);
      if (!importedSheetPath) continue;
      if (isIgnoredSpecifier(importedSheetPath)) continue;
      // eslint-disable-next-line no-await-in-loop
      const from = await this.resolver(importedSheetPath, { request: filePath });
      // eslint-disable-next-line no-await-in-loop
      const result = await this._load(from);
      const externalTokens = result.tokens;
      dependencies.push(from, ...result.dependencies);
      tokens.push(...externalTokens);
    }

    // Traverse the source file to find a class selector that matches the local token.
    for (const { rule, classSelector } of classSelectors) {
      // Consider a class selector to be the origin of a token if it matches a token fetched by postcss-modules.
      // NOTE: This method has false positives. However, it works as expected in many cases.
      if (!localTokenNames.includes(classSelector.value)) continue;

      const originalLocation = getOriginalLocationOfClassSelector(rule, classSelector);

      tokens.push({
        name: classSelector.value,
        originalLocation,
      });
    }

    for (const atValue of atValues) {
      const parsedAtValue = parseAtValue(atValue);

      if (parsedAtValue.type === 'valueDeclaration') {
        tokens.push({
          name: parsedAtValue.tokenName,
          originalLocation: getOriginalLocationOfAtValue(atValue, parsedAtValue),
        });
      } else if (parsedAtValue.type === 'valueImportDeclaration') {
        if (isIgnoredSpecifier(parsedAtValue.from)) continue;
        // eslint-disable-next-line no-await-in-loop
        const from = await this.resolver(parsedAtValue.from, { request: filePath });
        // eslint-disable-next-line no-await-in-loop
        const result = await this._load(from);
        dependencies.push(from, ...result.dependencies);
        for (const token of result.tokens) {
          const matchedImport = parsedAtValue.imports.find((i) => i.importedTokenName === token.name);
          if (!matchedImport) continue;
          if (matchedImport.localTokenName === matchedImport.importedTokenName) {
            tokens.push({
              name: matchedImport.localTokenName,
              originalLocation: token.originalLocation,
            });
          } else {
            tokens.push({
              name: matchedImport.localTokenName,
              importedName: matchedImport.importedTokenName,
              originalLocation: token.originalLocation,
            });
          }
        }
      }
    }

    const result: LoadResult = {
      dependencies: unique(dependencies).filter((dep) => dep !== filePath),
      tokens: uniqueBy(tokens, (token) => JSON.stringify(token)),
    };
    this.cache.set(filePath, { mtime, result });
    return result;
  }
}
