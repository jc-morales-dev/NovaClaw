package app.novaclaw

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.provider.ContactsContract
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Servidor HTTP local (127.0.0.1:8099) que le da al agente Node acceso a las
 * capacidades nativas del teléfono que NO se pueden hacer por shell: cámara,
 * ubicación (GPS) y contactos. El agente (que corre en el Linux embebido) las
 * consume con un simple fetch a http://127.0.0.1:8099/<recurso>.
 *
 * Cada endpoint valida el permiso primero; si falta, responde con un mensaje
 * claro para que el agente le diga al usuario que active el conector en Ajustes.
 */
class NativeToolsServer(private val context: Context, private val token: String = "") {

    companion object {
        const val PORT = 8099
        private const val TAG = "NovaClaw/Native"
    }

    @Volatile private var server: ServerSocket? = null

    fun start() {
        if (server != null) return
        thread(name = "novaclaw-native-tools", isDaemon = true) {
            try {
                val socket = ServerSocket(PORT, 8, InetAddress.getByName("127.0.0.1"))
                server = socket
                Log.i(TAG, "Native tools server on 127.0.0.1:$PORT")
                while (!socket.isClosed) {
                    val client = try { socket.accept() } catch (e: Exception) { break }
                    thread(isDaemon = true) { handle(client) }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Native server failed: ${e.message}")
            }
        }
    }

    fun stop() {
        try { server?.close() } catch (_: Exception) {}
        server = null
    }

    private fun handle(client: Socket) {
        try {
            client.use { sock ->
                val reader = BufferedReader(InputStreamReader(sock.getInputStream()))
                val requestLine = reader.readLine() ?: return
                // "GET /path?query HTTP/1.1"
                val parts = requestLine.split(" ")
                if (parts.size < 2) return
                val target = parts[1]
                val path = target.substringBefore('?')
                val query = parseQuery(target.substringAfter('?', ""))

                // Leer las cabeceras hasta la línea en blanco y extraer el token.
                var provided: String? = null
                var header = reader.readLine()
                while (!header.isNullOrEmpty()) {
                    val ci = header.indexOf(':')
                    if (ci > 0 && header.substring(0, ci).trim().equals("X-Nova-Token", ignoreCase = true)) {
                        provided = header.substring(ci + 1).trim()
                    }
                    header = reader.readLine()
                }
                // Endpoints sensibles (cámara/GPS/contactos) exigen el token compartido.
                val authed = token.isEmpty() || provided == token

                val json: JSONObject = try {
                    when (path) {
                        "/ping" -> JSONObject().put("ok", true)
                        "/location" -> if (authed) getLocation() else forbidden()
                        "/contacts" -> if (authed) getContacts(query["q"] ?: query["query"] ?: "") else forbidden()
                        "/calendar" -> if (authed) getCalendar(query["days"] ?: "14") else forbidden()
                        "/photo" -> if (authed) takePhoto(query["facing"] ?: "back") else forbidden()
                        else -> JSONObject().put("error", "unknown endpoint: $path")
                    }
                } catch (e: Exception) {
                    JSONObject().put("error", e.message ?: "internal error")
                }

                writeJson(sock.getOutputStream(), json)
            }
        } catch (e: Exception) {
            Log.e(TAG, "handle error: ${e.message}")
        }
    }

    private fun parseQuery(raw: String): Map<String, String> {
        if (raw.isBlank()) return emptyMap()
        return raw.split("&").mapNotNull {
            val idx = it.indexOf('=')
            if (idx <= 0) null
            else try {
                URLDecoder.decode(it.substring(0, idx), "UTF-8") to
                    URLDecoder.decode(it.substring(idx + 1), "UTF-8")
            } catch (_: Exception) { null }
        }.toMap()
    }

    private fun writeJson(out: OutputStream, json: JSONObject) {
        val body = json.toString().toByteArray(Charsets.UTF_8)
        val header = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Connection: close\r\n\r\n"
        out.write(header.toByteArray(Charsets.UTF_8))
        out.write(body)
        out.flush()
    }

    private fun forbidden(): JSONObject =
        JSONObject().put("error", "forbidden: missing or invalid token")

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    // ── Ubicación ─────────────────────────────────────────────────────────────
    private fun getLocation(): JSONObject {
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION) &&
            !granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            return JSONObject().put("error", "location permission not granted — enable the Location connector in Settings")
        }
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        var best: Location? = null
        try {
            for (provider in lm.getProviders(true)) {
                val loc = lm.getLastKnownLocation(provider) ?: continue
                if (best == null || loc.time > best!!.time) best = loc
            }
        } catch (e: SecurityException) {
            return JSONObject().put("error", "location permission denied")
        }

