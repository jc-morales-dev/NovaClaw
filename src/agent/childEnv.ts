// Entorno para procesos hijos, sin secretos.
//
// El agente corre con la API key del usuario (ZEN_API_KEY) y el token app↔agente
// (NOVACLAW_TOKEN) en su propio process.env — en Android los inyecta
// RuntimeManager desde el Android Keystore al arrancar. Cualquier hijo que herede
// ese entorno los puede leer: `printenv`, `cat /proc/self/environ`, `node -e`, o
// un servidor MCP de terceros.
//
// El gate de aprobación no alcanza para esto: solo obliga a que el usuario diga
// que sí una vez, y un único comando aprobado ya se lleva la key. Así que los
// secretos no entran al entorno del hijo, aprobado o no.
//
// Módulo puro a propósito (sin fs ni child_process): lo usan tanto src/agent como
// src/server, y así se puede testear sin lanzar procesos.
export type EnvLike = Record<string, string | undefined>;

// Nombres exactos propios de NovaClaw.
const SECRETOS_EXACTOS = new Set(['ZEN_API_KEY', 'NOVACLAW_TOKEN']);

// Credenciales de terceros reconocidas por su forma. El agente no sabe de
// antemano qué claves tiene el usuario en su entorno (el teléfono es suyo y
// puede haber puesto las que quiera), así que se filtra por patrón y no por
// lista cerrada: es preferible ocultar de más que filtrar una key.
const PATRONES_SECRETOS = [
  /API_KEY/,
  /(^|_)TOKEN($|_)/,
  /SECRET/,
  /PASSWORD|PASSWD/,
  /ACCESS_KEY/,
  /CREDENTIAL/,
  /PRIVATE_KEY/,
  /CONNECTION_STRING/,
];

export function esNombreSecreto(nombre: string): boolean {
  const upper = nombre.toUpperCase();
  if (SECRETOS_EXACTOS.has(upper)) return true;
  return PATRONES_SECRETOS.some((patron) => patron.test(upper));
}

/**
 * Copia `source` quitando todo lo que parezca una credencial y aplica `extra`
 * encima SIN filtrarlo: lo que el llamador pasa explícitamente es intencional
 * (p.ej. `mcp.add` entregándole al servidor MCP la credencial que el usuario
 * configuró para él). El filtro es para lo que se hereda por accidente.
 */
export function sanitizeChildEnv(source: EnvLike, extra?: EnvLike): EnvLike {
  const limpio: EnvLike = {};
  for (const [nombre, valor] of Object.entries(source)) {
    if (esNombreSecreto(nombre)) continue;
    limpio[nombre] = valor;
  }
  return { ...limpio, ...(extra ?? {}) };
}
