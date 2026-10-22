# Cambios

Este archivo sigue el formato de [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado [SemVer](https://semver.org/lang/es/).

## [0.1.0] - 2026-10-22

Primera versión pública.

### Agregado
- Agente de código para la terminal con herramientas de archivos, búsqueda, comandos y `fetch_url`, con aprobación previa para todo lo que modifica algo.
- 27 proveedores de IA preconfigurados y soporte para cualquier endpoint compatible con OpenAI; configuración dentro de la app con `/providers`.
- Enrutamiento por tarea (`/route`), chats guardados, exportación a Markdown y `/undo`.
- `nebulacodex --version` y `--help`.
- Instaladores autónomos (con Node.js incluido) para Windows (`.exe` y `.zip` portátil), macOS (`.dmg`) y Linux (`.sh`, x64 y arm64), con acceso directo en el escritorio, menú y desinstalador.
- Integración continua en Windows, macOS y Linux, y publicación automática de Releases al subir un tag `vX.Y.Z`.
- Licencia MIT, documentación (README, auditoría, informe de pruebas, modelos y proveedores) y guías de contribución y seguridad.

[0.1.0]: https://github.com/Tpskevin13/nebulacodex/releases/tag/v0.1.0
