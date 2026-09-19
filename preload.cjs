const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('storageDesktop',{
 startScan:()=>ipcRenderer.invoke('scan-start'),
 cancelScan:()=>ipcRenderer.invoke('scan-cancel'),
 trashFiles:p=>ipcRenderer.invoke('trash-files',p),
 onProgress:cb=>ipcRenderer.on('scan-progress',(_,d)=>cb(d)),
 onError:cb=>ipcRenderer.on('scan-error',(_,d)=>cb(d))
});