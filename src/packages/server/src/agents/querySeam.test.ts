/**
 * The seam in agents/runner.ts covers an agent run only if runner.ts is the one module that can
 * start Claude Code. Three SDK functions start its subprocess: query(), startup() and prewarm()
 * (sdk.d.ts, Agent SDK 0.3.319). The "/core" subpath exports them too. A second module that reaches
 * one of them would bypass setQueryImpl. Neither a test's fake nor the preload's refusal would
 * reach its calls, and the runner's guardrails would not apply to them.
 *
 * This file parses every code file in the server package with the TypeScript compiler API, tests
 * included. It recognises the SDK by a module name that is the SDK's package name, a subpath of
 * it, or a path that leads to them (SDK_MODULE below). It refuses two things:
 * - any module other than agents/runner.ts that reaches the SDK in one of these forms: a named
 *   import of query, startup or prewarm under any local name, a default or namespace import, an
 *   `import = require`, a dynamic import, or a string naming the SDK anywhere outside an import
 *   declaration, which covers require() and createRequire(import.meta.url)();
 * - any module, runner.ts included, that hands such a binding on through an export statement:
 *   a re-export from the SDK (`export *`, `export * as`, `export { query }`), or an export whose
 *   value is the binding or a local alias of it (`export { query }`, `export default (query)`,
 *   `export const run = query as QueryFn`, `const handOn = query; export { handOn }`). The check
 *   takes off parentheses, `as`, `satisfies`, `!` and `<T>`, and follows a variable declared
 *   from the binding.
 *
 * The scan reads a string literal only to test whether its whole value is a module name for the
 * SDK. Each fixture string below holds a whole statement, with spaces or quotes in it, so none
 * matches, and the scan reads this file and finds nothing; no file is excluded. A future fixture
 * string whose whole value is the SDK's name, or a path to it, would make the scan refuse this
 * file.
 *
 * KNOWN LIMITS, which the scan does not see and which nothing else refuses. Each has a fixture in
 * the "known limits" test below, except code outside the files the scan reads:
 * - a module name built at run time, such as a template literal with a substitution or a
 *   concatenation (`import("@anthropic-ai/" + name)`);
 * - a fixed module name that reaches the SDK without its package name in it: an `"imports"` alias
 *   in package.json (`#sdk`), a package alias (`"agent-sdk": "npm:@anthropic-ai/claude-agent-sdk"`)
 *   or a tsconfig `paths` alias;
 * - runner.ts handing its binding on by a route other than an export statement whose value is the
 *   binding or an alias of it: an exported object (`export const sdk = { query }`), a function
 *   that returns it, a function argument, an assignment after the declaration
 *   (`let handOn; handOn = query; export { handOn }`), or a global;
 * - code that is not in the server package (src/packages/server), or not in a file with a .ts,
 *   .tsx, .mts, .cts, .js, .jsx, .mjs or .cjs name;
 * - starting the Claude Code binary directly, through child_process, without the SDK;
 * - code evaluated from a string at run time, through eval or new Function.
 * These are the limits known on 2026-11-08, and other forms may pass too.
 */
import { deepStrictEqual, ok } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The SDK functions that start the Claude Code subprocess. */
const STARTS_CLAUDE_CODE = new Set(["query", "startup", "prewarm"]);
/**
 * The SDK's package name, any subpath of it such as "/core", and any path that leads to them, such
 * as "../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs". It is anchored at both ends and
 * admits no space or quote, so a string holding a whole statement never matches.
 */
