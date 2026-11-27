import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Each harness gets real, isolated Zustand/settings/editor stores. Only the Tauri
// transport and clock are replaced; TS source is executed, not reimplemented.
const compiled = new Map();
export function createTypeScriptLoader({ invoke, setTimeout, clearTimeout, window, confirm }) {
  const modules = new Map();
  const context = vm.createContext({
    console, performance, Event, CustomEvent, crypto, window, setTimeout, clearTimeout,
  });
  function load(filename) {
    filename = resolve(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const source = readFileSync(filename, 'utf8');
    let entry = compiled.get(filename);
    if (entry?.source !== source) {
      entry = { source, code: ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        fileName: filename,
      }).outputText };
      compiled.set(filename, entry);
    }
    const nativeRequire = createRequire(filename);
    const require = (id) => {
      if (id === '@tauri-apps/api/core') return { invoke };
      if (id === '@tauri-apps/plugin-dialog') return { confirm: (...args) => {
        if (!confirm) throw new Error('Unexpected native confirmation in test');
        return confirm(...args);
      } };
      if (id.startsWith('.')) {
        const target = resolve(dirname(filename), id);
        for (const candidate of [target, `${target}.ts`, resolve(target, 'index.ts')]) {
          if (existsSync(candidate) && candidate.endsWith('.ts')) return load(candidate);
        }
      }
      return nativeRequire(id);
    };
    const run = vm.runInContext(`(function(require, module, exports) {\n${entry.code}\n})`, context, { filename });
    run(require, module, module.exports);
    return module.exports;
  }
  load.functions = (filename, names, bindings = {}) => {
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found = new Map();
    const visit = node => {
      const name = node.name?.getText(source);
      if (names.includes(name)) {
        if (ts.isFunctionDeclaration(node)) found.set(name, node.getText(source).replace(/^export\s+/, ''));
        else {
          let value = node.initializer;
          if (value && ts.isJsxExpression(value)) value = value.expression;
          if (value && ts.isCallExpression(value) && value.expression.getText(source) === 'useCallback') value = value.arguments[0];
          if (value) found.set(name, `const ${name} = ${value.getText(source)};`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const name of names) if (!found.has(name)) throw new Error(`Missing source function: ${name}`);
    const code = ts.transpileModule(`${names.map(name => found.get(name)).join('\n')}\nreturn { ${names.join(', ')} };`, {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText;
    return vm.runInContext(`(function(${Object.keys(bindings).join(', ')}) { ${code} })`, context, { filename })(...Object.values(bindings));
  };
  return load;
}
