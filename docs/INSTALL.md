# Instalar NovaClaw

NovaClaw es una app Android que trae un Linux + Node.js adentro y corre su
propio agente de IA en tu teléfono. No está en Google Play (por diseño): se
instala por **sideload** (bajar el APK e instalarlo a mano).

## Requisitos

- Android **8 o superior**, procesador **arm64** (casi todos los teléfonos de
  los últimos años).
- ~**400 MB libres**: el APK pesa ~37 MB y, la primera vez que lo abrís, baja el
  sistema Linux + Node (~300 MB) una sola vez.
- Una **API key** de un proveedor de IA (traés la tuya — BYOK). Sirve
  OpenRouter, Anthropic, OpenAI, NVIDIA o Zen. Muchos tienen modelos gratis.

## Pasos

1. **Bajá el APK** desde la sección *Releases* del repositorio (el archivo
   `app-arm64-release.apk`).
2. En el teléfono, andá a **Ajustes → Seguridad → Instalar apps desconocidas**
   y permitíselo al navegador o gestor de archivos con el que abras el APK.
3. **Tocá el APK** para instalarlo.
4. **Abrí NovaClaw.** La primera vez descarga el sistema Linux (esperá a que
   termine; necesita internet y unos minutos).
5. Entrá a **Ajustes → Modelo de IA**, elegí tu proveedor y **pegá tu API key**.
   NovaClaw la guarda cifrada en el teléfono (nunca sale de ahí).
6. ¡Listo! Escribile al agente: puede leer y editar archivos, correr comandos,
   ver fotos, y usar cámara/ubicación/contactos si le das permiso.

## ¿Es seguro?

- El agente solo escucha en **127.0.0.1** (loopback): ninguna otra app ni nadie
  en tu WiFi puede hablarle.
- Cada acción sensible (borrar, instalar, tocar archivos fuera del proyecto)
  **te pide permiso** antes de ejecutarse.
- Tu API key vive en el **Keystore** de Android, cifrada. No se embebe en el APK.

## Problemas comunes

- **"App no instalada" / bloqueada**: activá "instalar apps desconocidas" para
  la app desde la que abrís el APK (paso 2).
- **"Este APK no incluye el entorno Linux para tu arquitectura"**: bajaste el
  APK equivocado. Usá el `arm64` para teléfonos.
- **El chat te manda a Ajustes**: falta la API key (paso 5).
- **Se queda sin espacio a mitad de la descarga**: liberá espacio y reabrí; la
  app avisa cuánto falta antes de empezar.
