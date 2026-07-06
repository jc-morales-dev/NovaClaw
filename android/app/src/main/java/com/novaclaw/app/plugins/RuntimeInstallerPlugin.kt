package com.novaclaw.app.plugins

import android.system.Os
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.novaclaw.app.NovaClawBootstrapLoader
import java.io.ByteArrayInputStream
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream

@CapacitorPlugin(name = "RuntimeInstaller")
class RuntimeInstallerPlugin : Plugin() {

    companion object {
        private const val TAG = "NovaClawInstaller"
        private const val SYMLINKS_FILE = "SYMLINKS.txt"
        private const val READY_MARKER = ".nova_ready"
        private const val POSTINST_LOCK = ".nova_postinst_done"
        private val EXECUTABLE_PREFIXES = listOf("bin/", "libexec/", "lib/apt/apt-helper", "lib/apt/methods/")
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val filesDir: String by lazy { context.filesDir.absolutePath }
    private val prefixDir: String by lazy { "$filesDir/usr" }
    private val stagingDir: String by lazy { "$filesDir/usr-staging" }
    private val homeDir: String by lazy { "$filesDir/home" }
    private val workspaceDir: String by lazy { "$homeDir/workspace" }

    // ─── checkInstalled ───────────────────────────────────────────────────

    @PluginMethod
    fun checkInstalled(call: PluginCall) {
        val ready = File(filesDir, READY_MARKER).exists()
        val prefixExists = File(prefixDir).isDirectory && File(prefixDir).listFiles()?.isNotEmpty() == true
        call.resolve(JSObject().apply {
            put("installed", ready || prefixExists)
            put("workspaceRoot", workspaceDir)
            put("prefix", if (prefixExists) prefixDir else "")
            put("path", if (ready) workspaceDir else "")
        })
    }

    // ─── install ──────────────────────────────────────────────────────────

    @PluginMethod
    fun install(call: PluginCall) {
        executor.submit {
            try { runFullInstall(call) }
            catch (e: Exception) {
                notifyListeners("done", JSObject().apply {
                    put("success", false)
                    put("failedStep", "setup")
                    put("output", e.message ?: "Unknown error")
                })
                call.reject("Installation failed: ${e.message}", e)
            }
        }
    }

    // ─── installNodePython ────────────────────────────────────────────────

    @PluginMethod
    fun installNodePython(call: PluginCall) {
        executor.submit {
            try { runPkgInstall(call) }
            catch (e: Exception) { call.reject("Package install failed: ${e.message}", e) }
        }
    }

    // ─── getPrefixPath ────────────────────────────────────────────────────

    @PluginMethod
    fun getPrefixPath(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("prefix", prefixDir)
            put("home", homeDir)
            put("workspace", workspaceDir)
            put("binPath", "$prefixDir/bin")
        })
    }

    // ─── Full install pipeline ────────────────────────────────────────────

    private fun runFullInstall(call: PluginCall) {
        val steps = listOf(
            "Loading bootstrap" to ::stepLoadBootstrap,
            "Preparing staging" to ::stepPrepareStaging,
            "Extracting filesystem" to ::stepExtractZip,
            "Atomic swap" to ::stepAtomicSwap,
            "Running postinst scripts" to ::stepRunPostinst,
            "Setting up workspace" to ::stepSetupWorkspace,
            "Installing Node.js & Python" to ::stepInstallPackages,
            "Finalizing" to ::stepFinalize,
        )
        for ((i, entry) in steps.withIndex()) {
            val (label, fn) = entry
            notifyListeners("progress", JSObject().apply {
                put("step", i + 1); put("total", steps.size); put("label", label)
            })
            fn()
        }
        notifyListeners("done", JSObject().apply { put("success", true) })
        call.resolve(JSObject().apply { put("success", true); put("workspaceRoot", workspaceDir); put("prefix", prefixDir) })
    }

    // ─── Step 1: Load bootstrap ZIP ───────────────────────────────────────

    private var bootstrapZipBytes: ByteArray? = null

    private fun stepLoadBootstrap() {
        val bytes = NovaClawBootstrapLoader.loadBootstrapZip(context)
        if (bytes == null) throw RuntimeException("No bootstrap ZIP available. Place novaclaw-bootstrap.zip in assets/ or run scripts/build-bootstrap-so.sh")
        bootstrapZipBytes = bytes
    }

    // ─── Step 2: Prepare staging directory ────────────────────────────────

    private fun stepPrepareStaging() {
        val staging = File(stagingDir); if (staging.exists()) staging.deleteRecursively()
        val prefix = File(prefixDir); if (prefix.exists()) prefix.deleteRecursively()
        staging.mkdirs(); prefix.mkdirs(); File(homeDir).mkdirs()
    }

    // ─── Step 3: Extract ZIP to staging ───────────────────────────────────

    private fun stepExtractZip() {
        val bytes = bootstrapZipBytes ?: throw RuntimeException("Bootstrap ZIP not loaded")
        val staging = File(stagingDir)
        val symlinkList = mutableListOf<Pair<String, String>>()

        ZipInputStream(ByteArrayInputStream(bytes)).use { zis ->
            var entry: ZipEntry? = zis.nextEntry
            while (entry != null) {
                val entryName = entry!!.name
                if (entryName == SYMLINKS_FILE) {
                    val content = String(zis.readBytes(), Charsets.UTF_8)
                    parseSymlinks(content, symlinkList)
                    zis.closeEntry(); entry = zis.nextEntry; continue
                }
                val targetFile = File(staging, entryName)
                if (entry.isDirectory) { targetFile.mkdirs() }
                else {
                    targetFile.parentFile?.mkdirs()
                    FileOutputStream(targetFile).use { fos ->
                        val buffer = ByteArray(8192); var read: Int
                        while (zis.read(buffer).also { read = it } != -1) fos.write(buffer, 0, read)
                    }
                    if (shouldSetExecutable(entryName)) targetFile.setExecutable(true)
                }
                zis.closeEntry(); entry = zis.nextEntry
            }
        }
        for ((target, linkPath) in symlinkList) {
            val linkFile = File(staging, linkPath)
            linkFile.parentFile?.mkdirs()
            try { Os.symlink(target, linkFile.absolutePath) }
            catch (e: Exception) {
                try {
                    val relativeTarget = if (File(target).isAbsolute) computeRelativePath(linkFile.absolutePath, target, staging.absolutePath) else target
                    Os.symlink(relativeTarget, linkFile.absolutePath)
                } catch (e2: Exception) { android.util.Log.w(TAG, "Failed to create symlink $linkPath -> $target: ${e2.message}") }
            }
        }
    }

    // ─── Step 4: Atomic rename ────────────────────────────────────────────

    private fun stepAtomicSwap() {
        val staging = File(stagingDir); val prefix = File(prefixDir)
        if (prefix.exists()) prefix.deleteRecursively()
        if (!staging.renameTo(prefix)) throw RuntimeException("Failed to rename staging to prefix.")
    }

    // ─── Step 5: Run postinst scripts ─────────────────────────────────────

    private fun stepRunPostinst() {
        val lockFile = File(prefixDir, POSTINST_LOCK)
        if (lockFile.exists()) return
        val dpkgInfo = File(prefixDir, "var/lib/dpkg/info")
        if (!dpkgInfo.isDirectory) return
        val postinstFiles = dpkgInfo.listFiles { _, name -> name.endsWith(".postinst") } ?: return
        for (postinst in postinstFiles) {
            try {
                postinst.setExecutable(true)
                runShellCommand("bash ${postinst.absolutePath} configure", prefixDir)
            } catch (e: Exception) { android.util.Log.w(TAG, "postinst ${postinst.name} failed: ${e.message}") }
        }
        lockFile.writeText(System.currentTimeMillis().toString())
    }

    // ─── Step 6: Setup workspace ──────────────────────────────────────────

    private fun stepSetupWorkspace() {
        File(workspaceDir).mkdirs()
        listOf("projects", "scripts", "downloads", "tmp", ".nova").forEach { File(workspaceDir, it).mkdirs() }
        File(workspaceDir, "README.md").writeText("# NovaClaw Workspace\n\nBienvenido a tu espacio de trabajo autonomo.\n", Charsets.UTF_8)
        val scripts = File(workspaceDir, "scripts")
        File(scripts, "sysinfo.sh").writeText(
            "#!/usr/bin/env bash\necho \"=== NovaClaw System Info ===\"\necho \"Date: \${date}\"\necho \"Shell: \${SHELL}\"\necho \"Workspace: \${NOVA_WORKSPACE}\"\necho \"===========================\"\n",
            Charsets.UTF_8
        )
    }

    // ─── Step 7: Install Node.js and Python ───────────────────────────────

    private fun stepInstallPackages() {
        val pkgBin = File(prefixDir, "bin/pkg"); val aptBin = File(prefixDir, "bin/apt")
        if (!pkgBin.exists() && !aptBin.exists()) { android.util.Log.w(TAG, "pkg/apt not found in bootstrap. Skipping package install."); return }
        try { runShellCommand("pkg update -y 2>&1 || apt update 2>&1", prefixDir, timeoutMs = 120_000) } catch (e: Exception) { android.util.Log.w(TAG, "pkg update failed: ${e.message}") }
        try { runShellCommand("pkg install -y nodejs 2>&1 || apt install -y nodejs 2>&1", prefixDir, timeoutMs = 300_000) } catch (e: Exception) { android.util.Log.w(TAG, "nodejs install failed: ${e.message}") }
        try { runShellCommand("pkg install -y python 2>&1 || apt install -y python 2>&1", prefixDir, timeoutMs = 300_000) } catch (e: Exception) { android.util.Log.w(TAG, "python install failed: ${e.message}") }
    }

    // ─── Step 8: Finalize ─────────────────────────────────────────────────

    private fun stepFinalize() {
        val envFile = File(prefixDir, "etc/novaclaw/novaclaw.env")
        envFile.parentFile?.mkdirs()
        envFile.writeText("export PREFIX=$prefixDir\nexport HOME=$homeDir\nexport NOVA_WORKSPACE=$workspaceDir\nexport PATH=$prefixDir/bin:/system/bin:/system/xbin\nexport TMPDIR=${context.cacheDir.absolutePath}\nexport TERM=xterm-256color\nexport LANG=en_US.UTF-8\n", Charsets.UTF_8)
        File(filesDir, READY_MARKER).writeText(System.currentTimeMillis().toString())
    }

    // ─── Package install (separate method) ────────────────────────────────

    private fun runPkgInstall(call: PluginCall) {
        val packages = call.getArray("packages") ?: run { call.reject("packages array required"); return }
        val pkgList = mutableListOf<String>()
        for (i in 0 until packages.length()) pkgList.add(packages.getString(i))
        if (pkgList.isEmpty()) { call.resolve(JSObject().apply { put("success", true); put("output", "No packages to install") }); return }
        val pkgBin = File(prefixDir, "bin/pkg")
        val cmd = if (pkgBin.exists()) "pkg install -y ${pkgList.joinToString(" ")}" else "apt install -y ${pkgList.joinToString(" ")}"
        try {
            val output = runShellCommand(cmd, prefixDir, timeoutMs = 300_000)
            call.resolve(JSObject().apply { put("success", true); put("output", output) })
        } catch (e: Exception) { call.reject("Package install failed: ${e.message}", e) }
    }

    // ─── Shell execution ──────────────────────────────────────────────────

    private fun runShellCommand(command: String, cwd: String, timeoutMs: Long = 60_000): String {
        val shellPath = listOf("/system/bin/sh", "/bin/sh").firstOrNull { File(it).exists() } ?: "/system/bin/sh"
        val pb = ProcessBuilder(shellPath, "-c", command).apply {
            directory(File(cwd.ifBlank { prefixDir }))
            environment().apply { put("HOME", homeDir); put("PREFIX", prefixDir); put("TMPDIR", "${context.cacheDir.absolutePath}"); put("PATH", "$prefixDir/bin:/system/bin:/system/xbin"); put("TERM", "xterm-256color"); put("NOVA_WORKSPACE", workspaceDir); put("LANG", "en_US.UTF-8"); put("SHELL", "$prefixDir/bin/bash"); remove("LD_PRELOAD") }
            redirectErrorStream(true)
        }
        val proc = pb.start()
        val outputBuilder = StringBuilder()
        val readerFuture = executor.submit<Unit> { BufferedReader(InputStreamReader(proc.inputStream)).use { reader -> var line: String?; while (reader.readLine().also { line = it } != null) outputBuilder.append(line).append('\n') } }
        val finished = proc.waitFor(timeoutMs / 1000, TimeUnit.SECONDS)
        if (!finished) { proc.destroyForcibly(); throw RuntimeException("Command timed out after ${timeoutMs}ms: $command") }
        readerFuture.get(5, TimeUnit.SECONDS)
        val exitCode = proc.exitValue()
        val output = outputBuilder.toString()
        if (exitCode != 0) android.util.Log.w(TAG, "Command exited with code $exitCode: $command\nOutput: ${output.take(500)}")
        return output
    }

    // ─── Symlink parsing ──────────────────────────────────────────────────

    private fun parseSymlinks(content: String, out: MutableList<Pair<String, String>>) {
        for (line in content.lines()) {
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith("#")) continue
            val parts = trimmed.split("<-")
            if (parts.size == 2) out.add(Pair(parts[0].trim(), parts[1].trim()))
        }
    }

    private fun shouldSetExecutable(entryName: String): Boolean = EXECUTABLE_PREFIXES.any { entryName.startsWith(it) }

    private fun computeRelativePath(fromPath: String, toPath: String, stagingPath: String): String {
        val fromDir = File(fromPath).parentFile ?: return toPath
        val fromParts = fromDir.absolutePath.split("/")
        val toParts = if (File(toPath).isAbsolute) toPath.removePrefix(stagingPath).split("/").filter { it.isNotEmpty() } else toPath.split("/").filter { it.isNotEmpty() }
        val commonPrefix = fromParts.zip(toParts).takeWhile { (a, b) -> a == b }.size
        val upCount = fromParts.size - commonPrefix
        val upParts = List(upCount) { ".." }
        val downParts = toParts.drop(commonPrefix)
        return (upParts + downParts).joinToString("/")
    }
}