const SDK_MODULE = /^(?:[^\s"']*\/)?@anthropic-ai\/claude-agent-sdk(?:\/[^\s"']*)?$/;
/** The code files the scan reads: TypeScript and JavaScript, in every module flavour. */
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

interface Finding {
  /** "reach" is allowed only in agents/runner.ts. "hand-on" is allowed nowhere. */
  kind: "reach" | "hand-on";
  line: number;
  detail: string;
}

function isExported(statement: ts.VariableStatement): boolean {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function isSdk(node: ts.Node | undefined): boolean {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && SDK_MODULE.test(node.text);
}

/** `value` without the parentheses, `as`, `satisfies`, `!` and `<T>` around it. */
function unwrap(value: ts.Expression): ts.Expression {
  let current = value;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The bound name that `value` evaluates to: the binding itself, or a member of a bound namespace. */
function boundName(value: ts.Expression | undefined, bound: Set<string>): string | undefined {
  if (!value) return undefined;
  let current = unwrap(value);
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrap(current.expression);
  return ts.isIdentifier(current) && bound.has(current.text) ? current.text : undefined;
}

/** Every way `text` can reach, or hand on, the SDK functions that start Claude Code. */
function scanSource(fileName: string, text: string): Finding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  // Local names bound to one of those functions, or to the whole SDK.
  const bound = new Set<string>();
  const add = (kind: Finding["kind"], node: ts.Node, detail: string) =>
    findings.push({ kind, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, detail });

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isSdk(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) {
          bound.add(clause.name.text);
          add("reach", node, `imports the SDK's default export as ${clause.name.text}`);
        }
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          bound.add(bindings.name.text);
          add("reach", node, `imports the SDK as the namespace ${bindings.name.text}`);
        } else if (bindings) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (element.isTypeOnly || !STARTS_CLAUDE_CODE.has(imported)) continue;
            bound.add(element.name.text);
            add("reach", node, `imports ${imported}${imported === element.name.text ? "" : ` as ${element.name.text}`}`);
          }
        }
      }
      return; // its module specifier is accounted for
    }
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) return;
      const clause = node.exportClause;
      if (node.moduleSpecifier && isSdk(node.moduleSpecifier)) {
        if (!clause) add("hand-on", node, "re-exports the whole SDK with export *");
        else if (ts.isNamespaceExport(clause)) add("hand-on", node, `re-exports the SDK as ${clause.name.text}`);
        else {
          for (const element of clause.elements) {
            const name = (element.propertyName ?? element.name).text;
            if (!element.isTypeOnly && STARTS_CLAUDE_CODE.has(name)) add("hand-on", node, `re-exports ${name} from the SDK`);
          }
        }
        return;
      }
      if (!node.moduleSpecifier && clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const local = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && bound.has(local)) add("hand-on", node, `exports its SDK binding ${local}`);
        }
      }
    }
    if (ts.isExportAssignment(node)) {
      const name = boundName(node.expression, bound);
      if (name) add("hand-on", node, `exports its SDK binding ${name} as the default`);
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const name = boundName(declaration.initializer, bound);
        if (!name) continue;
        // A local alias, such as `const handOn = query`, is bound too, so exporting it is caught.
        if (ts.isIdentifier(declaration.name)) bound.add(declaration.name.text);
        if (isExported(node)) add("hand-on", node, `exports its SDK binding ${name} through a variable`);
      }
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      if (isSdk(node.moduleReference.expression)) {
        bound.add(node.name.text);
        add("reach", node, "imports the SDK with import = require");
        return;
      }
    }
    if (isSdk(node)) {
      const parent = node.parent;
      if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return; // a type only
      if (ts.isCallExpression(parent)) {
        const dynamic = parent.expression.kind === ts.SyntaxKind.ImportKeyword;
        add(
          "reach",
          node,
          dynamic ? "imports the SDK dynamically" : "passes the SDK's name to a call, as require or createRequire()() does",
        );
        // `const sdk = await import(...)` or `const sdk = require(...)` binds the SDK to sdk.
        const holder = ts.isAwaitExpression(parent.parent) ? parent.parent : parent;
        const declaration = holder.parent;
        if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
          bound.add(declaration.name.text);
          const statement = declaration.parent.parent;
          if (ts.isVariableStatement(statement) && isExported(statement)) {
            add("hand-on", statement, `exports its SDK binding ${declaration.name.text} through a variable`);
          }
        }
      } else {
        add("reach", node, "names the SDK in a string, which import() or require could load");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** The kinds of finding in `text`, as "kind: detail". */
function scan(text: string, fileName = "fixture.ts"): string[] {
  return scanSource(fileName, text).map((finding) => `${finding.kind}: ${finding.detail}`);
}

test("the scan catches each way a module can reach the SDK functions that start Claude Code", () => {
  const caught: [string, string][] = [
    ['import { query, type Options } from "@anthropic-ai/claude-agent-sdk";', "reach: imports query"],
    ['import { tool, query as ask } from "@anthropic-ai/claude-agent-sdk";', "reach: imports query as ask"],
    ['import { startup } from "@anthropic-ai/claude-agent-sdk";', "reach: imports startup"],
    ['import { prewarm as warm } from "@anthropic-ai/claude-agent-sdk";', "reach: imports prewarm as warm"],
    ['import {\n  createSdkMcpServer,\n  query,\n} from "@anthropic-ai/claude-agent-sdk";', "reach: imports query"],
    ["import{query}from'@anthropic-ai/claude-agent-sdk'", "reach: imports query"],
    [
      'import { readFile } from "node:fs/promises"\nimport { query } from "@anthropic-ai/claude-agent-sdk"\nexport const x = 1',
      "reach: imports query",
    ],
    ['import { tool, /* the runner\'s */ query } from "@anthropic-ai/claude-agent-sdk";', "reach: imports query"],
    ['import { query } from "@anthropic-ai/claude-agent-sdk/core";', "reach: imports query"],
    ['import * as sdk from "@anthropic-ai/claude-agent-sdk";', "reach: imports the SDK as the namespace sdk"],
    ['import sdk from "@anthropic-ai/claude-agent-sdk";', "reach: imports the SDK's default export as sdk"],
    ['import sdk = require("@anthropic-ai/claude-agent-sdk");', "reach: imports the SDK with import = require"],
    ['const sdk = await import("@anthropic-ai/claude-agent-sdk");', "reach: imports the SDK dynamically"],
    ["const sdk = await import(`@anthropic-ai/claude-agent-sdk`);", "reach: imports the SDK dynamically"],
    [
      'import { createRequire } from "node:module";\nconst sdk = createRequire(import.meta.url)("@anthropic-ai/claude-agent-sdk");',
      "reach: passes the SDK's name to a call, as require or createRequire()() does",
    ],
    [
      'const sdk = require("@anthropic-ai/claude-agent-sdk");',
      "reach: passes the SDK's name to a call, as require or createRequire()() does",
    ],
    [
      'const name = "@anthropic-ai/claude-agent-sdk";\nconst sdk = await import(name);',
      "reach: names the SDK in a string, which import() or require could load",
    ],
    ['export { query } from "@anthropic-ai/claude-agent-sdk";', "hand-on: re-exports query from the SDK"],
    ['export * from "@anthropic-ai/claude-agent-sdk";', "hand-on: re-exports the whole SDK with export *"],
    ['export * as sdk from "@anthropic-ai/claude-agent-sdk";', "hand-on: re-exports the SDK as sdk"],
    // A path that leads to the SDK, without importing it by its package name.
    ['import { query } from "../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";', "reach: imports query"],
    [
      'import { startup } from "../../node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.319/node_modules/@anthropic-ai/claude-agent-sdk/core.mjs";',
      "reach: imports startup",
    ],
    [
      'const sdk = await import("file:///repo/src/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");',
      "reach: imports the SDK dynamically",
    ],
  ];
  for (const [source, finding] of caught) deepStrictEqual(scan(source), [finding], source);
});

test("the scan catches runner.ts handing its query binding on through an export", () => {
  const imports = 'import { query } from "@anthropic-ai/claude-agent-sdk";\n';
  const handOns: [string, string][] = [
    ["export { query };", "hand-on: exports its SDK binding query"],
    ["export { query as sdkQuery };", "hand-on: exports its SDK binding query"],
    ["export default query;", "hand-on: exports its SDK binding query as the default"],
    ["export const run = query;", "hand-on: exports its SDK binding query through a variable"],
    // The value wrapped in a cast, a check or parentheses.
    ["export const run = query as QueryFn;", "hand-on: exports its SDK binding query through a variable"],
    ["export const run = query satisfies QueryFn;", "hand-on: exports its SDK binding query through a variable"],
    ["export const run = ((query as unknown) as QueryFn)!;", "hand-on: exports its SDK binding query through a variable"],
    ["export default (query);", "hand-on: exports its SDK binding query as the default"],
    ["export = query as QueryFn;", "hand-on: exports its SDK binding query as the default"],
    // A local alias of the binding, exported later.
    ["const handOn = query;\nexport { handOn };", "hand-on: exports its SDK binding handOn"],
    ["let queryImpl: QueryFn = query;\nexport { queryImpl as run };", "hand-on: exports its SDK binding queryImpl"],
    ["const a = query as QueryFn;\nconst b = (a);\nexport default b;", "hand-on: exports its SDK binding b as the default"],
  ];
  for (const [statement, finding] of handOns) {
    deepStrictEqual(scan(imports + statement, "agents/runner.ts"), ["reach: imports query", finding], statement);
  }
  const bindings: [string, string[]][] = [
    [
      'import * as sdk from "@anthropic-ai/claude-agent-sdk";\nexport const run = sdk.query;',
      ["reach: imports the SDK as the namespace sdk", "hand-on: exports its SDK binding sdk through a variable"],
    ],
    [
      'export const sdk = await import("@anthropic-ai/claude-agent-sdk");',
      ["reach: imports the SDK dynamically", "hand-on: exports its SDK binding sdk through a variable"],
    ],
    [
      'import sdk = require("@anthropic-ai/claude-agent-sdk");\nexport { sdk };',
      ["reach: imports the SDK with import = require", "hand-on: exports its SDK binding sdk"],
    ],
  ];
  for (const [source, findings] of bindings) deepStrictEqual(scan(source, "agents/runner.ts"), findings, source);
});

test("the scan lets through what cannot start Claude Code, fixture strings included", () => {
  const harmless = [
    'import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";',
    'import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";',
    'import { type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";',
    'import { queryOptions } from "@anthropic-ai/claude-agent-sdk";',
    'export type { Options } from "@anthropic-ai/claude-agent-sdk";',
    'import { query } from "./elsewhere.ts";',
    'type Opts = import("@anthropic-ai/claude-agent-sdk").Options;',
    '// import { query } from "@anthropic-ai/claude-agent-sdk";',
    "const fixture = 'import { query } from \"@anthropic-ai/claude-agent-sdk\";';",
  ];
  for (const source of harmless) deepStrictEqual(scan(source), [], source);
  // runner.ts's own shape: the import is a reach, which runner.ts may make, and an exported
  // function that calls the binding hands nothing on.
  deepStrictEqual(
    scan(
      'import { query } from "@anthropic-ai/claude-agent-sdk";\nexport function run() { return query({ prompt: "p" }); }',
      "agents/runner.ts",
    ),
    ["reach: imports query"],
  );
});

test("known limits: the scan does not see these forms", () => {
  const unseen = [
    // A module name built at run time.
    "const sdk = await import(`@anthropic-ai/${'claude-agent-sdk'}`);",
    'const sdk = await import("@anthropic-ai/" + "claude-agent-sdk");',
    // A fixed module name without the package name in it: a package.json "imports" alias, a
    // package alias, and a tsconfig paths alias.
    'import { query } from "#sdk";',
    'import { query } from "agent-sdk";',
    'import { query } from "@sdk/core";',
    // Starting the Claude Code binary without the SDK, and code evaluated from a string.
    'import { spawn } from "node:child_process";\nspawn("claude", ["-p", "hello"]);',
    "eval('import(\"@anthropic-ai/claude-agent-sdk\")');",
  ];
  for (const source of unseen) deepStrictEqual(scan(source), [], source);
  // runner.ts handing its binding on by a route other than an export statement whose value is it.
  const imports = 'import { query } from "@anthropic-ai/claude-agent-sdk";\n';
  const routes = [
    "export const sdk = { query };",
    "export function get() { return query; }",
    "export function hand(take: (q: unknown) => void) { take(query); }",
    "let handOn;\nhandOn = query;\nexport { handOn };",
    "(globalThis as Record<string, unknown>).sdkQuery = query;",
  ];
  for (const route of routes) deepStrictEqual(scan(imports + route, "agents/runner.ts"), ["reach: imports query"], route);
});

/** Every code file in the server package, outside node_modules and dot-directories. */
function codeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return codeFiles(path);
    return CODE_FILE.test(entry.name) ? [path] : [];
  });
}

