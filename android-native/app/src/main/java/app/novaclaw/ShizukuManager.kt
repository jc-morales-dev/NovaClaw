package app.novaclaw

import android.content.pm.PackageManager
import android.util.Log
import rikka.shizuku.Shizuku

/**
 * Fase 3 — Puente con Shizuku para el control privilegiado del teléfono.
 *
 * Shizuku expone una identidad de shell ADB (UID 2000) a las apps que autoriza.
 * Con el permiso concedido a app.novaclaw, el binario `rish` (ver
 * RuntimeManager.installShizukuBridge) puede ejecutar comandos como `input`,
 * `screencap`, `pm`, `dumpsys`, etc. — que es lo que usa el agente.
 *
 * Esta clase se encarga SOLO del lado app: consultar si el servicio está vivo,
 * si tenemos permiso, y pedirlo (muestra el diálogo de Shizuku).
 */
class ShizukuManager(private val onStatus: (Status) -> Unit) {

    companion object {
        private const val TAG = "NovaClaw/Shizuku"
        private const val REQUEST_CODE = 4210
    }

    enum class Status {
        /** Shizuku no está instalado o su servicio no corre. */
        NOT_RUNNING,

        /** Servicio vivo pero sin permiso para NovaClaw. */
        NEEDS_PERMISSION,

        /** Todo listo: el agente puede controlar el teléfono. */
        READY,
    }

    private val binderReceived = Shizuku.OnBinderReceivedListener { refresh() }
    private val binderDead = Shizuku.OnBinderDeadListener { onStatus(Status.NOT_RUNNING) }
    private val permissionResult =
        Shizuku.OnRequestPermissionResultListener { code, grantResult ->
            if (code == REQUEST_CODE) {
                val granted = grantResult == PackageManager.PERMISSION_GRANTED
                Log.i(TAG, "Resultado del permiso: ${if (granted) "concedido" else "denegado"}")
                onStatus(if (granted) Status.READY else Status.NEEDS_PERMISSION)
            }
        }

    /** Registra los listeners de Shizuku. Llamar en onCreate. */
    fun register() {
        Shizuku.addBinderReceivedListenerSticky(binderReceived)
        Shizuku.addBinderDeadListener(binderDead)
        Shizuku.addRequestPermissionResultListener(permissionResult)
        refresh()
    }

    /** Quita los listeners. Llamar en onDestroy. */
    fun unregister() {
        Shizuku.removeBinderReceivedListener(binderReceived)
        Shizuku.removeBinderDeadListener(binderDead)
        Shizuku.removeRequestPermissionResultListener(permissionResult)
    }

    /** Estado actual, sin pedir permiso. */
    fun currentStatus(): Status {
        if (!Shizuku.pingBinder()) return Status.NOT_RUNNING
        // Las versiones pre-v11 usan un permiso de runtime distinto; no las soportamos.
        if (Shizuku.isPreV11()) return Status.NEEDS_PERMISSION
        return if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
            Status.READY
        } else {
            Status.NEEDS_PERMISSION
        }
    }

    private fun refresh() = onStatus(currentStatus())

    /**
     * Pide el permiso si hace falta. Devuelve true si ya estaba concedido.
     * Si no, dispara el diálogo de Shizuku (el resultado llega por el listener).
     */
    fun ensurePermission(): Boolean {
        if (!Shizuku.pingBinder()) {
            onStatus(Status.NOT_RUNNING)
            return false
        }
        if (Shizuku.isPreV11()) {
            onStatus(Status.NEEDS_PERMISSION)
            return false
        }
        if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
            onStatus(Status.READY)
            return true
        }
        if (Shizuku.shouldShowRequestPermissionRationale()) {
            Log.w(TAG, "El usuario denegó Shizuku antes; hay que habilitarlo desde la app Shizuku.")
            onStatus(Status.NEEDS_PERMISSION)
            return false
        }
        Shizuku.requestPermission(REQUEST_CODE)
        return false
    }
}
