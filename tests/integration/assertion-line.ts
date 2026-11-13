/** One line naming a test and the assertions it ran (shyden-labs/shydesk#132). */
export function assertionLine(test: string | undefined, assertions: number): string {
  return `assertions-ran: ${test ?? '(unnamed)'} = ${String(assertions)}\n`;
}
