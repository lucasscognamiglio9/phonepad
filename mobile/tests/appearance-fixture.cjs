const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const appearance={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/components/appearance.ts'),'utf8'),{compilerOptions:{module:1}}).outputText,{exports:appearance});
module.exports=appearance;
