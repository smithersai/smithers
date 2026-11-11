// The files TypeScript reads for each staged proof root: what LemmaScript's ts-morph project loads when `lsc gen` reads
// that root under the run's tsconfig (lsc.ts finds the nearest tsconfig.json). proof_cache.py keys a reused proof on them.
const path = require("node:path");
const { ts } = require(path.resolve(__dirname, "../../../packages/lemmascript/node_modules/ts-morph"));
const [config, ...roots] = process.argv.slice(2);
const parsed = ts.getParsedCommandLineOfConfigFile(path.resolve(config), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(d) { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); },
});
if (!parsed) throw new Error("Cannot read " + config);
const host = ts.createCompilerHost(parsed.options);
const parsedFiles = new Map();
const read = host.getSourceFile.bind(host);
// One parse per file across roots; each root still gets its own program and so its own resolution.
host.getSourceFile = (name, version, onError, fresh) => {
  const key = name + "\0" + JSON.stringify(version);
  if (fresh || !parsedFiles.has(key)) parsedFiles.set(key, read(name, version, onError, fresh));
  return parsedFiles.get(key);
};
const inputs = {};
for (const root of roots) {
  const program = ts.createProgram({ rootNames: [path.resolve(root)], options: parsed.options, host });
  inputs[root] = program.getSourceFiles().map((file) => path.resolve(file.fileName)).sort();
  if (!inputs[root].includes(path.resolve(root))) throw new Error("TypeScript did not read the proof root " + root);
}
const version = require(path.resolve(__dirname, "../../../packages/lemmascript/node_modules/ts-morph/package.json")).version;
process.stdout.write(JSON.stringify({ typescript: ts.version, tsMorph: version, inputs }));
