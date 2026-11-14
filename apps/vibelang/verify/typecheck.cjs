const {Project, ts} = require('../../../packages/lemmascript/node_modules/ts-morph');
const fs = require('fs');
const path = require('path');
// --json prints {files, diagnostics: {file: text}} and exits 0 whatever it finds, so a mutation run can tell an
// ill-typed mutant from a broken dependency (check.py); a diagnostic with no file is keyed "".
const json = process.argv[2] === '--json';
const inputs = process.argv.slice(json ? 3 : 2).map(value => path.resolve(value));
const project = new Project({compilerOptions:{strict:true,noEmit:true,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,skipLibCheck:true,types:[]}});
function scan(p) {
 for(const entry of fs.readdirSync(p,{withFileTypes:true})) {
  if(['node_modules','.tools','.checks'].includes(entry.name)) continue;
  const file=path.join(p,entry.name);
  if(entry.isDirectory()) scan(file);
  else if(entry.name.endsWith('.ts')) project.addSourceFileAtPath(file);
 }
}
for (const input of inputs) {
 if(fs.statSync(input).isFile()) project.addSourceFileAtPath(input); else scan(input);
}
if (project.getSourceFiles().length === 0) { console.error('No proof sources selected for strict typechecking'); process.exit(1); }
const diagnostics=project.getPreEmitDiagnostics();
if(json){
 const host={getCanonicalFileName:f=>f,getCurrentDirectory:()=>process.cwd(),getNewLine:()=>'\n'};
 const byFile={};
 for(const d of diagnostics){
  const file=d.getSourceFile()?.getFilePath() ?? '';
  byFile[file]=(byFile[file] ?? '')+ts.formatDiagnostic(d.compilerObject,host);
 }
 process.stdout.write(JSON.stringify({files:project.getSourceFiles().length,diagnostics:byFile}));
} else if(diagnostics.length){process.stderr.write(project.formatDiagnosticsWithColorAndContext(diagnostics));process.exitCode=1;}
else console.log(`TypeScript: ${project.getSourceFiles().length} files checked (strict)`);
