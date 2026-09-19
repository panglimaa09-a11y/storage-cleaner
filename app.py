import os, json, shutil, threading, time, webbrowser
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from ctypes import windll

HOST="127.0.0.1"
PORT=8765
PAGE_SIZE=200
ROOT=Path.home()/".storage-cleaner"
QUARANTINE=ROOT/"quarantine"
QUARANTINE.mkdir(parents=True, exist_ok=True)

state={"files":[],"scanning":False,"last_scan":None,"error":None}

PROTECTED_ROOTS=[
    os.environ.get("WINDIR","C:\\Windows"),
    os.environ.get("ProgramFiles","C:\\Program Files"),
    os.environ.get("ProgramFiles(x86)","C:\\Program Files (x86)"),
]
SAFE_TEMP_NAMES={"temp","tmp","cache","logs"}

def drives():
    out=[]
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        p=f"{letter}:\\"
        if os.path.exists(p):
            try:
                total,free=win32_space(p)
            except Exception:
                total=free=0
            out.append({"path":p,"total":total,"free":free})
    return out

def win32_space(path):
    total=free=0
    if os.name=="nt":
        free_b=windll.kernel32.GetDiskFreeSpaceExW
        import ctypes
        a=ctypes.c_ulonglong(); b=ctypes.c_ulonglong(); c=ctypes.c_ulonglong()
        free_b(ctypes.c_wchar_p(path), ctypes.byref(a), ctypes.byref(b), ctypes.byref(c))
        free=int(a.value); total=int(c.value)
    return total,free

def norm(p): return os.path.normcase(os.path.abspath(p))

def classify(path, size):
    n=norm(path)
    for r in PROTECTED_ROOTS:
        if n.startswith(norm(r)+os.sep) or n==norm(r):
            return "protected","Jangan Hapus"
    low=n.lower()
    parts=[x for x in low.replace("/","\\").split("\\") if x]
    if any(x in SAFE_TEMP_NAMES for x in parts):
        return "safe","Aman"
    ext=Path(path).suffix.lower()
    if ext in {".exe",".dll",".sys",".msi",".com",".bat",".cmd",".ps1"}:
        return "review","Perlu Dicek"
    if size>=5*1024**3:
        return "review","Perlu Dicek"
    return "review","Perlu Dicek"

def scan():
    state["scanning"]=True; state["error"]=None
    files=[]
    try:
        for d in drives():
            root=d["path"]
            for base, dirs, names in os.walk(root, topdown=True):
                dirs[:] = [x for x in dirs if x not in {"System Volume Information","$Recycle.Bin"}]
                for name in names:
                    p=os.path.join(base,name)
                    try:
                        st=os.stat(p, follow_symlinks=False)
                        if not os.path.isfile(p): continue
                        kind,status=classify(p, st.st_size)
                        files.append({"path":p,"name":name,"size":st.st_size,"status":status,"kind":kind,"ext":Path(name).suffix.lower()})
                    except (PermissionError, FileNotFoundError, OSError):
                        continue
        files.sort(key=lambda x:x["size"], reverse=True)
        state["files"]=files
        state["last_scan"]=time.strftime("%Y-%m-%d %H:%M:%S")
    except Exception as e:
        state["error"]=str(e)
    finally:
        state["scanning"]=False

def json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")

