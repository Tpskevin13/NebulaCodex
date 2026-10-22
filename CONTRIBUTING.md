# Cómo contribuir

¡Gracias por querer ayudar! NebulaCodex es software libre bajo licencia [MIT](LICENSE).

## Preparar el entorno

Necesitás Node.js 18 o superior.

```bash
git clone https://github.com/Tpskevin13/NebulaCodex.git
cd nebulacodex
npm install
npm run dev      # ejecuta la app desde src/
```

## Antes de abrir un Pull Request

```bash
npm run build    # TypeScript estricto: no puede haber errores ni variables sin usar
npm test         # todas las pruebas tienen que pasar
```

- Agregá una prueba en `test/` para cada cambio de comportamiento y registrala en el script `test` de `package.json`.
- El texto que ve el usuario va en español; el código y los nombres, en inglés.
- No subas API keys, `.env` ni datos personales. Los chats y la configuración viven en `~/.nebulacodex`, fuera del repositorio.
- Los Pull Requests corren la CI en Windows, macOS y Linux con Node 20, 22 y 24.

## Instaladores

Las fuentes están en `installers/` y el empaquetado en `scripts/package.mjs`. Cada instalador se prueba en un sistema real
con los scripts de `scripts/ci/`. Para probar el de Linux en tu máquina:

```bash
npm run build
npm run package -- --target linux-x64
HOME=$(mktemp -d) sh release/NebulaCodex-*-linux-x64.sh --no-desktop
```

## Publicar una versión (mantenedores)

1. Actualizá `version` en `package.json` y `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`) y el `CHANGELOG.md`.
2. Hacé commit en `main` y esperá a que la CI y el workflow *Release* (en modo prueba) estén en verde.
3. Subí el tag: `git tag vX.Y.Z && git push origin vX.Y.Z`, o en GitHub: *Releases → Draft a new release → Choose a tag → escribí `vX.Y.Z` → Create new tag on publish → Publish*.
   El workflow construye los instaladores, los prueba en cada sistema y los adjunta al Release.
   Un tag con guion (`v1.0.0-rc.1`) se publica como *pre-release*.

## Regenerar recursos

- Iconos: `python3 scripts/make-icons.py` (necesita Pillow).
- Tabla de proveedores: `node scripts/gen-providers-doc.mjs` (Node 22.18 o superior).
