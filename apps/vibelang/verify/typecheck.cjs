const {Project, ts} = require('./.tools/npm/node_modules/ts-morph');
const fs = require('fs');
const path = require('path');
const dir = path.resolve(process.argv[2]);
const project = new Project({compilerOptions:{strict:true,noEmit:true,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,skipLibCheck:true,types:[]}});
function scan(p) {
 for(const entry of fs.readdirSync(p,{withFileTypes:true})) {
  if(['node_modules','.tools','.checks'].includes(entry.name)) continue;
  const file=path.join(p,entry.name);
  if(entry.isDirectory()) scan(file);
  else if(entry.name.endsWith('.ts')) project.addSourceFileAtPath(file);
 }
}
if(fs.statSync(dir).isFile()) project.addSourceFileAtPath(dir); else scan(dir);
const diagnostics=project.getPreEmitDiagnostics();
if(diagnostics.length){process.stderr.write(project.formatDiagnosticsWithColorAndContext(diagnostics));process.exit(1);}
console.log(`TypeScript: ${project.getSourceFiles().length} files checked (strict)`);
