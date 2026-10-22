import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const sourceRoot = path.resolve(__dirname, '../src');

function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : [];
  });
}

function dependencies(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) specifier = node.arguments[0];
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      imports.push(path.resolve(path.dirname(file), specifier.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

test('Runtime consumes ports rather than concrete surfaces, connectors or evaluation adapters', () => {
  for (const file of sources(path.join(sourceRoot, 'runtime'))) {
    for (const dependency of dependencies(file)) {
      const relative = path.relative(sourceRoot, dependency);
      assert.doesNotMatch(relative, /^(surfaces|connectors|eval)(\/|$)/,
        `${path.relative(sourceRoot, file)} imports ${relative}`);
    }
  }
});

test('Event admission and storage do not import a session runner or a concrete surface', () => {
  for (const name of ['event.ts', 'dispatcher.ts', 'store.ts', 'file-event-store.ts']) {
    for (const dependency of dependencies(path.join(sourceRoot, 'events', name))) {
      assert.doesNotMatch(path.relative(sourceRoot, dependency), /^(runtime|surfaces|capabilities)(\/|$)/);
    }
  }
});
