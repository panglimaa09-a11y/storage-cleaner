const {app,BrowserWindow,ipcMain,shell}=require('electron');
const fs=require('fs'),path=require('path');
let win, scanning=false, cancelScan=false;
function drives(){const out=[];for(let i=65;i<=90;i++){const d=String.fromCharCode(i)+':\\';try{if(fs.existsSync(d))out.push(d)}catch{}}return out}
const protectedRoots=[process.env.WINDIR||'C:\\Windows',process.env.ProgramFiles||'C:\\Program Files',process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)',process.env.ProgramData||'C:\\ProgramData'].map(p=>path.resolve(p).toLowerCase());
function classify(p,size){const n=path.resolve(p).toLowerCase(),ext=path.extname(p).toLowerCase();if(protectedRoots.some(r=>n===r||n.startsWith(r+path.sep)))return ['Jangan Hapus','Lokasi sistem/aplikasi'];if(['.exe','.dll','.sys','.msi','.bat','.cmd','.ps1','.com'].includes(ext))return ['Jangan Hapus','Executable/sistem'];const parts=n.split(path.sep);if(parts.some(x=>['temp','tmp','cache'].includes(x))||['.tmp','.temp','.cache','.log'].includes(ext))return ['Aman','Temporary/cache terdeteksi'];if(size>=1024**3)return ['Perlu Dicek','File besar; ukuran bukan bukti sampah'];return ['Perlu Dicek','File pengguna']}
async function scan(){
 const files=[],blocked=[],roots=drives();let dirs=0;
 const emit=()=>win&&win.webContents.send('scan-progress',{files:files.slice(-250),fileCount:files.length,total:files.reduce((a,x)=>a+x.size,0),blockedCount:blocked.length,dirs,roots,done:false});
 for(const root of roots){const stack=[root];while(stack.length&&!cancelScan){const dir=stack.pop();dirs++;
  let entries;try{entries=await fs.promises.readdir(dir,{withFileTypes:true})}catch(e){blocked.push({path:dir,error:e.code||'ACCESS_DENIED'});emit();continue}
  for(const ent of entries){if(cancelScan)break;const p=path.join(dir,ent.name);try{
   if(ent.isDirectory()){if(ent.name==='$Recycle.Bin'||ent.name==='System Volume Information')continue;stack.push(p)}
   else if(ent.isFile()){const st=await fs.promises.stat(p),c=classify(p,st.size);files.push({name:ent.name,path:p,size:st.size,status:c[0],reason:c[1]});if(files.length%100===0)emit()}
  }catch(e){blocked.push({path:p,error:e.code||'ACCESS_DENIED'})}
  }
  if(dirs%25===0)emit();
 }}
 files.sort((a,b)=>b.size-a.size);win&&win.webContents.send('scan-progress',{files:files.slice(-250),fileCount:files.length,total:files.reduce((a,x)=>a+x.size,0),blockedCount:blocked.length,dirs,roots,done:true,allFiles:files,blocked});
 scanning=false;cancelScan=false;return {ok:true}
}
ipcMain.handle('scan-start',async()=>{if(scanning)return {ok:false,reason:'already-running'};scanning=true;cancelScan=false;scan().catch(e=>{scanning=false;win&&win.webContents.send('scan-error',{message:e.message})});return {ok:true}});
ipcMain.handle('scan-cancel',()=>{cancelScan=true;return {ok:true}});
ipcMain.handle('trash-files',async(_,paths)=>{let ok=0,failed=[];for(const p of paths){try{await shell.trashItem(p);ok++}catch(e){failed.push({path:p,error:e.message})}}return {ok,failed}});
function create(){win=new BrowserWindow({width:1500,height:950,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});win.loadFile(path.join(__dirname,'index.html'))}
app.whenReady().then(create);app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});