HTML = """<!doctype html><html><head><meta charset='utf-8'><title>Storage Cleaner</title>
<style>
body{font-family:Segoe UI,Arial;background:#0b1020;color:#eef;padding:24px;margin:0}
h1{margin:0 0 14px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
button,input,select{background:#151d35;color:#fff;border:1px solid #2b395d;border-radius:8px;padding:9px}
button{cursor:pointer}.stats{display:flex;gap:12px;flex-wrap:wrap}.card{background:#121a2c;border:1px solid #263452;border-radius:12px;padding:12px;min-width:150px}
table{width:100%;border-collapse:collapse;margin-top:14px;background:#10172a}th,td{padding:9px;border-bottom:1px solid #23304b;text-align:left;font-size:13px}th{position:sticky;top:0;background:#18223b}
.safe{color:#55d88b}.review{color:#f4c95d}.protected{color:#ff6b6b}.muted{color:#91a1bf}.pager{margin-top:12px;display:flex;gap:8px;align-items:center}
.path{max-width:620px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style></head><body>
<h1>Storage Cleaner Desktop</h1>
<div class='toolbar'><button onclick='scan()'>Scan Semua Storage</button><button onclick='sync()'>Sinkron Sekarang</button><label><input id='auto' type='checkbox' onchange='toggleAuto()'> Sinkron otomatis 2 menit</label><input id='q' placeholder='Cari nama/path...' oninput='load()'><select id='sort' onchange='load()'><option value='desc'>Terbesar</option><option value='asc'>Terkecil</option></select><select id='status' onchange='load()'><option value=''>Semua</option><option>Aman</option><option>Perlu Dicek</option><option>Jangan Hapus</option></select></div>
<div class='stats' id='stats'></div><div id='msg' class='muted'></div>
<table><thead><tr><th>Nama</th><th>Ukuran</th><th>Status</th><th>Lokasi</th></tr></thead><tbody id='rows'></tbody></table>
<div class='pager'><button onclick='prev()'>Sebelumnya</button><span id='page'></span><button onclick='next()'>Berikutnya</button></div>
<script>
let page=0, size=200, timer=null;
const esc=s=>String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const fmt=n=>{n=Number(n); if(n<1024)return n+' B'; let u=['KB','MB','GB','TB'],i=-1; do{n/=1024;i++}while(n>=1024&&i<u.length-1); return n.toFixed(n>=10?1:2)+' '+u[i]};
async function api(u){let r=await fetch(u); if(!r.ok) throw new Error((await r.text())||r.statusText); return r.json();}
async function load(){try{let q=encodeURIComponent(document.getElementById('q').value);let s=encodeURIComponent(document.getElementById('status').value);let sort=document.getElementById('sort').value;let d=await api('/api/files?page='+page+'&size='+size+'&q='+q+'&status='+s+'&sort='+sort);document.getElementById('rows').innerHTML=d.items.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+fmt(x.size)+'</td><td class="'+x.kind+'">'+esc(x.status)+'</td><td class="path" title="'+esc(x.path)+'">'+esc(x.path)+'</td></tr>').join('')||'<tr><td colspan="4" class="muted">Tidak ada file pada filter ini.</td></tr>';document.getElementById('page').textContent='Halaman '+(page+1)+' / '+Math.max(1,Math.ceil(d.total/size));}catch(e){document.getElementById('msg').textContent='Internal Server Error: '+e.message}}
async function stats(){try{let d=await api('/api/stats');document.getElementById('stats').innerHTML='<div class="card">File<br><b>'+d.total_files+'</b></div><div class="card">Total<br><b>'+fmt(d.total_size)+'</b></div><div class="card">Aman<br><b>'+d.safe+'</b></div><div class="card">Perlu Dicek<br><b>'+d.review+'</b></div><div class="card">Jangan Hapus<br><b>'+d.protected+'</b></div><div class="card">Scan<br><b>'+(d.scanning?'berjalan':'selesai')+'</b></div>';}catch(e){document.getElementById('msg').textContent='Status error: '+e.message}}
async function scan(){document.getElementById('msg').textContent='Scanning storage...';try{await fetch('/api/scan',{method:'POST'});page=0;load();stats();poll()}catch(e){document.getElementById('msg').textContent=e.message}}
async function sync(){await scan()}
function prev(){if(page>0){page--;load()}}
function next(){page++;load()}
function toggleAuto(){if(document.getElementById('auto').checked){timer=setInterval(()=>{scan()},120000)}else if(timer){clearInterval(timer);timer=null}}
function poll(){let t=setInterval(async()=>{await stats();if(!(await api('/api/status')).scanning){clearInterval(t);load();document.getElementById('msg').textContent='Scan selesai.'}},1000)}
load();stats();
</script></body></html>"""

class Handler(BaseHTTPRequestHandler):
    def sendj(self,obj,code=200):
        b=json_bytes(obj); self.send_response(code); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        p=urlparse(self.path)
        if p.path=="/":
            b=HTML.encode(); self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b); return
        if p.path=="/api/status": self.sendj({"scanning":state["scanning"],"last_scan":state["last_scan"],"error":state["error"]}); return
        if p.path=="/api/stats":
            f=state["files"]; self.sendj({"total_files":len(f),"total_size":sum(x["size"] for x in f),"safe":sum(x["status"]=="Aman" for x in f),"review":sum(x["status"]=="Perlu Dicek" for x in f),"protected":sum(x["status"]=="Jangan Hapus" for x in f),"scanning":state["scanning"]}); return
        if p.path=="/api/files":
            q=parse_qs(p.query); pg=max(0,int(q.get("page",["0"])[0])); sz=min(500,max(1,int(q.get("size",["200"])[0]))); term=q.get("q",[""])[0].lower(); st=q.get("status",[""])[0]; order=q.get("sort",["desc"])[0]
            arr=[x for x in state["files"] if (not term or term in x["name"].lower() or term in x["path"].lower()) and (not st or x["status"]==st)]
            arr.sort(key=lambda x:x["size"], reverse=order!="asc"); self.sendj({"items":arr[pg*sz:(pg+1)*sz],"total":len(arr),"page":pg,"size":sz}); return
        self.sendj({"error":"not found"},404)
    def do_POST(self):
        p=urlparse(self.path)
        if p.path=="/api/scan":
            if state["scanning"]: self.sendj({"ok":True,"already":True}); return
            threading.Thread(target=scan,daemon=True).start(); self.sendj({"ok":True}); return
        self.sendj({"error":"not found"},404)
    def log_message(self,fmt,*args): pass

if __name__=="__main__":
    threading.Thread(target=lambda:webbrowser.open(f"http://{HOST}:{PORT}"),daemon=True).start()
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
