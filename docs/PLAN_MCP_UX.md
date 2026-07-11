# Plan: MCP fácil (conectar por chat + auth + manual simple)

> Estado: EN CONSTRUCCIÓN. Objetivo: sacar el editor de JSON crudo y que
> conectar un MCP sea (a) pedírselo al agente, o (b) un formulario simple —
> manejando login/tokens/códigos sin enredar al usuario.

## Decisiones de Julio (10/jul)

- **Alcance auth: TODO** — tokens (Fase A) + código OAuth device flow (Fase B) +
  MCP remotos por HTTP con OAuth completo (Fase C).
- **Catálogo curado + avanzado**: lista de MCP conocidos (1 toque) + instalar
  cualquier otro mostrando qué corre.
- **Huella: solo al instalar un MCP nuevo** (no en cada uso de un secreto).
  Los secretos igual van cifrados en el Keystore.

## Cómo funciona hoy (punto de partida real)

- MCP en NovaClaw es **stdio**: el agente hace `spawn` de un comando (típico
  `npx -y @paquete/mcp-server`), habla JSON-RPC por líneas, descubre las tools
  y se las ofrece al modelo (`src/agent/mcp.ts`).
- La auth de esos MCP es por **variable de entorno** (un token). Ej: el MCP de
  GitHub necesita `GITHUB_PERSONAL_ACCESS_TOKEN`. No hay "login" adentro del
  MCP; hay un token que se le pasa por `env`.
- Hoy ese token se pega a mano en el JSON (`env`) → eso es lo feo a sacar.
- Ya existe: el agente instala MCP por chat (`mcp.add`), y `SecretStore.kt`
  cifra secretos en el Keystore (hoy para las API keys de IA).

## La verdad incómoda (para no vender humo)

NovaClaw **no puede iniciar sesión en GitHub/Google/etc. por su cuenta**. Esos
servicios protegen tu cuenta y solo dan acceso de dos formas: un **token** que
vos generás una vez, o un **OAuth** donde vos autorizás en la web del servicio.
Eso es bueno (si el agente pudiera entrar solo, cualquier app podría).

Lo que SÍ se puede: que el agente maneje TODA la plomería y vos solo hagas 2
cosas — poner la **huella**, y (la primera vez de un servicio nuevo) pegar un
token o tocar "Autorizar" y loguearte en la web del servicio. Después queda
guardado cifrado y el agente lo reusa solo.

## El método: 3 casos de auth, todos manejados por el agente

1. **Sin auth** → conecta directo (MCP de utilidades: archivos, memoria…).
2. **Token** → el agente te dice en criollo: "Para GitHub necesito un token,
   tocá acá [link], generalo con permiso X, pegámelo". Lo pegás una vez → va
   cifrado al Keystore → reconecta. Nunca ves JSON.
3. **OAuth 'código' (device flow)** → el agente te muestra: "Andá a
   github.com/login/device y poné este código: `XXXX-YYYY`". Vos autorizás en la
   web (ahí va tu login/huella del servicio); el agente espera (polling) y guarda
   el token solo. Esto es exactamente lo que imaginó Julio.

## La huella (BiometricPrompt) — para qué sí y para qué no

- **Sí**: desbloquear/guardar los secretos del Keystore antes de usarlos, y
  confirmar la instalación de un MCP nuevo (porque corre código de terceros).
- **No**: no reemplaza el login del servicio (eso es del lado de GitHub/Google).
  Del lado de NovaClaw, la huella es tu "sí, soy yo".

## Seguridad (lo que hay que cuidar sí o sí)

Instalar un MCP = correr un paquete npm de un desconocido en tu teléfono con los
permisos del agente. Dejar "el agente instala cualquier nombre" es una puerta a
paquetes maliciosos (typosquatting). Solución que NO enreda al usuario:

- **Catálogo curado** de MCP conocidos (GitHub, archivos, memoria, Slack,
  Postgres, etc.) con su paquete y qué token piden ya sabidos → conectar = 1 toque.
