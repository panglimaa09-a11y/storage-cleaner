package com.panglimaa.storagecleaner

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var web: WebView
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
            addJavascriptInterface(StorageBridge(this@MainActivity, this), "AndroidStorage")
        }
        setContentView(web)
        web.loadUrl("file:///android_asset/index.html")
    }

    override fun onDestroy() {
        executor.shutdownNow()
        web.destroy()
        super.onDestroy()
    }

    private fun hasStorageAccess(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun requestStorageAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                val intent = Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:$packageName")
                )
                startActivity(intent)
            } catch (_: Exception) {
                startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            }
        } else {
            requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE), 7001)
        }
    }

    inner class StorageBridge(private val context: Context, private val view: WebView) {
        @JavascriptInterface fun isAndroid(): Boolean = true
        @JavascriptInterface fun hasStorageAccess(): Boolean = hasStorageAccess()
        @JavascriptInterface fun requestStorageAccess() { runOnUiThread { requestStorageAccess() } }

        @JavascriptInterface
        fun startScan() {
            if (!hasStorageAccess()) {
                runOnUiThread { view.evaluateJavascript("window.onAndroidPermissionRequired && window.onAndroidPermissionRequired()", null) }
                return
            }
            executor.execute {
                val result = scanStorage()
                val js = "window.onAndroidScan && window.onAndroidScan(" + JSONObject.quote(result.toString()) + ")"
                runOnUiThread { view.evaluateJavascript(js, null) }
            }
        }

        private fun scanStorage(): JSONObject {
            val root = Environment.getExternalStorageDirectory()
            val result = JSONObject()
            val categories = JSONObject()
            val sources = JSONObject()
            var files = 0L
            var totalBytes = 0L
            var images = 0L; var imageBytes = 0L
            var videos = 0L; var videoBytes = 0L
            var audio = 0L; var audioBytes = 0L
            var docs = 0L; var docBytes = 0L
            var apks = 0L; var apkBytes = 0L
            var archives = 0L; var archiveBytes = 0L
            var cache = 0L; var temp = 0L; var large = 0L; var largeBytes = 0L

            val sourceBytes = linkedMapOf<String, Long>()
            val sourceFiles = linkedMapOf<String, Long>()
            val stack = java.util.ArrayDeque<File>()
            stack.add(root)

            fun addSource(name: String, size: Long) {
                sourceBytes[name] = (sourceBytes[name] ?: 0L) + size
                sourceFiles[name] = (sourceFiles[name] ?: 0L) + 1L
            }

            while (stack.isNotEmpty()) {
                val dir = stack.removeLast()
                val children = try { dir.listFiles() } catch (_: Exception) { null } ?: continue
                for (f in children) {
                    try {
                        if (f.isDirectory) {
                            if (f.name != "." && f.name != "..") stack.add(f)
                            continue
                        }
                        if (!f.isFile) continue
                        val size = f.length().coerceAtLeast(0L)
                        files++; totalBytes += size
                        val rel = try { f.relativeTo(root).path } catch (_: Exception) { f.name }
                        val first = rel.substringBefore(File.separatorChar, f.name).ifBlank { f.name }
                        addSource(first, size)
                        val n = f.name.lowercase(Locale.ROOT)
                        val ext = n.substringAfterLast('.', "")
                        when {
                            ext in setOf("jpg","jpeg","png","gif","webp","heic","heif","bmp","tif","tiff") -> { images++; imageBytes += size }
                            ext in setOf("mp4","mkv","mov","avi","webm","3gp","m4v","ts") -> { videos++; videoBytes += size }
                            ext in setOf("mp3","m4a","aac","wav","flac","ogg","opus","amr") -> { audio++; audioBytes += size }
                            ext in setOf("pdf","doc","docx","xls","xlsx","ppt","pptx","txt","csv","rtf","json","xml") -> { docs++; docBytes += size }
                            ext in setOf("apk","xapk","apks") -> { apks++; apkBytes += size }
                            ext in setOf("zip","rar","7z","tar","gz","bz2") -> { archives++; archiveBytes += size }
                        }
                        if (n.contains("cache")) cache += size
                        if (ext in setOf("tmp","temp","log")) temp += size
                        if (size >= 1024L * 1024L * 1024L) { large++; largeBytes += size }
                    } catch (_: Exception) {}
                }
            }

            categories.put("images", JSONObject().put("files", images).put("bytes", imageBytes))
            categories.put("videos", JSONObject().put("files", videos).put("bytes", videoBytes))
            categories.put("audio", JSONObject().put("files", audio).put("bytes", audioBytes))
            categories.put("documents", JSONObject().put("files", docs).put("bytes", docBytes))
            categories.put("apk", JSONObject().put("files", apks).put("bytes", apkBytes))
            categories.put("archives", JSONObject().put("files", archives).put("bytes", archiveBytes))
            categories.put("cache", cache); categories.put("temp", temp)
            categories.put("large", JSONObject().put("files", large).put("bytes", largeBytes))

            sourceBytes.entries.sortedByDescending { it.value }.take(12).forEach { (name, bytes) ->
                sources.put(name, JSONObject().put("bytes", bytes).put("files", sourceFiles[name] ?: 0L))
            }

            val stat = root.statFs()
            val capacity = stat.totalBytes
            val free = stat.availableBytes
            val used = (capacity - free).coerceAtLeast(0L)
            val appCount = try {
                packageManager.getInstalledApplications(PackageManager.GET_META_DATA)
                    .count { (it.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) == 0 }
            } catch (_: Exception) { 0 }

            result.put("ok", true).put("files", files).put("bytes", totalBytes)
                .put("capacity", capacity).put("free", free).put("used", used)
                .put("categories", categories).put("sources", sources).put("apps", appCount)
            return result
        }
    }
}
