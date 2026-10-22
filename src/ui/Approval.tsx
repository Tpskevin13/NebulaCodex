import { Box, Text, useInput } from "ink";
import { C } from "./theme.js";

export function Approval({
  name,
  desc,
  onAnswer,
}: {
  name: string;
  desc: string;
  onAnswer: (v: "yes" | "always" | "no") => void;
}) {
  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === "y" || key.return) onAnswer("yes");
    else if (c === "a") onAnswer("always");
    else if (c === "n") onAnswer("no");
  });
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={C.yellow}
      paddingX={1}
      marginTop={1}
    >
      <Text color={C.yellow} bold>
        ⚡ Permiso requerido
      </Text>
      <Text>
        <Text color={C.cyan}>{name}</Text> <Text color={C.text}>{desc}</Text>
      </Text>
      <Text color={C.dim}>
        <Text color={C.green}>[y/Enter]</Text> permitir · <Text color={C.green}>[a]</Text> permitir
        siempre · <Text color={C.red}>[n]</Text> rechazar · Esc detener
      </Text>
    </Box>
  );
}
