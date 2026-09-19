const {app,BrowserWindow,ipcMain,shell}=require('electron');
const fs=require('fs');
const fsp=fs.promises;
const path=require('path');

let win;
let scanning=false;
let cancelScan=false;

function getDrives(){
  const out=[];
  for(let code=65;code<=90;code++){
    const root=String.fromCharCode(code)+':\\';
    try{if(fs.existsSync(root))out.push(root)}catch{}
  }
  return out;
}

const protectedRoots=[
  process.env.WINDIR||'C:\\Windows',
  process.env.ProgramFiles||'C:\\Program Files',
  process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)',
  process.env.ProgramData||'C:\\ProgramData'
].map(p=>path.resolve(p).toLowerCase());

function isUnder(p,root){return p===root||p.startsWith(root+path.sep)}

function classify(filePath,size){
  const n=path.resolve(filePath).toLowerCase();
  const ext=path.extname(filePath).toLowerCase();

  if(protectedRoots.some(r=>isUnder(n,r)))
    return ['Jangan Hapus','Lokasi Windows/aplikasi yang dilindungi'];

  if(['.sys','.dll','.exe','.msi','.ocx','.drv','.cpl'].includes(ext))
    return ['Jangan Hapus','File sistem/aplikasi'];

  const parts=n.split(path.sep);
  if(parts.some(x=>['temp','tmp','cache'].includes(x)) ||
     ['.tmp','.temp','.cache','.log','.dmp'].includes(ext))
    return ['Aman','Lokasi/file sementara terdeteksi'];

  if(size>=5*1024**3)
    return ['Perlu Dicek','File sangat besar; ukuran saja bukan alasan untuk menghapus'];

  if(size>=1024**3)
    return ['Perlu Dicek','File besar; periksa pemilik dan kegunaannya'];

  return ['Perlu Dicek','File pengguna; tidak boleh diasumsikan aman dihapus'];
}

function send(type,data){
  if(win&&!win.isDestroyed())win.webContents.send(type,data);
}

async function scan(){
  const files=[];
  const blocked=[];
  const drives=getDrives();
  let dirs=0;
  let processed=0;
  const started=Date.now();

  const publish=(done=false,current='')=>{
    const total=files.reduce((sum,x)=>sum+x.size,0);
    send('scan-progress',{
      done, current, roots:drives, dirs, processed,
      fileCount:files.length,total,blockedCount:blocked.length,
      files:files.slice(-250),
      allFiles:done?files:undefined,
      blocked:done?blocked:undefined,
      elapsedMs:Date.now()-started
    });
  };

  async function walk(root){
    const stack=[root];

    while(stack.length && !cancelScan){
      const dir=stack.pop();
      dirs++;

      let entries;
      try{
        entries=await fsp.readdir(dir,{withFileTypes:true});
      }catch(e){
        blocked.push({path:dir,error:e.code||'ACCESS_DENIED'});
        if(blocked.length%10===0)publish(false,dir);
        continue;
      }

      for(const entry of entries){
        if(cancelScan)break;

        const full=path.join(dir,entry.name);
        try{
          if(entry.isDirectory()){
            // Do not recurse into Windows junctions/symlinks. This prevents loops
            // and avoids scanning the same storage repeatedly.
            let st;
            try{st=await fsp.lstat(full)}catch{continue}
            if(st.isSymbolicLink())continue;

            // These locations contain protected metadata rather than useful user files.
            // We record access failures instead of treating them as fatal.
            if(entry.name==='$Recycle.Bin'){
              stack.push(full);
              continue;
            }
            stack.push(full);
          }else if(entry.isFile()){
            const st=await fsp.stat(full);
            const [status,reason]=classify(full,st.size);
            files.push({
              name:entry.name,
              path:full,
              size:st.size,
              modified:st.mtimeMs,
              status,
              reason
            });
            processed++;

            // Keep the UI responsive on low-end machines.
            if(processed%100===0)publish(false,full);
          }
        }catch(e){
          blocked.push({path:full,error:e.code||'ACCESS_DENIED'});
        }

        if(processed%250===0){
          await new Promise(resolve=>setImmediate(resolve));
        }
      }

      if(dirs%20===0)publish(false,dir);
    }
  }

  for(const drive of drives){
    if(cancelScan)break;
    publish(false,drive);
    await walk(drive);
  }

  files.sort((a,b)=>b.size-a.size);

  send('scan-progress',{
    done:true,
    cancelled:cancelScan,
    current:'',
    roots:drives,
    dirs,processed,
    fileCount:files.length,
    total:files.reduce((sum,x)=>sum+x.size,0),
    blockedCount:blocked.length,
    files:files.slice(-250),
    allFiles:files,
    blocked,
    elapsedMs:Date.now()-started
  });

  scanning=false;
  const wasCancelled=cancelScan;
  cancelScan=false;
  return {ok:true,cancelled:wasCancelled};
}

ipcMain.handle('scan-start',async()=>{
  if(scanning)return {ok:false,reason:'already-running'};
  scanning=true;
  cancelScan=false;
  scan().catch(error=>{
    scanning=false;
    cancelScan=false;
    send('scan-error',{message:error.message,stack:error.stack});
  });
  return {ok:true};
});

ipcMain.handle('scan-cancel',()=>{
  cancelScan=true;
  return {ok:true};
});

ipcMain.handle('trash-files',async(_,paths)=>{
  let ok=0;
  const failed=[];
  for(const p of paths){
    try{
      await shell.trashItem(p);
      ok++;
    }catch(e){
      failed.push({path:p,error:e.message});
    }
  }
  return {ok,failed};
});

function createWindow(){
  win=new BrowserWindow({
    width:1500,
    height:950,
    minWidth:1000,
    minHeight:700,
    backgroundColor:'#070b14',
    webPreferences:{
      preload:path.join(__dirname,'preload.cjs'),
      contextIsolation:true,
      nodeIntegration:false
    }
  });
  win.loadFile(path.join(__dirname,'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
