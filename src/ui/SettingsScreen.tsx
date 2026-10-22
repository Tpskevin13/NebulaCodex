import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { C, aurora } from "./theme.js";
import type { EffortLevel } from "../core/types.js";
import { cleanLine } from "../core/text.js";

const EFFORTS: EffortLevel[] = ["low", "medium", "high", "max"];
const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "Bajo",
  medium: "Medio",
  high: "Alto",
  max: "Máximo",
};

export function SettingsScreen({
  provider,
  model,
  effort,
  workingDirectory,
  allowedTools,
  onOpenProviders,
  onEffortChange,
  onDirectoryChange,
  onResetPermissions,
  onClose,
}: {
  provider: string;
  model: string;
  effort: EffortLevel;
  workingDirectory: string;
  allowedTools: string[];
  onOpenProviders: () => void;
  onEffortChange: (effort: EffortLevel) => void;
  onDirectoryChange: (directory: string) => string | null;
  onResetPermissions: () => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const [editingDirectory, setEditingDirectory] = useState(false);
  const [directory, setDirectory] = useState(workingDirectory);
  const [error, setError] = useState("");

  useInput((_input, key) => {
    if (editingDirectory) {
      if (key.escape) {
        setEditingDirectory(false);
        setError("");
      }
      return;
    }

    if (key.escape) onClose();
    else if (key.upArrow) setSelected((index) => (index + 4) % 5);
    else if (key.downArrow) setSelected((index) => (index + 1) % 5);
    else if (selected === 1 && (key.leftArrow || key.rightArrow || key.return)) {
      const current = EFFORTS.indexOf(effort);
      const step = key.leftArrow ? -1 : 1;
      onEffortChange(EFFORTS[(current + step + EFFORTS.length) % EFFORTS.length]);
    } else if (key.return) {
      if (selected === 0) onOpenProviders();
      else if (selected === 2) {
        setDirectory(workingDirectory);
        setError("");
        setEditingDirectory(true);
      } else if (selected === 3) {
        onResetPermissions();
      } else if (selected === 4) onClose();
    }
  }, { isActive: !editingDirectory });

  useInput((_input, key) => {
    if (editingDirectory && key.escape) {
      setEditingDirectory(false);
      setError("");
    }
  }, { isActive: editingDirectory });

  const changeDirectory = () => {
    const result = onDirectoryChange(directory.trim());
    if (result) {
      setError(result);
      return;
    }
    setDirectory(directory.trim());
    setError("");
    setEditingDirectory(false);
  };

  const option = (index: number, title: string, value: string, hint: string) => (
    <Box key={title} flexDirection="column" marginTop={1}>
      <Text color={selected === index ? C.magenta : C.text} bold={selected === index}>
        {selected === index ? "❯ " : "  "}{title}: {value}
      </Text>
      <Text color={C.dim}>   {hint}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text>{aurora("✦ Ajustes de NebulaCodex")}</Text>
      <Text color={C.dim}>↑↓ elegir · Enter abrir/cambiar · Esc volver al chat</Text>

      {option(0, "Proveedor, API key y modelo", `${provider} · ${model}`, "Configurar o cambiar el proveedor activo")}
      {option(1, "Esfuerzo de razonamiento", EFFORT_LABEL[effort], "←→ o Enter para cambiar; se guarda automáticamente")}

      <Box flexDirection="column" marginTop={1}>
        <Text color={selected === 2 ? C.magenta : C.text} bold={selected === 2}>
          {selected === 2 ? "❯ " : "  "}Carpeta de trabajo: {workingDirectory}
        </Text>
        {editingDirectory ? (
          <Box paddingLeft={3}>
            <Text color={C.cyan}>Ruta: </Text>
            <TextInput
              value={directory}
              onChange={(value) => {
                setDirectory(cleanLine(value));
                setError("");
              }}
              onSubmit={changeDirectory}
              placeholder="C:\\ruta\\de\\trabajo"
            />
            <Text color={C.dim}> Enter aplica · Esc cancela</Text>
          </Box>
        ) : (
          <Text color={C.dim}>   Enter para cambiar esta sesión</Text>
        )}
        {error ? <Text color={C.red}>   {error}</Text> : null}
      </Box>

      {option(
        3,
        "Permisos de herramientas",
        allowedTools.length ? `${allowedTools.length} permiso(s) recordado(s) en esta sesión` : "confirmación activa",
        "Enter olvida los permisos recordados; las herramientas sensibles vuelven a pedir confirmación",
      )}
      {option(4, "Volver al chat", "", "")}
    </Box>
  );
}
