const {Project, ts} = require('./.tools/npm/node_modules/ts-morph');
const fs = require('fs');
const path = require('path');
const inputs = process.argv.slice(2).map(value => path.resolve(value));
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
if(diagnostics.length){process.stderr.write(project.formatDiagnosticsWithColorAndContext(diagnostics));process.exit(1);}
console.log(`TypeScript: ${project.getSourceFiles().length} files checked (strict)`);
