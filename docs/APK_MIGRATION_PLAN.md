# NovaClaw - Plan tecnico de migracion a APK real

> Estado actual: la UI del APK ya no debe depender de `fetch('/api/...')` directo, el splash debe responder a estado real del runtime, y la meta del producto es una APK con runtime embebido. La ruta basada en Termux externo queda solo como referencia historica.

---

## 1. Objetivo

Pasar del prototipo web actual a una APK Android funcional que cumpla con la vision del producto:

- agente real
- terminal y archivos locales
- instalacion automatica en primer uso
- modelo remoto por API
- runtime embebido dentro de la app

---

## 2. Arquitectura objetivo

```text
React UI
  -> platform.ts
  -> Capacitor bridge
  -> Android plugins/services
  -> runtime embebido local
  -> herramientas del agente (terminal, archivos, workspace)
```

Capas:

1. `UI React`
   - Home, Chat, Terminal, Settings, Logs, Splash
   - No decide si esta en web o APK

2. `platform.ts`
   - frontera unica entre interfaz y runtime
   - navegador: usa Express local para desarrollo
   - APK: usa plugins/servicios nativos

3. `RuntimeBootstrapPlugin`
   - descarga manifiesto y assets
   - valida checksum
   - extrae runtime en almacenamiento privado
   - emite progreso real

4. `EmbeddedRuntimePlugin`
   - ejecuta terminal, archivos y workspace
   - expone las herramientas usadas por el agente

5. `SecureKeyPlugin`
   - protege claves o tokens del lado Android

---

## 3. Fases recomendadas

### Fase A - Transporte movil compartido

- quitar `fetch('/api/...')` directo de las pantallas
- mover la UI a `platform.ts`
- conservar el prototipo web

### Fase B - Bootstrap real

- reemplazar splash falso por estados reales:
  - `checking`
  - `not_installed`
  - `installing`
  - `ready`
  - `error`
- instalar runtime en primer arranque
- soportar reintento y health check

### Fase C - Runtime local embebido

- empaquetar o descargar bootstrap del runtime
- ejecutar comandos y archivos dentro del entorno local
- conectar `terminal.run`, `file.read`, `file.write`, `file.list`, `file.search`, `workspace.mkdir`

### Fase D - Seguridad y backend final

- mover el acceso al modelo al backend propio o endurecer la ruta nativa
- guardar secretos del lado nativo
- reforzar permisos sensibles y aprobaciones

### Fase E - QA Android y release

- pruebas en dispositivos reales
- manejo de errores de red, espacio y reinstalacion
- firma release y empaquetado final

---

## 4. Lo que ya esta encaminado en este repo

- runtime agentico en `src/agent/*`
- capa compartida `src/platform.ts`
- pruebas de regresion para evitar `/api/...` directo en las pantallas
- estado de bootstrap compartido en `src/bootstrap/state.ts`
- splash conectado a estado real del runtime

---

## 5. Lo que sigue pendiente

- plugin/servicio real de bootstrap embebido
- runtime local completo dentro de la APK
- terminal PTY real
- acceso a carpetas del telefono con permisos del usuario
- pruebas Android reales del flujo completo

---

## 6. Decision vigente

La direccion del producto es:

- APK ligera
- descarga del runtime en primer inicio
- sin login
- modelo remoto
- backend propio
- runtime local embebido
- aprobacion explicita para acciones sensibles
