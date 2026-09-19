# Storage Cleaner Desktop

Windows storage scanner with file-size sorting, safety classification, pagination and automatic rescan.

## Run locally
```powershell
py app.py
```

The app opens http://127.0.0.1:8765 automatically.

## Build Windows EXE
Use the GitHub Actions workflow in .github/workflows/build-windows.yml. It creates a portable Windows executable artifact.

> The scanner intentionally classifies protected Windows/Program Files locations as "Jangan Hapus". It does not permanently delete files.
