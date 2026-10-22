# Política de seguridad

## Versiones con soporte

Sólo la última versión publicada recibe correcciones de seguridad.

## Cómo reportar una vulnerabilidad

**No abras un issue público con los detalles.** Usá el reporte privado de GitHub:
pestaña **Security → Report a vulnerability** de este repositorio
(<https://github.com/Tpskevin13/NebulaCodex/security/advisories/new>).

Incluí, si podés: versión y sistema operativo, pasos para reproducirlo, el impacto que ves y, de ser posible, una propuesta de arreglo.
Vas a recibir una respuesta con los próximos pasos; es un proyecto comunitario, así que los plazos son de mejor esfuerzo.

## Qué se considera una vulnerabilidad

- Saltarse la aprobación de herramientas (`write_file`, `edit_file`, `delete_file`, `move_file`, `run_command`, `fetch_url`).
- Que `fetch_url` alcance `localhost`, redes privadas o servicios de metadatos (SSRF).
- Exposición o filtración de las API keys guardadas en `~/.nebulacodex/config.json`.
- Ejecución de código al abrir un chat, una configuración o un archivo exportado.
- Problemas en los instaladores (por ejemplo, borrar archivos que no son de NebulaCodex).

## Lo que ya se sabe

- NebulaCodex no tiene *sandbox*: un comando aprobado corre con tus permisos.
- Las API keys se guardan en texto plano (permisos `0600` en Linux y macOS).
- `fetch_url` no fija la IP resuelta en el socket, por lo que queda una ventana de *DNS rebinding* ([`docs/AUDIT.md`](docs/AUDIT.md)).
- Los instaladores no están firmados; verificá la descarga con `SHA256SUMS.txt` de cada Release.