        // Si no hay última ubicación conocida (arranque en frío), pedimos una
        // actualización activa con timeout corto en su propio hilo con Looper.
        if (best == null) {
            best = requestSingleFix(lm)
        }

        if (best == null) {
            return JSONObject().put("error", "no location fix available yet — move to an open area and retry")
        }
        val out = JSONObject().apply {
            put("latitude", best!!.latitude)
            put("longitude", best!!.longitude)
            put("accuracyMeters", best!!.accuracy.toDouble())
            put("provider", best!!.provider)
            put("timestamp", best!!.time)
        }
        // Dirección legible (calle, ciudad, provincia, país) — geocoder nativo
        // y, si falla, OpenStreetMap por internet.
        reverseGeocode(best!!.latitude, best!!.longitude)?.let { addr ->
            for (key in addr.keys()) out.put(key, addr.get(key))
        }
        return out
    }

    /** Convierte lat/lng en una dirección legible. Intenta el Geocoder nativo y,
     *  si no hay backend o falla, cae a Nominatim (OpenStreetMap) por internet. */
    private fun reverseGeocode(lat: Double, lng: Double): JSONObject? {
        // 1) Geocoder nativo de Android (offline en muchos equipos).
        try {
            if (Geocoder.isPresent()) {
                @Suppress("DEPRECATION")
                val list = Geocoder(context, Locale("es")).getFromLocation(lat, lng, 1)
                val a = list?.firstOrNull()
                if (a != null) {
                    val street = listOfNotNull(a.thoroughfare, a.subThoroughfare)
                        .joinToString(" ").ifBlank { a.featureName ?: "" }
                    val full = (0..a.maxAddressLineIndex).mapNotNull { a.getAddressLine(it) }
                        .joinToString(", ")
                    return JSONObject().apply {
                        if (street.isNotBlank()) put("street", street)
                        a.locality?.let { put("city", it) }
                        (a.subAdminArea ?: a.adminArea)?.let { put("area", it) }
                        a.adminArea?.let { put("state", it) }
                        a.countryName?.let { put("country", it) }
                        a.postalCode?.let { put("postalCode", it) }
                        if (full.isNotBlank()) put("address", full)
                    }
                }
            }
        } catch (_: Exception) { /* cae a Nominatim */ }

        // 2) Fallback web: Nominatim (OpenStreetMap).
        try {
            val url = URL(
                "https://nominatim.openstreetmap.org/reverse?format=jsonv2" +
                    "&lat=$lat&lon=$lng&accept-language=es&zoom=18"
            )
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("User-Agent", "NovaClaw/1.0 (agent)")
                connectTimeout = 6000
                readTimeout = 6000
            }
            if (conn.responseCode == 200) {
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(body)
                val addr = json.optJSONObject("address")
                return JSONObject().apply {
                    put("address", json.optString("display_name"))
                    if (addr != null) {
                        (addr.optString("road").takeIf { it.isNotBlank() })?.let { put("street", it) }
                        val city = addr.optString("city").ifBlank {
                            addr.optString("town").ifBlank { addr.optString("village") }
                        }
                        if (city.isNotBlank()) put("city", city)
                        (addr.optString("state").takeIf { it.isNotBlank() })?.let { put("state", it) }
                        (addr.optString("country").takeIf { it.isNotBlank() })?.let { put("country", it) }
                        (addr.optString("postcode").takeIf { it.isNotBlank() })?.let { put("postalCode", it) }
                    }
                }
            }
        } catch (_: Exception) { /* sin dirección */ }

        return null
    }

    /** Pide una única actualización de ubicación con timeout (arranque en frío). */
    private fun requestSingleFix(lm: LocationManager): Location? {
        val providers = lm.getProviders(true).filter {
            it == LocationManager.GPS_PROVIDER || it == LocationManager.NETWORK_PROVIDER
        }
        if (providers.isEmpty()) return null

        val thread = HandlerThread("nova-loc").apply { start() }
        val handler = Handler(thread.looper)
        val latch = CountDownLatch(1)
        val result = java.util.concurrent.atomic.AtomicReference<Location?>(null)

        val listener = object : android.location.LocationListener {
            override fun onLocationChanged(location: Location) {
                result.set(location)
                latch.countDown()
            }
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) {}
            @Deprecated("Deprecated in Java")
            override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
        }

        try {
            handler.post {
                for (provider in providers) {
                    try { lm.requestLocationUpdates(provider, 0L, 0f, listener, thread.looper) }
                    catch (_: SecurityException) {}
                }
            }
            latch.await(6, TimeUnit.SECONDS)
        } catch (_: Exception) {
        } finally {
            try { lm.removeUpdates(listener) } catch (_: Exception) {}
            thread.quitSafely()
        }
        return result.get()
    }

    // ── Contactos ─────────────────────────────────────────────────────────────
    private fun getContacts(queryText: String): JSONObject {
        if (!granted(Manifest.permission.READ_CONTACTS)) {
            return JSONObject().put("error", "contacts permission not granted — enable the Contacts connector in Settings")
        }
        val results = JSONArray()
        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
        )
        val selection: String?
        val args: Array<String>?
        if (queryText.isNotBlank()) {
            selection = "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?"
            args = arrayOf("%$queryText%")
        } else {
            selection = null
            args = null
        }
        val cursor = context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            projection, selection, args,
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC",
        )
        val seen = HashSet<String>()
        cursor?.use {
            val nameIdx = it.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
            val numIdx = it.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
            while (it.moveToNext() && results.length() < 100) {
                val name = if (nameIdx >= 0) it.getString(nameIdx) ?: "" else ""
                val number = if (numIdx >= 0) it.getString(numIdx) ?: "" else ""
                val key = "$name|$number"
                if (key in seen) continue
                seen.add(key)
                results.put(JSONObject().put("name", name).put("number", number))
            }
        }
        return JSONObject().put("count", results.length()).put("contacts", results)
    }

    // ── Calendario ────────────────────────────────────────────────────────────
    private fun getCalendar(daysStr: String): JSONObject {
        if (!granted(Manifest.permission.READ_CALENDAR)) {
            return JSONObject().put("error", "calendar permission not granted — enable the Calendar connector in Settings")
        }
        val days = (daysStr.toLongOrNull() ?: 14L).coerceIn(1L, 365L)
        val now = System.currentTimeMillis()
        val end = now + days * 24L * 60L * 60L * 1000L
        val results = JSONArray()
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", Locale("es"))

        val builder = android.provider.CalendarContract.Instances.CONTENT_URI.buildUpon()
        android.content.ContentUris.appendId(builder, now)
        android.content.ContentUris.appendId(builder, end)
        val projection = arrayOf(
            android.provider.CalendarContract.Instances.TITLE,
            android.provider.CalendarContract.Instances.BEGIN,
            android.provider.CalendarContract.Instances.END,
            android.provider.CalendarContract.Instances.EVENT_LOCATION,
            android.provider.CalendarContract.Instances.ALL_DAY,
        )
        try {
            val cursor = context.contentResolver.query(
                builder.build(), projection, null, null,
                "${android.provider.CalendarContract.Instances.BEGIN} ASC",
            )
            val seen = HashSet<String>()
            cursor?.use {
                while (it.moveToNext() && results.length() < 100) {
                    val title = it.getString(0) ?: "(sin título)"
                    val start = fmt.format(java.util.Date(it.getLong(1)))
                    // Dedupe: mismo título + mismo día. Evita listar 23 veces el mismo
                    // feriado por calendarios duplicados o eventos recurrentes.
                    val key = "$title|${start.substring(0, minOf(10, start.length))}"
                    if (!seen.add(key)) continue
                    val o = JSONObject()
                    o.put("title", title)
                    o.put("start", start)
                    o.put("end", fmt.format(java.util.Date(it.getLong(2))))
                    it.getString(3)?.let { loc -> if (loc.isNotBlank()) o.put("location", loc) }
                    o.put("allDay", it.getInt(4) == 1)
                    results.put(o)
                }
            }
        } catch (e: SecurityException) {
            return JSONObject().put("error", "calendar permission denied")
        }
        return JSONObject().put("count", results.length()).put("events", results)
    }

    // ── Cámara (captura headless con Camera2) ─────────────────────────────────
    private fun takePhoto(facing: String): JSONObject {
        if (!granted(Manifest.permission.CAMERA)) {
            return JSONObject().put("error", "camera permission not granted — enable the Camera connector in Settings")
        }
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val wantFront = facing.equals("front", ignoreCase = true)
        val targetLens = if (wantFront) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK

        var cameraId: String? = null
        for (id in manager.cameraIdList) {
            val chars = manager.getCameraCharacteristics(id)
            if (chars.get(CameraCharacteristics.LENS_FACING) == targetLens) { cameraId = id; break }
        }
        if (cameraId == null) cameraId = manager.cameraIdList.firstOrNull()
            ?: return JSONObject().put("error", "no camera available on this device")

        val outFile = File(context.filesDir, "home/nova-photo-${System.currentTimeMillis()}.jpg").apply {
            parentFile?.mkdirs()
        }

        val thread = HandlerThread("nova-cam").apply { start() }
        val handler = Handler(thread.looper)
        val latch = CountDownLatch(1)
        var error: String? = null
        var device: CameraDevice? = null

        val reader = ImageReader.newInstance(1280, 720, ImageFormat.JPEG, 1)
        reader.setOnImageAvailableListener({ r ->
            try {
                val image = r.acquireLatestImage()
                val buffer = image.planes[0].buffer
                val bytes = ByteArray(buffer.remaining())
                buffer.get(bytes)
                outFile.writeBytes(bytes)
                image.close()
            } catch (e: Exception) {
                error = "capture failed: ${e.message}"
            } finally {
                latch.countDown()
            }
        }, handler)

        try {
            manager.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(cam: CameraDevice) {
                    device = cam
                    try {
                        val surface = reader.surface
                        cam.createCaptureSession(listOf(surface), object : CameraCaptureSession.StateCallback() {
                            override fun onConfigured(session: CameraCaptureSession) {
                                val req = cam.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
                                req.addTarget(surface)
                                req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                                // Pequeña espera para exposición automática antes de disparar.
                                handler.postDelayed({
                                    try { session.capture(req.build(), null, handler) }
                                    catch (e: Exception) { error = e.message; latch.countDown() }
                                }, 700)
                            }
                            override fun onConfigureFailed(session: CameraCaptureSession) {
                                error = "camera session config failed"; latch.countDown()
                            }
                        }, handler)
                    } catch (e: Exception) { error = e.message; latch.countDown() }
                }
                override fun onDisconnected(cam: CameraDevice) { cam.close(); latch.countDown() }
                override fun onError(cam: CameraDevice, err: Int) { error = "camera error $err"; cam.close(); latch.countDown() }
            }, handler)
        } catch (e: Exception) {
            error = e.message
            latch.countDown()
        }

        val done = latch.await(8, TimeUnit.SECONDS)
        try { device?.close() } catch (_: Exception) {}
        try { reader.close() } catch (_: Exception) {}
        thread.quitSafely()

        if (!done) return JSONObject().put("error", "camera timed out")
        if (error != null) return JSONObject().put("error", error)
        if (!outFile.exists() || outFile.length() == 0L) return JSONObject().put("error", "photo was not saved")

        return JSONObject().apply {
            put("path", outFile.absolutePath)
            put("bytes", outFile.length())
            put("facing", if (wantFront) "front" else "back")
        }
    }
}
