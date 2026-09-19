const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('storageDesktop',{
  scanAll:()=>ipcRenderer.invoke('scan-all'),
  trashFiles:(paths)=>ipcRenderer.invoke('trash-files',paths)
});