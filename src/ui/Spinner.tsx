import { Text } from "ink";
import { C } from "./theme.js";

export function Spinner({ label }: { label: string }) {
  return (
    <Text color={C.magenta}>
      ✦ <Text color={C.dim}>{label}</Text>
    </Text>
  );
}
