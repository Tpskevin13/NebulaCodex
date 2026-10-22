// Genera docs/PROVIDERS.md a partir de src/core/providers/presets.ts (así la tabla nunca se desactualiza).
// Uso: node scripts/gen-providers-doc.mjs      (Node 22.18+ o con --experimental-strip-types)
import fs from "node:fs";

const { PRESETS } = await import(new URL("../src/core/providers/presets.ts", import.meta.url));
const esc = (s) => String(s ?? "").replaceAll("|", "\\|");
const rows = PRESETS.map((p) => {
  const key = p.needsKey ? (p.envKey ? `\`${p.envKey}\`` : "sí") : "no";
  const extra = [p.customBaseUrl ? "URL editable" : "", p.kind === "anthropic" ? "API de Anthropic" : ""].filter(Boolean).join(", ");
  return `| ${esc(p.label)} | \`${p.id}\` | ${key} | \`${esc(p.model)}\` | ${esc(p.hint)}${extra ? ` (${extra})` : ""} |`;
});
const text = `# Proveedores incluidos

Todo se configura dentro de la aplicación con \`/providers\`: elegís el proveedor, pegás la API key y NebulaCodex guarda
la configuración en \`~/.nebulacodex/config.json\` (permisos 0600 en Linux y macOS).

Si no hay una API key guardada para un proveedor, NebulaCodex usa la variable de entorno de la columna **Variable** (si existe).
Así podés trabajar sin escribir la clave en ningún archivo:

\`\`\`bash
export GROQ_API_KEY="..."      # Linux / macOS
\`\`\`

\`\`\`powershell
$env:GROQ_API_KEY = "..."      # PowerShell
\`\`\`

El modelo de la columna **Modelo por defecto** es sólo el valor inicial; se puede cambiar con \`/model\` o \`/providers\`.
Los identificadores de modelo cambian con el tiempo: verificá el nombre vigente en la documentación del proveedor.

| Proveedor | ID | Variable de la API key | Modelo por defecto | Notas |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

> Esta tabla se genera con \`node scripts/gen-providers-doc.mjs\`. Cualquier endpoint compatible con OpenAI funciona con el proveedor **Personalizado** (\`custom\`).
`;
fs.writeFileSync(new URL("../docs/PROVIDERS.md", import.meta.url), text);
console.log(`docs/PROVIDERS.md: ${PRESETS.length} proveedores`);
