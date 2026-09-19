const {app,BrowserWindow,ipcMain,shell}=require('electron');
const fs=require('fs');
const path=require('path');
const os=require('os');
let win;
function drives(){
  const out=[];
  for(let i=65;i<=90;i++){
    const d=String.fromCharCode(i)+':\\';
    try{if(fs.existsSync(d)) out.push(d)}catch{}
  }
  return out;
}
const protectedRoots=[
  process.env.WINDIR||'C:\\Windows',
  process.env.ProgramFiles||'C:\\Program Files',
  process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)',
  process.env.ProgramData||'C:\\ProgramData'
].map(p=>path.resolve(p).toLowerCase());
function classify(p,size){
  const n=path.resolve(p).toLowerCase(), ext=path.extname(p).toLowerCase();
  if(protectedRoots.some(r=>n===r||n.startsWith(r+path.sep))) return ['Jangan Hapus','Lokasi sistem/aplikasi'];
  if(['.exe','.dll','.sys','.msi','.bat','.cmd','.ps1','.com'].includes(ext)) return ['Jangan Hapus','File executable/sistem'];
  const parts=n.split(path.sep);
  if(parts.some(x=>['temp','tmp','cache'].includes(x))||['.tmp','.temp','.cache','.log'].includes(ext)) return ['Aman','Temporary/cache terdeteksi'];
  if(size>=1024**3) return ['Perlu Dicek','File besar; ukuran bukan bukti file sampah'];
  return ['Perlu Dicek','File pengguna'];
}
async function scan(){
  const files=[], inaccessible=[];
  const roots=drives();
  for(const root of roots){
    const stack=[root];
    while(stack.length){
      const dir=stack.pop();
      let entries;
      try{entries=await fs.promises.readdir(dir,{withFileTypes:true})}catch(e){inaccessible.push({path:dir,error:e.code||'ACCESS_DENIED'});continue}
      for(const ent of entries){
        const p=path.join(dir,ent.name);
        try{
          if(ent.isDirectory()){
            if(ent.name==='$Recycle.Bin'||ent.name==='System Volume Information') continue;
            stack.push(p);
          }else if(ent.isFile()){
            const st=await fs.promises.stat(p);
            const [status,reason]=classify(p,st.size);
            files.push({name:ent.name,path:p,size:st.size,status,reason});
          }
        }catch(e){inaccessible.push({path:p,error:e.code||'ACCESS_DENIED'})}
      }
    }
  }
  files.sort((a,b)=>b.size-a.size);
  return {files,inaccessible,roots};
}
ipcMain.handle('scan-all',()=>scan());
ipcMain.handle('trash-files',async(_,paths)=>{
  let ok=0,failed=[];
  for(const p of paths){try{await shell.trashItem(p);ok++}catch(e){failed.push({path:p,error:e.message})}}
  return {ok,failed};
});
function create(){
  win=new BrowserWindow({width:1500,height:950,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});
  win.loadFile(path.join(__dirname,'index.html'));
}
app.whenReady().then(create);
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
