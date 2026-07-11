# Plan de distribución (open source + nicho)

NovaClaw no es un producto de masas: sideload + 300 MB de descarga inicial +
BYOK (traer tu propia API key) filtran al público no técnico. Pero para la
**comunidad Termux/dev** es exactamente lo que quieren, y como **pieza de
portafolio** demuestra Android nativo (Kotlin), sistemas (Linux embebido +
proot), backend (Node/Express/SSE/PTY) y agentes de IA en un solo repo.

La meta realista no es venta directa, sino **comunidad + reputación + sponsors**.

## Camino recomendado

1. **Abrir el repo (MIT)** con un README fuerte, `docs/INSTALL.md` y un **video
   demo corto** (lo que más convence: Claude Code corriendo DENTRO de un
   teléfono). El video vale más que mil READMEs.
2. **Release firmada** vía GitHub Actions (`.github/workflows/release.yml`):
   push de un tag `vX.Y.Z` → compila el APK arm64 (targetSdk 34) y lo adjunta.
3. **Publicar en los lugares del nicho**:
   - r/termux, r/androiddev, r/LocalLLaMA, r/selfhosted
   - Hacker News (Show HN), Lobsters
   - Awesome-lists: awesome-termux, awesome-android, awesome-ai-agents
   - X/Twitter y el Discord de Termux
4. **F-Droid** como meta a mediano plazo (requiere build 100% reproducible y
   revisar los binarios prebuilt; da mucha legitimidad en el nicho).
5. **Sponsors**: habilitar GitHub Sponsors (`.github/FUNDING.yml` ya está) y
   Ko-fi. El pitch: "el único Claude Code que corre entero en tu teléfono".

## Qué lo hace vendible (para el pitch)

- Agente de código on-device con function-calling nativo (explorar → editar
  quirúrgico → verificar), streaming en vivo, plan de tareas, rewind.
- Herramientas que Claude Code NO tiene en el celular: **cámara + visión**,
  GPS, contactos, calendario como tools del agente.
- Seguridad seria: loopback-only, token por instalación, **allowlist** de
  comandos (default-deny), SSRF guard, BYOK cifrado en Keystore.
- Ya no depende del truco de targetSdk 28: corre en **targetSdk 34** vía proot.

## Antes de hacerlo público (checklist)

- [ ] Rotar cualquier API key que haya estado embebida en versiones viejas.
- [ ] Confirmar que `novaclaw.config.json` / `.jks` NO están en git (ya
      gitignored) y que ningún commit viejo los tiene.
- [ ] Probar el APK de targetSdk 34 en un teléfono real (ver
      `docs/PROOT_TARGETSDK.md`).
- [ ] Grabar el video demo (30–60 s).
- [ ] Revisar `THIRD-PARTY-LICENSES.md` (obligaciones GPL de proot/bootstrap).
- [ ] Decidir handle/nombre público y actualizar los links del README.
