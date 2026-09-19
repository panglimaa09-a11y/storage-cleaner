const {app,BrowserWindow,ipcMain,shell}=require('electron');
const fs=require('fs');
const fsp=fs.promises;
const path=require('path');
const {execFile}=require('child_process');
const os=require('os');

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

const protectedNames=new Set([
  'system volume information',
  '$recycle.bin',
  'windowsapps',
  'recovery',
  'config.msi',
  '$winreagent'
]);

const systemExts=new Set([
  '.sys','.dll','.exe','.msi','.ocx','.drv','.cpl','.efi'
]);

const tempExts=new Set(['.tmp','.temp','.cache']);
const dirDeleteAccessCache=new Map();

function isUnder(p,root){return p===root||p.startsWith(root+path.sep)}

function isProtectedPath(filePath){
  const n=path.resolve(filePath).toLowerCase();
  if(protectedRoots.some(r=>isUnder(n,r)))return true;

  const relative=n.split(path.sep);
  return relative.some(part=>protectedNames.has(part));
}

async function canDeleteFromDirectory(dir){
  const key=path.resolve(dir).toLowerCase();
  if(dirDeleteAccessCache.has(key))return dirDeleteAccessCache.get(key);

  let ok=false;
  try{
    // This is a low-cost preflight only. Windows ACLs can still reject a
    // later Recycle Bin operation, so the actual trash operation is guarded too.
    await fsp.access(dir,fs.constants.W_OK);
    ok=true;
  }catch{}

  dirDeleteAccessCache.set(key,ok);
  return ok;
}

async function classify(filePath,size){
  const n=path.resolve(filePath).toLowerCase();
  const ext=path.extname(filePath).toLowerCase();

  if(isProtectedPath(filePath))
    return {
      status:'Jangan Hapus',
      reason:'Lokasi Windows/aplikasi/metadata yang dilindungi',
      canTrash:false
    };

  if(systemExts.has(ext))
    return {
      status:'Jangan Hapus',
      reason:'File sistem/aplikasi; jangan hapus dari Storage Cleaner',
      canTrash:false
    };

  const parts=n.split(path.sep);
  const tempLocation=parts.some(x=>['temp','tmp','cache'].includes(x));
  const tempCandidate=tempLocation||tempExts.has(ext);

  if(tempCandidate){
    const parentWritable=await canDeleteFromDirectory(path.dirname(filePath));
    if(parentWritable){
      return {
        status:'Aman',
        reason:'File sementara/cache dan folder induk lolos pemeriksaan akses awal',
        canTrash:true
      };
    }
    return {
      status:'Perlu Dicek',
      reason:'File sementara terdeteksi, tetapi folder induk tidak lolos pemeriksaan akses awal',
      canTrash:false
    };
  }

  if(size>=5*1024**3)
    return {
      status:'Perlu Dicek',
      reason:'File sangat besar; ukuran saja bukan alasan untuk menghapus',
      canTrash:false
    };

  if(size>=1024**3)
    return {
      status:'Perlu Dicek',
      reason:'File besar; periksa pemilik dan kegunaannya',
      canTrash:false
    };

  return {
    status:'Perlu Dicek',
    reason:'File pengguna; tidak boleh diasumsikan aman dihapus',
    canTrash:false
  };
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
  dirDeleteAccessCache.clear();

  const publish=(done=false,current='')=>{
    const total=files.reduce((sum,x)=>sum+x.size,0);
    send('scan-progress',{
      done,current,roots:drives,dirs,processed,
      fileCount:files.length,total,blockedCount:blocked.length,
      files:files.slice(-250),
      allFiles:done?files:undefined,
      blocked:done?blocked:undefined,
      elapsedMs:Date.now()-started
    });
  };

  async function walk(root){
    const stack=[root];

    while(stack.length&&!cancelScan){
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
            let st;
            try{st=await fsp.lstat(full)}catch{continue}
            if(st.isSymbolicLink())continue;
            stack.push(full);
          }else if(entry.isFile()){
            const st=await fsp.stat(full);
            const info=await classify(full,st.size);
            files.push({
              name:entry.name,
              path:full,
              size:st.size,
              modified:st.mtimeMs,
              status:info.status,
              reason:info.reason,
              canTrash:info.canTrash
            });
            processed++;
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



function runMtpHelper(mode,args=[]){
  return new Promise((resolve,reject)=>{
    const helperPath=path.join(__dirname,'mtp-helper.ps1');
    const psArgs=[
      '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',helperPath,'-Mode',mode
    ];
    if(mode==='scan')psArgs.push('-TargetPath',String(args[0]||''));
    execFile('powershell.exe',psArgs,{windowsHide:true,maxBuffer:64*1024*1024},(error,stdout,stderr)=>{
      if(error)return reject(new Error((stderr||stdout||error.message).trim()));
      try{resolve(stdout.trim()?JSON.parse(stdout):[])}
      catch(e){reject(new Error('Respons MTP tidak valid: '+e.message))}
    });
  });
}

ipcMain.handle('mtp-list',async()=>{
  try{return {ok:true,devices:await runMtpHelper('list')}}
  catch(e){return {ok:false,error:e.message,devices:[]}}
});

ipcMain.handle('mtp-scan',async(_,targetPath)=>{
  try{
    const files=await runMtpHelper('scan',[targetPath]);
    return {ok:true,files:Array.isArray(files)?files:(files?[files]:[])}
  }catch(e){
    return {ok:false,error:e.message,files:[]};
  }
});

ipcMain.handle('trash-files',async(_,paths)=>{
  let ok=0;
  const failed=[];

  for(const p of Array.isArray(paths)?paths:[]){
    try{
      const absolute=path.resolve(String(p));

      // Never allow the renderer to bypass the scanner's safety rules.
      if(isProtectedPath(absolute)){
        failed.push({path:absolute,error:'PROTECTED_PATH'});
        continue;
      }

      const st=await fsp.stat(absolute);
      if(!st.isFile()){
        failed.push({path:absolute,error:'NOT_A_FILE'});
        continue;
      }

      const info=await classify(absolute,st.size);
      if(info.status!=='Aman'||!info.canTrash){
        failed.push({path:absolute,error:'NOT_MARKED_SAFE'});
        continue;
      }

      await shell.trashItem(absolute);
      ok++;
    }catch(e){
      failed.push({path:String(p),error:e.code||e.message});
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