test("the scan reads JavaScript and test files as well as TypeScript modules", () => {
  for (const name of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "a.test.ts", "a.d.ts"]) {
    ok(CODE_FILE.test(name), name);
  }
  deepStrictEqual(scan('import { query } from "@anthropic-ai/claude-agent-sdk";', "plain.js"), ["reach: imports query"]);
});

test("only agents/runner.ts reaches query, startup or prewarm, and no module hands them on", () => {
  const server = fileURLToPath(new URL("../../", import.meta.url));
  const files = codeFiles(server).map((file) => ({
    path: relative(server, file).split(sep).join("/"),
    findings: scanSource(file, readFileSync(file, "utf-8")),
  }));
  const paths = files.map((file) => file.path);
  ok(paths.includes("src/agents/runner.test.ts"), "the scan reads test files");
  ok(paths.includes("src/agents/querySeam.test.ts"), "the scan reads its own file");

  const runner = files.find((file) => file.path === "src/agents/runner.ts");
  deepStrictEqual(
    runner?.findings.map((finding) => `${finding.kind}: ${finding.detail}`),
    ["reach: imports query"],
    "the scan sees runner.ts's own import, and runner.ts hands nothing on",
  );
  const refused = files.flatMap((file) =>
    file.findings
      .filter((finding) => finding.kind === "hand-on" || file.path !== "src/agents/runner.ts")
      .map((finding) => `${file.path}:${finding.line} ${finding.detail}`),
  );
  deepStrictEqual(refused, [], "modules that reach or hand on the SDK functions that start Claude Code");
});
