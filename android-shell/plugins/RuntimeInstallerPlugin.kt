package com.novaclaw.app.plugins

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.concurrent.Executors

/**
 * RuntimeInstallerPlugin — Configuración de primer arranque.
 *
 * Crea la estructura del workspace en el storage privado de la app.
 * Sin Termux, sin internet, sin root. Todo dentro de:
 *   /data/data/com.novaclaw.app/files/workspace/
 *
 * Etapas de instalación:
 *   1. Crear estructura de directorios
 *   2. Copiar scripts de utilidad desde assets
 *   3. Escribir archivo de bienvenida
 *   4. Marcar instalación completa (.nova_ready)
 */
@CapacitorPlugin(name = "RuntimeInstaller")
class RuntimeInstallerPlugin : Plugin() {

    private val executor = Executors.newSingleThreadExecutor()

    private val workspaceRoot: String by lazy {
        "${context.filesDir.absolutePath}/workspace"
    }

    // ─── checkInstalled ───────────────────────────────────────────────────────

    @PluginMethod
    fun checkInstalled(call: PluginCall) {
        val ready = File(workspaceRoot, ".nova_ready").exists()
        call.resolve(JSObject().apply {
            put("installed",     ready)
            put("workspaceRoot", workspaceRoot)
            put("path",          if (ready) workspaceRoot else "")
        })
    }

    // ─── install ──────────────────────────────────────────────────────────────

    @PluginMethod
    fun install(call: PluginCall) {
        executor.submit {
            try {
                runInstall(call)
            } catch (e: Exception) {
                notifyListeners("done", JSObject().apply {
                    put("success",     false)
                    put("failedStep",  "setup")
                    put("output",      e.message ?: "Unknown error")
                })
                call.reject("Installation failed: ${e.message}", e)
            }
        }
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    private fun runInstall(call: PluginCall) {
        val steps = listOf(
            "Creating workspace"      to ::createWorkspace,
            "Creating directories"    to ::createDirectories,
            "Writing helper scripts"  to ::writeHelperScripts,
            "Writing welcome file"    to ::writeWelcomeFile,
            "Finalizing"              to ::writeReadyMarker,
        )

        for ((i, entry) in steps.withIndex()) {
            val (label, fn) = entry
            notifyListeners("progress", JSObject().apply {
                put("step",    i + 1)
                put("total",   steps.size)
                put("label",   label)
            })
            fn()   // throws on failure
        }

        notifyListeners("done", JSObject().apply { put("success", true) })
        call.resolve(JSObject().apply { put("success", true); put("workspaceRoot", workspaceRoot) })
    }

    private fun createWorkspace() {
        File(workspaceRoot).mkdirs()
    }

    private fun createDirectories() {
        listOf("projects", "scripts", "downloads", "tmp", ".nova")
            .forEach { File(workspaceRoot, it).mkdirs() }
    }

    private fun writeHelperScripts() {
        val scripts = File(workspaceRoot, "scripts")

        // sysinfo — muestra información del dispositivo usando herramientas del sistema
        File(scripts, "sysinfo.sh").writeText(
            """#!/system/bin/sh
echo "=== NovaClaw System Info ==="
echo "Date:    $(date)"
echo "Shell:   $SHELL"
echo "Android: $(getprop ro.build.version.release 2>/dev/null || echo n/a)"
echo "Device:  $(getprop ro.product.model 2>/dev/null || echo n/a)"
echo "Arch:    $(uname -m 2>/dev/null || echo n/a)"
echo "Kernel:  $(uname -r 2>/dev/null || echo n/a)"
echo "Workspace: $NOVA_WORKSPACE"
du -sh "$NOVA_WORKSPACE" 2>/dev/null | awk '{print "Used:    "$1}'
echo "==========================="
""", Charsets.UTF_8
        )

        // hello — test de que el entorno funciona
        File(scripts, "hello.sh").writeText(
            """#!/system/bin/sh
echo "✓ NovaClaw shell is working!"
echo "  Workspace: $NOVA_WORKSPACE"
echo "  Shell: $0"
echo "  Date: $(date)"
""", Charsets.UTF_8
        )
    }

    private fun writeWelcomeFile() {
        File(workspaceRoot, "README.md").writeText(
            """# NovaClaw Workspace

Bienvenido a tu espacio de trabajo autónomo.

## Estructura
- `projects/`   — Tus proyectos de código
- `scripts/`    — Scripts de utilidad
- `downloads/`  — Archivos descargados
- `tmp/`        — Archivos temporales

## Comandos de prueba
Puedes pedirle al agente:
- "Muéstrame la información del sistema"
- "Crea un archivo de texto con Hola Mundo"
- "Lista los archivos en el workspace"
- "Crea un proyecto de ejemplo en Python"

## Shell disponible
El shell usa /system/bin/sh integrado en Android.
Comandos disponibles: ls, cat, echo, find, grep, sed,
awk, sort, head, tail, mkdir, rm, mv, cp, chmod, date,
uname, getprop, y más.
""", Charsets.UTF_8
        )
    }

    private fun writeReadyMarker() {
        File(workspaceRoot, ".nova_ready").writeText(
            System.currentTimeMillis().toString()
        )
    }
}