- Para cualquier otro, el agente igual lo instala, pero te **muestra exactamente
  qué va a correr** y te pide la huella (marcado como "no verificado").
- Secretos SIEMPRE cifrados en el Keystore; el archivo de config en disco nunca
  tiene el token (usa un placeholder `${SECRET:github}` que se resuelve al
  arrancar el MCP). Mismo patrón que ya usa la API key de IA.

## La UI nueva (reemplaza el editor JSON de la captura)

Pantalla "Herramientas (MCP)":
- Arriba: "Pedíselo al agente" (lo que ya está).
- **Catálogo** de MCP conocidos con botón *Conectar*.
- **Conectados**: estado (✓ + nº de tools) y botón *Quitar*.
- Botón "Agregar manualmente" → **formulario simple** (no JSON):
  - Nombre (ej: `github`)
  - Comando (ej: `npx`)
  - Argumentos (ej: `-y @modelcontextprotocol/server-github`)
  - Secretos: pares clave/valor (los valores van al Keystore cifrados)
  - *Conectar* → prueba y muestra ✓ con las tools o ✗ con el motivo.
- El JSON crudo queda escondido detrás de "Avanzado" (por si algún día hace falta).

## Cambio técnico chico pero necesario

Hoy el cliente MCP **ignora el stderr** del servidor (`mcp.ts` línea ~56), por
eso los errores son crípticos. Hay que **capturarlo** para que, cuando un MCP
falle por falta de token, el agente lea "falta GITHUB_TOKEN" y sepa pedírtelo.

## Fases (para construirlo sin romper nada)

- **Fase A** ✅ HECHA — UI nueva (catálogo + formulario) + tokens al Keystore
  (namespace `mcp:<id>`) + placeholder `${SECRET:<id>}` (el config nunca guarda
  el token) + huella al instalar + captura de stderr. Cubre ~90% de los MCP.
- **Fase B** ✅ HECHA — **OAuth device flow** (el flujo del código) para GitHub/
  GitLab. `src/agent/oauthDevice.ts` + tarjeta con el código en la UI + polling.
  El `client_id` lo trae Julio (registra una OAuth App y setea la env var); si no
  está, cae al pegado de token manual.
- **Fase C** ✅ HECHA (transporte + bearer) — **cliente HTTP** (Streamable HTTP)
  para MCP remotos (`src/agent/mcpHttp.ts`); el `McpManager` ahora conecta stdio
  (npx local) o HTTP (url remota). Auth por token Bearer en el header, con el
  mismo `${SECRET:<id>}`. Formulario manual con toggle Local/Remoto.

### Decisión sobre el OAuth-redirect completo (spec MCP 2025)

El flujo OAuth 2.1 con redirect (dynamic client registration + PKCE + callback
por navegador) NO se implementó a propósito: en un teléfono es frágil (necesita
manejar un redirect URI / esquema custom) y el **device flow (Fase B) ya cubre la
autenticación interactiva** de forma más robusta y sin registrar redirect URIs.
Para MCP remotos que exigen OAuth, la recomendación es device flow o un token
Bearer. Si algún día aparece un MCP remoto que SOLO soporte redirect, se suma
ahí (es aditivo al cliente HTTP que ya existe).

## Piezas de código a tocar (referencia para implementar)

- `src/agent/mcp.ts`: capturar stderr; resolver placeholders `${SECRET:...}`.
- `SecretStore.kt`: namespace para tokens de MCP (`mcp:<server>`), + Biometric.
- `ConnectorBridge.kt`: puente para guardar/leer secretos MCP + BiometricPrompt.
- `server.ts` (`routes/admin` MCP): endpoints catálogo/estado/token; resolver
  secretos del Keystore al conectar.
- UI Settings (modal MCP): catálogo + formulario + estado (sacar el textarea JSON).
- `src/agent/tools.ts` (`mcp.add`) + prompt: flujo guiado de token/código.
