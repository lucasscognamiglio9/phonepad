const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {verifyIOSExport}=require('../scripts/verify-ios-export.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'phonepad-export-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const project=path.join(root,'project'),output=path.join(root,'output');fs.mkdirSync(output);
 const sources=['/src/screens/control.tsx','/src/components/native-keyboard.tsx','/src/components/session-options.tsx','/src/components/attachment-transfer.tsx','/src/lib/updates.ts'];
 const sourcesContent=sources.map(name=>`// current ${name}\n`);
 for(let i=0;i<sources.length;i++){const file=path.join(project,sources[i]);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,sourcesContent[i]);}
 fs.writeFileSync(path.join(output,'metadata.json'),JSON.stringify({fileMetadata:{ios:{bundle:'app.hbc'}}}));
 fs.writeFileSync(path.join(output,'app.hbc'),Buffer.from('c61fbc03c103191f','hex'));
 const map={sources,sourcesContent};const save=()=>fs.writeFileSync(path.join(output,'app.hbc.map'),JSON.stringify(map));save();
 return {project,output,map,save};
}
test('publication verification rejects an export containing previous source even if the copied project is current',t=>{
 const h=fixture(t);assert.equal(verifyIOSExport(h.output,h.project).matchedSourceFiles,5);
 h.map.sourcesContent[2]='// stale slider';h.save();assert.throws(()=>verifyIOSExport(h.output,h.project),/stale or unexpected source/);
});
test('publication verification requires the actual app modules, not only framework code',t=>{
 const h=fixture(t);h.map.sources[0]='/node_modules/other-app/control.tsx';h.save();assert.throws(()=>verifyIOSExport(h.output,h.project),/Missing current PhonePad source/);
});
