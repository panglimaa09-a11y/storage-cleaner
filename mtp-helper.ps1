param(
  [ValidateSet("list","scan","delete")]
  [string]$Mode="list",
  [string]$TargetPath="",
  [string]$DeletePathsJson=""
)

$ErrorActionPreference="Stop"
$shell = New-Object -ComObject Shell.Application
$thisPc = $shell.Namespace(17)

function Get-ItemChildren($folderItem) {
  try {
    $folder = $folderItem.GetFolder()
    if ($null -eq $folder) { return @() }
    return @($folder.Items())
  } catch { return @() }
}

function Get-DeviceRoots {
  $out = @()
  foreach($item in @($thisPc.Items())) {
    try {
      $folder = $item.GetFolder()
      if ($null -ne $folder -and $item.IsFolder) {
        $children = Get-ItemChildren $item
        $hasStorage = $false
        foreach($child in $children) {
          if($child.IsFolder) { $hasStorage = $true; break }
        }
        if($hasStorage) {
          $out += [pscustomobject]@{
            name=[string]$item.Name
            path=[string]$item.Path
            type="WPD/MTP"
          }
        }
      }
    } catch {}
  }
  return $out
}

function Get-DeviceFolderByPath($path) {
  if([string]::IsNullOrWhiteSpace($path)) { return $null }
  foreach($item in @($thisPc.Items())) {
    try {
      if([string]$item.Path -eq $path) { return $item }
      $stack = New-Object System.Collections.Stack
      $stack.Push($item)
      while($stack.Count -gt 0) {
        $cur=$stack.Pop()
        if([string]$cur.Path -eq $path) { return $cur }
        foreach($child in (Get-ItemChildren $cur)) {
          if($child.IsFolder) { $stack.Push($child) }
        }
      }
    } catch {}
  }
  return $null
}

function Is-ProtectedMtpPath($p) {
  $l=$p.ToLowerInvariant()
  return (
    $l -match '\\android\\data(\\|$)' -or
    $l -match '\\android\\obb(\\|$)' -or
    $l -match '\\android\\media(\\|$)' -or
    $l -match '\\android\\.*' -or
    $l -match '\\data(\\|$)' -or
    $l -match '\\obb(\\|$)' -or
    $l -match '\\system(\\|$)' -or
    $l -match '\\windows(\\|$)'
  )
}

function Classify-Mtp($item,$fullPath) {
  $name=[string]$item.Name
  $ext=[IO.Path]::GetExtension($name).ToLowerInvariant()
  $l=$fullPath.ToLowerInvariant()

  if(Is-ProtectedMtpPath $fullPath) {
    return @{status="Jangan Hapus";reason="Folder Android/sistem; tidak disentuh oleh cleaner";canTrash=$false}
  }

  if($l -match '\\(cache|temp|tmp)(\\|$)' -or $ext -in @(".tmp",".temp",".cache")) {
    return @{status="Perlu Dicek";reason="Cache/temp pada MTP; periksa aplikasi pemilik sebelum menghapus";canTrash=$false}
  }

  if($ext -in @(".jpg",".jpeg",".png",".webp",".mp4",".mkv",".mov",".mp3",".wav",".zip",".rar",".7z")) {
    return @{status="Perlu Dicek";reason="File pengguna; ukuran dan ekstensi saja tidak cukup untuk menganggap aman";canTrash=$false}
  }

  return @{status="Perlu Dicek";reason="File pada HP; jangan diasumsikan aman dihapus";canTrash=$false}
}

function Scan-MtpFolder($folderItem,$prefix,[int]$Depth=0) {
  if($Depth -gt 30) { return }
  foreach($item in (Get-ItemChildren $folderItem)) {
    try {
      $p = if([string]::IsNullOrWhiteSpace($prefix)){[string]$item.Name}else{"$prefix\$($item.Name)"}
      if($item.IsFolder) {
        Scan-MtpFolder $item $p ($Depth+1)
      } else {
        $size=0
        try {$size=[int64]$item.Size} catch {}
        $c=Classify-Mtp $item $p
        [pscustomobject]@{
          name=[string]$item.Name
          path=$p
          size=$size
          status=$c.status
          reason=$c.reason
          canTrash=$c.canTrash
          type="MTP"
        }
      }
    } catch {}
  }
}

if($Mode -eq "list") {
  Get-DeviceRoots | ConvertTo-Json -Compress
  exit
}

if($Mode -eq "scan") {
  $root=Get-DeviceFolderByPath $TargetPath
  if($null -eq $root) { throw "Perangkat/storage MTP tidak ditemukan. Pastikan HP terbuka dan mode USB File Transfer (MTP) aktif." }
  @(Scan-MtpFolder $root ([string]$root.Name)) | ConvertTo-Json -Compress -Depth 5
  exit
}

if($Mode -eq "delete") {
  $paths=@()
  if($DeletePathsJson) { $paths=@($DeletePathsJson | ConvertFrom-Json) }
  $result=@()
  foreach($p in $paths) {
    $result += [pscustomobject]@{path=[string]$p;ok=$false;error="MTP deletion is intentionally disabled until a device-specific safe delete flow is implemented"}
  }
  $result | ConvertTo-Json -Compress
  exit
}
