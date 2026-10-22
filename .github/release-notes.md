## Descargas

Elegí el archivo de tu sistema. **No hace falta tener Node.js instalado**: cada instalador trae el suyo.

| Sistema | Archivo | Cómo instalar |
| --- | --- | --- |
| **Windows 10/11** (64 bits) | `NebulaCodex-{{VERSION}}-windows-x64-setup.exe` | Doble clic y seguí el asistente. Crea el acceso directo en el escritorio y en el menú Inicio. |
| Windows (sin instalar) | `NebulaCodex-{{VERSION}}-windows-x64-portable.zip` | Descomprimí y abrí `NebulaCodex.cmd`. |
| **macOS 13.5 o superior** (Apple Silicon e Intel) | `NebulaCodex-{{VERSION}}-macos.dmg` | Abrí el disco y doble clic en **Instalar NebulaCodex.command** (clic derecho → Abrir la primera vez). |
| **Linux x86_64** | `NebulaCodex-{{VERSION}}-linux-x64.sh` | `sh NebulaCodex-{{VERSION}}-linux-x64.sh` |
| **Linux ARM64** | `NebulaCodex-{{VERSION}}-linux-arm64.sh` | `sh NebulaCodex-{{VERSION}}-linux-arm64.sh` |

Después de instalar, abrí NebulaCodex y escribí `/providers`: **todo se configura dentro de la app** (proveedor, API key y modelo).

### Avisos de seguridad del sistema

Estos instaladores **no están firmados** con certificados de pago, así que Windows (SmartScreen) y macOS (Gatekeeper) pueden mostrar una advertencia la primera vez:

- **Windows:** *Más información* → *Ejecutar de todas formas*.
- **macOS:** clic derecho sobre el archivo → *Abrir*; o en Terminal: `xattr -dr com.apple.quarantine /Applications/NebulaCodex.app`.

Podés comprobar que el archivo es el original con `SHA256SUMS.txt` (`sha256sum -c SHA256SUMS.txt` en Linux, `shasum -a 256 -c` en macOS, `Get-FileHash` en PowerShell).

Cada instalador se probó automáticamente en un sistema real (Windows, macOS y Linux): instala, abre la app, y desinstala sin dejar restos.

### English

Standalone installers for Windows, macOS and Linux (they bundle their own Node.js). Download the file for your OS from the table above, run it, then type `/providers` inside the app to configure your provider and API key. The installers are unsigned, so Windows SmartScreen / macOS Gatekeeper may warn on first run.
